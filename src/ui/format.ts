export function formatTokenCount(value: number): string {
	return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value);
}

export function formatCompactTokenCount(value: number): string {
	if (value < 1000) {
		return formatTokenCount(value);
	}

	const units = [
		{ threshold: 1_000_000, suffix: 'M' },
		{ threshold: 1000, suffix: 'K' },
	];
	const unit = units.find(({ threshold }) => value >= threshold) ?? units[units.length - 1];
	const scaled = value / unit.threshold;
	const decimals = unit.suffix === 'M' && scaled < 100
		? 1
		: scaled < 10
		? 1
		: 0;
	return `${scaled.toFixed(decimals).replace(/\.0$/, '')}${unit.suffix}`;
}
