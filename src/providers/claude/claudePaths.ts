import * as os from 'node:os';
import * as path from 'node:path';

export interface ClaudePaths {
	readonly configPath: string;
	readonly projectsPath: string;
}

/**
 * Claude documents CLAUDE_CONFIG_DIR as the supported storage override and
 * ~/.claude/projects as the default transcript location.
 */
export function resolveClaudePaths(environment: NodeJS.ProcessEnv = process.env, homedir = os.homedir()): ClaudePaths {
	const configuredHome = environment.CLAUDE_CONFIG_DIR;
	const configPath = configuredHome && path.isAbsolute(configuredHome) ? configuredHome : path.join(homedir, '.claude');
	return { configPath, projectsPath: path.join(configPath, 'projects') };
}
