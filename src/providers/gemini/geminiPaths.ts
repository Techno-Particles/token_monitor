import * as os from 'node:os';
import * as path from 'node:path';

export interface GeminiPaths {
	readonly configPath: string;
	readonly sessionsPath: string;
}

/**
 * Gemini CLI documents GEMINI_CLI_HOME as the user-level storage override and
 * creates .gemini beneath it. Session files are documented below .gemini/tmp.
 */
export function resolveGeminiPaths(environment: NodeJS.ProcessEnv = process.env, homedir = os.homedir()): GeminiPaths {
	const configuredHome = environment.GEMINI_CLI_HOME;
	const baseHome = configuredHome && path.isAbsolute(configuredHome) ? configuredHome : homedir;
	const configPath = path.join(baseHome, '.gemini');
	return { configPath, sessionsPath: path.join(configPath, 'tmp') };
}
