export interface ClaudeSessionFileMetadata {
	readonly filePath: string;
	readonly sessionId: string;
	readonly modifiedAt: number;
}

export interface ClaudeDiscoveryResult {
	readonly detected: boolean;
	readonly configPath?: string;
	readonly projectsPath?: string;
	readonly sessionFileCount?: number;
	readonly latestSessionFile?: ClaudeSessionFileMetadata;
	readonly reason?: string;
}

/** Claude transcript format is intentionally schema-gated until observed locally. */
export interface ClaudeParsedUsage {
	readonly supported: false;
}
