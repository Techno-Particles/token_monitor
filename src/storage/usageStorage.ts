import * as vscode from 'vscode';

import { PersistedUsageHistory } from '../history/historyTypes';

export const HISTORY_STORAGE_KEY = 'ai-usage-monitor.historyLedger';

/** Local versioned persistence boundary; it never writes Codex session files. */
export class UsageStorage implements vscode.Disposable {
	constructor(private readonly state: vscode.Memento) {}

	getPersistedHistory(): unknown {
		return this.state.get<unknown>(HISTORY_STORAGE_KEY);
	}

	async saveHistory(history: PersistedUsageHistory): Promise<void> {
		await this.state.update(HISTORY_STORAGE_KEY, history);
	}

	async clear(): Promise<void> {
		await this.state.update(HISTORY_STORAGE_KEY, undefined);
	}

	dispose(): void {}
}
