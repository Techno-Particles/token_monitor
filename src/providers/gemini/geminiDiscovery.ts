import { readdir, stat } from 'node:fs/promises';
import * as path from 'node:path';

import { GeminiPaths } from './geminiPaths';
import { GeminiDiscoveryResult, GeminiSessionFileMetadata } from './geminiTypes';

interface GeminiDirectoryEntry {
	readonly name: string;
	readonly isDirectory: () => boolean;
	readonly isFile: () => boolean;
	readonly isSymbolicLink: () => boolean;
}

interface GeminiFileSystem {
	readdir(directoryPath: string): Promise<readonly GeminiDirectoryEntry[]>;
	stat(filePath: string): Promise<{ isDirectory(): boolean; isFile(): boolean; mtimeMs: number }>;
}

const nodeFileSystem: GeminiFileSystem = {
	readdir: async (directoryPath) => readdir(directoryPath, { withFileTypes: true }),
	stat,
};

function isSessionFile(name: string): boolean {
	return /\.(?:jsonl?|JSONL?)$/.test(name);
}

/** Discovers Gemini session metadata without opening session contents. */
export class GeminiDiscovery {
	constructor(
		private readonly paths: GeminiPaths,
		private readonly fileSystem: GeminiFileSystem = nodeFileSystem,
	) {}

	getPaths(): GeminiPaths {
		return this.paths;
	}

	async discover(): Promise<GeminiDiscoveryResult> {
		try {
			const configStats = await this.fileSystem.stat(this.paths.configPath);
			if (!configStats.isDirectory()) {
				return { detected: false, configPath: this.paths.configPath, sessionsPath: this.paths.sessionsPath, reason: 'Gemini config path is not a directory.' };
			}
		} catch {
			return { detected: false, configPath: this.paths.configPath, sessionsPath: this.paths.sessionsPath, reason: 'Gemini config directory was not found.' };
		}

		let files: readonly GeminiSessionFileMetadata[] = [];
		try {
			const sessionStats = await this.fileSystem.stat(this.paths.sessionsPath);
			if (sessionStats.isDirectory()) {
				files = await this.findSessionFiles(this.paths.sessionsPath);
			}
		} catch {
			// Gemini can be installed before the first session creates tmp/.
		}

		const latestSessionFile = files.reduce<GeminiSessionFileMetadata | undefined>((latest, candidate) =>
			!latest || candidate.modifiedAt > latest.modifiedAt ? candidate : latest, undefined);
		return {
			detected: true,
			configPath: this.paths.configPath,
			sessionsPath: this.paths.sessionsPath,
			sessionFileCount: files.length,
			latestSessionFile,
			reason: files.length === 0 ? 'Gemini config found; no session files were found.' : undefined,
		};
	}

	async discoverSessionFiles(): Promise<readonly GeminiSessionFileMetadata[]> {
		try {
			const stats = await this.fileSystem.stat(this.paths.sessionsPath);
			return stats.isDirectory() ? this.findSessionFiles(this.paths.sessionsPath) : [];
		} catch {
			return [];
		}
	}

	private async findSessionFiles(root: string): Promise<readonly GeminiSessionFileMetadata[]> {
		const pending: Array<{ directory: string; inChatsTree: boolean }> = [{ directory: root, inChatsTree: false }];
		const files: GeminiSessionFileMetadata[] = [];
		while (pending.length > 0) {
			const current = pending.pop();
			if (!current) {
				continue;
			}
			let entries: readonly GeminiDirectoryEntry[];
			try {
				entries = await this.fileSystem.readdir(current.directory);
			} catch {
				continue;
			}
			for (const entry of entries) {
				if (entry.isSymbolicLink()) {
					continue;
				}
				const entryPath = path.join(current.directory, entry.name);
				if (entry.isDirectory()) {
					pending.push({ directory: entryPath, inChatsTree: current.inChatsTree || entry.name === 'chats' });
					continue;
				}
				if (!entry.isFile() || !current.inChatsTree || !isSessionFile(entry.name)) {
					continue;
				}
				try {
					const entryStats = await this.fileSystem.stat(entryPath);
					if (entryStats.isFile()) {
						files.push({ filePath: entryPath, sessionId: path.basename(entry.name, path.extname(entry.name)), modifiedAt: entryStats.mtimeMs });
					}
				} catch {
					// Files can disappear during a concurrent Gemini write.
				}
			}
		}
		return files;
	}
}
