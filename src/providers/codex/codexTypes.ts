import { RateLimitSnapshot } from '../../core/types';

export interface CodexTokenUsage {
	readonly inputTokens: number;
	readonly cachedInputTokens?: number;
	readonly outputTokens: number;
	readonly reasoningTokens?: number;
	readonly totalTokens: number;
}

/** Parsed Codex usage with session and latest-turn semantics kept separate. */
export interface CodexParsedUsage {
	readonly sessionUsage: CodexTokenUsage;
	readonly lastTurnUsage?: CodexTokenUsage;
	readonly model?: string;
	readonly modelContextWindow?: number;
	readonly rateLimits?: RateLimitSnapshot;
	readonly tokenEventCount: number;
	readonly sessionId?: string;
	readonly startedAt?: number;
	readonly lastUpdatedAt?: number;
	readonly cwd?: string;
	readonly usageTimeline?: readonly CodexUsagePoint[];
}

export interface CodexUsagePoint {
	readonly timestamp?: number;
	readonly usage: CodexTokenUsage;
}
