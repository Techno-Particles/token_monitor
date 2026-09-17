import { RateLimitSnapshot, UsageSnapshot } from '../../core/types';
import { tokenComposition } from '../../core/tokenMetrics';
import { HistoricalUsageAggregate, UsageBreakdown } from '../../history/historyTypes';
import { SessionLedger } from '../../history/sessionLedger';
import { RateLimitObservationStore } from '../../history/rateLimitObservations';
import { calculateObservedBurnRate, ObservedBurnRate } from '../burnRate';

export interface DashboardMetric extends UsageBreakdown {
	readonly label?: string;
}

export interface DashboardLimit {
	readonly key: 'primary' | 'secondary';
	readonly label: string;
	readonly compactLabel: string;
	readonly usedPercent?: number;
	readonly remainingPercent?: number;
	readonly resetsAt?: number;
	readonly windowMinutes?: number;
	readonly burnRate?: ObservedBurnRate;
}

export interface DashboardState {
	readonly provider: 'codex';
	readonly defaultRange: '7d' | '30d';
	readonly detected: boolean;
	readonly claudeDetected: boolean;
	readonly geminiDetected: boolean;
	readonly live: boolean;
	readonly currentSession?: DashboardMetric & { readonly model?: string; readonly planType?: string; readonly cacheRate: number; readonly freshRate: number };
	readonly limits?: {
		readonly observedAt?: number;
		readonly windows: readonly DashboardLimit[];
		readonly planType?: string;
	};
	readonly history: {
		readonly today: DashboardMetric;
		readonly last7Days: DashboardMetric;
		readonly last30Days: DashboardMetric;
		readonly allTime: DashboardMetric;
	};
	readonly dailyUsage7: readonly DashboardMetric[];
	readonly dailyUsage30: readonly DashboardMetric[];
	readonly models: readonly DashboardMetric[];
	readonly projects: readonly DashboardMetric[];
	readonly error?: string;
}

const EMPTY_BREAKDOWN: UsageBreakdown = {
	inputTokens: 0,
	freshInputTokens: 0,
	outputTokens: 0,
	totalTokens: 0,
};

function addBreakdowns(left: UsageBreakdown, right: UsageBreakdown): UsageBreakdown {
	return {
		inputTokens: left.inputTokens + right.inputTokens,
		freshInputTokens: left.freshInputTokens + right.freshInputTokens,
		cachedInputTokens: left.cachedInputTokens === undefined && right.cachedInputTokens === undefined
			? undefined
			: (left.cachedInputTokens ?? 0) + (right.cachedInputTokens ?? 0),
		outputTokens: left.outputTokens + right.outputTokens,
		reasoningTokens: left.reasoningTokens === undefined && right.reasoningTokens === undefined
			? undefined
			: (left.reasoningTokens ?? 0) + (right.reasoningTokens ?? 0),
		totalTokens: left.totalTokens + right.totalTokens,
	};
}

function safeText(value: string | undefined, fallback?: string): string | undefined {
	if (value === undefined || value.length === 0 || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) {
		return fallback;
	}
	// Model and project labels are not allowed to become an absolute path leak.
	if (value.startsWith('/') || value.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(value)) {
		return fallback;
	}
	return value;
}

function displayDimension(value: string, fallback: string): string {
	return value === 'unknown' ? fallback : safeText(value, fallback) ?? fallback;
}

function metric(value: UsageBreakdown, label?: string): DashboardMetric {
	return {
		inputTokens: value.inputTokens,
		freshInputTokens: value.freshInputTokens,
		cachedInputTokens: value.cachedInputTokens,
		outputTokens: value.outputTokens,
		reasoningTokens: value.reasoningTokens,
		totalTokens: value.totalTokens,
		...(label === undefined ? {} : { label }),
	};
}

function summary(value: HistoricalUsageAggregate): DashboardMetric {
	return metric(value);
}

