import * as vscode from 'vscode';

import { UsageSnapshot } from '../core/types';
import { OPEN_DASHBOARD_COMMAND } from './dashboard/dashboardPanel';
import { formatCompactTokenCount, formatTokenCount } from './format';
import { formatRateLimitDetails, formatRateLimitStatus, hasRateLimitWindows } from './rateLimits';

type IntervalHandle = ReturnType<typeof setInterval>;
type IntervalScheduler = (callback: () => void, milliseconds: number) => IntervalHandle;
type IntervalCanceller = (handle: IntervalHandle) => void;

/** Owns the always-available entry point into the usage UI. */
export class StatusBarController implements vscode.Disposable {
	private readonly item: vscode.StatusBarItem;
	private usage?: UsageSnapshot;
	private detected = false;
	private claudeDetected = false;
	private geminiDetected = false;
	private enabled = true;
	private showRateLimits = true;
	private refreshTimer?: IntervalHandle;

	constructor(
		private readonly now: () => number = () => Date.now(),
		private readonly schedule: IntervalScheduler = (callback, milliseconds) => setInterval(callback, milliseconds),
		private readonly cancel: IntervalCanceller = (handle) => clearInterval(handle),
	) {
		this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
		this.item.text = '$(pulse) AI Usage: Ready';
		this.item.tooltip = 'AI Usage Monitor — click to view usage';
		this.item.command = OPEN_DASHBOARD_COMMAND;
		this.item.show();
	}

	setCodexDetected(detected: boolean): void {
		this.detected = detected;
		this.usage = undefined;
		this.stopRefreshTimer();
		this.render();
	}

	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
		if (enabled) {
			this.item.show();
			this.syncRefreshTimer();
		} else {
			this.stopRefreshTimer();
			this.item.hide();
		}
	}

	setShowRateLimits(showRateLimits: boolean): void {
		this.showRateLimits = showRateLimits;
		if (!showRateLimits) {
			this.stopRefreshTimer();
		} else {
			this.syncRefreshTimer();
		}
		this.render();
	}

	setCodexUsage(usage: UsageSnapshot | undefined, detected: boolean): void {
		this.detected = detected;
		this.usage = usage;
		this.syncRefreshTimer();
		this.render();
	}

	setClaudeDetected(detected: boolean): void {
		this.claudeDetected = detected;
		if (!this.usage) {
			this.render();
		}
	}

	setGeminiDetected(detected: boolean): void {
		this.geminiDetected = detected;
		if (!this.usage) {
			this.render();
		}
	}

	private render(): void {
		if (!this.usage) {
			this.item.text = this.detected
				? '$(pulse) Codex: Detected'
				: this.claudeDetected ? '$(pulse) Claude: Detected' : this.geminiDetected ? '$(pulse) Gemini: Detected' : '$(pulse) AI Usage: Ready';
			this.item.tooltip = this.detected
				? 'Codex detected locally; waiting for token metadata — click to view usage'
				: this.claudeDetected
					? 'Claude Code detected locally; usage schema is not available — click to view dashboard'
					: this.geminiDetected
						? 'Gemini CLI detected locally; usage schema is not available — click to view dashboard'
						: 'AI Usage Monitor — click to view usage';
			return;
		}

		const usage = this.usage;
		const rateLimitParts = this.showRateLimits
			? (usage.rateLimits?.windows
				.map(formatRateLimitStatus)
				.filter((part): part is string => part !== undefined) ?? [])
			: [];
		this.item.text = rateLimitParts.length > 0
			? `$(pulse) Codex ${formatCompactTokenCount(usage.totalTokens)} │ ${rateLimitParts.join(' │ ')}`
			: `$(pulse) Codex: ${formatCompactTokenCount(usage.totalTokens)}`;
		this.item.tooltip = [
			'Codex',
			'',
			'Current session (live):',
			`${formatTokenCount(usage.totalTokens)} tokens`,
			...(this.showRateLimits && hasRateLimitWindows(usage.rateLimits) ? ['', ...formatRateLimitDetails(usage.rateLimits, this.now())] : []),
			'',
			'Live tracking active',
		].join('\n');
	}

	private syncRefreshTimer(): void {
		const hasReset = this.usage?.rateLimits?.windows.some((window) => window.resetsAt !== undefined) ?? false;
		if (hasReset && this.refreshTimer === undefined) {
			this.refreshTimer = this.schedule(() => this.render(), 60_000);
		} else if (!hasReset) {
			this.stopRefreshTimer();
		}
	}

	private stopRefreshTimer(): void {
		if (this.refreshTimer !== undefined) {
			this.cancel(this.refreshTimer);
			this.refreshTimer = undefined;
		}
	}

	dispose(): void {
		this.stopRefreshTimer();
		this.item.dispose();
	}
}
