import * as assert from 'assert';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { ClaudeDiscovery } from '../providers/claude/claudeDiscovery';
import { ClaudePaths, resolveClaudePaths } from '../providers/claude/claudePaths';
import { ClaudeProvider } from '../providers/claude/claudeProvider';
import { ClaudeTokenParser } from '../providers/claude/claudeTokenParser';
import { ClaudeWatcher } from '../providers/claude/claudeWatcher';

suite('Claude Provider Test Suite', () => {
	let temporaryRoot: string;

	setup(async () => {
		temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'ai-usage-monitor-claude-'));
	});

	teardown(async () => {
		await rm(temporaryRoot, { recursive: true, force: true });
	});

	test('reports Claude absent when the documented config directory is missing', async () => {
		const paths: ClaudePaths = { configPath: path.join(temporaryRoot, 'missing'), projectsPath: path.join(temporaryRoot, 'missing', 'projects') };
		const result = await new ClaudeDiscovery(paths).discover();
		assert.strictEqual(result.detected, false);
		assert.strictEqual(result.sessionFileCount, undefined);
	});

	test('detects nested project transcript metadata without opening contents', async () => {
		const projectsPath = path.join(temporaryRoot, 'projects');
		const projectPath = path.join(projectsPath, 'project-slug');
		await mkdir(projectPath, { recursive: true });
		const older = path.join(projectPath, 'older.jsonl');
		const latest = path.join(projectPath, 'latest.jsonl');
		await writeFile(older, 'not parsed\n');
		await writeFile(latest, 'not parsed\n');
		await utimes(older, new Date(1000), new Date(1000));
		await utimes(latest, new Date(2000), new Date(2000));

		const result = await new ClaudeDiscovery({ configPath: temporaryRoot, projectsPath }).discover();
		assert.strictEqual(result.detected, true);
		assert.strictEqual(result.sessionFileCount, 2);
		assert.strictEqual(result.latestSessionFile?.sessionId, 'latest');
	});

	test('resolves only documented config override and platform-neutral defaults', () => {
		assert.deepStrictEqual(resolveClaudePaths({ CLAUDE_CONFIG_DIR: '/var/tmp/claude-data' }, '/home/test-user'), {
			configPath: '/var/tmp/claude-data',
			projectsPath: '/var/tmp/claude-data/projects',
		});
		assert.deepStrictEqual(resolveClaudePaths({}, '/home/test-user'), {
			configPath: '/home/test-user/.claude',
			projectsPath: '/home/test-user/.claude/projects',
		});
	});

	test('does not invent a parser for undocumented transcript entries', async () => {
		const parser = new ClaudeTokenParser();
		assert.strictEqual(await parser.parseFile(path.join(temporaryRoot, 'unknown-schema.jsonl')), undefined);
	});

	test('provider detects local Claude storage but reports usage unavailable safely', async () => {
		const paths: ClaudePaths = { configPath: temporaryRoot, projectsPath: path.join(temporaryRoot, 'projects') };
		await mkdir(paths.projectsPath, { recursive: true });
		await writeFile(path.join(paths.projectsPath, 'session.jsonl'), '');
		const provider = new ClaudeProvider(new ClaudeDiscovery(paths));
		assert.strictEqual(await provider.detect(), true);
		assert.strictEqual(provider.getDiscoveryResult()?.sessionFileCount, 1);
		assert.strictEqual(await provider.getCurrentUsage(), undefined);
		provider.dispose();
	});

	test('Claude watcher tolerates missing projects and disposes safely', () => {
		const watcher = new ClaudeWatcher({ configPath: temporaryRoot, projectsPath: path.join(temporaryRoot, 'missing-projects') }, () => undefined);
		watcher.start();
		watcher.dispose();
		watcher.dispose();
	});
});
