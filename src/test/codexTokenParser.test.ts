import * as assert from 'assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { CodexTokenParser } from '../providers/codex/codexTokenParser';

suite('Codex Token Parser Test Suite', () => {
	let temporaryRoot: string;
	const parser = new CodexTokenParser();

	setup(async () => {
		temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'ai-usage-monitor-parser-'));
	});

	teardown(async () => {
		await rm(temporaryRoot, { recursive: true, force: true });
	});

	test('parses cumulative snapshots without double counting', async () => {
		const fixturePath = path.resolve(__dirname, '../../src/test/fixtures/codex/cumulative-token-events.jsonl');
		const result = await parser.parseFile(fixturePath);

		assert.ok(result);
		assert.strictEqual(result.tokenEventCount, 3);
		assert.strictEqual(result.sessionUsage.inputTokens, 25000);
		assert.strictEqual(result.sessionUsage.cachedInputTokens, 18000);
		assert.strictEqual(result.sessionUsage.outputTokens, 1200);
		assert.strictEqual(result.sessionUsage.reasoningTokens, 300);
		assert.strictEqual(result.sessionUsage.totalTokens, 26200);
		assert.strictEqual(result.lastTurnUsage?.totalTokens, 7400);
		assert.strictEqual(result.modelContextWindow, 258400);
		assert.strictEqual(result.rateLimits, undefined);
	});

	test('uses thread usage across a compaction reset', async () => {
		const fixturePath = path.resolve(__dirname, '../../src/test/fixtures/codex/compaction-reset.jsonl');
		const result = await parser.parseFile(fixturePath);

		assert.ok(result);
		assert.strictEqual(result.sessionUsage.totalTokens, 14850);
		assert.strictEqual(result.lastTurnUsage?.totalTokens, 350);
	});

	test('ignores malformed middle and partial final lines', async () => {
		const fixturePath = path.resolve(__dirname, '../../src/test/fixtures/codex/malformed-token-events.jsonl');
		const result = await parser.parseFile(fixturePath);

		assert.ok(result);
		assert.strictEqual(result.tokenEventCount, 2);
		assert.strictEqual(result.sessionUsage.totalTokens, 580);
	});

	test('keeps cached input as a reported subset and does not add it twice', async () => {
		const filePath = path.join(temporaryRoot, 'cached.jsonl');
		await writeFile(filePath, JSON.stringify({
			type: 'event_msg',
			payload: {
				type: 'token_count',
				info: {
					total_token_usage: {
					input_tokens: 1000,
					cached_input_tokens: 800,
					output_tokens: 200,
					reasoning_output_tokens: 50,
					total_tokens: 1200,
				},
				},
			},
		}));

		const result = await parser.parseFile(filePath);

		assert.ok(result);
		assert.strictEqual(result.sessionUsage.totalTokens, 1200);
		assert.strictEqual(result.sessionUsage.totalTokens, result.sessionUsage.inputTokens + result.sessionUsage.outputTokens);
	});

	test('supports missing optional fields, model metadata, and populated rate limits', async () => {
		const filePath = path.join(temporaryRoot, 'schema-variation.jsonl');
		await writeFile(filePath, [
			JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-test' } }),
			JSON.stringify({
				type: 'event_msg',
				payload: {
					type: 'token_count',
					info: {
						total_token_usage: {
						input_tokens: 2000000,
						output_tokens: 1000000,
						total_tokens: 3000000,
					},
					},
					rate_limits: {
					primary: { used_percent: 24, window_minutes: 300, resets_at: 1789637595 },
					secondary: { used_percent: 49, window_minutes: 10080, resets_at: 1789805381 },
				},
				},
			}),
		].join('\n'));

		const result = await parser.parseFile(filePath);

		assert.ok(result);
		assert.strictEqual(result.model, 'gpt-test');
		assert.strictEqual(result.sessionUsage.cachedInputTokens, undefined);
		assert.strictEqual(result.sessionUsage.reasoningTokens, undefined);
		assert.strictEqual(result.modelContextWindow, undefined);
		assert.deepStrictEqual(result.rateLimits, {
			windows: [
				{
					key: 'primary',
					label: '5-hour limit',
					compactLabel: '5h',
					usedPercent: 24,
					remainingPercent: 76,
					windowMinutes: 300,
					resetsAt: 1789637595000,
				},
				{
					key: 'secondary',
					label: 'Weekly limit',
					compactLabel: 'W',
					usedPercent: 49,
					remainingPercent: 51,
					windowMinutes: 10080,
					resetsAt: 1789805381000,
				},
			],
		});
	});

	test('returns undefined when no token events exist', async () => {
		const filePath = path.join(temporaryRoot, 'no-token-events.jsonl');
		await writeFile(filePath, '{"type":"response_item","payload":{"type":"message"}}\n\n');

		assert.strictEqual(await parser.parseFile(filePath), undefined);
	});

	test('ignores unrelated event content', async () => {
		const filePath = path.join(temporaryRoot, 'unrelated.jsonl');
		await writeFile(filePath, JSON.stringify({
			type: 'response_item',
			payload: { type: 'message', content: 'not interpreted' },
		}));

		assert.strictEqual(await parser.parseFile(filePath), undefined);
	});
});
