const DAY_MS = 24 * 60 * 60 * 1000;

export function localDateKey(timestamp: number): string {
	const date = new Date(timestamp);
	const year = date.getFullYear().toString().padStart(4, '0');
	const month = (date.getMonth() + 1).toString().padStart(2, '0');
	const day = date.getDate().toString().padStart(2, '0');
	return `${year}-${month}-${day}`;
}

export function startOfLocalDay(timestamp: number): number {
	const date = new Date(timestamp);
	return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

export function dateKeyOffset(dateKey: string, offsetDays: number): string {
	const [year, month, day] = dateKey.split('-').map(Number);
	const date = new Date(year, month - 1, day + offsetDays);
	return localDateKey(date.getTime());
}

export function isDateKeyInRange(dateKey: string, startDateKey: string, endDateKey: string): boolean {
	return dateKey >= startDateKey && dateKey <= endDateKey;
}

export const ONE_DAY_MS = DAY_MS;
