import * as vscode from 'vscode';

import { UsageSnapshot } from '../../core/types';
import { SessionLedger } from '../../history/sessionLedger';
import { RateLimitObservationStore } from '../../history/rateLimitObservations';
import { CodexProvider } from '../../providers/codex/codexProvider';
import { ClaudeProvider } from '../../providers/claude/claudeProvider';
import { GeminiProvider } from '../../providers/gemini/geminiProvider';
import { createDashboardState } from './dashboardState';
import { getDashboardHtml } from './dashboardHtml';

export const OPEN_DASHBOARD_COMMAND = 'ai-usage-monitor.openDashboard';
const DASHBOARD_VIEW_TYPE = 'aiUsageMonitor.dashboard';

type DashboardMessage =
	| { readonly type: 'ready' }
	| { readonly type: 'refresh' }
	| { readonly type: 'resetHistory' };

export function isDashboardMessage(value: unknown): value is DashboardMessage {
	if (typeof value !== 'object' || value === null || !('type' in value)) {
		return false;
	}
	const type = value.type;
	return type === 'ready' || type === 'refresh' || type === 'resetHistory';
}

/** Owns the single dashboard panel and translates internal state to Webview messages. */
export class DashboardPanelController implements vscode.Disposable {
	private readonly command: vscode.Disposable;
	private readonly panelSubscriptions: vscode.Disposable[] = [];
	private panel?: vscode.WebviewPanel;
	private postTimer?: NodeJS.Timeout;
	private latestUsage?: UsageSnapshot;
	private detected = false;
	private live = false;
	private claudeDetected = false;
	private geminiDetected = false;
	private defaultRange: '7d' | '30d' = '7d';
	private enabled = true;
	private error?: string;
	private disposed = false;

	constructor(
		private readonly provider: CodexProvider,
		private readonly ledger: SessionLedger,
		private readonly claudeProvider?: ClaudeProvider,
		private readonly geminiProvider?: GeminiProvider,
		commandId = OPEN_DASHBOARD_COMMAND,
		private readonly rateLimitObservations?: RateLimitObservationStore,
	) {
		this.command = vscode.commands.registerCommand(commandId, () => {
			this.open();
		});
	}

	updateUsage(usage: UsageSnapshot | undefined, detected: boolean, live = this.live): void {
		this.latestUsage = usage;
		this.detected = detected;
		this.live = live;
		this.error = undefined;
		this.queueStatePost();
	}

	setLiveTracking(live: boolean): void {
		this.live = live;
		this.queueStatePost();
	}

	setClaudeDetected(detected: boolean): void {
		this.claudeDetected = detected;
		this.queueStatePost();
	}

	setGeminiDetected(detected: boolean): void {
		this.geminiDetected = detected;
		this.queueStatePost();
	}

	setDefaultRange(range: '7d' | '30d'): void {
		this.defaultRange = range;
		this.queueStatePost();
	}

	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
		if (!enabled) {
			this.latestUsage = undefined;
			this.detected = false;
			this.live = false;
		}
		this.queueStatePost();
	}

	open(): void {
		if (this.disposed) {
			return;
		}
		if (this.panel) {
			this.panel.reveal(vscode.ViewColumn.One);
			this.queueStatePost();
			void this.refresh();
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			DASHBOARD_VIEW_TYPE,
			'AI Usage Monitor',
			vscode.ViewColumn.One,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [],
			},
		);
		this.panel = panel;
		panel.webview.html = getDashboardHtml(panel.webview);
		this.panelSubscriptions.push(
			panel.webview.onDidReceiveMessage((message: unknown) => {
				if (!isDashboardMessage(message)) {
					return;
				}
				if (message.type === 'ready' || message.type === 'refresh') {
					void this.refresh();
				} else {
					void this.resetHistory();
				}
			}),
			panel.onDidDispose(() => {
				if (this.panel === panel) {
					this.panel = undefined;
					this.clearPostTimer();
					this.clearPanelSubscriptions();
				}
			}),
		);
		this.queueStatePost();
		void this.refresh();
	}

	dispose(): void {
		this.disposed = true;
		this.command.dispose();
		this.clearPostTimer();
		this.clearPanelSubscriptions();
		this.panel?.dispose();
		this.panel = undefined;
	}

	private async refresh(): Promise<void> {
		if (this.disposed) {
			return;
		}
		if (!this.enabled) {
			this.latestUsage = undefined;
			this.detected = false;
			this.live = false;
			this.queueStatePost();
			return;
		}
		try {
			this.latestUsage = await this.provider.getCurrentUsage();
			this.detected = this.provider.getDiscoveryResult()?.detected ?? false;
			if (this.claudeProvider) {
				this.claudeDetected = await this.claudeProvider.detect();
			}
			if (this.geminiProvider) {
				this.geminiDetected = await this.geminiProvider.detect();
			}
			this.error = undefined;
		} catch {
			this.error = 'Unable to read current Codex usage. Existing local history is still available.';
		}
		this.queueStatePost();
	}

	private async resetHistory(): Promise<void> {
		const choice = await vscode.window.showWarningMessage(
			'Reset AI Usage Monitor local history? This deletes only extension-maintained analytics and never modifies Codex session files.',
			{ modal: true },
			'Reset history',
		);
		if (choice !== 'Reset history' || this.disposed) {
			return;
		}
		try {
			await this.ledger.reset();
			await this.rateLimitObservations?.reset();
			await this.refresh();
		} catch {
			this.error = 'Unable to reset local history. No Codex files were changed.';
			this.queueStatePost();
		}
	}

	private queueStatePost(): void {
		if (!this.panel || this.postTimer !== undefined || this.disposed) {
			return;
		}
		this.postTimer = setTimeout(() => {
			this.postTimer = undefined;
			if (!this.panel || this.disposed) {
				return;
			}
			const state = createDashboardState(this.latestUsage, this.detected, this.live, this.ledger, Date.now(), this.error, this.claudeDetected, this.geminiDetected, this.defaultRange, this.rateLimitObservations);
			void this.panel.webview.postMessage({ type: 'state', state });
		}, 0);
	}

	private clearPostTimer(): void {
		if (this.postTimer !== undefined) {
			clearTimeout(this.postTimer);
			this.postTimer = undefined;
		}
	}

	private clearPanelSubscriptions(): void {
		while (this.panelSubscriptions.length > 0) {
			this.panelSubscriptions.pop()?.dispose();
		}
	}
}
