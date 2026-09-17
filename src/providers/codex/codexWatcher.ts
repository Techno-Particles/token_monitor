import { watch as nodeWatch } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import * as path from 'node:path';

import {
	CodexDirectoryEntry,
	CodexDiscoveryResult,
	CodexFileStat,
} from './codexDiscovery';
import { CodexPaths } from './codexPaths';

export type CodexWatchSignal = 'active-file' | 'topology';

export type CodexWatchEvent =
	| { readonly type: 'active-file-changed'; readonly filePath: string }
	| { readonly type: 'session-changed'; readonly filePath?: string };

export interface CodexWatchHandle {
	close(): void;
}

export interface CodexWatchFileSystem {
	watch(
		watchPath: string,
		listener: (eventType: string, filename?: string | Buffer | null) => void,
	): CodexWatchHandle;
	readdir(directoryPath: string): Promise<readonly CodexDirectoryEntry[]>;
	stat(filePath: string): Promise<CodexFileStat>;
}

const nodeWatchFileSystem: CodexWatchFileSystem = {
	watch: (watchPath, listener) => nodeWatch(watchPath, (eventType, filename) => listener(eventType, filename)),
	readdir: async (directoryPath) => readdir(directoryPath, { withFileTypes: true }),
	stat,
};

/** Coalesces filesystem bursts before handing them to the provider. */
export class CodexWatchCoordinator {
	private timer?: NodeJS.Timeout;
	private pendingSignal?: CodexWatchSignal;
	private disposed = false;

	constructor(
		private readonly callback: (signal: CodexWatchSignal) => void | Promise<void>,
		private readonly debounceMs = 250,
	) {}

	signal(signal: CodexWatchSignal): void {
		if (this.disposed) {
			return;
		}

		this.pendingSignal = this.pendingSignal === 'topology' || signal === 'topology'
			? 'topology'
			: 'active-file';
		if (this.timer) {
			clearTimeout(this.timer);
		}
		this.timer = setTimeout(() => {
			this.timer = undefined;
			const pendingSignal = this.pendingSignal;
			this.pendingSignal = undefined;
			if (pendingSignal && !this.disposed) {
				void Promise.resolve(this.callback(pendingSignal)).catch(() => undefined);
			}
		}, this.debounceMs);
	}

	dispose(): void {
		this.disposed = true;
		this.pendingSignal = undefined;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
	}
}

/**
 * Watches the Codex session topology and the currently active rollout file.
 * It explicitly watches each directory because recursive fs.watch is not
 * consistently supported across operating systems and filesystem providers.
 */
export class CodexWatcher {
	private readonly coordinator: CodexWatchCoordinator;
	private readonly directoryHandles = new Map<string, CodexWatchHandle>();
	private activeFileHandle?: CodexWatchHandle;
	private activeFile?: string;
	private started = false;
	private disposed = false;

	constructor(
		private readonly paths: CodexPaths,
		private readonly discovery: { discover(): Promise<CodexDiscoveryResult> },
		private readonly onEvent: (event: CodexWatchEvent) => void | Promise<void>,
		private readonly fileSystem: CodexWatchFileSystem = nodeWatchFileSystem,
		debounceMs = 250,
	) {
		this.coordinator = new CodexWatchCoordinator((signal) => this.handleSignal(signal), debounceMs);
	}

	async start(): Promise<void> {
		if (this.started || this.disposed) {
			return;
		}
		this.started = true;
		await this.refreshTargets();
	}

	getActiveFile(): string | undefined {
		return this.activeFile;
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.coordinator.dispose();
		this.activeFileHandle?.close();
		this.activeFileHandle = undefined;
		for (const handle of this.directoryHandles.values()) {
			handle.close();
		}
		this.directoryHandles.clear();
	}

	private async handleSignal(signal: CodexWatchSignal): Promise<void> {
		if (this.disposed) {
			return;
		}
		if (signal === 'active-file') {
			if (this.activeFile) {
				await this.onEvent({ type: 'active-file-changed', filePath: this.activeFile });
			}
			return;
		}

		const previousFile = this.activeFile;
		await this.refreshTargets();
		if (!this.disposed) {
			await this.onEvent({ type: 'session-changed', filePath: this.activeFile ?? previousFile });
		}
	}

	private async refreshTargets(): Promise<void> {
		let result: CodexDiscoveryResult;
		try {
			result = await this.discovery.discover();
		} catch {
			result = { detected: false };
		}

		this.setActiveFile(result.latestSessionFile);
		await this.refreshDirectoryWatches();
	}

	private setActiveFile(filePath: string | undefined): void {
		if (filePath === this.activeFile) {
			return;
		}
		this.activeFileHandle?.close();
		this.activeFileHandle = undefined;
		this.activeFile = filePath;
		if (!filePath || this.disposed) {
			return;
		}

		try {
			this.activeFileHandle = this.fileSystem.watch(filePath, (eventType) => {
				this.coordinator.signal(eventType === 'change' ? 'active-file' : 'topology');
			});
		} catch {
			// The directory watchers still cover creation/replacement of this file.
		}
	}

	private async refreshDirectoryWatches(): Promise<void> {
		for (const handle of this.directoryHandles.values()) {
			handle.close();
		}
		this.directoryHandles.clear();

		const directories = await this.findDirectoriesToWatch();
		for (const directoryPath of directories) {
			if (this.disposed) {
				return;
			}
			try {
				const handle = this.fileSystem.watch(directoryPath, (eventType, filename) => {
					const filenameText = typeof filename === 'string'
						? filename
						: Buffer.isBuffer(filename)
						? filename.toString('utf8')
						: undefined;
					const changedPath = filenameText
						? path.join(directoryPath, filenameText)
						: undefined;
					if (changedPath && changedPath === this.activeFile && eventType === 'change') {
						this.coordinator.signal('active-file');
					} else {
						this.coordinator.signal('topology');
					}
				});
				this.directoryHandles.set(directoryPath, handle);
			} catch {
				// A directory can disappear between enumeration and watch creation.
			}
		}
	}

	private async findDirectoriesToWatch(): Promise<readonly string[]> {
		const directories: string[] = [];
		const pending = [this.paths.sessionsPath];
		let foundExistingDirectory = false;

		while (pending.length > 0) {
			const directoryPath = pending.pop();
			if (!directoryPath) {
				continue;
			}

			try {
				const stats = await this.fileSystem.stat(directoryPath);
				if (!stats.isDirectory()) {
					continue;
				}
				foundExistingDirectory = true;
				directories.push(directoryPath);
				const entries = await this.fileSystem.readdir(directoryPath);
				for (const entry of entries) {
					if (!entry.isSymbolicLink() && entry.isDirectory()) {
						pending.push(path.join(directoryPath, entry.name));
					}
				}
			} catch {
				// A missing/inaccessible branch is handled by its nearest parent watch.
			}
		}

		if (foundExistingDirectory) {
			return directories;
		}

		let candidate = this.paths.sessionsPath;
		while (candidate !== path.dirname(candidate)) {
			try {
				const stats = await this.fileSystem.stat(candidate);
				if (stats.isDirectory()) {
					return [candidate];
				}
			} catch {
				// Continue toward an existing ancestor.
			}
			candidate = path.dirname(candidate);
		}
		return [candidate];
	}
}
