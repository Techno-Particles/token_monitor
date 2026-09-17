import { GeminiParsedUsage } from './geminiTypes';

/**
 * Gemini's session schema is versioned with the CLI and is not available on
 * this machine for validation. Refuse to infer token semantics from an
 * unverified transcript rather than risking inaccurate totals or content
 * handling.
 */
export class GeminiTokenParser {
	async parseFile(_filePath: string): Promise<GeminiParsedUsage | undefined> {
		return undefined;
	}
}
