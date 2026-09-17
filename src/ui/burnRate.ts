import { RateLimitObservation } from '../history/rateLimitObservations';

export const MAX_BURN_RATE_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface ObservedBurnRate {
	readonly changePoints: number;
	readonly elapsedMinutes: number;
	readonly pointsPerHour: number;
}

/** Compares only observations from the same provider-reported reset window. */
export function calculateObservedBurnRate(
	observations: readonly RateLimitObservation[],
	key: RateLimitObservation['key'],
	now = Date.now(),
): ObservedBurnRate | undefined {
	const candidates = observations
		.filter((observation) => observation.key === key && observation.observedAt <= now && now - observation.observedAt <= MAX_BURN_RATE_AGE_MS)
		.sort((left, right) => left.observedAt - right.observedAt);
	if (candidates.length < 2) {
		return undefined;
	}

	const latest = candidates[candidates.length - 1];
	for (let index = candidates.length - 2; index >= 0; index--) {
		const previous = candidates[index];
		if (previous.resetsAt !== latest.resetsAt) {
			continue;
		}
		const elapsedMinutes = (latest.observedAt - previous.observedAt) / 60_000;
		if (elapsedMinutes <= 0 || latest.usedPercent < previous.usedPercent) {
			return undefined;
		}
		const changePoints = latest.usedPercent - previous.usedPercent;
		return {
			changePoints,
			elapsedMinutes,
			pointsPerHour: changePoints / (elapsedMinutes / 60),
		};
	}
	return undefined;
}
