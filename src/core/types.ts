/** Providers supported by the normalized usage model. */
export type ProviderId = 'codex' | 'claude' | 'gemini';

/** A normalized provider-reported rate-limit window. */
export interface RateLimitWindow {
	readonly key: 'primary' | 'secondary';
	/** Human-readable label derived only from a known window duration. */
	readonly label: string;
	/** Compact label used by the status bar. */
	readonly compactLabel: string;
	readonly usedPercent?: number;
	readonly remainingPercent?: number;
	readonly resetsAt?: number;
	readonly windowMinutes?: number;
}

/**
 * Current rate-limit state. This is deliberately separate from token history;
 * it is an in-memory view of the provider's latest observation.
 */
export interface RateLimitSnapshot {
	readonly observedAt?: number;
	readonly windows: readonly RateLimitWindow[];
	readonly planType?: string;
	/** Parsed for safe internal inspection; never rendered as currency. */
	readonly credits?: {
		readonly hasCredits?: boolean;
		readonly unlimited?: boolean;
		readonly balance?: string;
	};
}

/**
 * Provider-neutral usage data.
 * Optional fields remain absent when a provider does not expose them reliably.
 */
export interface UsageSnapshot {
	readonly provider: ProviderId;
	readonly timestamp: number;
	readonly sessionId?: string;
	readonly model?: string;
	readonly workspace?: string;
	readonly workspaceId?: string;
	readonly workspaceName?: string;
	readonly inputTokens: number;
	readonly cachedInputTokens?: number;
	readonly outputTokens: number;
	readonly reasoningTokens?: number;
	readonly totalTokens: number;
	readonly contextWindow?: number;
	readonly contextUsedTokens?: number;
	readonly rateLimits?: RateLimitSnapshot;
}