function mapLimits(rateLimits: RateLimitSnapshot | undefined, observations: RateLimitObservationStore | undefined, now: number): DashboardState['limits'] {
	if (!rateLimits) {
		return undefined;
	}
	return {
		observedAt: rateLimits.observedAt,
		planType: safeText(rateLimits.planType),
		windows: rateLimits.windows.map((window) => ({
			key: window.key,
			label: safeText(window.label, window.key === 'primary' ? 'Primary limit' : 'Secondary limit') ?? window.key,
			compactLabel: safeText(window.compactLabel, window.key) ?? window.key,
			usedPercent: window.usedPercent,
			remainingPercent: window.remainingPercent,
			resetsAt: window.resetsAt,
			windowMinutes: window.windowMinutes,
			...(observations === undefined ? {} : { burnRate: calculateObservedBurnRate(observations.getObservations(), window.key, now) }),
		})),
	};
}

function topBreakdowns(values: Readonly<Record<string, UsageBreakdown>>, fallback: string): readonly DashboardMetric[] {
	return Object.entries(values)
		.map(([key, value]) => metric(value, displayDimension(key, fallback)))
		.sort((left, right) => right.totalTokens - left.totalTokens)
		.slice(0, 12);
}

function projectBreakdowns(ledger: SessionLedger): readonly DashboardMetric[] {
	const projects = new Map<string, UsageBreakdown>();
	for (const session of ledger.getSessions()) {
		const sessionUsage: UsageBreakdown = metric({
			...session.lifetimeUsage,
			freshInputTokens: tokenComposition(session.lifetimeUsage.inputTokens, session.lifetimeUsage.cachedInputTokens).freshInputTokens,
		});
		const name = safeText(session.workspaceName, 'Unknown / Unattributed') ?? 'Unknown / Unattributed';
		projects.set(name, addBreakdowns(projects.get(name) ?? EMPTY_BREAKDOWN, sessionUsage));
	}
	return [...projects.entries()]
		.filter(([, value]) => value.totalTokens > 0)
		.map(([label, value]) => metric(value, label))
		.sort((left, right) => right.totalTokens - left.totalTokens)
		.slice(0, 12);
}

function dailyMetrics(ledger: SessionLedger, days: 7 | 30, now: number): readonly DashboardMetric[] {
	return ledger.queryDailyUsage(days, now).map((point) => metric(point, point.dateKey));
}

/** Maps internal provider and ledger values to the small, Webview-safe state contract. */
export function createDashboardState(
	usage: UsageSnapshot | undefined,
	detected: boolean,
	live: boolean,
	ledger: SessionLedger,
	now = Date.now(),
	error?: string,
	claudeDetected = false,
	geminiDetected = false,
	defaultRange: '7d' | '30d' = '7d',
	rateLimitObservations?: RateLimitObservationStore,
): DashboardState {
	const allTime = ledger.queryAllTime({ provider: 'codex' });
	return {
		provider: 'codex',
		defaultRange,
		detected,
		claudeDetected,
		geminiDetected,
		live,
		currentSession: usage === undefined
			? undefined
			: {
				inputTokens: usage.inputTokens,
				freshInputTokens: tokenComposition(usage.inputTokens, usage.cachedInputTokens).freshInputTokens,
				cachedInputTokens: usage.cachedInputTokens,
				outputTokens: usage.outputTokens,
				reasoningTokens: usage.reasoningTokens,
				totalTokens: usage.totalTokens,
				cacheRate: tokenComposition(usage.inputTokens, usage.cachedInputTokens).cacheRate,
				freshRate: tokenComposition(usage.inputTokens, usage.cachedInputTokens).freshRate,
				model: safeText(usage.model),
				planType: safeText(usage.rateLimits?.planType),
			},
		limits: mapLimits(usage?.rateLimits, rateLimitObservations, now),
		history: {
			today: summary(ledger.queryToday(now, { provider: 'codex' })),
			last7Days: summary(ledger.queryLast7Days(now, { provider: 'codex' })),
			last30Days: summary(ledger.queryLast30Days(now, { provider: 'codex' })),
			allTime: summary(allTime),
		},
		dailyUsage7: dailyMetrics(ledger, 7, now),
		dailyUsage30: dailyMetrics(ledger, 30, now),
		models: topBreakdowns(allTime.byModel, 'Unknown model'),
		projects: projectBreakdowns(ledger),
		error,
	};
}
