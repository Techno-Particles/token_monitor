import * as fs from 'node:fs';
import { createReadStream } from 'node:fs';
import * as readline from 'node:readline';

import { RateLimitSnapshot, RateLimitWindow } from '../../core/types';
import { CodexParsedUsage, CodexTokenUsage, CodexUsagePoint } from './codexTypes';

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? value as JsonRecord
		: undefined;
}

function readNumber(record: JsonRecord, key: string): number | undefined {
	const value = record[key];
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function readPercentage(record: JsonRecord, key: string): number | undefined {
	const value = record[key];
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
		? value
		: undefined;
}

/** Codex reports resets_at in epoch seconds, not milliseconds. */
function readRateLimitReset(value: unknown): number | undefined {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
		return undefined;
	}

	const milliseconds = value < 1_000_000_000_000 ? value * 1000 : value;
	return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
}

function readSafeInteger(record: JsonRecord, key: string): number | undefined {
	const value = record[key];
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function readTimestamp(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value)) {
		const milliseconds = value < 1_000_000_000_000 ? value * 1000 : value;
		return Number.isSafeInteger(milliseconds) && milliseconds >= 0 ? milliseconds : undefined;
	}
	if (typeof value === 'string') {
		const parsed = Date.parse(value);
		return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
	}
	return undefined;
}

