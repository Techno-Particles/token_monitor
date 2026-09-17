import { UsageSnapshot, ProviderId } from '../core/types';
import { tokenComposition } from '../core/tokenMetrics';
import { UsageStorage } from '../storage/usageStorage';
import { dateKeyOffset, isDateKeyInRange, localDateKey } from './time';
import {
	HistoryFilter,
	HistoricalDailyUsage,
	HistoricalUsageAggregate,
	PersistedUsageHistory,
	UsageBreakdown,
	UsageCounters,
	UsageSessionRecord,
} from './historyTypes';

export const HISTORY_SCHEMA_VERSION = 2 as const;
export const MAX_SESSION_RECORDS = 10_000;
export const MAX_DAILY_BUCKETS_PER_SESSION = 4_096;

export interface HistoricalUsagePoint {
	readonly timestamp?: number;
	readonly usage: UsageCounters;
}

export interface HistoricalSessionImport {
	readonly provider: ProviderId;
	readonly sessionId: string;
	readonly startedAt?: number;
	readonly lastUpdatedAt?: number;
	readonly model?: string;
	readonly workspaceId?: string;
	readonly workspaceName?: string;
	readonly usage: UsageCounters;
	readonly points?: readonly HistoricalUsagePoint[];
}

const EMPTY_COUNTERS: UsageCounters = {
	inputTokens: 0,
	outputTokens: 0,
	totalTokens: 0,
};

