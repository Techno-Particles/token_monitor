import * as os from 'node:os';
import * as path from 'node:path';

export interface CodexPaths {
	readonly homePath: string;
	readonly sessionsPath: string;
}

export interface CodexPathResolverOptions {
	readonly homedir?: () => string;
	readonly environment?: NodeJS.ProcessEnv;
}

/**
 * Resolves Codex's local data directory without shelling out.
 * Codex documents CODEX_HOME for its profile/config location; the normal
 * fallback is the .codex directory below the current user's home directory.
 */
export function resolveCodexPaths(options: CodexPathResolverOptions = {}): CodexPaths {
	const environment = options.environment ?? process.env;
	const configuredHome = environment.CODEX_HOME?.trim();
	const homePath = configuredHome
		? path.resolve(configuredHome)
		: path.join((options.homedir ?? os.homedir)(), '.codex');

	return {
		homePath,
		sessionsPath: path.join(homePath, 'sessions'),
	};
}
