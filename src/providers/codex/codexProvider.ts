import * as path from 'node:path';

import { UsageUpdateHandler } from '../../core/provider';
import { UsageSnapshot } from '../../core/types';
import { PlaceholderProvider } from '../placeholderProvider';
import { CodexDiscovery, CodexDiscoveryResult, CodexSessionFileMetadata } from './codexDiscovery';
import { CodexIncrementalTokenParser } from './codexIncrementalTokenParser';
import { CodexPaths, resolveCodexPaths } from './codexPaths';
import { CodexWatchEvent, CodexWatcher } from './codexWatcher';
import { workspaceIdentityFromCwd } from '../../history/workspaceIdentity';

export interface CodexDiscoveryService {
	discover(): Promise<CodexDiscoveryResult>;
	getPaths?(): CodexPaths;
	discoverSessionFiles?(): Promise<readonly CodexSessionFileMetadata[]>;
}

export type CodexWatcherFactory = (
	paths: CodexPaths,
	discovery: CodexDiscoveryService,
	onEvent: (event: CodexWatchEvent) => void | Promise<void>,
) => CodexWatcher;

/** Codex adapter with incremental local rollout tracking. */
export class CodexProvider extends PlaceholderProvider {
	private latestDiscovery?: CodexDiscoveryResult;
	private currentUsage?: UsageSnapshot;
	private currentFile?: string;
	private initialized = false;
	private watcher?: CodexWatcher;

	private readonly discovery: CodexDiscoveryService;
	private readonly paths: CodexPaths;
	private readonly parser: CodexIncrementalTokenParser;
	private readonly watcherFactory: CodexWatcherFactory;

	constructor(
		discovery: CodexDiscoveryService = new CodexDiscovery(resolveCodexPaths()),
		parser = new CodexIncrementalTokenParser(),
		paths = discovery.getPaths?.() ?? resolveCodexPaths(),
		watcherFactory: CodexWatcherFactory = (watchPaths, watchDiscovery, onEvent) =>
			new CodexWatcher(watchPaths, watchDiscovery, onEvent),
	) {
		super('codex', 'Codex');
		this.discovery = discovery;
		this.parser = parser;
		this.paths = paths;
		this.watcherFactory = watcherFactory;
	}

	async detect(): Promise<boolean> {
		this.latestDiscovery = await this.discovery.discover();
		return this.latestDiscovery.detected;
	}

	getDiscoveryResult(): CodexDiscoveryResult | undefined {
		return this.latestDiscovery;
	}

	getDiscoveryService(): CodexDiscoveryService {
		return this.discovery;
	}

	async getCurrentUsage(): Promise<UsageSnapshot | undefined> {
		if (!this.initialized) {
			await this.refreshCurrentSession(true);
		} else if (this.currentFile) {
			const parsed = await this.parser.readAppended(this.currentFile);
			this.currentUsage = this.toSnapshot(parsed, this.currentFile, Date.now());
		}
		return this.currentUsage;
	}

	async startWatching(onUsage: UsageUpdateHandler): Promise<void> {
		this.stopWatching();
		this.watcher = this.watcherFactory(this.paths, this.discovery, (event) => this.handleWatchEvent(event, onUsage));
		await this.watcher.start();
	}

	stopWatching(): void {
		this.watcher?.dispose();
		this.watcher = undefined;
	}

	dispose(): void {
		this.stopWatching();
		super.dispose();
	}

	private async handleWatchEvent(
		event: CodexWatchEvent,
		onUsage: UsageUpdateHandler,
	): Promise<void> {
		if (event.type === 'active-file-changed') {
			if (!this.initialized || event.filePath !== this.currentFile) {
				await this.refreshCurrentSession(true);
				onUsage(this.currentUsage);
				return;
			}
			const parsed = await this.parser.readAppended(event.filePath);
			this.currentUsage = this.toSnapshot(parsed, event.filePath, Date.now());
			onUsage(this.currentUsage);
			return;
		}

		await this.refreshCurrentSession(true);
		onUsage(this.currentUsage);
	}

	private async refreshCurrentSession(forceInitialize: boolean): Promise<void> {
		const discovery = await this.discovery.discover();
		this.latestDiscovery = discovery;
		const nextFile = discovery.latestSessionFile;
		if (!nextFile) {
			this.parser.reset();
			this.currentFile = undefined;
			this.currentUsage = undefined;
			this.initialized = true;
			return;
		}

		const shouldInitialize = forceInitialize || nextFile !== this.currentFile;
		const parsed = shouldInitialize
			? await this.parser.initialize(nextFile)
			: await this.parser.readAppended(nextFile);
		this.currentFile = nextFile;
		this.currentUsage = this.toSnapshot(parsed, nextFile, discovery.latestSessionModifiedAt ?? Date.now());
		this.initialized = true;
	}

	private toSnapshot(
		parsed: Awaited<ReturnType<CodexIncrementalTokenParser['getResult']>>,
		filePath: string,
		timestamp: number,
	): UsageSnapshot | undefined {
		if (!parsed) {
			return undefined;
		}
		const workspace = workspaceIdentityFromCwd(parsed.cwd);

		return {
			provider: this.id,
			timestamp,
			sessionId: path.basename(filePath, path.extname(filePath)),
			model: parsed.model,
			workspaceId: workspace?.workspaceId,
			workspaceName: workspace?.workspaceName,
			inputTokens: parsed.sessionUsage.inputTokens,
			cachedInputTokens: parsed.sessionUsage.cachedInputTokens,
			outputTokens: parsed.sessionUsage.outputTokens,
			reasoningTokens: parsed.sessionUsage.reasoningTokens,
			totalTokens: parsed.sessionUsage.totalTokens,
			contextWindow: parsed.modelContextWindow,
			rateLimits: parsed.rateLimits === undefined
				? undefined
				: { ...parsed.rateLimits, observedAt: parsed.rateLimits.observedAt ?? timestamp },
		};
	}
}
