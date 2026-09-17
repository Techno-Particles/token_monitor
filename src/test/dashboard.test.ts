import * as assert from 'assert';

import * as vscode from 'vscode';

import { RateLimitSnapshot, UsageSnapshot } from '../core/types';
import { SessionLedger } from '../history/sessionLedger';
import { RateLimitObservationStore } from '../history/rateLimitObservations';
import { UsageStorage, HISTORY_STORAGE_KEY } from '../storage/usageStorage';
import { DashboardPanelController, isDashboardMessage } from '../ui/dashboard/dashboardPanel';
import { createDashboardState } from '../ui/dashboard/dashboardState';
import { getDashboardHtml } from '../ui/dashboard/dashboardHtml';

class MemoryState {
	private valueStore: unknown;

	get<T>(key: string): T | undefined {
		return key === HISTORY_STORAGE_KEY ? this.valueStore as T | undefined : undefined;
	}

	async update(key: string, value: unknown): Promise<void> {
		if (key === HISTORY_STORAGE_KEY) {
			this.valueStore = value;
		}
	}
}

const NOW = new Date(2026, 8, 17, 12).getTime();

function createLedger(): SessionLedger {
	return new SessionLedger(new UsageStorage(new MemoryState() as never), 0);
}

function snapshot(
	sessionId: string,
	totalTokens: number,
	timestamp: number,
	options: { model?: string; workspaceId?: string; workspaceName?: string; rateLimits?: RateLimitSnapshot } = {},
): UsageSnapshot {
	return {
		provider: 'codex',
		sessionId,
		timestamp,
		model: options.model,
		workspaceId: options.workspaceId,
		workspaceName: options.workspaceName,
		inputTokens: totalTokens - 100,
		cachedInputTokens: 200,
		outputTokens: 100,
		reasoningTokens: 25,
		totalTokens,
		rateLimits: options.rateLimits,
	};
}

