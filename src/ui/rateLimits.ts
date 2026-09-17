import { RateLimitSnapshot, RateLimitWindow } from '../core/types';

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;

export function formatRateLimitPercent(value: number | undefined): string | undefined {
	return value === undefined ? undefined : `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(value)}%`;
}

/** Formats a local-user-facing countdown without parsing locale date strings. */
export function formatResetCountdown(resetsAt: number | undefined, now = Date.now()): string | undefined {
	if (resetsAt === undefined) {
		return undefined;
	}

	const remainingMinutes = Math.max(0, Math.ceil((resetsAt - now) / 60_000));
	if (remainingMinutes === 0) {
		return 'now';
	}
	if (remainingMinutes >= MINUTES_PER_DAY) {
		const days = Math.floor(remainingMinutes / MINUTES_PER_DAY);
		const hours = Math.floor((remainingMinutes % MINUTES_PER_DAY) / MINUTES_PER_HOUR);
		return hours === 0 ? `${days}d` : `${days}d ${hours}h`;
	}
	if (remainingMinutes >= MINUTES_PER_HOUR) {
		const hours = Math.floor(remainingMinutes / MINUTES_PER_HOUR);
		const minutes = remainingMinutes % MINUTES_PER_HOUR;
		return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
	}
	return `${remainingMinutes}m`;
}

export function formatRateLimitStatus(window: RateLimitWindow): string | undefined {
	const used = formatRateLimitPercent(window.usedPercent);
	return used === undefined ? undefined : `${window.compactLabel} ${used}`;
}

export function hasRateLimitWindows(rateLimits: RateLimitSnapshot | undefined): rateLimits is RateLimitSnapshot {
	return rateLimits !== undefined && rateLimits.windows.length > 0;
}

/** Shared detailed rendering for the status-bar tooltip and native command. */
export function formatRateLimitDetails(rateLimits: RateLimitSnapshot | undefined, now = Date.now()): string[] {
	if (!hasRateLimitWindows(rateLimits)) {
		return ['Quota data unavailable'];
	}
	const availableRateLimits = rateLimits;

	const lines: string[] = [];
	for (const window of availableRateLimits.windows) {
		lines.push(window.label);
		const used = formatRateLimitPercent(window.usedPercent);
		if (used !== undefined) {
			lines.push(`${used} used`);
		}
		const remaining = formatRateLimitPercent(window.remainingPercent);
		if (remaining !== undefined) {
			lines.push(`${remaining} remaining`);
		}
		const reset = formatResetCountdown(window.resetsAt, now);
		if (reset !== undefined) {
			lines.push(`Resets in ${reset}`);
		}
	}
	if (availableRateLimits.planType !== undefined) {
		lines.push(`Plan: ${availableRateLimits.planType}`);
	}
	return lines;
}