const EMPTY_BREAKDOWN: UsageBreakdown = {
	inputTokens: 0,
	freshInputTokens: 0,
	outputTokens: 0,
	totalTokens: 0,
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeCounter(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function readCounters(value: unknown): UsageCounters | undefined {
	if (!isRecord(value) || !isSafeCounter(value.inputTokens) || !isSafeCounter(value.outputTokens) || !isSafeCounter(value.totalTokens)) {
		return undefined;
	}
	if (('cachedInputTokens' in value && value.cachedInputTokens !== undefined && !isSafeCounter(value.cachedInputTokens))
		|| ('reasoningTokens' in value && value.reasoningTokens !== undefined && !isSafeCounter(value.reasoningTokens))) {
		return undefined;
	}

	return {
		inputTokens: value.inputTokens,
		cachedInputTokens: value.cachedInputTokens === undefined ? undefined : isSafeCounter(value.cachedInputTokens) ? value.cachedInputTokens : undefined,
		outputTokens: value.outputTokens,
		reasoningTokens: value.reasoningTokens === undefined ? undefined : isSafeCounter(value.reasoningTokens) ? value.reasoningTokens : undefined,
		totalTokens: value.totalTokens,
	};
}

function readTimestamp(value: unknown): number | undefined {
	return isSafeCounter(value) ? value : undefined;
}

function readText(value: unknown, maxLength = 256): string | undefined {
	return typeof value === 'string'
		&& value.length > 0
		&& value.length <= maxLength
		&& !/[\u0000-\u001f\u007f]/.test(value)
		&& !value.startsWith('/')
		&& !value.startsWith('\\\\')
		&& !/^[A-Za-z]:[\\/]/.test(value)
		? value
		: undefined;
}

function readDailyUsage(value: unknown): Record<string, UsageCounters> | undefined {
	if (!isRecord(value)) {
		return undefined;
	}

	const dailyUsage: Record<string, UsageCounters> = {};
	for (const [dateKey, rawCounters] of Object.entries(value)) {
		if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
			continue;
		}
		const dailyCounters = readCounters(rawCounters);
		if (dailyCounters && Object.keys(dailyUsage).length < MAX_DAILY_BUCKETS_PER_SESSION) {
			dailyUsage[dateKey] = dailyCounters;
		}
	}
	return dailyUsage;
}

function saturatingAdd(left: number, right: number): number {
	return left > Number.MAX_SAFE_INTEGER - right ? Number.MAX_SAFE_INTEGER : left + right;
}

function saturatingAddCounters(left: UsageCounters, right: UsageCounters): UsageCounters {
	return {
		inputTokens: saturatingAdd(left.inputTokens, right.inputTokens),
		cachedInputTokens: left.cachedInputTokens === undefined && right.cachedInputTokens === undefined
			? undefined
			: saturatingAdd(left.cachedInputTokens ?? 0, right.cachedInputTokens ?? 0),
		outputTokens: saturatingAdd(left.outputTokens, right.outputTokens),
		reasoningTokens: left.reasoningTokens === undefined && right.reasoningTokens === undefined
			? undefined
			: saturatingAdd(left.reasoningTokens ?? 0, right.reasoningTokens ?? 0),
		totalTokens: saturatingAdd(left.totalTokens, right.totalTokens),
	};
}

function reconstructLifetimeUsage(counters: UsageCounters, dailyUsage: Readonly<Record<string, UsageCounters>>): UsageCounters {
	let dailyTotal = EMPTY_COUNTERS;
	for (const dailyCounters of Object.values(dailyUsage)) {
		dailyTotal = saturatingAddCounters(dailyTotal, dailyCounters);
	}
	// Daily buckets are positive historical deltas. Preserve both their known
	// total and any larger cumulative value already stored in the session.
	return mergeCounters(counters, dailyTotal);
}

function readPersistedSession(value: unknown, reconstructLegacyUsage: boolean): UsageSessionRecord | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const counters = readCounters(value);
	const checkpoint = readCounters(value.checkpoint);
	const provider = value.provider;
	if (!counters || !checkpoint || (provider !== 'codex' && provider !== 'claude' && provider !== 'gemini')) {
		return undefined;
	}
	const sessionId = readText(value.sessionId);
	const startedAt = readTimestamp(value.startedAt);
	const lastUpdatedAt = readTimestamp(value.lastUpdatedAt);
	const dailyUsage = readDailyUsage(value.dailyUsage);
	if (!sessionId || startedAt === undefined || lastUpdatedAt === undefined || dailyUsage === undefined) {
		return undefined;
	}
	const storedLifetime = readCounters(value.lifetimeUsage) ?? counters;
	const lifetimeUsage = reconstructLifetimeUsage(
		reconstructLegacyUsage ? counters : storedLifetime,
		dailyUsage,
	);

	const workspaceName = readText(value.workspaceName, 128);
	const workspaceId = readText(value.workspaceId, 128);
	return {
		...counters,
		provider,
		sessionId,
		startedAt,
		lastUpdatedAt,
		model: readText(value.model),
		workspaceId: workspaceId && !workspaceId.includes('/') && !workspaceId.includes('\\') ? workspaceId : undefined,
		workspaceName: workspaceName && !workspaceName.includes('/') && !workspaceName.includes('\\') ? workspaceName : undefined,
		lifetimeUsage,
		checkpoint,
		dailyUsage,
	};
}

function emptyHistory(): PersistedUsageHistory {
	return { version: HISTORY_SCHEMA_VERSION, sessions: [], backfill: {} };
}

function readHistory(value: unknown): PersistedUsageHistory {
	if (!isRecord(value) || (value.version !== 1 && value.version !== HISTORY_SCHEMA_VERSION) || !Array.isArray(value.sessions)) {
		return emptyHistory();
	}

	const reconstructLegacyUsage = value.version === 1;
	const sessions = value.sessions
		.map((session) => readPersistedSession(session, reconstructLegacyUsage))
		.filter((session): session is UsageSessionRecord => session !== undefined)
		.slice(0, MAX_SESSION_RECORDS);
	const backfill: Record<string, Record<string, boolean>> = {};
	if (isRecord(value.backfill)) {
		for (const [provider, rawSessions] of Object.entries(value.backfill)) {
			if (!isRecord(rawSessions)) {
				continue;
			}
			backfill[provider] = {};
			for (const [sessionId, imported] of Object.entries(rawSessions)) {
				if (imported === true && Object.keys(backfill[provider]).length < MAX_SESSION_RECORDS) {
					backfill[provider][sessionId] = true;
				}
			}
		}
	}
	return { version: HISTORY_SCHEMA_VERSION, sessions, backfill };
}

