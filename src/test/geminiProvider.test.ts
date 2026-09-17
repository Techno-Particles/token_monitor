import * as assert from 'assert';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { GeminiDiscovery } from '../providers/gemini/geminiDiscovery';
import { GeminiPaths, resolveGeminiPaths } from '../providers/gemini/geminiPaths';
import { GeminiProvider } from '../providers/gemini/geminiProvider';
import { GeminiTokenParser } from '../providers/gemini/geminiTokenParser';
import { GeminiWatcher } from '../providers/gemini/geminiWatcher';

suite('Gemini Provider Test Suite', () => {
	let temporaryRoot: string;

	setup(async () => {
		temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'ai-usage-monitor-gemini-'));
	});

	teardown(async () => {
		await rm(temporaryRoot, { recursive: true, force: true });
	});

	test('reports Gemini absent when the documented config directory is missing', async () => {
		const paths: GeminiPaths = { configPath: path.join(temporaryRoot, 'missing'), sessionsPath: path.join(temporaryRoot, 'missing', 'tmp') };
		const result = await new GeminiDiscovery(paths).discover();
		assert.strictEqual(result.detected, false);
		assert.strictEqual(result.sessionFileCount, undefined);
	});

	test('discovers only session metadata below the documented chats tree', async () => {
		const chatsPath = path.join(temporaryRoot, 'tmp', 'project-hash', 'chats');
		const subagentChatsPath = path.join(chatsPath, 'parent-session');
		await mkdir(chatsPath, { recursive: true });
		await mkdir(subagentChatsPath, { recursive: true });
		const older = path.join(chatsPath, 'session-older.json');
		const latest = path.join(chatsPath, 'session-latest.jsonl');
		await writeFile(older, 'prompt and response content must not be parsed here\n');
		await writeFile(latest, 'prompt and response content must not be parsed here\n');
		const subagent = path.join(subagentChatsPath, 'subagent.jsonl');
		await writeFile(subagent, 'prompt and response content must not be parsed here\n');
		await writeFile(path.join(temporaryRoot, 'tmp', 'project-hash', 'shell_history'), 'not a session\n');
		await utimes(older, new Date(1000), new Date(1000));
		await utimes(subagent, new Date(1500), new Date(1500));
		await utimes(latest, new Date(2000), new Date(2000));

		const result = await new GeminiDiscovery({ configPath: temporaryRoot, sessionsPath: path.join(temporaryRoot, 'tmp') }).discover();
		assert.strictEqual(result.detected, true);
		assert.strictEqual(result.sessionFileCount, 3);
		assert.strictEqual(result.latestSessionFile?.sessionId, 'session-latest');
	});

	test('resolves only the documented home override and platform-neutral defaults', () => {
		assert.deepStrictEqual(resolveGeminiPaths({ GEMINI_CLI_HOME: '/var/tmp/gemini-data' }, '/home/test-user'), {
			configPath: '/var/tmp/gemini-data/.gemini',
			sessionsPath: '/var/tmp/gemini-data/.gemini/tmp',
		});
		assert.deepStrictEqual(resolveGeminiPaths({}, '/home/test-user'), {
			configPath: '/home/test-user/.gemini',
			sessionsPath: '/home/test-user/.gemini/tmp',
		});
	});

	test('does not infer token semantics without an installed-version schema', async () => {
		const parser = new GeminiTokenParser();
		assert.strictEqual(await parser.parseFile(path.join(temporaryRoot, 'unknown-schema.jsonl')), undefined);
	});

	test('provider detects local Gemini storage but reports usage unavailable safely', async () => {
		const paths: GeminiPaths = { configPath: temporaryRoot, sessionsPath: path.join(temporaryRoot, 'tmp') };
		const chatsPath = path.join(paths.sessionsPath, 'project-hash', 'chats');
		await mkdir(chatsPath, { recursive: true });
		await writeFile(path.join(chatsPath, 'session-test.jsonl'), 'unknown schema\n');
		const provider = new GeminiProvider(new GeminiDiscovery(paths));
		assert.strictEqual(await provider.detect(), true);
		assert.strictEqual(provider.getDiscoveryResult()?.sessionFileCount, 1);
		assert.strictEqual(await provider.getCurrentUsage(), undefined);
		provider.dispose();
	});

	test('Gemini watcher tolerates absent storage and disposes safely', () => {
		const watcher = new GeminiWatcher({ configPath: path.join(temporaryRoot, 'missing'), sessionsPath: path.join(temporaryRoot, 'missing', 'tmp') }, () => undefined);
		watcher.start();
		watcher.dispose();
		watcher.dispose();
	});
});
