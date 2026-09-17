import * as vscode from 'vscode';

import { ProviderId, UsageSnapshot } from './types';

/**
 * Maintains the latest provider snapshot without estimating missing values or
 * combining snapshots from incompatible windows.
 */
export class UsageAggregator implements vscode.Disposable {
	private readonly latestByProvider = new Map<ProviderId, UsageSnapshot>();

	update(snapshot: UsageSnapshot): void {
		const previous = this.latestByProvider.get(snapshot.provider);
		if (previous && previous.timestamp > snapshot.timestamp) {
			return;
		}

		this.latestByProvider.set(snapshot.provider, snapshot);
	}

	getLatest(provider: ProviderId): UsageSnapshot | undefined {
		return this.latestByProvider.get(provider);
	}

	getLatestSnapshots(): readonly UsageSnapshot[] {
		return [...this.latestByProvider.values()];
	}

	clear(): void {
		this.latestByProvider.clear();
	}

	dispose(): void {
		this.clear();
	}
}