function needsLifetimeRepair(value: unknown, history: PersistedUsageHistory): boolean {
	if (!isRecord(value) || !Array.isArray(value.sessions)) {
		return false;
	}
	return value.sessions.some((rawSession, index) => {
		const normalized = history.sessions[index];
		if (!isRecord(rawSession) || !normalized) {
			return false;
		}
		const storedLifetime = readCounters(rawSession.lifetimeUsage) ?? readCounters(rawSession);
		return storedLifetime !== undefined && !countersEqual(storedLifetime, normalized.lifetimeUsage);
	});
}

function maxOptional(left: number | undefined, right: number | undefined): number | undefined {
	if (left === undefined) {
		return right;
	}
	if (right === undefined) {
		return left;
	}
	return Math.max(left, right);
}

function mergeCounters(left: UsageCounters, right: UsageCounters): UsageCounters {
	return {
		inputTokens: Math.max(left.inputTokens, right.inputTokens),
		cachedInputTokens: maxOptional(left.cachedInputTokens, right.cachedInputTokens),
		outputTokens: Math.max(left.outputTokens, right.outputTokens),
		reasoningTokens: maxOptional(left.reasoningTokens, right.reasoningTokens),
		totalTokens: Math.max(left.totalTokens, right.totalTokens),
	};
}

function positiveDelta(previous: UsageCounters, current: UsageCounters): UsageCounters {
	return {
		inputTokens: Math.max(0, current.inputTokens - previous.inputTokens),
		cachedInputTokens: current.cachedInputTokens === undefined
			? undefined
			: Math.max(0, current.cachedInputTokens - (previous.cachedInputTokens ?? 0)),
		outputTokens: Math.max(0, current.outputTokens - previous.outputTokens),
		reasoningTokens: current.reasoningTokens === undefined
			? undefined
			: Math.max(0, current.reasoningTokens - (previous.reasoningTokens ?? 0)),
		totalTokens: Math.max(0, current.totalTokens - previous.totalTokens),
	};
}

function hasPositiveUsage(counters: UsageCounters): boolean {
	return counters.totalTokens > 0 || counters.inputTokens > 0 || counters.outputTokens > 0;
}

function addCounters(left: UsageCounters, right: UsageCounters): UsageCounters {
	const add = (a: number, b: number): number => {
		const sum = a + b;
		if (!Number.isSafeInteger(sum)) {
			throw new RangeError('Usage counter exceeded Number.MAX_SAFE_INTEGER.');
		}
		return sum;
	};
	return {
		inputTokens: add(left.inputTokens, right.inputTokens),
		cachedInputTokens: left.cachedInputTokens === undefined && right.cachedInputTokens === undefined
			? undefined
			: add(left.cachedInputTokens ?? 0, right.cachedInputTokens ?? 0),
		outputTokens: add(left.outputTokens, right.outputTokens),
		reasoningTokens: left.reasoningTokens === undefined && right.reasoningTokens === undefined
			? undefined
			: add(left.reasoningTokens ?? 0, right.reasoningTokens ?? 0),
		totalTokens: add(left.totalTokens, right.totalTokens),
	};
}

function countersEqual(left: UsageCounters, right: UsageCounters): boolean {
	return left.inputTokens === right.inputTokens
		&& left.cachedInputTokens === right.cachedInputTokens
		&& left.outputTokens === right.outputTokens
		&& left.reasoningTokens === right.reasoningTokens
		&& left.totalTokens === right.totalTokens;
}

function safeSnapshotCounters(snapshot: UsageSnapshot): UsageCounters | undefined {
	return readCounters({
		inputTokens: snapshot.inputTokens,
		cachedInputTokens: snapshot.cachedInputTokens,
		outputTokens: snapshot.outputTokens,
		reasoningTokens: snapshot.reasoningTokens,
		totalTokens: snapshot.totalTokens,
	});
}

function isProvider(value: unknown): value is ProviderId {
	return value === 'codex' || value === 'claude' || value === 'gemini';
}

function dimensionKey(value: string | undefined, fallback: string): string {
	return value && value.length > 0 ? value : fallback;
}