function readString(record: JsonRecord, key: string): string | undefined {
	const value = record[key];
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function parseTokenUsage(value: unknown): CodexTokenUsage | undefined {
	const usage = asRecord(value);
	if (!usage) {
		return undefined;
	}

	const inputTokens = readSafeInteger(usage, 'input_tokens');
	const outputTokens = readSafeInteger(usage, 'output_tokens');
	const totalTokens = readSafeInteger(usage, 'total_tokens');
	if (inputTokens === undefined || outputTokens === undefined || totalTokens === undefined) {
		return undefined;
	}

	return {
		inputTokens,
		cachedInputTokens: readNumber(usage, 'cached_input_tokens'),
		outputTokens,
		reasoningTokens: readNumber(usage, 'reasoning_output_tokens'),
		totalTokens,
	};
}

function rateLimitLabels(key: RateLimitWindow['key'], windowMinutes: number | undefined): Pick<RateLimitWindow, 'label' | 'compactLabel'> {
	if (windowMinutes === 300) {
		return { label: '5-hour limit', compactLabel: '5h' };
	}
	if (windowMinutes === 10080) {
		return { label: 'Weekly limit', compactLabel: 'W' };
	}
	return key === 'primary'
		? { label: 'Primary limit', compactLabel: 'Primary' }
		: { label: 'Secondary limit', compactLabel: 'Secondary' };
}

function parseRateLimit(value: unknown, key: RateLimitWindow['key']): RateLimitWindow | undefined {
	const limit = asRecord(value);
	if (!limit) {
		return undefined;
	}

	const usedPercent = readPercentage(limit, 'used_percent');
	const reportedRemainingPercent = readPercentage(limit, 'remaining_percent');
	const windowMinutes = readNumber(limit, 'window_minutes');
	const resetsAt = readRateLimitReset(limit.resets_at);
	if (usedPercent === undefined && reportedRemainingPercent === undefined && windowMinutes === undefined && resetsAt === undefined) {
		return undefined;
	}

	return {
		key,
		...rateLimitLabels(key, windowMinutes),
		...(usedPercent === undefined ? {} : { usedPercent, remainingPercent: reportedRemainingPercent ?? 100 - usedPercent }),
		...(usedPercent !== undefined || reportedRemainingPercent === undefined ? {} : { remainingPercent: reportedRemainingPercent }),
		...(windowMinutes === undefined ? {} : { windowMinutes }),
		...(resetsAt === undefined ? {} : { resetsAt }),
	};
}

function parseCredits(value: unknown): RateLimitSnapshot['credits'] | undefined {
	const credits = asRecord(value);
	if (!credits) {
		return undefined;
	}

	const hasCredits = typeof credits.has_credits === 'boolean' ? credits.has_credits : undefined;
	const unlimited = typeof credits.unlimited === 'boolean' ? credits.unlimited : undefined;
	const balance = typeof credits.balance === 'string' && /^\d+(?:\.\d+)?$/.test(credits.balance)
		? credits.balance
		: undefined;
	if (hasCredits === undefined && unlimited === undefined && balance === undefined) {
		return undefined;
	}

	return { hasCredits, unlimited, balance };
}

function parseRateLimits(value: unknown, observedAt?: number): RateLimitSnapshot | undefined {
	const limits = asRecord(value);
	if (!limits) {
		return undefined;
	}

	const windows = (['primary', 'secondary'] as const)
		.map((key) => parseRateLimit(limits[key], key))
		.filter((limit): limit is RateLimitWindow => limit !== undefined);
	const planType = readString(limits, 'plan_type');
	const credits = parseCredits(limits.credits);
	if (windows.length === 0 && planType === undefined && credits === undefined) {
		return undefined;
	}

	return {
		...(observedAt === undefined ? {} : { observedAt }),
		windows,
		...(planType === undefined ? {} : { planType }),
		...(credits === undefined ? {} : { credits }),
	};
}

function parseTokenCountEvent(event: unknown): {
	sessionUsage: CodexTokenUsage;
	lastTurnUsage?: CodexTokenUsage;
	modelContextWindow?: number;
	rateLimits?: RateLimitSnapshot;
	rateLimitsObserved: boolean;
} | undefined {
	const eventRecord = asRecord(event);
	const payload = asRecord(eventRecord?.payload);
	if (eventRecord?.type !== 'event_msg' || payload?.type !== 'token_count') {
		return undefined;
	}

	const info = asRecord(payload.info);
	const sessionUsage = parseTokenUsage(info?.total_token_usage);
	if (!sessionUsage) {
		return undefined;
	}

	return {
		sessionUsage,
		lastTurnUsage: parseTokenUsage(info?.last_token_usage),
		modelContextWindow: info ? readSafeInteger(info, 'model_context_window') : undefined,
		rateLimits: parseRateLimits(payload.rate_limits, readTimestamp(eventRecord.timestamp)),
		rateLimitsObserved: Object.prototype.hasOwnProperty.call(payload, 'rate_limits'),
	};
}

function parseTokenUsageRecord(event: unknown): {
	sessionUsage: CodexTokenUsage;
	lastTurnUsage?: CodexTokenUsage;
} | undefined {
	const eventRecord = asRecord(event);
	if (eventRecord?.type !== 'token_usage_record') {
		return undefined;
	}

	const payload = asRecord(eventRecord.payload);
	const sessionUsage = parseTokenUsage(payload?.thread_token_usage);
	if (!sessionUsage) {
		return undefined;
	}

	return {
		sessionUsage,
		lastTurnUsage: parseTokenUsage(payload?.usage),
	};
}

function readTurnModel(event: unknown): string | undefined {
	const eventRecord = asRecord(event);
	if (eventRecord?.type !== 'turn_context') {
		return undefined;
	}

	return readString(eventRecord, 'model') ?? readString(asRecord(eventRecord.payload) ?? {}, 'model');
}

/** Accumulates only the latest valid Codex metadata snapshots. */
export class CodexTokenAccumulator {
	private latestTokenEvent: ReturnType<typeof parseTokenCountEvent>;
	private latestUsageRecord: ReturnType<typeof parseTokenUsageRecord>;
	private tokenEventCount = 0;
	private model: string | undefined;
	private sessionId: string | undefined;
	private startedAt: number | undefined;
	private lastUpdatedAt: number | undefined;
	private cwd: string | undefined;
	private latestRateLimits: RateLimitSnapshot | undefined;
	private readonly usageTimeline: CodexUsagePoint[] = [];

	consumeLine(line: string): void {
		if (!line.trim()) {
			return;
		}

		let event: unknown;
		try {
			event = JSON.parse(line) as unknown;
		} catch {
			// Complete malformed lines are ignored; incomplete lines are held by the
			// incremental reader until a newline arrives.
			return;
		}

		const eventRecord = asRecord(event);
		const eventTimestamp = readTimestamp(eventRecord?.timestamp);
		const payload = asRecord(eventRecord?.payload);
		if (eventRecord?.type === 'session_meta') {
			this.sessionId = readString(payload ?? {}, 'session_id') ?? readString(payload ?? {}, 'id') ?? this.sessionId;
			this.startedAt = readTimestamp(payload?.timestamp) ?? eventTimestamp ?? this.startedAt;
			this.cwd = readString(payload ?? {}, 'cwd') ?? this.cwd;
		}
		if (eventRecord?.type === 'turn_context') {
			this.cwd = readString(payload ?? {}, 'cwd') ?? this.cwd;
		}
		this.model = readTurnModel(event) ?? this.model;
		const tokenEvent = parseTokenCountEvent(event);
		if (tokenEvent) {
			this.tokenEventCount++;
			this.latestTokenEvent = tokenEvent;
			if (tokenEvent.rateLimitsObserved && tokenEvent.rateLimits !== undefined) {
				this.latestRateLimits = tokenEvent.rateLimits;
			} else if (tokenEvent.rateLimitsObserved && tokenEvent.rateLimits === undefined && payload && payload.rate_limits === null) {
				// Codex uses explicit null to report that quota data is unavailable.
				// A missing optional field is intentionally not treated as a reset.
				this.latestRateLimits = undefined;
			}
			this.lastUpdatedAt = eventTimestamp ?? this.lastUpdatedAt;
			this.usageTimeline.push({ timestamp: eventTimestamp, usage: tokenEvent.sessionUsage });
		}

		const usageRecord = parseTokenUsageRecord(event);
		if (usageRecord) {
			this.latestUsageRecord = usageRecord;
			this.lastUpdatedAt = eventTimestamp ?? this.lastUpdatedAt;
			this.usageTimeline.push({ timestamp: eventTimestamp, usage: usageRecord.sessionUsage });
		}
	}

	getResult(): CodexParsedUsage | undefined {
		const sessionUsage = this.latestUsageRecord?.sessionUsage ?? this.latestTokenEvent?.sessionUsage;
		if (!sessionUsage) {
			return undefined;
		}

		return {
			sessionUsage,
			lastTurnUsage: this.latestUsageRecord?.lastTurnUsage ?? this.latestTokenEvent?.lastTurnUsage,
			modelContextWindow: this.latestTokenEvent?.modelContextWindow,
			rateLimits: this.latestRateLimits,
			model: this.model,
			tokenEventCount: this.tokenEventCount,
			sessionId: this.sessionId,
			startedAt: this.startedAt,
			lastUpdatedAt: this.lastUpdatedAt,
			cwd: this.cwd,
			usageTimeline: this.usageTimeline,
		};
	}

	reset(): void {
		this.latestTokenEvent = undefined;
		this.latestUsageRecord = undefined;
		this.tokenEventCount = 0;
		this.model = undefined;
		this.sessionId = undefined;
		this.startedAt = undefined;
		this.lastUpdatedAt = undefined;
		this.cwd = undefined;
		this.latestRateLimits = undefined;
		this.usageTimeline.length = 0;
	}
}

/** Streams a rollout JSONL file and retains only the latest valid token snapshot. */
export class CodexTokenParser {
	async parseFile(filePath: string): Promise<CodexParsedUsage | undefined> {
		return this.parseFileWithHistory(filePath);
	}

	async parseFileWithHistory(filePath: string): Promise<CodexParsedUsage | undefined> {
		let input: fs.ReadStream;
		try {
			input = createReadStream(filePath, { encoding: 'utf8' });
		} catch {
			return undefined;
		}

		const reader = readline.createInterface({ input, crlfDelay: Infinity });
		const accumulator = new CodexTokenAccumulator();
		try {
			for await (const line of reader) {
				accumulator.consumeLine(line);
			}
		} catch {
			return undefined;
		} finally {
			reader.close();
		}

		return accumulator.getResult();
	}
}
