import { ProviderId, UsageSnapshot } from './types';

export type UsageUpdateHandler = (snapshot: UsageSnapshot | undefined) => void;

/** Contract implemented by each provider adapter. */
export interface AiProvider {
	readonly id: ProviderId;
	readonly displayName: string;

	detect(): Promise<boolean>;

	getCurrentUsage(): Promise<UsageSnapshot | undefined>;

	/** Starts provider-local observation without persisting live snapshots. */
	startWatching(onUsage: UsageUpdateHandler): Promise<void>;

	dispose(): void;
}
