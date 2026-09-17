import * as assert from 'assert';
import { appendFile, mkdir, mkdtemp, readFile, rm, truncate, unlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import * as vscode from 'vscode';

import {
	CodexDirectoryEntry,
	CodexFileStat,
} from '../providers/codex/codexDiscovery';
import { CodexIncrementalTokenParser } from '../providers/codex/codexIncrementalTokenParser';
import { CodexPaths } from '../providers/codex/codexPaths';
import { CodexProvider } from '../providers/codex/codexProvider';
import { CodexWatchEvent, CodexWatchFileSystem, CodexWatchHandle, CodexWatcher } from '../providers/codex/codexWatcher';
import { StatusBarController } from '../ui/statusBar';

function tokenLine(totalTokens: number, options: { cachedInputTokens?: number; reasoningTokens?: number } = {}): string {
	return JSON.stringify({
		type: 'event_msg',
		payload: {
			type: 'token_count',
			info: {
				total_token_usage: {
					input_tokens: totalTokens - 100,
					cached_input_tokens: options.cachedInputTokens,
					output_tokens: 100,
					reasoning_output_tokens: options.reasoningTokens,
					total_tokens: totalTokens,
				},
			},
		},
	}) + '\n';
}

class FakeWatchHandle implements CodexWatchHandle {
	closed = false;

	constructor(
		readonly watchPath: string,
		private readonly listener: (eventType: string, filename?: string | Buffer | null) => void,
	) {}

	close(): void {
		this.closed = true;
	}

	trigger(eventType: string, filename?: string): void {
		if (!this.closed) {
			this.listener(eventType, filename);
		}
	}
}

class FakeWatchFileSystem implements CodexWatchFileSystem {
	readonly directories = new Set<string>();
	readonly handles: FakeWatchHandle[] = [];
	private readonly entries = new Map<string, readonly CodexDirectoryEntry[]>();

	watch(watchPath: string, listener: (eventType: string, filename?: string | Buffer | null) => void): CodexWatchHandle {
		const handle = new FakeWatchHandle(watchPath, listener);
		this.handles.push(handle);
		return handle;
	}

	async readdir(directoryPath: string): Promise<readonly CodexDirectoryEntry[]> {
		const entries = this.entries.get(directoryPath);
		if (!entries) {
			throw new Error('ENOENT');
		}
		return entries;
	}

	async stat(filePath: string): Promise<CodexFileStat> {
		if (filePath === path.parse(filePath).root || this.directories.has(filePath)) {
			return { isDirectory: () => true, isFile: () => false, mtimeMs: 0 };
		}
		throw new Error('ENOENT');
	}

	setDirectory(directoryPath: string, entries: readonly CodexDirectoryEntry[] = []): void {
		this.directories.add(directoryPath);
		this.entries.set(directoryPath, entries);
	}

	trigger(watchPath: string, eventType: string, filename?: string): void {
		for (const handle of this.handles.filter((candidate) => candidate.watchPath === watchPath)) {
			handle.trigger(eventType, filename);
		}
	}
}

function directoryEntry(name: string): CodexDirectoryEntry {
	return {
		name,
		isDirectory: () => true,
		isFile: () => false,
		isSymbolicLink: () => false,
	};
}

function fileEntry(name: string): CodexDirectoryEntry {
	return {
		name,
		isDirectory: () => false,
		isFile: () => true,
		isSymbolicLink: () => false,
	};
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

suite('Codex Live Tracking Test Suite', () => {
	let temporaryRoot: string;

	setup(async () => {
		temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'ai-usage-monitor-live-'));
	});

	teardown(async () => {
		await rm(temporaryRoot, { recursive: true, force: true });
	});

	test('reads only appended bytes and coalesces a partial JSONL record', async () => {
		const filePath = path.join(temporaryRoot, 'rollout.jsonl');
		const first = tokenLine(1000);
		const second = tokenLine(2000, { cachedInputTokens: 1500, reasoningTokens: 25 });
		await writeFile(filePath, first);

		const parser = new CodexIncrementalTokenParser();
		const initial = await parser.initialize(filePath);
		const bytesAfterInitial = parser.getBytesRead();
		assert.strictEqual(initial?.sessionUsage.totalTokens, 1000);

		await appendFile(filePath, second.slice(0, -1));
		assert.strictEqual((await parser.readAppended(filePath))?.sessionUsage.totalTokens, 1000);
		assert.strictEqual(parser.getBytesRead(), bytesAfterInitial + Buffer.byteLength(second) - 1);

		await appendFile(filePath, '\n');
		const updated = await parser.readAppended(filePath);
		assert.strictEqual(updated?.sessionUsage.totalTokens, 2000);
		assert.strictEqual(updated?.sessionUsage.cachedInputTokens, 1500);
		assert.strictEqual(updated?.sessionUsage.reasoningTokens, 25);
	});

	test('ignores malformed complete lines without losing valid updates', async () => {
		const filePath = path.join(temporaryRoot, 'malformed.jsonl');
		await writeFile(filePath, tokenLine(1000));
		const parser = new CodexIncrementalTokenParser();
		await parser.initialize(filePath);

		await appendFile(filePath, '{not-json}\n' + tokenLine(3000));
		assert.strictEqual((await parser.readAppended(filePath))?.sessionUsage.totalTokens, 3000);
	});

	test('resets safely after truncation and after file recreation', async () => {
		const filePath = path.join(temporaryRoot, 'recover.jsonl');
		await writeFile(filePath, tokenLine(9000));
		const parser = new CodexIncrementalTokenParser();
		await parser.initialize(filePath);

		await truncate(filePath, 0);
		await appendFile(filePath, tokenLine(100));
		assert.strictEqual((await parser.readAppended(filePath))?.sessionUsage.totalTokens, 100);

		await unlink(filePath);
		assert.strictEqual((await parser.readAppended(filePath))?.sessionUsage.totalTokens, 100);
		await writeFile(filePath, tokenLine(700));
		assert.strictEqual((await parser.readAppended(filePath))?.sessionUsage.totalTokens, 700);
	});

	test('watches active appends with one debounced callback', async () => {
		const sessionsPath = path.join(temporaryRoot, 'sessions');
		const filePath = path.join(sessionsPath, '2026', '09', '17', 'rollout-a.jsonl');
		const fileSystem = new FakeWatchFileSystem();
		fileSystem.setDirectory(sessionsPath, [directoryEntry('2026')]);
		fileSystem.setDirectory(path.dirname(filePath), [fileEntry(path.basename(filePath))]);
		const discovery = { discover: async () => ({ detected: true, latestSessionFile: filePath }) };
		const events: CodexWatchEvent[] = [];
		const watcher = new CodexWatcher(
			{ homePath: temporaryRoot, sessionsPath } satisfies CodexPaths,
			discovery,
			(event) => { events.push(event); },
			fileSystem,
			10,
		);

		await watcher.start();
		fileSystem.trigger(filePath, 'change');
		fileSystem.trigger(filePath, 'change');
		fileSystem.trigger(path.dirname(filePath), 'change', path.basename(filePath));
		await delay(100);

		assert.deepStrictEqual(events, [{ type: 'active-file-changed', filePath }]);
		watcher.dispose();
	});

	test('switches to a new rollout and watches a newly created date directory', async () => {
		const sessionsPath = path.join(temporaryRoot, 'sessions');
		const oldFile = path.join(sessionsPath, '2026', '09', '16', 'rollout-old.jsonl');
		const newDatePath = path.join(sessionsPath, '2026', '09', '17');
		const newFile = path.join(newDatePath, 'rollout-new.jsonl');
		const fileSystem = new FakeWatchFileSystem();
		fileSystem.setDirectory(sessionsPath, [directoryEntry('2026')]);
		fileSystem.setDirectory(path.dirname(oldFile), [fileEntry(path.basename(oldFile))]);
		fileSystem.setDirectory(path.join(sessionsPath, '2026'), [directoryEntry('09')]);
		fileSystem.setDirectory(path.join(sessionsPath, '2026', '09'), [directoryEntry('16')]);
		let latestFile: string | undefined = oldFile;
		const discovery = { discover: async () => ({ detected: true, latestSessionFile: latestFile }) };
		const events: CodexWatchEvent[] = [];
		const watcher = new CodexWatcher(
			{ homePath: temporaryRoot, sessionsPath },
			discovery,
			(event) => { events.push(event); },
			fileSystem,
			10,
		);

		await watcher.start();
		const oldFileHandle = fileSystem.handles.find((handle) => handle.watchPath === oldFile);
		assert.ok(oldFileHandle);
		fileSystem.setDirectory(path.join(sessionsPath, '2026', '09'), [directoryEntry('16'), directoryEntry('17')]);
		fileSystem.setDirectory(newDatePath, [fileEntry(path.basename(newFile))]);
		latestFile = newFile;
		fileSystem.trigger(path.join(sessionsPath, '2026', '09'), 'rename', '17');
		await delay(100);

		assert.strictEqual(oldFileHandle.closed, true);
		assert.deepStrictEqual(events, [{ type: 'session-changed', filePath: newFile }]);
		assert.ok(fileSystem.handles.some((handle) => handle.watchPath === newDatePath && !handle.closed));
		assert.strictEqual(watcher.getActiveFile(), newFile);
		watcher.dispose();
	});

	test('survives a missing Codex directory and dispose prevents callbacks', async () => {
		const sessionsPath = path.join(temporaryRoot, 'missing', 'sessions');
		const fileSystem = new FakeWatchFileSystem();
		const events: CodexWatchEvent[] = [];
		const watcher = new CodexWatcher(
			{ homePath: path.dirname(sessionsPath), sessionsPath },
			{ discover: async () => ({ detected: false }) },
			(event) => { events.push(event); },
			fileSystem,
			10,
		);

		await assert.doesNotReject(() => watcher.start());
		watcher.dispose();
		for (const handle of fileSystem.handles) {
			handle.trigger('rename', 'sessions');
		}
		await delay(100);
		assert.deepStrictEqual(events, []);
	});

	test('keeps compaction-safe thread totals and optional fields unchanged', async () => {
		const fixturePath = path.resolve(__dirname, '../../src/test/fixtures/codex/compaction-reset.jsonl');
		const parser = new CodexIncrementalTokenParser();
		const result = await parser.initialize(fixturePath);

		assert.strictEqual(result?.sessionUsage.totalTokens, 14850);
		assert.strictEqual(result?.sessionUsage.cachedInputTokens, 8100);
		assert.strictEqual(result?.sessionUsage.reasoningTokens, 310);
	});

	test('publishes active updates and never mixes a replaced rollout into the old session', async () => {
		const sessionsPath = path.join(temporaryRoot, 'sessions');
		const datePath = path.join(sessionsPath, '2026', '09', '17');
		const firstFile = path.join(datePath, 'rollout-first.jsonl');
		const secondFile = path.join(datePath, 'rollout-second.jsonl');
		await mkdir(datePath, { recursive: true });
		await writeFile(firstFile, tokenLine(1000));
		await writeFile(secondFile, tokenLine(150));

		const fileSystem = new FakeWatchFileSystem();
		fileSystem.setDirectory(sessionsPath, [directoryEntry('2026')]);
		fileSystem.setDirectory(path.join(sessionsPath, '2026'), [directoryEntry('09')]);
		fileSystem.setDirectory(path.join(sessionsPath, '2026', '09'), [directoryEntry('17')]);
		fileSystem.setDirectory(datePath, [fileEntry(path.basename(firstFile))]);
		let latestFile = firstFile;
		const discovery = { discover: async () => ({ detected: true, latestSessionFile: latestFile }) };
		const paths = { homePath: temporaryRoot, sessionsPath } satisfies CodexPaths;
		const provider = new CodexProvider(
			discovery,
			undefined,
			paths,
			(watchPaths, watchDiscovery, onEvent) => new CodexWatcher(watchPaths, watchDiscovery, onEvent, fileSystem, 10),
		);
		const updates: Array<number | undefined> = [];

		assert.strictEqual((await provider.getCurrentUsage())?.totalTokens, 1000);
		await provider.startWatching((usage) => { updates.push(usage?.totalTokens); });
		await appendFile(firstFile, tokenLine(2000));
		fileSystem.trigger(firstFile, 'change');
		await delay(100);
		assert.deepStrictEqual(updates, [2000]);

		fileSystem.setDirectory(datePath, [fileEntry(path.basename(firstFile)), fileEntry(path.basename(secondFile))]);
		latestFile = secondFile;
		fileSystem.trigger(datePath, 'rename', path.basename(secondFile));
		await delay(100);
		assert.deepStrictEqual(updates, [2000, 150]);
		provider.dispose();
	});

	test('does not expose rollout content through the incremental state', async () => {
		const filePath = path.join(temporaryRoot, 'privacy.jsonl');
		await writeFile(filePath, tokenLine(500));
		const parser = new CodexIncrementalTokenParser();
		await parser.initialize(filePath);
		assert.strictEqual(Object.prototype.hasOwnProperty.call(parser, 'prompt'), false);
		assert.strictEqual((await readFile(filePath, 'utf8')).includes('prompt'), false);
	});

	test('updates the status bar with a live snapshot', () => {
		const controller = new StatusBarController();
		try {
			controller.setCodexUsage({
				provider: 'codex',
				timestamp: Date.now(),
				inputTokens: 18081477,
				outputTokens: 100,
				totalTokens: 18081577,
			}, true);
			const item = (controller as unknown as { item: vscode.StatusBarItem }).item;
			assert.strictEqual(item.text, '$(pulse) Codex: 18.1M');
			controller.setCodexUsage({
				provider: 'codex',
				timestamp: Date.now() + 1,
				inputTokens: 18193933,
				outputTokens: 100,
				totalTokens: 18194033,
			}, true);
			assert.strictEqual(item.text, '$(pulse) Codex: 18.2M');
			assert.match(String(item.tooltip), /live/);
		} finally {
			controller.dispose();
		}
	});
});