suite('Dashboard Test Suite', () => {
	test('maps current Codex usage and plan into sanitized dashboard state', () => {
		const ledger = createLedger();
		const state = createDashboardState(snapshot('current', 3400, NOW, {
			model: 'gpt-5.6-luna',
			rateLimits: {
				observedAt: NOW,
				planType: 'plus',
				windows: [{ key: 'primary', label: '5-hour limit', compactLabel: '5h', usedPercent: 49, remainingPercent: 51, resetsAt: NOW + 3600000, windowMinutes: 300 }],
			},
		}), true, true, ledger, NOW);

		assert.deepStrictEqual(state.currentSession, {
			inputTokens: 3300,
			freshInputTokens: 3100,
			cachedInputTokens: 200,
			outputTokens: 100,
			reasoningTokens: 25,
			totalTokens: 3400,
			cacheRate: 6.0606060606060606,
			freshRate: 93.93939393939394,
			model: 'gpt-5.6-luna',
			planType: 'plus',
		});
		assert.strictEqual(state.limits?.windows[0].usedPercent, 49);
		assert.strictEqual(state.limits?.planType, 'plus');
		assert.strictEqual(state.live, true);
	});

	test('maps reset-aware observed burn rate without predicting exhaustion', () => {
		const observations = new RateLimitObservationStore(new MemoryState() as never, 0);
		observations.record({ observedAt: NOW - 60 * 60 * 1000, windows: [{ key: 'primary', label: '5-hour limit', compactLabel: '5h', usedPercent: 20, resetsAt: NOW + 60 * 60 * 1000 }] });
		observations.record({ observedAt: NOW, windows: [{ key: 'primary', label: '5-hour limit', compactLabel: '5h', usedPercent: 30, resetsAt: NOW + 60 * 60 * 1000 }] });
		const state = createDashboardState(snapshot('current', 3400, NOW, {
			rateLimits: { observedAt: NOW, windows: [{ key: 'primary', label: '5-hour limit', compactLabel: '5h', usedPercent: 30, resetsAt: NOW + 60 * 60 * 1000 }] },
		}), true, true, createLedger(), NOW, undefined, false, false, '7d', observations);
		assert.strictEqual(state.limits?.windows[0].burnRate?.changePoints, 10);
		assert.strictEqual(state.limits?.windows[0].burnRate?.pointsPerHour, 10);
	});

	test('represents missing provider data and quota data without fake values', () => {
		const state = createDashboardState(undefined, false, false, createLedger(), NOW);
		assert.strictEqual(state.detected, false);
		assert.strictEqual(state.currentSession, undefined);
		assert.strictEqual(state.limits, undefined);
		assert.strictEqual(state.history.allTime.totalTokens, 0);
		assert.deepStrictEqual(state.dailyUsage7.map((point) => point.totalTokens), [0, 0, 0, 0, 0, 0, 0]);
	});

	test('maps history summaries, daily 7D/30D data, model, and project breakdowns', () => {
		const ledger = createLedger();
		ledger.recordSnapshot(snapshot('today-model', 1500, NOW, { model: 'gpt-a', workspaceId: 'project-a', workspaceName: 'alpha' }));
		ledger.recordSnapshot(snapshot('today-model', 2000, NOW + 60000, { model: 'gpt-a', workspaceId: 'project-a', workspaceName: 'alpha' }));
		ledger.recordSnapshot(snapshot('yesterday-model', 3000, NOW - 86400000, { model: 'gpt-b', workspaceId: 'project-b', workspaceName: 'beta' }));

		const state = createDashboardState(undefined, true, false, ledger, NOW);
		assert.strictEqual(state.history.today.totalTokens, 2000);
		assert.strictEqual(state.history.last7Days.totalTokens, 5000);
		assert.strictEqual(state.history.last30Days.totalTokens, 5000);
		assert.strictEqual(state.history.allTime.totalTokens, 5000);
		assert.strictEqual(state.history.today.freshInputTokens, 1700);
		assert.strictEqual(state.history.today.cachedInputTokens, 200);
		assert.strictEqual(state.dailyUsage7.length, 7);
		assert.strictEqual(state.dailyUsage7[6].totalTokens, 2000);
		assert.strictEqual(state.dailyUsage30.length, 30);
		assert.strictEqual(state.dailyUsage30[28].totalTokens, 3000);
		assert.deepStrictEqual(state.models.map((entry) => entry.label), ['gpt-b', 'gpt-a']);
		assert.deepStrictEqual(state.projects.map((entry) => entry.label), ['beta', 'alpha']);
	});

	test('uses the privacy-safe unknown project label and never serializes paths', () => {
		const ledger = createLedger();
		ledger.recordSnapshot(snapshot('unknown', 1000, NOW, { model: '/private/secret/model', workspaceName: '/private/secret/project' }));
		const state = createDashboardState(snapshot('current', 1000, NOW, { model: '/private/secret/current' }), true, true, ledger, NOW);
		assert.strictEqual(state.currentSession?.model, undefined);
		assert.strictEqual(state.projects[0].label, 'Unknown / Unattributed');
		assert.strictEqual(JSON.stringify(state).includes('/private/'), false);
	});

	test('preserves cached and reasoning subset semantics in dashboard state', () => {
		const current = createDashboardState(snapshot('subsets', 1200, NOW), true, false, createLedger(), NOW).currentSession;
		assert.strictEqual(current?.cachedInputTokens, 200);
		assert.strictEqual(current?.reasoningTokens, 25);
		assert.strictEqual(current?.inputTokens, 1100);
		assert.strictEqual(current?.outputTokens, 100);
		assert.strictEqual(current?.totalTokens, 1200);
	});

	test('dashboard HTML has a nonce CSP and no remote resource loading', () => {
		const html = getDashboardHtml({ cspSource: 'vscode-webview://test' } as vscode.Webview);
		assert.match(html, /Content-Security-Policy/);
		assert.match(html, /script-src 'nonce-[a-f0-9]+'/);
		assert.match(html, /style-src vscode-webview:\/\/test 'nonce-[a-f0-9]+'/);
		assert.strictEqual(/<script\s+src=/i.test(html), false);
		assert.strictEqual(/https?:\/\/(?!www\.w3\.org)/i.test(html), false);
		assert.strictEqual(html.includes('unsafe-eval'), false);
		assert.match(html, /Where your tokens went/);
		assert.match(html, /data-insight-range="all"/);
		assert.match(html, /No measurable change yet/);
	});

	test('dashboard panel is a singleton and can be disposed', () => {
		const provider = {
			getCurrentUsage: async () => undefined,
			getDiscoveryResult: () => ({ detected: false }),
		} as never;
		const controller = new DashboardPanelController(provider, createLedger(), undefined, undefined, 'ai-usage-monitor.testDashboard');
		try {
			controller.open();
			const firstPanel = (controller as unknown as { panel: vscode.WebviewPanel }).panel;
			controller.open();
			assert.strictEqual((controller as unknown as { panel: vscode.WebviewPanel }).panel, firstPanel);
		} finally {
			controller.dispose();
		}
	});

	test('validates dashboard messages and ignores unknown message types', () => {
		assert.strictEqual(isDashboardMessage({ type: 'ready' }), true);
		assert.strictEqual(isDashboardMessage({ type: 'refresh' }), true);
		assert.strictEqual(isDashboardMessage({ type: 'resetHistory' }), true);
		assert.strictEqual(isDashboardMessage({ type: 'deleteEverything' }), false);
		assert.strictEqual(isDashboardMessage('refresh'), false);
	});
});
