import * as assert from 'assert';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
	CodexDiscovery,
	CodexFileSystem,
	CodexDiscoveryResult,
} from '../providers/codex/codexDiscovery';
import { CodexProvider } from '../providers/codex/codexProvider';
import { resolveCodexPaths } from '../providers/codex/codexPaths';

suite('Codex Discovery Test Suite', () => {
	let temporaryRoot: string;

	setup(async () => {
		temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'ai-usage-monitor-codex-'));
	});

	teardown(async () => {
		await rm(temporaryRoot, { recursive: true, force: true });
	});

	function createDiscovery(homePath = temporaryRoot): CodexDiscovery {
		return new CodexDiscovery({
			homePath,
			sessionsPath: path.join(homePath, 'sessions'),
		});
	}

	test('reports a missing Codex home', async () => {
		const result = await createDiscovery(path.join(temporaryRoot, 'missing')).discover();

		assert.strictEqual(result.detected, false);
		assert.strictEqual(result.sessionFileCount, undefined);
	});

	test('detects a home without a sessions directory', async () => {
		const result = await createDiscovery().discover();

		assert.strictEqual(result.detected, true);
		assert.strictEqual(result.sessionFileCount, 0);
	});

	test('detects an empty sessions directory', async () => {
		await mkdir(path.join(temporaryRoot, 'sessions'));

		const result = await createDiscovery().discover();

		assert.strictEqual(result.detected, true);
		assert.strictEqual(result.sessionFileCount, 0);
		assert.strictEqual(result.latestSessionFile, undefined);
	});

	test('finds nested rollout files and ignores irrelevant files', async () => {
		const nestedSessions = path.join(temporaryRoot, 'sessions', '2026', '09', '17');
		await mkdir(nestedSessions, { recursive: true });
		await writeFile(path.join(nestedSessions, 'rollout-first.jsonl'), '');
		await writeFile(path.join(nestedSessions, 'rollout-second.jsonl'), '');
		await writeFile(path.join(nestedSessions, 'notes.jsonl'), '');
		await writeFile(path.join(nestedSessions, 'rollout-third.txt'), '');

		const result = await createDiscovery().discover();

		assert.strictEqual(result.sessionFileCount, 2);
	});

	test('selects the latest rollout by modification time', async () => {
		const sessionsPath = path.join(temporaryRoot, 'sessions');
		await mkdir(sessionsPath);
		const olderFile = path.join(sessionsPath, 'rollout-older.jsonl');
		const latestFile = path.join(sessionsPath, 'rollout-latest.jsonl');
		await writeFile(olderFile, '');
		await writeFile(latestFile, '');
		await utimes(olderFile, new Date(1000), new Date(1000));
		await utimes(latestFile, new Date(2000), new Date(2000));

		const result = await createDiscovery().discover();

		assert.strictEqual(result.latestSessionFile, latestFile);
		assert.strictEqual(result.latestSessionModifiedAt, 2000);
	});

	test('handles inaccessible sessions safely', async () => {
		const paths = {
			homePath: '/test/.codex',
			sessionsPath: '/test/.codex/sessions',
		};
		const inaccessibleFileSystem: CodexFileSystem = {
			stat: async (filePath) => {
				if (filePath === paths.homePath) {
					return { isDirectory: () => true, isFile: () => false, mtimeMs: 0 };
				}

				const error = new Error('permission denied') as Error & { code: string };
				error.code = 'EACCES';
				throw error;
			},
			readdir: async () => [],
		};

		const result = await new CodexDiscovery(paths, inaccessibleFileSystem).discover();

		assert.strictEqual(result.detected, true);
		assert.match(result.reason ?? '', /not accessible/);
	});

	test('resolves the documented custom Codex home', () => {
		const result = resolveCodexPaths({
			homedir: () => '/home/test-user',
			environment: { CODEX_HOME: '/var/tmp/test-codex' },
		});

		assert.strictEqual(result.homePath, '/var/tmp/test-codex');
		assert.strictEqual(result.sessionsPath, '/var/tmp/test-codex/sessions');
	});

	test('CodexProvider exposes discovery without reading usage data', async () => {
		const discoveryResult: CodexDiscoveryResult = {
			detected: true,
			sessionFileCount: 3,
		};
		const provider = new CodexProvider({
			discover: async () => discoveryResult,
		});

		assert.strictEqual(await provider.detect(), true);
		assert.strictEqual(provider.getDiscoveryResult(), discoveryResult);
		assert.strictEqual(await provider.getCurrentUsage(), undefined);
	});

	test('CodexProvider normalizes the latest parsed session usage', async () => {
		const latestSessionFile = path.resolve(__dirname, '../../src/test/fixtures/codex/cumulative-token-events.jsonl');
		const provider = new CodexProvider({
			discover: async () => ({
				detected: true,
				sessionFileCount: 3,
				latestSessionFile,
				latestSessionModifiedAt: 1234,
			}),
		});

		const usage = await provider.getCurrentUsage();

		assert.ok(usage);
		assert.strictEqual(usage.inputTokens, 25000);
		assert.strictEqual(usage.cachedInputTokens, 18000);
		assert.strictEqual(usage.outputTokens, 1200);
		assert.strictEqual(usage.reasoningTokens, 300);
		assert.strictEqual(usage.totalTokens, 26200);
		assert.strictEqual(usage.contextWindow, 258400);
		assert.strictEqual(usage.contextUsedTokens, undefined);
	});
});