/**
 * Persistent session ledger. Cumulative snapshots update one record; daily
 * history is made only from positive deltas against the persisted checkpoint.
 */
export class SessionLedger {
	private history: PersistedUsageHistory;
	private writeTimer?: NodeJS.Timeout;
	private writeChain: Promise<void> = Promise.resolve();

	constructor(private readonly storage: UsageStorage, private readonly debounceMs = 250) {
		const persisted = storage.getPersistedHistory();
		this.history = readHistory(persisted);
		if (isRecord(persisted) && (persisted.version === 1 || needsLifetimeRepair(persisted, this.history))) {
			this.scheduleWrite();
		}
	}

	getSessions(): readonly UsageSessionRecord[] {
		return this.history.sessions;
	}

	getSession(provider: ProviderId, sessionId: string): UsageSessionRecord | undefined {
		return this.history.sessions.find((session) => session.provider === provider && session.sessionId === sessionId);
	}

	/**
	 * Advances a session checkpoint without adding usage to daily history. This
	 * prevents time spent while history is disabled from becoming a giant delta.
	 */
	seedSnapshot(snapshot: UsageSnapshot): boolean {
		const counters = safeSnapshotCounters(snapshot);
		const sessionId = readText(snapshot.sessionId);
		if (!counters || !sessionId || !isProvider(snapshot.provider) || !Number.isSafeInteger(snapshot.timestamp) || snapshot.timestamp < 0 || Number.isNaN(new Date(snapshot.timestamp).getTime())) {
			return false;
		}

		const index = this.history.sessions.findIndex((session) => session.provider === snapshot.provider && session.sessionId === sessionId);
		if (index < 0) {
			if (this.history.sessions.length >= MAX_SESSION_RECORDS) {
				return false;
			}
			this.history = {
				...this.history,
				sessions: [...this.history.sessions, {
					...counters,
					provider: snapshot.provider,
					sessionId,
					startedAt: snapshot.timestamp,
					lastUpdatedAt: snapshot.timestamp,
					model: readText(snapshot.model),
					workspaceId: readText(snapshot.workspaceId, 128),
					workspaceName: readText(snapshot.workspaceName, 128),
					lifetimeUsage: EMPTY_COUNTERS,
					checkpoint: counters,
					dailyUsage: {},
				}],
			};
			this.scheduleWrite();
			return true;
		}

		const previous = this.history.sessions[index];
		const merged = mergeCounters(previous, counters);
		const updated: UsageSessionRecord = {
			...merged,
			provider: previous.provider,
			sessionId: previous.sessionId,
			startedAt: previous.startedAt,
			lastUpdatedAt: Math.max(previous.lastUpdatedAt, snapshot.timestamp),
			model: readText(snapshot.model) ?? previous.model,
			workspaceId: readText(snapshot.workspaceId, 128) ?? previous.workspaceId,
			workspaceName: readText(snapshot.workspaceName, 128) ?? previous.workspaceName,
			lifetimeUsage: previous.lifetimeUsage,
			checkpoint: merged,
			dailyUsage: previous.dailyUsage,
		};
		this.history = { ...this.history, sessions: this.history.sessions.map((session, candidateIndex) => candidateIndex === index ? updated : session) };
		this.scheduleWrite();
		return true;
	}

	/** Removes expired daily buckets while retaining session totals and checkpoints. */
	pruneDailyUsage(retentionDays: number, now = Date.now()): boolean {
		if (!Number.isSafeInteger(retentionDays) || retentionDays < 1 || retentionDays > 3_650) {
			return false;
		}
		const cutoff = dateKeyOffset(localDateKey(now), -(retentionDays - 1));
		let changed = false;
		const sessions = this.history.sessions.map((session) => {
			const dailyUsage = Object.fromEntries(Object.entries(session.dailyUsage).filter(([dateKey]) => dateKey >= cutoff));
			if (Object.keys(dailyUsage).length !== Object.keys(session.dailyUsage).length) {
				changed = true;
				return { ...session, dailyUsage };
			}
			return session;
		});
		if (changed) {
			this.history = { ...this.history, sessions };
			this.scheduleWrite();
		}
		return changed;
	}

