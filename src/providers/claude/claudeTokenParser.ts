import { ClaudeParsedUsage } from './claudeTypes';

/**
 * Claude's local transcript entries are documented as internal and changing.
 * Until a real installed version is available to verify, parsing is disabled
 * rather than guessing token or cache semantics.
 */
export class ClaudeTokenParser {
	async parseFile(_filePath: string): Promise<ClaudeParsedUsage | undefined> {
		return undefined;
	}
}
