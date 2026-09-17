import { readdir, stat } from 'node:fs/promises';
import * as path from 'node:path';

import { CodexPaths } from './codexPaths';

export interface CodexDiscoveryResult {
	readonly detected: boolean;
	readonly homePath?: string;
	readonly sessionsPath?: string;
	readonly sessionFileCount?: number;
	readonly latestSessionFile?: string;
	readonly latestSessionModifiedAt?: number;
	readonly reason?: string;
}

export interface CodexSessionFileMetadata {
	readonly filePath: string;
	readonly modifiedAt: number;
}

export interface CodexDirectoryEntry {
	readonly name: string;
	readonly isDirectory: () => boolean;
	readonly isFile: () => boolean;
	readonly isSymbolicLink: () => boolean;
}

export interface CodexFileStat {
	readonly isDirectory: () => boolean;
	readonly isFile: () => boolean;
	readonly mtimeMs: number;
}

export interface CodexFileSystem {
	readdir(directoryPath: string): Promise<readonly CodexDirectoryEntry[]>;
	stat(filePath: string): Promise<CodexFileStat>;
}

const nodeFileSystem: CodexFileSystem = {
	readdir: async (directoryPath) => readdir(directoryPath, { withFileTypes: true }),
	stat,
};

const rolloutFilePattern = /^rollout-.*\.jsonl$/i;

function errorCode(error: unknown): string | undefined {
	if (typeof error !== 'object' || error === null || !('code' in error)) {
		return undefined;
	}

	const code = error.code;
	return typeof code === 'string' ? code : undefined;
}

/** Discovers Codex session metadata without opening session files. */
export class CodexDiscovery {
	constructor(
		private readonly paths: CodexPaths,
		private readonly fileSystem: CodexFileSystem = nodeFileSystem,
	) {}

	getPaths(): CodexPaths {
		return this.paths;
	}

	/** Lists rollout metadata only; session contents are not opened here. */
	async discoverSessionFiles(): Promise<readonly CodexSessionFileMetadata[]> {
		try {
			const sessionsStats = await this.fileSystem.stat(this.paths.sessionsPath);
			return sessionsStats.isDirectory() ? this.findSessionFiles(this.paths.sessionsPath) : [];
		} catch {
			return [];
		}
	}

	async discover(): Promise<CodexDiscoveryResult> {
		const baseResult = {
			homePath: this.paths.homePath,
			sessionsPath: this.paths.sessionsPath,
		};

		let homeStats: CodexFileStat;
		try {
			homeStats = await this.fileSystem.stat(this.paths.homePath);
		} catch (error) {
			return {
				...baseResult,
				detected: false,
				reason: errorCode(error) === 'EACCES'
					? 'Codex home directory is not accessible.'
					: 'Codex home directory was not found.',
			};
		}

		if (!homeStats.isDirectory()) {
			return {
				...baseResult,
				detected: false,
				reason: 'Codex home path is not a directory.',
			};
		}

		let sessionsStats: CodexFileStat;
		try {
			sessionsStats = await this.fileSystem.stat(this.paths.sessionsPath);
		} catch (error) {
			if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') {
				return {
					...baseResult,
					detected: true,
					sessionFileCount: 0,
					reason: 'Codex home found; sessions directory is not present.',
				};
			}

			return {
				...baseResult,
				detected: true,
				reason: 'Codex home found; sessions directory is not accessible.',
			};
		}

		if (!sessionsStats.isDirectory()) {
			return {
				...baseResult,
				detected: true,
				sessionFileCount: 0,
				reason: 'Codex home found; sessions path is not a directory.',
			};
		}

		const sessionFiles = await this.findSessionFiles(this.paths.sessionsPath);
		const latest = sessionFiles.reduce<typeof sessionFiles[number] | undefined>(
			(current, candidate) => {
				if (!current || candidate.modifiedAt > current.modifiedAt) {
					return candidate;
				}
				return current;
			},
			undefined,
		);

		return {
			...baseResult,
			detected: true,
			sessionFileCount: sessionFiles.length,
			latestSessionFile: latest?.filePath,
			latestSessionModifiedAt: latest?.modifiedAt,
			reason: sessionFiles.length === 0 ? 'Codex home found; no session files were found.' : undefined,
		};
	}

	private async findSessionFiles(sessionsPath: string): Promise<readonly { filePath: string; modifiedAt: number }[]> {
		const pendingDirectories = [sessionsPath];
		const sessionFiles: { filePath: string; modifiedAt: number }[] = [];

		while (pendingDirectories.length > 0) {
			const directoryPath = pendingDirectories.pop();
			if (!directoryPath) {
				continue;
			}

			let entries: readonly CodexDirectoryEntry[];
			try {
				entries = await this.fileSystem.readdir(directoryPath);
			} catch {
				// A missing or inaccessible nested directory should not break detection.
				continue;
			}

			for (const entry of entries) {
				if (entry.isSymbolicLink()) {
					continue;
				}

				const entryPath = path.join(directoryPath, entry.name);
				if (entry.isDirectory()) {
					pendingDirectories.push(entryPath);
					continue;
				}

				if (!entry.isFile() || !rolloutFilePattern.test(entry.name)) {
					continue;
				}

				try {
					const entryStats = await this.fileSystem.stat(entryPath);
					if (entryStats.isFile()) {
						sessionFiles.push({ filePath: entryPath, modifiedAt: entryStats.mtimeMs });
					}
				} catch {
					// Ignore files that disappear or become inaccessible during discovery.
				}
			}
		}

		return sessionFiles;
	}
}