	recordSnapshot(snapshot: UsageSnapshot): boolean {
		const counters = safeSnapshotCounters(snapshot);
		const sessionId = readText(snapshot.sessionId);
		if (!counters || !sessionId || !isProvider(snapshot.provider) || !Number.isSafeInteger(snapshot.timestamp) || snapshot.timestamp < 0 || Number.isNaN(new Date(snapshot.timestamp).getTime())) {
			return false;
		}

		const index = this.history.sessions.findIndex((session) => session.provider === snapshot.provider && session.sessionId === sessionId);
		if (index < 0) {
			if (this.history.sessions.length >= MAX_SESSION_RECORDS) {
				return false;
			}
			const dailyUsage: Record<string, UsageCounters> = {};
			if (hasPositiveUsage(counters)) {
				dailyUsage[localDateKey(snapshot.timestamp)] = counters;
			}
			this.history = {
				...this.history,
				sessions: [...this.history.sessions, {
					...counters,
					provider: snapshot.provider,
					sessionId,
					startedAt: snapshot.timestamp,
					lastUpdatedAt: snapshot.timestamp,
					model: readText(snapshot.model),
					workspaceId: readText(snapshot.workspaceId, 128),
					workspaceName: readText(snapshot.workspaceName, 128),
					lifetimeUsage: counters,
					checkpoint: counters,
					dailyUsage,
				}],
			};
			this.scheduleWrite();
			return true;
		}

		const previous = this.history.sessions[index];
		const merged = mergeCounters(previous, counters);
		const checkpoint = merged.totalTokens > previous.checkpoint.totalTokens
			? merged
			: previous.checkpoint;
		let dailyUsage = previous.dailyUsage;
		let lifetimeUsage = previous.lifetimeUsage;
		if (checkpoint !== previous.checkpoint) {
			const delta = positiveDelta(previous.checkpoint, checkpoint);
			lifetimeUsage = addCounters(previous.lifetimeUsage, delta);
			if (hasPositiveUsage(delta)) {
				const key = localDateKey(snapshot.timestamp);
				if (dailyUsage[key] || Object.keys(dailyUsage).length < MAX_DAILY_BUCKETS_PER_SESSION) {
					dailyUsage = {
						...dailyUsage,
						[key]: addCounters(dailyUsage[key] ?? EMPTY_COUNTERS, delta),
					};
				}
			}
		}
		const updated: UsageSessionRecord = {
			...merged,
			provider: previous.provider,
			sessionId: previous.sessionId,
			startedAt: previous.startedAt,
			lastUpdatedAt: Math.max(previous.lastUpdatedAt, snapshot.timestamp),
			model: readText(snapshot.model) ?? previous.model,
			workspaceId: readText(snapshot.workspaceId, 128) ?? previous.workspaceId,
			workspaceName: readText(snapshot.workspaceName, 128) ?? previous.workspaceName,
			lifetimeUsage,
			checkpoint,
			dailyUsage,
		};
		if (countersEqual(previous, updated) && countersEqual(previous.lifetimeUsage, updated.lifetimeUsage) && previous.lastUpdatedAt === updated.lastUpdatedAt && previous.model === updated.model && previous.workspaceId === updated.workspaceId && previous.workspaceName === updated.workspaceName && previous.checkpoint === updated.checkpoint && previous.dailyUsage === updated.dailyUsage) {
			return false;
		}
		this.history = { ...this.history, sessions: this.history.sessions.map((session, candidateIndex) => candidateIndex === index ? updated : session) };
		this.scheduleWrite();
		return true;
	}

