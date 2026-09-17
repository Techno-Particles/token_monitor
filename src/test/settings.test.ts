import * as assert from 'assert';

import * as vscode from 'vscode';

import { readMonitorSettings } from '../config/settings';
import { StatusBarController } from '../ui/statusBar';

class FakeConfiguration {
	constructor(private readonly values: Record<string, unknown> = {}) {}

	get<T>(key: string, fallback: T): T {
		return (this.values[key] as T | undefined) ?? fallback;
	}
}

suite('Settings Test Suite', () => {
	test('uses safe defaults and bounds malformed retention settings', () => {
		assert.deepStrictEqual(readMonitorSettings(new FakeConfiguration()), {
			enabled: true,
			statusBarEnabled: true,
			showRateLimits: true,
			historyEnabled: true,
			retentionDays: 365,
			dashboardDefaultRange: '7d',
		});
		assert.strictEqual(readMonitorSettings(new FakeConfiguration({ 'history.retentionDays': 0 })).retentionDays, 1);
		assert.strictEqual(readMonitorSettings(new FakeConfiguration({ 'history.retentionDays': 99999 })).retentionDays, 3650);
		assert.strictEqual(readMonitorSettings(new FakeConfiguration({ 'dashboard.defaultRange': '30d' })).dashboardDefaultRange, '30d');
	});

	test('shows and hides the status bar without recreating it', () => {
		const controller = new StatusBarController();
		try {
			const item = (controller as unknown as { item: vscode.StatusBarItem }).item;
			controller.setEnabled(false);
			assert.strictEqual(item, (controller as unknown as { item: vscode.StatusBarItem }).item);
			controller.setEnabled(true);
		} finally {
			controller.dispose();
		}
	});

	test('hides rate-limit text while retaining current usage', () => {
		const controller = new StatusBarController();
		try {
			const item = (controller as unknown as { item: vscode.StatusBarItem }).item;
			controller.setCodexUsage({
				provider: 'codex', timestamp: 1_700_000_000_000, inputTokens: 900, outputTokens: 100, totalTokens: 1000,
				rateLimits: { windows: [{ key: 'primary', label: '5-hour limit', compactLabel: '5h', usedPercent: 32 }] },
			}, true);
			controller.setShowRateLimits(false);
			assert.strictEqual(item.text, '$(pulse) Codex: 1K');
			assert.strictEqual(String(item.tooltip).includes('5-hour limit'), false);
		} finally {
			controller.dispose();
		}
	});
});
