import * as path from 'node:path';

import type { CodexDiscoveryService } from '../providers/codex/codexProvider';
import { CodexTokenParser } from '../providers/codex/codexTokenParser';
import { workspaceIdentityFromCwd } from './workspaceIdentity';
import { SessionLedger } from './sessionLedger';
import { localDateKey } from './time';

export interface BackfillResult {
	readonly discovered: number;
	readonly imported: number;
	readonly skipped: number;
	readonly earliestSessionDate?: string;
	readonly latestSessionDate?: string;
	readonly complete: boolean;
}

function dateOnly(timestamp: number): string {
	return localDateKey(timestamp);
}

/** Imports existing rollout files once, resuming from per-session markers. */
export class CodexBackfill {
	constructor(
		private readonly ledger: SessionLedger,
		private readonly parser = new CodexTokenParser(),
	) {}

	async run(discovery: CodexDiscoveryService): Promise<BackfillResult> {
		if (this.ledger.isBackfillComplete('codex')) {
			return { discovered: 0, imported: 0, skipped: 0, complete: true };
		}

		const files = discovery.discoverSessionFiles ? await discovery.discoverSessionFiles() : [];
		let imported = 0;
		let skipped = 0;
		let failed = false;
		const dates: string[] = [];
		for (const file of files) {
			const sessionId = path.basename(file.filePath, path.extname(file.filePath));
			if (this.ledger.isBackfillSessionImported('codex', sessionId)) {
				skipped++;
				continue;
			}

			let parsed;
			try {
				parsed = await this.parser.parseFileWithHistory(file.filePath);
			} catch {
				failed = true;
				skipped++;
				continue;
			}
			if (!parsed) {
				// A valid rollout without usage metadata is not retried forever.
				this.ledger.markBackfillSessionImported('codex', sessionId);
				skipped++;
				continue;
			}

			const firstPointTimestamp = parsed.usageTimeline?.find((point) => point.timestamp !== undefined)?.timestamp;
			const startedAt = parsed.startedAt ?? firstPointTimestamp ?? file.modifiedAt;
			const lastUpdatedAt = parsed.lastUpdatedAt ?? file.modifiedAt;
			const workspace = workspaceIdentityFromCwd(parsed.cwd);
			const didImport = this.ledger.importSession({
				provider: 'codex',
				sessionId,
				startedAt,
				lastUpdatedAt,
				model: parsed.model,
				workspaceId: workspace?.workspaceId,
				workspaceName: workspace?.workspaceName,
				usage: parsed.sessionUsage,
				points: parsed.usageTimeline,
			});
			if (!didImport) {
				failed = true;
				skipped++;
				continue;
			}

			this.ledger.markBackfillSessionImported('codex', sessionId);
			imported++;
			dates.push(dateOnly(startedAt));
			if (imported % 10 === 0) {
				await this.ledger.flush();
				await new Promise<void>((resolve) => setImmediate(resolve));
			}
		}

		if (!failed) {
			this.ledger.markBackfillComplete('codex');
		}
		await this.ledger.flush();
		const allDates = dates.sort();
		return {
			discovered: files.length,
			imported,
			skipped,
			earliestSessionDate: allDates[0],
			latestSessionDate: allDates[allDates.length - 1],
			complete: !failed,
		};
	}
}
