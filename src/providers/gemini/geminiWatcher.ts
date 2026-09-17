import { watch, FSWatcher } from 'node:fs';
import * as path from 'node:path';

import { GeminiPaths } from './geminiPaths';

export class GeminiWatcher {
	private readonly handles: FSWatcher[] = [];
	private timer?: NodeJS.Timeout;
	private disposed = false;

	constructor(
		private readonly paths: GeminiPaths,
		private readonly onChange: () => void,
		private readonly debounceMs = 250,
	) {}

	start(): void {
		this.dispose();
		this.disposed = false;
		const watchPaths = [this.paths.configPath, this.paths.sessionsPath, path.dirname(this.paths.configPath)];
		for (const watchPath of [...new Set(watchPaths)]) {
			try {
				this.handles.push(watch(watchPath, { persistent: false }, () => this.signal()));
			} catch {
				// Missing Gemini storage is normal before the first CLI session.
			}
		}
	}

	dispose(): void {
		this.disposed = true;
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		while (this.handles.length > 0) {
			this.handles.pop()?.close();
		}
	}

	private signal(): void {
		if (this.disposed) {
			return;
		}
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
		}
		this.timer = setTimeout(() => {
			this.timer = undefined;
			if (!this.disposed) {
				this.onChange();
			}
		}, this.debounceMs);
	}
}
