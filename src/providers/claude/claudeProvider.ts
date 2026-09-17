import { AiProvider, UsageUpdateHandler } from '../../core/provider';
import { UsageSnapshot } from '../../core/types';
import { ClaudeDiscovery } from './claudeDiscovery';
import { ClaudePaths, resolveClaudePaths } from './claudePaths';
import { ClaudeTokenParser } from './claudeTokenParser';
import { ClaudeDiscoveryResult } from './claudeTypes';
import { ClaudeWatcher } from './claudeWatcher';

/** Claude adapter with verified detection and schema-gated usage parsing. */
export class ClaudeProvider implements AiProvider {
	readonly id = 'claude' as const;
	readonly displayName = 'Claude Code';
	private latestDiscovery?: ClaudeDiscoveryResult;
	private watcher?: ClaudeWatcher;

	constructor(
		private readonly discovery = new ClaudeDiscovery(resolveClaudePaths()),
		private readonly parser = new ClaudeTokenParser(),
		private readonly paths: ClaudePaths = discovery.getPaths(),
	) {}

	async detect(): Promise<boolean> {
		this.latestDiscovery = await this.discovery.discover();
		return this.latestDiscovery.detected;
	}

	getDiscoveryResult(): ClaudeDiscoveryResult | undefined {
		return this.latestDiscovery;
	}

	async getCurrentUsage(): Promise<UsageSnapshot | undefined> {
		if (!this.latestDiscovery) {
			await this.detect();
		}
		const latest = this.latestDiscovery?.latestSessionFile;
		if (!latest) {
			return undefined;
		}
		// Deliberately does not read a transcript until its schema is verified.
		await this.parser.parseFile(latest.filePath);
		return undefined;
	}

	async startWatching(_onUsage: UsageUpdateHandler): Promise<void> {
		this.watcher?.dispose();
		this.watcher = new ClaudeWatcher(this.paths, () => { void this.detect(); });
		this.watcher.start();
	}

	dispose(): void {
		this.watcher?.dispose();
		this.watcher = undefined;
	}
}
