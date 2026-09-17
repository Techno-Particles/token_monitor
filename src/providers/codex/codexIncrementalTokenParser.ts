import { open, stat } from 'node:fs/promises';

import { CodexParsedUsage } from './codexTypes';
import { CodexTokenAccumulator } from './codexTokenParser';

interface FileIdentity {
	readonly device?: number;
	readonly inode?: number;
}

function identityOf(fileStats: { dev: number; ino: number }): FileIdentity {
	return { device: fileStats.dev, inode: fileStats.ino };
}

function sameIdentity(left: FileIdentity | undefined, right: FileIdentity): boolean {
	if (!left || left.device === undefined || left.inode === undefined) {
		return true;
	}
	return left.device === right.device && left.inode === right.inode;
}

/**
 * Reads a rollout file incrementally. The trailing unterminated JSONL record
 * is retained until its newline arrives, so partial writes are never parsed.
 */
export class CodexIncrementalTokenParser {
	private filePath?: string;
	private offset = 0;
	private partialBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
	private identity?: FileIdentity;
	private accumulator = new CodexTokenAccumulator();
	private bytesRead = 0;

	async initialize(filePath: string): Promise<CodexParsedUsage | undefined> {
		this.reset(filePath);
		return this.readAppended(filePath);
	}

	async readAppended(filePath: string): Promise<CodexParsedUsage | undefined> {
		if (this.filePath !== filePath) {
			this.reset(filePath);
		}

		let fileStats: Awaited<ReturnType<typeof stat>>;
		try {
			fileStats = await stat(filePath);
		} catch {
			return this.accumulator.getResult();
		}

		const currentIdentity = identityOf(fileStats);
		if (fileStats.size < this.offset || !sameIdentity(this.identity, currentIdentity)) {
			this.reset(filePath);
		}
		this.identity = currentIdentity;

		if (fileStats.size <= this.offset) {
			return this.accumulator.getResult();
		}

		let handle: Awaited<ReturnType<typeof open>>;
		try {
			handle = await open(filePath, 'r');
		} catch {
			return this.accumulator.getResult();
		}

		try {
			let position = this.offset;
			while (position < fileStats.size) {
				const chunk = Buffer.alloc(Math.min(64 * 1024, fileStats.size - position));
				const result = await handle.read(chunk, 0, chunk.length, position);
				if (result.bytesRead === 0) {
					break;
				}
				this.consumeBytes(chunk.subarray(0, result.bytesRead));
				this.offset += result.bytesRead;
				position += result.bytesRead;
				this.bytesRead += result.bytesRead;
			}
		} catch {
			return this.accumulator.getResult();
		} finally {
			await handle.close().catch(() => undefined);
		}

		return this.accumulator.getResult();
	}

	getResult(): CodexParsedUsage | undefined {
		return this.accumulator.getResult();
	}

	/** Test-only observability proving normal updates read appended bytes only. */
	getBytesRead(): number {
		return this.bytesRead;
	}

	reset(filePath?: string): void {
		this.filePath = filePath;
		this.offset = 0;
		this.partialBuffer = Buffer.alloc(0);
		this.identity = undefined;
		this.accumulator = new CodexTokenAccumulator();
	}

	private consumeBytes(bytes: Buffer): void {
		const data = this.partialBuffer.length === 0 ? bytes : Buffer.concat([this.partialBuffer, bytes]);
		let lineStart = 0;
		for (let index = 0; index < data.length; index++) {
			if (data[index] !== 0x0a) {
				continue;
			}
			this.accumulator.consumeLine(data.subarray(lineStart, index).toString('utf8'));
			lineStart = index + 1;
		}
		this.partialBuffer = data.subarray(lineStart);
	}
}
