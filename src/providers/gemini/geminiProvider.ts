import { AiProvider, UsageUpdateHandler } from '../../core/provider';
import { UsageSnapshot } from '../../core/types';
import { GeminiDiscovery } from './geminiDiscovery';
import { GeminiPaths, resolveGeminiPaths } from './geminiPaths';
import { GeminiTokenParser } from './geminiTokenParser';
import { GeminiDiscoveryResult, GeminiSessionFileMetadata } from './geminiTypes';
import { GeminiWatcher } from './geminiWatcher';

export interface GeminiDiscoveryService {
	discover(): Promise<GeminiDiscoveryResult>;
	getPaths?(): GeminiPaths;
	discoverSessionFiles?(): Promise<readonly GeminiSessionFileMetadata[]>;
}

export type GeminiWatcherFactory = (paths: GeminiPaths, onChange: () => void) => GeminiWatcher;

/** Gemini adapter with safe local detection and schema-gated usage parsing. */
export class GeminiProvider implements AiProvider {
	readonly id = 'gemini' as const;
	readonly displayName = 'Gemini CLI';
	private latestDiscovery?: GeminiDiscoveryResult;
	private watcher?: GeminiWatcher;

	constructor(
		private readonly discovery: GeminiDiscoveryService = new GeminiDiscovery(resolveGeminiPaths()),
		private readonly parser = new GeminiTokenParser(),
		private readonly paths: GeminiPaths = discovery.getPaths?.() ?? resolveGeminiPaths(),
		private readonly watcherFactory: GeminiWatcherFactory = (watchPaths, onChange) => new GeminiWatcher(watchPaths, onChange),
	) {}

	async detect(): Promise<boolean> {
		this.latestDiscovery = await this.discovery.discover();
		return this.latestDiscovery.detected;
	}

	getDiscoveryResult(): GeminiDiscoveryResult | undefined {
		return this.latestDiscovery;
	}

	getDiscoveryService(): GeminiDiscoveryService {
		return this.discovery;
	}

	async getCurrentUsage(): Promise<UsageSnapshot | undefined> {
		if (!this.latestDiscovery) {
			await this.detect();
		}
		const latest = this.latestDiscovery?.latestSessionFile;
		if (latest) {
			await this.parser.parseFile(latest.filePath);
		}
		return undefined;
	}

	async startWatching(onUsage: UsageUpdateHandler): Promise<void> {
		this.stopWatching();
		this.watcher = this.watcherFactory(this.paths, () => {
			void this.detect().then(() => onUsage(undefined)).catch(() => undefined);
		});
		this.watcher.start();
	}

	stopWatching(): void {
		this.watcher?.dispose();
		this.watcher = undefined;
	}

	dispose(): void {
		this.stopWatching();
	}
}
