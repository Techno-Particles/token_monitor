import * as assert from 'assert';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { UsageSnapshot } from '../core/types';
import { CodexBackfill } from '../history/codexBackfill';
import { HistoryFilter } from '../history/historyTypes';
import { SessionLedger } from '../history/sessionLedger';
import { localDateKey } from '../history/time';
import { UsageStorage, HISTORY_STORAGE_KEY } from '../storage/usageStorage';
import { CodexSessionFileMetadata } from '../providers/codex/codexDiscovery';
import { CodexTokenParser } from '../providers/codex/codexTokenParser';

class MemoryState {
	private readonly values = new Map<string, unknown>();

	constructor(initial?: unknown) {
		if (initial !== undefined) {
			this.values.set(HISTORY_STORAGE_KEY, initial);
		}
	}

	get<T>(key: string): T | undefined {
		return this.values.get(key) as T | undefined;
	}

	async update(key: string, value: unknown): Promise<void> {
		if (value === undefined) {
			this.values.delete(key);
		} else {
			this.values.set(key, value);
		}
	}

	value(): unknown {
		return this.values.get(HISTORY_STORAGE_KEY);
	}
}

function createLedger(state = new MemoryState()): { ledger: SessionLedger; state: MemoryState } {
	return { ledger: new SessionLedger(new UsageStorage(state as never), 0), state };
}

function timestamp(dayOffset = 0, hour = 12, minute = 0): number {
	return new Date(2026, 8, 17 + dayOffset, hour, minute).getTime();
}

function snapshot(
	provider: 'codex' | 'claude' | 'gemini',
	sessionId: string,
	totalTokens: number,
	time = timestamp(),
	options: { model?: string; workspaceId?: string; workspaceName?: string; cachedInputTokens?: number; reasoningTokens?: number } = {},
): UsageSnapshot {
	return {
		provider,
		sessionId,
		timestamp: time,
		model: options.model,
		workspaceId: options.workspaceId,
		workspaceName: options.workspaceName,
		inputTokens: totalTokens - 100,
		cachedInputTokens: options.cachedInputTokens,
		outputTokens: 100,
		reasoningTokens: options.reasoningTokens,
		totalTokens,
	};
}

function usageJson(timestampValue: number, totalTokens: number): string {
	return JSON.stringify({
		type: 'token_usage_record',
		timestamp: new Date(timestampValue).toISOString(),
		payload: {
			thread_token_usage: {
				input_tokens: totalTokens - 100,
				output_tokens: 100,
				total_tokens: totalTokens,
			},
		},
	}) + '\n';
}

function sessionJson(start: number, points: readonly { time: number; total: number }[], cwd: string): string {
	return [
		JSON.stringify({
			type: 'session_meta',
			timestamp: new Date(start).toISOString(),
			payload: {
				timestamp: new Date(start).toISOString(),
				session_id: 'provider-session-id-not-persisted',
				cwd,
			},
		}),
		...points.map((point) => usageJson(point.time, point.total).trimEnd()),
	].join('\n') + '\n';
}

function assertWindowInvariants(ledger: SessionLedger, now: number, filter: HistoryFilter = {}): void {
	const today = ledger.queryToday(now, filter).totalTokens;
	const last7Days = ledger.queryLast7Days(now, filter).totalTokens;
	const last30Days = ledger.queryLast30Days(now, filter).totalTokens;
	const allTime = ledger.queryAllTime(filter).totalTokens;
	assert.ok(allTime >= last30Days, `All Time ${allTime} must be >= Last 30 Days ${last30Days}`);
	assert.ok(last30Days >= last7Days, `Last 30 Days ${last30Days} must be >= Last 7 Days ${last7Days}`);
	assert.ok(last7Days >= today, `Last 7 Days ${last7Days} must be >= Today ${today}`);
}

class OneFailureParser extends CodexTokenParser {
	constructor(private failingPath: string | undefined) {
		super();
	}

