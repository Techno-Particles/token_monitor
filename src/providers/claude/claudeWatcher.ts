import { watch, FSWatcher } from 'node:fs';

import { ClaudePaths } from './claudePaths';

export class ClaudeWatcher {
	private readonly handles: FSWatcher[] = [];

	constructor(
		private readonly paths: ClaudePaths,
		private readonly onChange: () => void,
	) {}

	start(): void {
		this.dispose();
		for (const watchPath of [this.paths.configPath, this.paths.projectsPath]) {
			try {
				this.handles.push(watch(watchPath, { persistent: false }, () => this.onChange()));
			} catch {
				// Missing projects/ is normal before the first Claude session.
			}
		}
	}

	dispose(): void {
		while (this.handles.length > 0) {
			this.handles.pop()?.close();
		}
	}
}
