import { readdir, stat } from 'node:fs/promises';
import * as path from 'node:path';

import { ClaudePaths } from './claudePaths';
import { ClaudeDiscoveryResult, ClaudeSessionFileMetadata } from './claudeTypes';

interface ClaudeDirectoryEntry {
	readonly name: string;
	readonly isDirectory: () => boolean;
	readonly isFile: () => boolean;
	readonly isSymbolicLink: () => boolean;
}

interface ClaudeFileSystem {
	readdir(directoryPath: string): Promise<readonly ClaudeDirectoryEntry[]>;
	stat(filePath: string): Promise<{ isDirectory(): boolean; isFile(): boolean; mtimeMs: number }>;
}

const nodeFileSystem: ClaudeFileSystem = { readdir: async (directoryPath) => readdir(directoryPath, { withFileTypes: true }), stat };

/** Discovers Claude transcript metadata without opening transcript contents. */
export class ClaudeDiscovery {
	constructor(
		private readonly paths: ClaudePaths,
		private readonly fileSystem: ClaudeFileSystem = nodeFileSystem,
	) {}

	getPaths(): ClaudePaths {
		return this.paths;
	}

	async discover(): Promise<ClaudeDiscoveryResult> {
		try {
			const configStats = await this.fileSystem.stat(this.paths.configPath);
			if (!configStats.isDirectory()) {
				return { detected: false, configPath: this.paths.configPath, projectsPath: this.paths.projectsPath, reason: 'Claude config path is not a directory.' };
			}
		} catch {
			return { detected: false, configPath: this.paths.configPath, projectsPath: this.paths.projectsPath, reason: 'Claude config directory was not found.' };
		}

		let files: readonly ClaudeSessionFileMetadata[] = [];
		try {
			const projectStats = await this.fileSystem.stat(this.paths.projectsPath);
			if (projectStats.isDirectory()) {
				files = await this.findSessionFiles(this.paths.projectsPath);
			}
		} catch {
			// Claude can be installed before its first session creates projects/.
		}
		const latestSessionFile = files.reduce<ClaudeSessionFileMetadata | undefined>((latest, candidate) =>
			!latest || candidate.modifiedAt > latest.modifiedAt ? candidate : latest, undefined);
		return {
			detected: true,
			configPath: this.paths.configPath,
			projectsPath: this.paths.projectsPath,
			sessionFileCount: files.length,
			latestSessionFile,
			reason: files.length === 0 ? 'Claude config found; no transcript files were found.' : undefined,
		};
	}

	async discoverSessionFiles(): Promise<readonly ClaudeSessionFileMetadata[]> {
		try {
			const stats = await this.fileSystem.stat(this.paths.projectsPath);
			return stats.isDirectory() ? this.findSessionFiles(this.paths.projectsPath) : [];
		} catch {
			return [];
		}
	}

	private async findSessionFiles(root: string): Promise<readonly ClaudeSessionFileMetadata[]> {
		const pending = [root];
		const files: ClaudeSessionFileMetadata[] = [];
		while (pending.length > 0) {
			const directory = pending.pop();
			if (!directory) {
				continue;
			}
			let entries: readonly ClaudeDirectoryEntry[];
			try {
				entries = await this.fileSystem.readdir(directory);
			} catch {
				continue;
			}
			for (const entry of entries) {
				if (entry.isSymbolicLink()) {
					continue;
				}
				const entryPath = path.join(directory, entry.name);
				if (entry.isDirectory()) {
					pending.push(entryPath);
					continue;
				}
				if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.jsonl')) {
					continue;
				}
				try {
					const entryStats = await this.fileSystem.stat(entryPath);
					if (entryStats.isFile()) {
						files.push({ filePath: entryPath, sessionId: path.basename(entry.name, '.jsonl'), modifiedAt: entryStats.mtimeMs });
					}
				} catch {
					// Files can disappear during a concurrent Claude write.
				}
			}
		}
		return files;
	}
}
