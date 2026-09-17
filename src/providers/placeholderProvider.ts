import { AiProvider, UsageUpdateHandler } from '../core/provider';
import { ProviderId, UsageSnapshot } from '../core/types';

/** Base behavior for adapters intentionally deferred to a later phase. */
export abstract class PlaceholderProvider implements AiProvider {
	protected constructor(
		public readonly id: ProviderId,
		public readonly displayName: string,
	) {}

	async detect(): Promise<boolean> {
		return false;
	}

	async getCurrentUsage(): Promise<UsageSnapshot | undefined> {
		return undefined;
	}

	async startWatching(_onUsage: UsageUpdateHandler): Promise<void> {}

	dispose(): void {}
}
