import { ProviderId } from '../core/types';

/** Numeric counters are provider-reported values; cached/reasoning are subsets. */
export interface UsageCounters {
	readonly inputTokens: number;
	readonly cachedInputTokens?: number;
	readonly outputTokens: number;
	readonly reasoningTokens?: number;
	readonly totalTokens: number;
}

export interface UsageSessionRecord extends UsageCounters {
	readonly provider: ProviderId;
	readonly sessionId: string;
	readonly startedAt: number;
	readonly lastUpdatedAt: number;
	readonly model?: string;
	readonly workspaceId?: string;
	readonly workspaceName?: string;
	/** Cumulative usage that was intentionally accounted in local history. */
	readonly lifetimeUsage: UsageCounters;
	readonly checkpoint: UsageCounters;
	readonly dailyUsage: Readonly<Record<string, UsageCounters>>;
}

export interface PersistedUsageHistory {
	readonly version: 2;
	readonly sessions: readonly UsageSessionRecord[];
	readonly backfill: Readonly<Record<string, Readonly<Record<string, boolean>>>>;
}

export interface HistoryFilter {
	readonly provider?: ProviderId;
	readonly model?: string;
	readonly workspaceId?: string;
}

export interface UsageBreakdown {
	readonly inputTokens: number;
	readonly freshInputTokens: number;
	readonly cachedInputTokens?: number;
	readonly outputTokens: number;
	readonly reasoningTokens?: number;
	readonly totalTokens: number;
}

export interface HistoricalUsageAggregate extends UsageBreakdown {
	readonly sessionCount: number;
	readonly byProvider: Readonly<Record<string, UsageBreakdown>>;
	readonly byModel: Readonly<Record<string, UsageBreakdown>>;
	readonly byWorkspace: Readonly<Record<string, UsageBreakdown>>;
}

export interface HistoricalDailyUsage extends UsageBreakdown {
	readonly dateKey: string;
}
