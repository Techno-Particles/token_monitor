import * as vscode from 'vscode';

export const SETTINGS_SECTION = 'aiUsageMonitor';
export const DEFAULT_RETENTION_DAYS = 365;

export type DashboardDefaultRange = '7d' | '30d';

export interface MonitorSettings {
	readonly enabled: boolean;
	readonly statusBarEnabled: boolean;
	readonly showRateLimits: boolean;
	readonly historyEnabled: boolean;
	readonly retentionDays: number;
	readonly dashboardDefaultRange: DashboardDefaultRange;
}

export interface SettingsConfiguration {
	get<T>(section: string, defaultValue: T): T;
}

function boundedInteger(value: number, fallback: number, minimum: number, maximum: number): number {
	return Number.isSafeInteger(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
}

/** Reads and bounds user settings so malformed configuration cannot destabilize tracking. */
export function readMonitorSettings(configuration: SettingsConfiguration = vscode.workspace.getConfiguration(SETTINGS_SECTION)): MonitorSettings {
	const retentionDays = configuration.get<number>('history.retentionDays', DEFAULT_RETENTION_DAYS);
	const range = configuration.get<string>('dashboard.defaultRange', '7d');
	return {
		enabled: configuration.get<boolean>('enabled', true),
		statusBarEnabled: configuration.get<boolean>('statusBar.enabled', true),
		showRateLimits: configuration.get<boolean>('statusBar.showRateLimits', true),
		historyEnabled: configuration.get<boolean>('history.enabled', true),
		retentionDays: boundedInteger(retentionDays, DEFAULT_RETENTION_DAYS, 1, 3_650),
		dashboardDefaultRange: range === '30d' ? '30d' : '7d',
	};
}
