import { createHash } from 'node:crypto';
import * as path from 'node:path';

export interface WorkspaceIdentity {
	readonly workspaceId: string;
	readonly workspaceName?: string;
}

/**
 * Derives an opaque, stable project identity from Codex's cwd. The raw cwd is
 * never returned or persisted. This identifies the Codex working directory;
 * it does not claim that it matches the currently open VS Code workspace.
 */
export function workspaceIdentityFromCwd(cwd: string | undefined): WorkspaceIdentity | undefined {
	if (!cwd || !path.isAbsolute(cwd)) {
		return undefined;
	}

	const normalizedPath = path.normalize(cwd);
	const workspaceName = path.basename(normalizedPath) || undefined;
	const workspaceId = createHash('sha256')
		.update(`ai-usage-monitor.workspace.v1\0${normalizedPath}`, 'utf8')
		.digest('hex')
		.slice(0, 24);

	return { workspaceId, workspaceName };
}
