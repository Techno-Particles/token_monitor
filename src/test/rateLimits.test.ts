import * as assert from 'assert';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import * as vscode from 'vscode';

import { CodexTokenParser } from '../providers/codex/codexTokenParser';
import { CodexIncrementalTokenParser } from '../providers/codex/codexIncrementalTokenParser';
import { RateLimitSnapshot, UsageSnapshot } from '../core/types';
import { StatusBarController } from '../ui/statusBar';
import { formatRateLimitDetails, formatResetCountdown } from '../ui/rateLimits';

function tokenLine(rateLimits: unknown, includeRateLimits = true, timestamp?: string): string {
	const payload: Record<string, unknown> = {
		type: 'token_count',
		info: {
			total_token_usage: { input_tokens: 900, output_tokens: 100, total_tokens: 1000 },
		},
	};
	if (includeRateLimits) {
		payload.rate_limits = rateLimits;
	}
	return JSON.stringify({ type: 'event_msg', ...(timestamp ? { timestamp } : {}), payload }) + '\n';
}

async function parseLines(root: string, lines: readonly string[]): Promise<Awaited<ReturnType<CodexTokenParser['parseFile']>>> {
	const filePath = path.join(root, 'rollout.jsonl');
	await writeFile(filePath, lines.join(''));
	return new CodexTokenParser().parseFile(filePath);
}

function primary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { used_percent: 32, window_minutes: 300, resets_at: 1_800_000_000, ...overrides };
}

function usageWithLimits(rateLimits?: RateLimitSnapshot): UsageSnapshot {
	return {
		provider: 'codex',
		timestamp: 1_700_000_000_000,
		inputTokens: 900,
		outputTokens: 100,
		totalTokens: 1000,
		rateLimits,
	};
}

