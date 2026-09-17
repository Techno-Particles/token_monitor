import * as vscode from 'vscode';

import { RateLimitSnapshot } from '../core/types';

export const RATE_LIMIT_OBSERVATIONS_KEY = 'ai-usage-monitor.rateLimitObservations';
export const RATE_LIMIT_OBSERVATION_SCHEMA_VERSION = 1 as const;
export const MAX_RATE_LIMIT_OBSERVATIONS = 256;

export interface RateLimitObservation {
	readonly key: 'primary' | 'secondary';
	readonly observedAt: number;
	readonly usedPercent: number;
	readonly resetsAt?: number;
}

interface PersistedRateLimitObservations {
	readonly version: 1;
	readonly observations: readonly RateLimitObservation[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeTimestamp(value: unknown): number | undefined {
	return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined;
}

function safePercent(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : undefined;
}

function readObservation(value: unknown): RateLimitObservation | undefined {
	if (!isRecord(value) || (value.key !== 'primary' && value.key !== 'secondary')) {
		return undefined;
	}
	const observedAt = safeTimestamp(value.observedAt);
	const usedPercent = safePercent(value.usedPercent);
	const resetsAt = value.resetsAt === undefined ? undefined : safeTimestamp(value.resetsAt);
	if (observedAt === undefined || usedPercent === undefined || (value.resetsAt !== undefined && resetsAt === undefined)) {
		return undefined;
	}
	return { key: value.key, observedAt, usedPercent, ...(resetsAt === undefined ? {} : { resetsAt }) };
}

function readPersisted(value: unknown): readonly RateLimitObservation[] {
	if (!isRecord(value) || value.version !== RATE_LIMIT_OBSERVATION_SCHEMA_VERSION || !Array.isArray(value.observations)) {
		return [];
	}
	return value.observations
		.map(readObservation)
		.filter((observation): observation is RateLimitObservation => observation !== undefined)
		.slice(-MAX_RATE_LIMIT_OBSERVATIONS);
}

function sameObservation(left: RateLimitObservation, right: RateLimitObservation): boolean {
	return left.key === right.key
		&& left.observedAt === right.observedAt
		&& left.usedPercent === right.usedPercent
		&& left.resetsAt === right.resetsAt;
}

/** Stores only bounded, normalized provider percentage observations. */
export class RateLimitObservationStore implements vscode.Disposable {
	private observations: readonly RateLimitObservation[];
	private writeTimer?: NodeJS.Timeout;
	private writeChain: Promise<void> = Promise.resolve();

	constructor(private readonly state: vscode.Memento, private readonly debounceMs = 250) {
		this.observations = readPersisted(state.get<unknown>(RATE_LIMIT_OBSERVATIONS_KEY));
	}

	record(rateLimits: RateLimitSnapshot | undefined, fallbackObservedAt = Date.now()): void {
		if (!rateLimits) {
			return;
		}
		const observedAt = safeTimestamp(rateLimits.observedAt ?? fallbackObservedAt);
		if (observedAt === undefined) {
			return;
		}
		const next = [...this.observations];
		for (const window of rateLimits.windows) {
			const usedPercent = safePercent(window.usedPercent);
			const resetsAt = window.resetsAt;
			if (usedPercent === undefined || (resetsAt !== undefined && safeTimestamp(resetsAt) === undefined)) {
				continue;
			}
			const observation: RateLimitObservation = {
				key: window.key,
				observedAt,
				usedPercent,
				...(resetsAt === undefined ? {} : { resetsAt }),
			};
			if (!next.some((candidate) => sameObservation(candidate, observation))) {
				next.push(observation);
			}
		}
		const bounded = next.slice(-MAX_RATE_LIMIT_OBSERVATIONS);
		if (bounded.length !== this.observations.length || bounded.some((observation, index) => !sameObservation(observation, this.observations[index]))) {
			this.observations = bounded;
			this.scheduleWrite();
		}
	}

	getObservations(): readonly RateLimitObservation[] {
		return this.observations;
	}

	async flush(): Promise<void> {
		if (this.writeTimer) {
			clearTimeout(this.writeTimer);
			this.writeTimer = undefined;
		}
		const persisted: PersistedRateLimitObservations = {
			version: RATE_LIMIT_OBSERVATION_SCHEMA_VERSION,
			observations: this.observations,
		};
		this.writeChain = this.writeChain.then(() => this.state.update(RATE_LIMIT_OBSERVATIONS_KEY, persisted));
		await this.writeChain;
	}

	async reset(): Promise<void> {
		if (this.writeTimer) {
			clearTimeout(this.writeTimer);
			this.writeTimer = undefined;
		}
		this.observations = [];
		await this.writeChain;
		await this.state.update(RATE_LIMIT_OBSERVATIONS_KEY, undefined);
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
}
