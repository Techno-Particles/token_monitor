import * as assert from 'assert';

import { tokenComposition, freshInputTokens } from '../core/tokenMetrics';
import { SessionLedger } from '../history/sessionLedger';
import { RateLimitObservationStore, MAX_RATE_LIMIT_OBSERVATIONS } from '../history/rateLimitObservations';
import { UsageStorage } from '../storage/usageStorage';
import { calculateObservedBurnRate } from '../ui/burnRate';

class MemoryState {
	private readonly values = new Map<string, unknown>();

	get<T>(key: string): T | undefined {
		return this.values.get(key) as T | undefined;
	}

	async update(key: string, value: unknown): Promise<void> {
		this.values.set(key, value);
	}
}

function snapshot(totalTokens: number, timestamp: number) {
	return {
		provider: 'codex' as const,
		sessionId: 'composition',
		timestamp,
		inputTokens: 1_000,
		cachedInputTokens: 600,
		outputTokens: 100,
		totalTokens,
	};
}

suite('Usage Insights Test Suite', () => {
	test('calculates fresh input and rates without double counting subsets', () => {
		assert.strictEqual(freshInputTokens(1_000, 600), 400);
		assert.deepStrictEqual(tokenComposition(1_000, 600), { freshInputTokens: 400, cacheRate: 60, freshRate: 40 });
		assert.strictEqual(freshInputTokens(0, 0), 0);
		assert.deepStrictEqual(tokenComposition(0, undefined), { freshInputTokens: 0, cacheRate: 0, freshRate: 0 });
		assert.deepStrictEqual(tokenComposition(400, 800), { freshInputTokens: 0, cacheRate: 100, freshRate: 0 });
	});

	test('aggregates historical fresh and cached input while preserving authoritative totals', () => {
		const state = new MemoryState();
		const ledger = new SessionLedger(new UsageStorage(state as never), 0);
		ledger.recordSnapshot(snapshot(1_100, Date.now()));
		const result = ledger.queryAllTime();
		assert.strictEqual(result.inputTokens, 1_000);
		assert.strictEqual(result.freshInputTokens, 400);
		assert.strictEqual(result.cachedInputTokens, 600);
		assert.strictEqual(result.outputTokens, 100);
		assert.strictEqual(result.totalTokens, 1_100, 'cached input must not be added to authoritative total a second time');
	});

	test('calculates burn rate only within one reset window', () => {
		const now = 1_700_000_000_000;
		const observations = [
			{ key: 'primary' as const, observedAt: now - 120 * 60_000, usedPercent: 20, resetsAt: now + 3 * 60 * 60_000 },
			{ key: 'primary' as const, observedAt: now, usedPercent: 30, resetsAt: now + 3 * 60 * 60_000 },
		];
		assert.deepStrictEqual(calculateObservedBurnRate(observations, 'primary', now), { changePoints: 10, elapsedMinutes: 120, pointsPerHour: 5 });
		assert.strictEqual(calculateObservedBurnRate([
			{ ...observations[0], resetsAt: now + 2 * 60 * 60_000 },
			{ ...observations[1], usedPercent: 5, resetsAt: now + 3 * 60 * 60_000 },
		], 'primary', now), undefined);
	});

	test('reports insufficient burn-rate observations and ignores stale data', () => {
		const now = 1_700_000_000_000;
		assert.strictEqual(calculateObservedBurnRate([{ key: 'secondary', observedAt: now, usedPercent: 10 }], 'secondary', now), undefined);
		assert.strictEqual(calculateObservedBurnRate([
			{ key: 'secondary', observedAt: now - 31 * 24 * 60 * 60 * 1000, usedPercent: 10 },
			{ key: 'secondary', observedAt: now - 30 * 24 * 60 * 60 * 1000, usedPercent: 20 },
		], 'secondary', now), undefined);
	});

	test('persists normalized rate-limit observations and keeps them bounded', async () => {
		const state = new MemoryState();
		const store = new RateLimitObservationStore(state as never, 0);
		const now = 1_700_000_000_000;
		for (let index = 0; index < MAX_RATE_LIMIT_OBSERVATIONS + 10; index++) {
			store.record({ observedAt: now + index, windows: [{ key: 'primary', label: '5-hour limit', compactLabel: '5h', usedPercent: index % 101, resetsAt: now + 100_000 }] });
		}
		assert.strictEqual(store.getObservations().length, MAX_RATE_LIMIT_OBSERVATIONS);
		await store.flush();
		const restarted = new RateLimitObservationStore(state as never, 0);
		assert.strictEqual(restarted.getObservations().length, MAX_RATE_LIMIT_OBSERVATIONS);
		assert.strictEqual(restarted.getObservations()[0].observedAt, now + 10);
	});
});
