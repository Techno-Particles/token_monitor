import * as vscode from 'vscode';

import { MonitorSettings, readMonitorSettings, SETTINGS_SECTION } from './config/settings';
import { ProviderRegistry } from './core/providerRegistry';
import { UsageSnapshot } from './core/types';
import { UsageAggregator } from './core/usageAggregator';
import { CodexBackfill } from './history/codexBackfill';
import { SessionLedger } from './history/sessionLedger';
import { RateLimitObservationStore } from './history/rateLimitObservations';
import { ClaudeProvider } from './providers/claude/claudeProvider';
import { CodexProvider } from './providers/codex/codexProvider';
import { GeminiProvider } from './providers/gemini/geminiProvider';
import { UsageStorage } from './storage/usageStorage';
import { UsageCommands } from './ui/commands';
import { DashboardPanelController } from './ui/dashboard/dashboardPanel';
import { StatusBarController } from './ui/statusBar';

/**
 * Privacy boundary for the extension:
 * usage metadata remains local to VS Code. The extension does not collect prompts,
 * responses, source code, filenames, telemetry, or data from the network.
 */
export function activate(context: vscode.ExtensionContext): void {
	const storage = new UsageStorage(context.globalState);
	const rateLimitObservations = new RateLimitObservationStore(context.globalState);
	const ledger = new SessionLedger(storage);
	const backfill = new CodexBackfill(ledger);
	const aggregator = new UsageAggregator();
	const providerRegistry = new ProviderRegistry();
	const codexProvider = new CodexProvider();
	const claudeProvider = new ClaudeProvider();
	const geminiProvider = new GeminiProvider();

	providerRegistry.register(codexProvider);
	providerRegistry.register(claudeProvider);
	providerRegistry.register(geminiProvider);

	const statusBar = new StatusBarController();
	const commands = new UsageCommands(codexProvider, undefined, ledger);
	const dashboard = new DashboardPanelController(codexProvider, ledger, claudeProvider, geminiProvider, undefined, rateLimitObservations);
	let settings: MonitorSettings = readMonitorSettings();
	let liveTrackingActive = false;
	let trackingGeneration = 0;

	context.subscriptions.push(
		storage,
		rateLimitObservations,
		ledger,
		aggregator,
		providerRegistry,
		statusBar,
		commands,
		dashboard,
	);

	const publishUsage = (usage: UsageSnapshot | undefined): void => {
		if (usage) {
			aggregator.update(usage);
			rateLimitObservations.record(usage.rateLimits, usage.timestamp);
			if (settings.historyEnabled) {
				ledger.recordSnapshot(usage);
			}
		} else {
			aggregator.clear();
		}
		statusBar.setCodexUsage(
			aggregator.getLatest('codex'),
			codexProvider.getDiscoveryResult()?.detected ?? false,
		);
		dashboard.updateUsage(aggregator.getLatest('codex'), codexProvider.getDiscoveryResult()?.detected ?? false, liveTrackingActive);
	};

	const stopTracking = (): void => {
		codexProvider.stopWatching();
		geminiProvider.stopWatching();
		liveTrackingActive = false;
		aggregator.clear();
		statusBar.setCodexDetected(false);
		dashboard.updateUsage(undefined, false, false);
	};

	const startTracking = async (next: MonitorSettings, seedAfterDisabledHistory: boolean, generation: number): Promise<void> => {
		if (next.historyEnabled && !seedAfterDisabledHistory) {
			await backfill.run(codexProvider.getDiscoveryService());
		}
		const usage = await codexProvider.getCurrentUsage();
		if (generation !== trackingGeneration) {
			return;
		}
		if (next.historyEnabled && seedAfterDisabledHistory && usage) {
			ledger.seedSnapshot(usage);
		}
		publishUsage(usage);
		await codexProvider.startWatching(publishUsage);
		if (generation !== trackingGeneration) {
			codexProvider.stopWatching();
			return;
		}
		liveTrackingActive = true;
		dashboard.setLiveTracking(true);
	};

	const applySettings = (): void => {
		const previous = settings;
		settings = readMonitorSettings();
		statusBar.setEnabled(settings.enabled && settings.statusBarEnabled);
		statusBar.setShowRateLimits(settings.showRateLimits);
		dashboard.setDefaultRange(settings.dashboardDefaultRange);
		dashboard.setEnabled(settings.enabled);
		ledger.pruneDailyUsage(settings.retentionDays);
		const generation = ++trackingGeneration;
		const seedAfterDisabledHistory = !previous.historyEnabled && settings.historyEnabled;
		if (seedAfterDisabledHistory) {
			codexProvider.stopWatching();
		}
		if (!settings.enabled) {
			stopTracking();
			return;
		}
		void startTracking(settings, seedAfterDisabledHistory, generation).catch(() => {
			if (generation !== trackingGeneration) {
				return;
			}
			liveTrackingActive = false;
			codexProvider.stopWatching();
			aggregator.clear();
			statusBar.setCodexDetected(false);
			dashboard.updateUsage(undefined, false, false);
		});
	};

	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
		if (event.affectsConfiguration(SETTINGS_SECTION)) {
			applySettings();
		}
	}));

	applySettings();

	void claudeProvider.detect()
		.then((detected) => {
			statusBar.setClaudeDetected(detected);
			dashboard.setClaudeDetected(detected);
		})
		.catch(() => {
			statusBar.setClaudeDetected(false);
			dashboard.setClaudeDetected(false);
		});

	void geminiProvider.detect()
		.then((detected) => {
			statusBar.setGeminiDetected(detected);
			dashboard.setGeminiDetected(detected);
			if (!detected) {
				return;
			}
			return geminiProvider.startWatching(() => {
				const currentDetected = geminiProvider.getDiscoveryResult()?.detected ?? false;
				statusBar.setGeminiDetected(currentDetected);
				dashboard.setGeminiDetected(currentDetected);
			});
		})
		.catch(() => {
			statusBar.setGeminiDetected(false);
			dashboard.setGeminiDetected(false);
		});
}

export function deactivate(): void {}