suite('Rate Limit Test Suite', () => {
	let temporaryRoot: string;

	setup(async () => {
		temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'ai-usage-monitor-rate-limits-'));
	});

	teardown(async () => {
		await rm(temporaryRoot, { recursive: true, force: true });
	});

	test('parses primary and secondary windows with verified Codex units', async () => {
		const result = await parseLines(temporaryRoot, [tokenLine({
			primary: primary(),
			secondary: { used_percent: 18, window_minutes: 10080, resets_at: 1_800_001_000 },
			plan_type: 'plus',
			credits: { has_credits: false, unlimited: false, balance: '0' },
		}, true, '2026-09-17T08:00:00.000Z')]);

		assert.ok(result?.rateLimits);
		assert.strictEqual(result.rateLimits.observedAt, Date.parse('2026-09-17T08:00:00.000Z'));
		assert.deepStrictEqual(result.rateLimits.windows, [
			{
				key: 'primary', label: '5-hour limit', compactLabel: '5h', usedPercent: 32,
				remainingPercent: 68, windowMinutes: 300, resetsAt: 1_800_000_000_000,
			},
			{
				key: 'secondary', label: 'Weekly limit', compactLabel: 'W', usedPercent: 18,
				remainingPercent: 82, windowMinutes: 10080, resetsAt: 1_800_001_000_000,
			},
		]);
		assert.strictEqual(result.rateLimits.planType, 'plus');
		assert.deepStrictEqual(result.rateLimits.credits, { hasCredits: false, unlimited: false, balance: '0' });
	});

	test('handles null, missing, and one-window rate-limit data', async () => {
		assert.strictEqual((await parseLines(temporaryRoot, [tokenLine(null)]))?.rateLimits, undefined);
		assert.strictEqual((await parseLines(temporaryRoot, [tokenLine(undefined, false)]))?.rateLimits, undefined);
		const onlyPrimary = await parseLines(temporaryRoot, [tokenLine({ primary: primary() })]);
		assert.strictEqual(onlyPrimary?.rateLimits?.windows.length, 1);
		assert.strictEqual(onlyPrimary?.rateLimits?.windows[0].key, 'primary');
		const onlySecondary = await parseLines(temporaryRoot, [tokenLine({ secondary: { used_percent: 18, window_minutes: 10080 } })]);
		assert.strictEqual(onlySecondary?.rateLimits?.windows[0].key, 'secondary');
	});

	test('rejects invalid percentages without inventing fallback values', async () => {
		const result = await parseLines(temporaryRoot, [tokenLine({
			primary: primary({ used_percent: -1 }),
			secondary: primary({ used_percent: 101 }),
		})]);
		assert.deepStrictEqual(result?.rateLimits?.windows, [
			{
				key: 'primary', label: '5-hour limit', compactLabel: '5h',
				windowMinutes: 300, resetsAt: 1_800_000_000_000,
			},
			{
				key: 'secondary', label: '5-hour limit', compactLabel: '5h',
				windowMinutes: 300, resetsAt: 1_800_000_000_000,
			},
		]);
		const nonNumber = await parseLines(temporaryRoot, [tokenLine({ primary: { used_percent: 'NaN' } })]);
		assert.strictEqual(nonNumber?.rateLimits, undefined);
		const invalidReset = await parseLines(temporaryRoot, [tokenLine({ primary: primary({ resets_at: 'not-a-timestamp' }) })]);
		assert.strictEqual(invalidReset?.rateLimits?.windows[0].resetsAt, undefined);
	});

	test('normalizes seconds, retains past resets, and handles missing resets', async () => {
		const result = await parseLines(temporaryRoot, [tokenLine({
			primary: primary({ resets_at: 1_700_000_000 }),
			secondary: { used_percent: 10, window_minutes: 10080 },
		})]);
		assert.strictEqual(result?.rateLimits?.windows[0].resetsAt, 1_700_000_000_000);
		assert.strictEqual(result?.rateLimits?.windows[1].resetsAt, undefined);
		const unknownDuration = await parseLines(temporaryRoot, [tokenLine({ primary: { used_percent: 32, window_minutes: 17 } })]);
		assert.deepStrictEqual(unknownDuration?.rateLimits?.windows[0], {
			key: 'primary', label: 'Primary limit', compactLabel: 'Primary', usedPercent: 32, remainingPercent: 68, windowMinutes: 17,
		});
	});

	test('latest valid observation wins and explicit null clears it', async () => {
		const latest = await parseLines(temporaryRoot, [
			tokenLine({ primary: primary({ used_percent: 20 }) }),
			tokenLine({ primary: primary({ used_percent: 40 }) }),
		]);
		assert.strictEqual(latest?.rateLimits?.windows[0].usedPercent, 40);

		const missingAfterValid = await parseLines(temporaryRoot, [
			tokenLine({ primary: primary({ used_percent: 20 }) }),
			tokenLine(undefined, false),
		]);
		assert.strictEqual(missingAfterValid?.rateLimits?.windows[0].usedPercent, 20);

		const nullAfterValid = await parseLines(temporaryRoot, [
			tokenLine({ primary: primary({ used_percent: 20 }) }),
			tokenLine(null),
		]);
		assert.strictEqual(nullAfterValid?.rateLimits, undefined);
	});

	test('incremental append updates the current rate-limit observation', async () => {
		const filePath = path.join(temporaryRoot, 'incremental-rollout.jsonl');
		await writeFile(filePath, tokenLine({ primary: primary({ used_percent: 20 }) }));
		const parser = new CodexIncrementalTokenParser();
		assert.strictEqual((await parser.initialize(filePath))?.rateLimits?.windows[0].usedPercent, 20);
		await appendFile(filePath, tokenLine({ primary: primary({ used_percent: 45 }) }));
		assert.strictEqual((await parser.readAppended(filePath))?.rateLimits?.windows[0].usedPercent, 45);
	});

	test('formats minute, hour, day, and expired countdowns', () => {
		const now = 1_700_000_000_000;
		assert.strictEqual(formatResetCountdown(now + 5 * 60_000, now), '5m');
		assert.strictEqual(formatResetCountdown(now + (2 * 60 + 14) * 60_000, now), '2h 14m');
		assert.strictEqual(formatResetCountdown(now + (4 * 1440 + 7 * 60) * 60_000, now), '4d 7h');
		assert.strictEqual(formatResetCountdown(now - 1, now), 'now');
	});

	test('renders both, one, and unavailable limits consistently in the status bar', () => {
		const now = 1_700_000_000_000;
		const fourDaysSevenHours = now + (4 * 1440 + 7 * 60) * 60_000;
		const both: RateLimitSnapshot = {
			observedAt: now,
			windows: [
				{ key: 'primary', label: '5-hour limit', compactLabel: '5h', usedPercent: 32, remainingPercent: 68, resetsAt: fourDaysSevenHours },
				{ key: 'secondary', label: 'Weekly limit', compactLabel: 'W', usedPercent: 18, remainingPercent: 82, resetsAt: fourDaysSevenHours },
			],
		};
		const controller = new StatusBarController(() => now, () => ({}) as ReturnType<typeof setInterval>, () => {});
		try {
			const item = (controller as unknown as { item: vscode.StatusBarItem }).item;
			controller.setCodexUsage(usageWithLimits(both), true);
			assert.strictEqual(item.text, '$(pulse) Codex 1K │ 5h 32% │ W 18%');
			assert.match(String(item.tooltip), /68% remaining/);
			assert.match(String(item.tooltip), /Resets in 4d 7h/);

			controller.setCodexUsage(usageWithLimits({ ...both, windows: [both.windows[0]] }), true);
			assert.strictEqual(item.text, '$(pulse) Codex 1K │ 5h 32%');
			controller.setCodexUsage(usageWithLimits(undefined), true);
			assert.strictEqual(item.text, '$(pulse) Codex: 1K');
		} finally {
			controller.dispose();
		}
	});

	test('refreshes countdown from memory and disposes its timer', () => {
		let now = 1_700_000_000_000;
		let refresh: (() => void) | undefined;
		let cancelled = 0;
		const controller = new StatusBarController(
			() => now,
			(callback) => { refresh = callback; return {} as ReturnType<typeof setInterval>; },
			() => { cancelled++; },
		);
		try {
			const item = (controller as unknown as { item: vscode.StatusBarItem }).item;
			controller.setCodexUsage(usageWithLimits({
				windows: [{ key: 'primary', label: '5-hour limit', compactLabel: '5h', usedPercent: 32, remainingPercent: 68, resetsAt: now + 5 * 60_000 }],
			}), true);
			assert.ok(refresh);
			now += 4 * 60_000;
			refresh?.();
			assert.match(String(item.tooltip), /Resets in 1m/);
		} finally {
			controller.dispose();
		}
		assert.strictEqual(cancelled, 1);
	});

	test('shares detailed rendering for the native usage command', () => {
		const rateLimits: RateLimitSnapshot = {
			windows: [{ key: 'primary', label: 'Primary limit', compactLabel: 'Primary', usedPercent: 32, remainingPercent: 68 }],
		};
		assert.deepStrictEqual(formatRateLimitDetails(rateLimits), ['Primary limit', '32% used', '68% remaining']);
		assert.deepStrictEqual(formatRateLimitDetails(undefined), ['Quota data unavailable']);
	});
});
