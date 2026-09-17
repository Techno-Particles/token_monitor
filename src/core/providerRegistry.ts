import * as vscode from 'vscode';

import { AiProvider } from './provider';
import { ProviderId } from './types';

/** Owns provider adapters and their lifecycle. */
export class ProviderRegistry implements vscode.Disposable {
	private readonly providers = new Map<ProviderId, AiProvider>();

	register(provider: AiProvider): void {
		if (this.providers.has(provider.id)) {
			throw new Error(`A provider with id "${provider.id}" is already registered.`);
		}

		this.providers.set(provider.id, provider);
	}

	get(id: ProviderId): AiProvider | undefined {
		return this.providers.get(id);
	}

	getAll(): readonly AiProvider[] {
		return [...this.providers.values()];
	}

	/** Detect available providers without allowing one adapter to break the rest. */
	async detectAvailable(): Promise<readonly AiProvider[]> {
		const providers = this.getAll();
		const results = await Promise.all(providers.map(async (provider) => {
			try {
				return await provider.detect();
			} catch {
				return false;
			}
		}));

		return providers.filter((_provider, index) => results[index]);
	}

	dispose(): void {
		for (const provider of this.providers.values()) {
			try {
				provider.dispose();
			} catch {
				// Disposal is best-effort so one provider cannot block shutdown.
			}
		}

		this.providers.clear();
	}
}