	importSession(session: HistoricalSessionImport): boolean {
		if (!isProvider(session.provider) || !readText(session.sessionId) || !safeSnapshotCounters({
			provider: session.provider,
			timestamp: session.lastUpdatedAt ?? session.startedAt ?? 0,
			sessionId: session.sessionId,
			inputTokens: session.usage.inputTokens,
			cachedInputTokens: session.usage.cachedInputTokens,
			outputTokens: session.usage.outputTokens,
			reasoningTokens: session.usage.reasoningTokens,
			totalTokens: session.usage.totalTokens,
		})) {
			return false;
		}
		if (this.getSession(session.provider, session.sessionId)) {
			return false;
		}
		if (this.history.sessions.length >= MAX_SESSION_RECORDS) {
			return false;
		}

		const startedAt = session.startedAt ?? session.points?.find((point) => point.timestamp !== undefined)?.timestamp;
		const lastUpdatedAt = session.lastUpdatedAt ?? startedAt;
		if (startedAt === undefined || lastUpdatedAt === undefined || !Number.isSafeInteger(startedAt) || !Number.isSafeInteger(lastUpdatedAt)) {
			return false;
		}

		const dailyUsage: Record<string, UsageCounters> = {};
		const points = [...(session.points ?? [])]
			.filter((point) => point.timestamp === undefined || Number.isSafeInteger(point.timestamp))
			.sort((left, right) => (left.timestamp ?? startedAt) - (right.timestamp ?? startedAt));
		let previous = EMPTY_COUNTERS;
		for (const point of points) {
			const current = mergeCounters(previous, point.usage);
			if (current.totalTokens > previous.totalTokens) {
				const delta = positiveDelta(previous, current);
				const dateKey = localDateKey(point.timestamp ?? startedAt);
				if (dailyUsage[dateKey] || Object.keys(dailyUsage).length < MAX_DAILY_BUCKETS_PER_SESSION) {
					dailyUsage[dateKey] = addCounters(dailyUsage[dateKey] ?? EMPTY_COUNTERS, delta);
				}
			}
			previous = current;
		}
		if (Object.keys(dailyUsage).length === 0 && hasPositiveUsage(session.usage)) {
			dailyUsage[localDateKey(startedAt)] = session.usage;
		}

		this.history = {
			...this.history,
			sessions: [...this.history.sessions, {
				...session.usage,
				provider: session.provider,
				sessionId: session.sessionId,
				startedAt,
				lastUpdatedAt,
				model: readText(session.model),
				workspaceId: readText(session.workspaceId, 128),
				workspaceName: readText(session.workspaceName, 128),
				lifetimeUsage: session.usage,
				checkpoint: session.usage,
				dailyUsage,
			}],
		};
		this.scheduleWrite();
		return true;
	}

	queryToday(now = Date.now(), filter: HistoryFilter = {}): HistoricalUsageAggregate {
		return this.queryRange(localDateKey(now), localDateKey(now), filter);
	}

	queryLast7Days(now = Date.now(), filter: HistoryFilter = {}): HistoricalUsageAggregate {
		const end = localDateKey(now);
		return this.queryRange(dateKeyOffset(end, -6), end, filter);
	}

	queryLast30Days(now = Date.now(), filter: HistoryFilter = {}): HistoricalUsageAggregate {
		const end = localDateKey(now);
		return this.queryRange(dateKeyOffset(end, -29), end, filter);
	}

	queryAllTime(filter: HistoryFilter = {}): HistoricalUsageAggregate {
		return this.queryRange(undefined, undefined, filter);
	}

	/** Returns calendar-day buckets for lightweight chart rendering. */
	queryDailyUsage(days: 7 | 30, now = Date.now(), filter: HistoryFilter = {}): readonly HistoricalDailyUsage[] {
		const end = localDateKey(now);
		const points: HistoricalDailyUsage[] = [];
		for (let offset = days - 1; offset >= 0; offset--) {
			const dateKey = dateKeyOffset(end, -offset);
			let usage = EMPTY_BREAKDOWN;
			for (const session of this.history.sessions) {
				if (!this.matchesFilter(session, filter)) {
					continue;
				}
				const dailyUsage = session.dailyUsage[dateKey];
				if (dailyUsage) {
					usage = addBreakdowns(usage, breakdownFromCounters(dailyUsage));
				}
			}
			points.push({ dateKey, ...usage });
		}
		return points;
	}

	isBackfillComplete(provider: ProviderId): boolean {
		return this.history.backfill[provider]?.complete === true;
	}

	isBackfillSessionImported(provider: ProviderId, sessionId: string): boolean {
		return this.history.backfill[provider]?.[sessionId] === true;
	}