	override async parseFileWithHistory(filePath: string) {
		if (filePath === this.failingPath) {
			this.failingPath = undefined;
			throw new Error('temporary parse failure');
		}
		return super.parseFileWithHistory(filePath);
	}
}

suite('Session Ledger Test Suite', () => {
	test('inserts and upserts one cumulative session record', async () => {
		const { ledger } = createLedger();
		ledger.recordSnapshot(snapshot('codex', 'session-a', 10_000, timestamp(0)));
		ledger.recordSnapshot(snapshot('codex', 'session-a', 18_000, timestamp(0, 13)));
		ledger.recordSnapshot(snapshot('codex', 'session-a', 25_000, timestamp(0, 14)));
		await ledger.flush();

		assert.strictEqual(ledger.getSessions().length, 1);
		assert.strictEqual(ledger.getSession('codex', 'session-a')?.totalTokens, 25_000);
		assert.strictEqual(ledger.queryAllTime().totalTokens, 25_000);
	});

	test('restart recovery adds only the post-checkpoint delta', async () => {
		const state = new MemoryState();
		const first = createLedger(state).ledger;
		first.recordSnapshot(snapshot('codex', 'restart', 100_000));
		await first.flush();

		const restarted = createLedger(state).ledger;
		restarted.recordSnapshot(snapshot('codex', 'restart', 120_000));
		await restarted.flush();
		assert.strictEqual(restarted.queryAllTime().totalTokens, 120_000);
		assert.strictEqual(restarted.getSession('codex', 'restart')?.checkpoint.totalTokens, 120_000);
	});

	test('duplicate and smaller stale snapshots do not change history', async () => {
		const { ledger } = createLedger();
		ledger.recordSnapshot(snapshot('codex', 'stable', 10_000));
		ledger.recordSnapshot(snapshot('codex', 'stable', 10_000));
		ledger.recordSnapshot(snapshot('codex', 'stable', 8_000));
		assert.strictEqual(ledger.queryAllTime().totalTokens, 10_000);
		assert.strictEqual(ledger.getSession('codex', 'stable')?.totalTokens, 10_000);
	});

	test('cached input and reasoning remain informational subsets', () => {
		const { ledger } = createLedger();
		ledger.recordSnapshot(snapshot('codex', 'subsets', 1_200, timestamp(), { cachedInputTokens: 800, reasoningTokens: 50 }));
		const result = ledger.queryAllTime();
		assert.strictEqual(result.totalTokens, 1_200);
		assert.strictEqual(result.inputTokens, 1_100);
		assert.strictEqual(result.cachedInputTokens, 800);
		assert.strictEqual(result.outputTokens, 100);
		assert.strictEqual(result.reasoningTokens, 50);
	});

	test('rate limits never enter historical token totals', () => {
		const { ledger } = createLedger();
		ledger.recordSnapshot({
			...snapshot('codex', 'quota-is-current-state', 1_200),
			rateLimits: {
				windows: [{ key: 'primary', label: '5-hour limit', compactLabel: '5h', usedPercent: 80 }],
			},
		});
		assert.strictEqual(ledger.queryAllTime().totalTokens, 1_200);
		assert.strictEqual(JSON.stringify(ledger.getSessions()).includes('usedPercent'), false);
	});

	test('different sessions and providers aggregate independently', () => {
		const { ledger } = createLedger();
		ledger.recordSnapshot(snapshot('codex', 'codex-session', 1_000));
		ledger.recordSnapshot(snapshot('claude', 'claude-session', 2_000));
		ledger.recordSnapshot(snapshot('codex', 'other-session', 3_000));
		const result = ledger.queryAllTime();
		assert.strictEqual(result.sessionCount, 3);
		assert.strictEqual(result.totalTokens, 6_000);
		assert.strictEqual(result.byProvider.codex.totalTokens, 4_000);
		assert.strictEqual(result.byProvider.claude.totalTokens, 2_000);
	});

	test('today, seven-day, thirty-day, and all-time windows use local calendar days', () => {
		const { ledger } = createLedger();
		const now = timestamp();
		ledger.recordSnapshot(snapshot('codex', 'today', 1_000, timestamp(0)));
		ledger.recordSnapshot(snapshot('codex', 'six-days', 2_000, timestamp(-6)));
		ledger.recordSnapshot(snapshot('codex', 'seven-days', 4_000, timestamp(-7)));
		ledger.recordSnapshot(snapshot('codex', 'twenty-nine-days', 8_000, timestamp(-29)));
		ledger.recordSnapshot(snapshot('codex', 'thirty-days', 16_000, timestamp(-30)));
		assert.strictEqual(ledger.queryToday(now).totalTokens, 1_000);
		assert.strictEqual(ledger.queryLast7Days(now).totalTokens, 3_000);
		assert.strictEqual(ledger.queryLast30Days(now).totalTokens, 15_000);
		assert.strictEqual(ledger.queryAllTime().totalTokens, 31_000);
		assert.strictEqual(localDateKey(timestamp()), '2026-09-17');
	});

	test('session deltas cross local midnight into the new day', () => {
		const { ledger } = createLedger();
		const beforeMidnight = timestamp(0, 23, 55);
		const afterMidnight = timestamp(1, 0, 5);
		ledger.recordSnapshot(snapshot('codex', 'overnight', 10_000, beforeMidnight));
		ledger.recordSnapshot(snapshot('codex', 'overnight', 14_000, afterMidnight));
		assert.strictEqual(ledger.queryToday(afterMidnight).totalTokens, 4_000);
		assert.strictEqual(ledger.queryAllTime().totalTokens, 14_000);
	});

	test('supports model, provider, workspace, and unknown-workspace filters', () => {
		const { ledger } = createLedger();
		ledger.recordSnapshot(snapshot('codex', 'model-a', 1_000, timestamp(), { model: 'gpt-a', workspaceId: 'opaque-a', workspaceName: 'project-a' }));
		ledger.recordSnapshot(snapshot('codex', 'model-b', 2_000, timestamp(), { model: 'gpt-b', workspaceId: 'opaque-b', workspaceName: 'project-b' }));
		ledger.recordSnapshot(snapshot('claude', 'unknown', 4_000, timestamp(), { model: 'claude-x' }));
		assert.strictEqual(ledger.queryAllTime({ model: 'gpt-a' }).totalTokens, 1_000);
		assert.strictEqual(ledger.queryAllTime({ provider: 'codex' }).totalTokens, 3_000);
		assert.strictEqual(ledger.queryAllTime({ workspaceId: 'opaque-b' }).totalTokens, 2_000);
		assert.strictEqual(ledger.queryAllTime({ workspaceId: 'unknown' }).totalTokens, 4_000);
	});

	test('corrupt and future-version storage safely start empty', () => {
		for (const value of [null, { version: 0 }, { version: 999, sessions: [] }, { version: 1, sessions: [{ invalid: true }] }]) {
			const { ledger } = createLedger(new MemoryState(value));
			assert.strictEqual(ledger.getSessions().length, 0);
		}
	});

	test('migrates version one sessions to lifetime-aware version two storage', async () => {
		const counters = { inputTokens: 900, outputTokens: 100, totalTokens: 1_000 };
		const state = new MemoryState({
			version: 1,
			sessions: [{ provider: 'codex', sessionId: 'legacy', startedAt: timestamp(), lastUpdatedAt: timestamp(), model: 'legacy-model', ...counters, checkpoint: counters, dailyUsage: { [localDateKey(timestamp())]: counters } }],
			backfill: {},
		});
		const ledger = new SessionLedger(new UsageStorage(state as never), 0);
		assert.strictEqual(ledger.getSession('codex', 'legacy')?.lifetimeUsage.totalTokens, 1_000);
		await ledger.flush();
		assert.strictEqual((state.value() as { version: number }).version, 2);
	});

	test('v1 migration reconstructs lifetime usage from all historical daily buckets', async () => {
		const latest = { inputTokens: 45, outputTokens: 5, totalTokens: 50 };
		const older = { inputTokens: 90, outputTokens: 10, totalTokens: 100 };
		const recent = { inputTokens: 135, outputTokens: 15, totalTokens: 150 };
		const now = timestamp();
		const state = new MemoryState({
			version: 1,
			sessions: [{
				provider: 'codex', sessionId: 'legacy-large-history', startedAt: timestamp(-40), lastUpdatedAt: now,
				model: 'legacy-model', ...latest, checkpoint: latest,
				dailyUsage: { [localDateKey(timestamp(-40))]: older, [localDateKey(timestamp(-10))]: recent },
			}],
			backfill: {},
		});
		const ledger = new SessionLedger(new UsageStorage(state as never), 0);

		assert.strictEqual(ledger.getSession('codex', 'legacy-large-history')?.lifetimeUsage.totalTokens, 250);
		assert.strictEqual(ledger.queryAllTime().totalTokens, 250);
		assert.strictEqual(ledger.queryLast30Days(now).totalTokens, 150);
		assertWindowInvariants(ledger, now);
		await ledger.flush();

		const restarted = new SessionLedger(new UsageStorage(state as never), 0);
		assert.strictEqual(restarted.queryAllTime().totalTokens, 250);
		assertWindowInvariants(restarted, now);
		await restarted.flush();
		assert.strictEqual((state.value() as { version: number }).version, 2);
	});

	test('repairs already-migrated v2 lifetime totals from larger daily history', async () => {
		const older = { inputTokens: 90, outputTokens: 10, totalTokens: 100 };
		const recent = { inputTokens: 135, outputTokens: 15, totalTokens: 150 };
		const latest = { inputTokens: 45, outputTokens: 5, totalTokens: 50 };
		const now = timestamp();
		const state = new MemoryState({
			version: 2,
			sessions: [{
				provider: 'codex', sessionId: 'v2-under-counted', startedAt: timestamp(-40), lastUpdatedAt: now,
				model: 'current-model', ...latest, lifetimeUsage: latest, checkpoint: latest,
				dailyUsage: { [localDateKey(timestamp(-40))]: older, [localDateKey(timestamp(-10))]: recent },
			}],
			backfill: {},
		});
		const ledger = new SessionLedger(new UsageStorage(state as never), 0);
		assert.strictEqual(ledger.queryAllTime().totalTokens, 250);
		assertWindowInvariants(ledger, now);
		await ledger.flush();

		const persisted = state.value() as { sessions: Array<{ lifetimeUsage: UsageSnapshot }> };
		assert.strictEqual(persisted.sessions[0].lifetimeUsage.totalTokens, 250);
		const restarted = new SessionLedger(new UsageStorage(state as never), 0);
		assert.strictEqual(restarted.queryAllTime().totalTokens, 250);
		assertWindowInvariants(restarted, now);
	});

	test('rejects invalid and unsafe numeric snapshots while accepting large safe values', () => {
		const { ledger } = createLedger();
		assert.strictEqual(ledger.recordSnapshot(snapshot('codex', 'negative', -1)), false);
		assert.strictEqual(ledger.recordSnapshot({ ...snapshot('codex', 'nan', 100), totalTokens: Number.NaN }), false);
		const large = Number.MAX_SAFE_INTEGER - 10_000;
		assert.strictEqual(ledger.recordSnapshot(snapshot('codex', 'large', large)), true);
		assert.strictEqual(ledger.getSession('codex', 'large')?.totalTokens, large);
	});

	test('backfills existing sessions, resumes markers, and is idempotent', async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), 'ai-usage-monitor-history-'));
		try {
			const firstPath = path.join(root, 'rollout-first.jsonl');
			const secondPath = path.join(root, 'rollout-second.jsonl');
			const cwd = path.join(root, 'project');
			await mkdir(cwd);
			await writeFile(firstPath, sessionJson(timestamp(-1, 23, 55), [
				{ time: timestamp(-1, 23, 59), total: 10_000 },
				{ time: timestamp(0, 0, 5), total: 14_000 },
			], cwd));
			await writeFile(secondPath, sessionJson(timestamp(-2), [{ time: timestamp(-2, 13), total: 2_000 }], cwd));
			const files: readonly CodexSessionFileMetadata[] = [
				{ filePath: firstPath, modifiedAt: timestamp(0) },
				{ filePath: secondPath, modifiedAt: timestamp(-2) },
			];
			const discovery = {
				discover: async () => ({ detected: true }),
				discoverSessionFiles: async () => files,
			};
			const { ledger, state } = createLedger();
			const backfill = new CodexBackfill(ledger);
			const firstRun = await backfill.run(discovery);
			assert.deepStrictEqual(
				{ discovered: firstRun.discovered, imported: firstRun.imported, skipped: firstRun.skipped, complete: firstRun.complete },
				{ discovered: 2, imported: 2, skipped: 0, complete: true },
			);
			assert.strictEqual(ledger.queryAllTime().totalTokens, 16_000);
			assert.strictEqual(ledger.queryToday(timestamp(0)).totalTokens, 4_000);
			assertWindowInvariants(ledger, timestamp(0));
			assert.strictEqual((state.value() as { version: number }).version, 2);
			assert.ok(JSON.stringify(state.value()).includes('project'));
			assert.strictEqual(JSON.stringify(state.value()).includes(cwd), false);

			const secondRun = await backfill.run(discovery);
			assert.deepStrictEqual(secondRun, { discovered: 0, imported: 0, skipped: 0, complete: true });
			assert.strictEqual(ledger.getSessions().length, 2);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test('live update after backfill adds only its positive delta', async () => {
		const { ledger } = createLedger();
		ledger.importSession({ provider: 'codex', sessionId: 'backfilled', startedAt: timestamp(-1), lastUpdatedAt: timestamp(-1), usage: { inputTokens: 9_000, outputTokens: 1_000, totalTokens: 10_000 }, points: [{ timestamp: timestamp(-1), usage: { inputTokens: 9_000, outputTokens: 1_000, totalTokens: 10_000 } }] });
		ledger.recordSnapshot(snapshot('codex', 'backfilled', 12_000, timestamp()));
		assert.strictEqual(ledger.queryAllTime().totalTokens, 12_000);
		assertWindowInvariants(ledger, timestamp());
	});

	test('history pause and resume seeds the checkpoint without an artificial delta', () => {
		const { ledger } = createLedger();
		ledger.recordSnapshot(snapshot('codex', 'paused', 1_000, timestamp()));
		ledger.seedSnapshot(snapshot('codex', 'paused', 9_000, timestamp(1)));
		assert.strictEqual(ledger.queryAllTime().totalTokens, 1_000);
		ledger.recordSnapshot(snapshot('codex', 'paused', 9_500, timestamp(2)));
		assert.strictEqual(ledger.queryAllTime().totalTokens, 1_500);
		assert.strictEqual(ledger.queryToday(timestamp(2)).totalTokens, 500);
	});

	test('retention prunes daily buckets while All Time uses lifetime session totals', () => {
		const { ledger } = createLedger();
		const current = timestamp();
		ledger.recordSnapshot(snapshot('codex', 'retained', 1_000, current - 3 * 86400000));
		ledger.recordSnapshot(snapshot('codex', 'retained', 2_000, current));
		assert.strictEqual(ledger.pruneDailyUsage(2, current), true);
		assert.strictEqual(ledger.queryLast7Days(current).totalTokens, 1_000);
		assert.strictEqual(ledger.queryAllTime().totalTokens, 2_000);
		assert.strictEqual(ledger.getSession('codex', 'retained')?.checkpoint.totalTokens, 2_000);
		assertWindowInvariants(ledger, current);
	});

	test('window invariants hold for provider, model, and workspace filters', () => {
		const { ledger } = createLedger();
		const now = timestamp();
		ledger.recordSnapshot(snapshot('codex', 'codex-today', 1_000, now, { model: 'model-a', workspaceId: 'workspace-a' }));
		ledger.recordSnapshot(snapshot('codex', 'codex-seven', 2_000, timestamp(-6), { model: 'model-a', workspaceId: 'workspace-a' }));
		ledger.recordSnapshot(snapshot('codex', 'codex-thirty', 3_000, timestamp(-20), { model: 'model-a', workspaceId: 'workspace-a' }));
		ledger.recordSnapshot(snapshot('codex', 'codex-old', 4_000, timestamp(-40), { model: 'model-a', workspaceId: 'workspace-a' }));
		ledger.recordSnapshot(snapshot('claude', 'claude-today', 500, now, { model: 'model-a', workspaceId: 'workspace-a' }));
		ledger.recordSnapshot(snapshot('codex', 'other-model', 600, now, { model: 'model-b', workspaceId: 'workspace-b' }));

		for (const filter of [
			{},
			{ provider: 'codex' as const },
			{ provider: 'claude' as const },
			{ model: 'model-a' },
			{ workspaceId: 'workspace-a' },
		]) {
			assertWindowInvariants(ledger, now, filter);
		}
	});

	test('handles a bounded synthetic large history and update sequence', () => {
		const { ledger } = createLedger();
		const current = timestamp();
		for (let index = 0; index < 1_000; index++) {
			ledger.recordSnapshot(snapshot('codex', `bulk-${index}`, 1_000 + index, current, { model: 'synthetic-model' }));
		}
		for (let update = 1; update <= 10_000; update++) {
			ledger.recordSnapshot(snapshot('codex', 'bulk-0', 1_000 + update, current));
		}
		assert.strictEqual(ledger.getSessions().length, 1_000);
		assert.strictEqual(ledger.getSession('codex', 'bulk-0')?.totalTokens, 11_000);
		assert.strictEqual(ledger.queryAllTime().sessionCount, 1_000);
		assert.ok(JSON.stringify(ledger.getSessions()).length < 5_000_000);
	});

	test('backfill resumes failed files without duplicating completed files', async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), 'ai-usage-monitor-resume-'));
		try {
			const firstPath = path.join(root, 'rollout-first.jsonl');
			const secondPath = path.join(root, 'rollout-second.jsonl');
			await writeFile(firstPath, sessionJson(timestamp(-1), [{ time: timestamp(-1), total: 1_000 }], root));
			await writeFile(secondPath, sessionJson(timestamp(), [{ time: timestamp(), total: 2_000 }], root));
			const files = [
				{ filePath: firstPath, modifiedAt: timestamp(-1) },
				{ filePath: secondPath, modifiedAt: timestamp() },
			];
			const discovery = { discoverSessionFiles: async () => files, discover: async () => ({ detected: true }) };
			const { ledger } = createLedger();
			const backfill = new CodexBackfill(ledger, new OneFailureParser(firstPath));
			const firstRun = await backfill.run(discovery);
			assert.strictEqual(firstRun.complete, false);
			assert.strictEqual(firstRun.imported, 1);
			assert.strictEqual(ledger.queryAllTime().totalTokens, 2_000);
			const secondRun = await backfill.run(discovery);
			assert.strictEqual(secondRun.complete, true);
			assert.strictEqual(secondRun.imported, 1);
			assert.strictEqual(ledger.getSessions().length, 2);
			assert.strictEqual(ledger.queryAllTime().totalTokens, 3_000);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test('reset clears only extension history and leaves Codex files intact', async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), 'ai-usage-monitor-reset-'));
		try {
			const codexFile = path.join(root, 'rollout.jsonl');
			await writeFile(codexFile, 'metadata remains untouched\n');
			const { ledger, state } = createLedger();
			ledger.recordSnapshot(snapshot('codex', 'resettable', 100));
			await ledger.flush();
			await ledger.reset();
			assert.strictEqual(ledger.getSessions().length, 0);
			assert.strictEqual(state.value(), undefined);
			assert.ok((await stat(codexFile)).isFile());
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
