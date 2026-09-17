export interface GeminiSessionFileMetadata {
	readonly filePath: string;
	readonly sessionId: string;
	readonly modifiedAt: number;
}

export interface GeminiDiscoveryResult {
	readonly detected: boolean;
	readonly configPath: string;
	readonly sessionsPath: string;
	readonly sessionFileCount?: number;
	readonly latestSessionFile?: GeminiSessionFileMetadata;
	readonly reason?: string;
}

/** Reserved for the first version-specific parser verification. */
export interface GeminiParsedUsage {
	readonly supported: false;
}