	markBackfillSessionImported(provider: ProviderId, sessionId: string): void {
		this.history = {
			...this.history,
			backfill: {
				...this.history.backfill,
				[provider]: { ...this.history.backfill[provider], [sessionId]: true },
			},
		};
		this.scheduleWrite();
	}

	markBackfillComplete(provider: ProviderId): void {
		this.history = {
			...this.history,
			backfill: {
				...this.history.backfill,
				[provider]: { ...this.history.backfill[provider], complete: true },
			},
		};
		this.scheduleWrite();
	}

	async reset(): Promise<void> {
		if (this.writeTimer) {
			clearTimeout(this.writeTimer);
			this.writeTimer = undefined;
		}
		this.history = emptyHistory();
		await this.writeChain;
		await this.storage.clear();
	}

	async flush(): Promise<void> {
		if (this.writeTimer) {
			clearTimeout(this.writeTimer);
			this.writeTimer = undefined;
		}
		const pending = this.history;
		this.writeChain = this.writeChain.then(() => this.storage.saveHistory(pending));
		await this.writeChain;
	}

	dispose(): void {
		void this.flush().catch(() => undefined);
	}

	private scheduleWrite(): void {
		if (this.writeTimer) {
			clearTimeout(this.writeTimer);
		}
		this.writeTimer = setTimeout(() => {
			this.writeTimer = undefined;
			void this.flush().catch(() => undefined);
		}, this.debounceMs);
	}

	private queryRange(startDateKey: string | undefined, endDateKey: string | undefined, filter: HistoryFilter): HistoricalUsageAggregate {
		let totals = EMPTY_BREAKDOWN;
		let sessionCount = 0;
		const byProvider: Record<string, UsageBreakdown> = {};
		const byModel: Record<string, UsageBreakdown> = {};
		const byWorkspace: Record<string, UsageBreakdown> = {};

		for (const session of this.history.sessions) {
			if (!this.matchesFilter(session, filter)) {
				continue;
			}
			let sessionTotals = startDateKey === undefined && endDateKey === undefined
				? session.lifetimeUsage
				: EMPTY_COUNTERS;
			if (startDateKey !== undefined && endDateKey !== undefined) {
				for (const [dateKey, daily] of Object.entries(session.dailyUsage)) {
					if (isDateKeyInRange(dateKey, startDateKey, endDateKey)) {
						sessionTotals = addCounters(sessionTotals, daily);
					}
				}
			}
			if (!hasPositiveUsage(sessionTotals)) {
				continue;
			}
			sessionCount++;
			const breakdown = breakdownFromCounters(sessionTotals);
			totals = addBreakdowns(totals, breakdown);
			byProvider[session.provider] = addBreakdown(byProvider[session.provider], breakdown);
			byModel[dimensionKey(session.model, 'unknown')] = addBreakdown(byModel[dimensionKey(session.model, 'unknown')], breakdown);
			byWorkspace[dimensionKey(session.workspaceId, 'unknown')] = addBreakdown(byWorkspace[dimensionKey(session.workspaceId, 'unknown')], breakdown);
		}

		return { ...totals, sessionCount, byProvider, byModel, byWorkspace };
	}

	private matchesFilter(session: UsageSessionRecord, filter: HistoryFilter): boolean {
		if (filter.provider && session.provider !== filter.provider) {
			return false;
		}
		if (filter.model && session.model !== filter.model) {
			return false;
		}
		if (filter.workspaceId && (filter.workspaceId === 'unknown' ? session.workspaceId !== undefined : session.workspaceId !== filter.workspaceId)) {
			return false;
		}
		return true;
	}
}

function breakdownFromCounters(counters: UsageCounters): UsageBreakdown {
	return { ...counters, freshInputTokens: tokenComposition(counters.inputTokens, counters.cachedInputTokens).freshInputTokens };
}

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

function addBreakdown(existing: UsageBreakdown | undefined, incoming: UsageBreakdown): UsageBreakdown {
	return addBreakdowns(existing ?? EMPTY_BREAKDOWN, incoming);
}
