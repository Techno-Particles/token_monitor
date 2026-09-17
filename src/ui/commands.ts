import * as vscode from 'vscode';

import { CodexProvider } from '../providers/codex/codexProvider';
import { SessionLedger } from '../history/sessionLedger';
import { formatTokenCount } from './format';
import { formatRateLimitDetails, hasRateLimitWindows } from './rateLimits';

export const SHOW_USAGE_COMMAND = 'ai-usage-monitor.showUsage';
export const RESET_HISTORY_COMMAND = 'ai-usage-monitor.resetHistory';

function safeModel(value: string | undefined): string | undefined {
	return value !== undefined
		&& value.length > 0
		&& value.length <= 128
		&& !/[\u0000-\u001f\u007f]/.test(value)
		&& !value.startsWith('/')
		&& !value.startsWith('\\\\')
		&& !/^[A-Za-z]:[\\/]/.test(value)
		? value
		: undefined;
}

/** Registers the user-facing commands for current and historical local usage. */
export class UsageCommands implements vscode.Disposable {
	private readonly command: vscode.Disposable;
	private readonly resetCommand?: vscode.Disposable;

	constructor(
		private readonly codexProvider: CodexProvider,
		private readonly commandId = SHOW_USAGE_COMMAND,
		private readonly ledger?: SessionLedger,
	) {
		this.command = vscode.commands.registerCommand(this.commandId, () => {
			void this.showUsage();
		});
		if (this.ledger) {
			this.resetCommand = vscode.commands.registerCommand(RESET_HISTORY_COMMAND, () => {
				void this.resetHistory();
			});
		}
	}

	private async showUsage(): Promise<void> {
		let usage;
		try {
			usage = await this.codexProvider.getCurrentUsage();
		} catch {
			usage = undefined;
		}

		const codexResult = this.codexProvider.getDiscoveryResult();
		const rateLimits = usage?.rateLimits;
		const history = this.ledger;
		const historicalStatus = history
			? [
				'History',
				`Today: ${formatTokenCount(history.queryToday().totalTokens)}`,
				`Last 7 days: ${formatTokenCount(history.queryLast7Days().totalTokens)}`,
				`Last 30 days: ${formatTokenCount(history.queryLast30Days().totalTokens)}`,
				`All time: ${formatTokenCount(history.queryAllTime().totalTokens)}`,
			].join('\n')
			: undefined;
		const codexStatus = usage && codexResult?.detected
			? [
				'Codex — Detected',
				'',
				'Current session',
				`Input: ${formatTokenCount(usage.inputTokens)}`,
				...(usage.cachedInputTokens === undefined ? [] : [`Cached input: ${formatTokenCount(usage.cachedInputTokens)}`]),
				`Output: ${formatTokenCount(usage.outputTokens)}`,
				...(usage.reasoningTokens === undefined ? [] : [`Reasoning: ${formatTokenCount(usage.reasoningTokens)}`]),
				`Total: ${formatTokenCount(usage.totalTokens)}`,
				...(safeModel(usage.model) === undefined ? [] : [`Model: ${safeModel(usage.model)}`]),
				...(usage.contextWindow === undefined ? [] : [`Context window: ${formatTokenCount(usage.contextWindow)}`]),
			].join('\n')
			: codexResult?.detected
			? `Codex — Detected locally\nSessions found: ${codexResult.sessionFileCount ?? 'Unavailable'}\nNo token metadata was found in the latest session.`
			: codexResult
				? 'Codex\nNot detected locally'
				: 'Codex\nDetection in progress';
		const codexLimits = [
			'Codex limits',
			...(hasRateLimitWindows(rateLimits)
				? formatRateLimitDetails(rateLimits)
				: ['Quota data unavailable']),
		].join('\n');

		await vscode.window.showInformationMessage(
			[
				'AI Usage Monitor',
				'',
				codexStatus,
				...(historicalStatus ? ['', historicalStatus] : []),
				'',
				codexLimits,
				'',
				'Claude Code\nNot tracked yet',
				'',
				'Gemini CLI\nNot tracked yet',
			].join('\n'),
		);
	}

	private async resetHistory(): Promise<void> {
		if (!this.ledger) {
			return;
		}
		const choice = await vscode.window.showWarningMessage(
			'Reset AI Usage Monitor local history? This deletes only extension-maintained analytics and never modifies Codex session files.',
			{ modal: true },
			'Reset history',
		);
		if (choice === 'Reset history') {
			await this.ledger.reset();
		}
	}

	dispose(): void {
		this.command.dispose();
		this.resetCommand?.dispose();
	}
}
