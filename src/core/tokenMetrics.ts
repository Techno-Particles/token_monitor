export interface TokenComposition {
	readonly freshInputTokens: number;
	readonly cacheRate: number;
	readonly freshRate: number;
}

/** Cached input is already included in the provider-reported input total. */
export function freshInputTokens(inputTokens: number, cachedInputTokens: number | undefined): number {
	return Math.max(0, inputTokens - Math.max(0, cachedInputTokens ?? 0));
}

export function tokenComposition(inputTokens: number, cachedInputTokens: number | undefined): TokenComposition {
	const fresh = freshInputTokens(inputTokens, cachedInputTokens);
	if (inputTokens <= 0) {
		return { freshInputTokens: 0, cacheRate: 0, freshRate: 0 };
	}

	const cacheRate = Math.min(100, Math.max(0, (Math.max(0, cachedInputTokens ?? 0) / inputTokens) * 100));
	return {
		freshInputTokens: fresh,
		cacheRate,
		freshRate: Math.min(100, Math.max(0, (fresh / inputTokens) * 100)),
	};
}
