# AI Usage Monitor

AI Usage Monitor is a privacy-first, local-only VS Code extension for usage analytics from AI coding assistants. It reads supported provider usage metadata on your computer and presents it in the status bar and a dashboard.

## V0.1.0 support

- Codex tracking is implemented and manually verified on VS Code 1.138, including live updates, history, attribution, and provider-reported limits.
- Claude Code and Gemini CLI detection foundations are included, but their end-to-end token tracking is not currently advertised as complete or verified.

## Dashboard

For the current Codex session and historical ranges, the dashboard shows:

- Total Processed: the provider-reported authoritative total processed-token counter.
- Fresh Input: input tokens that were not reported as cached (max(0, Input - Cached Input)).
- Cached Input: the cached portion of Input.
- Output: output tokens reported by the provider.
- Reasoning: the reasoning portion of Output when the provider reports it.
- Cache Rate: Cached Input divided by Input, shown as a percentage.
- Fresh Rate: Fresh Input divided by Input, shown for the current session.

Cached Input is included in Input. Reasoning is included in Output. These are subsets, so the categories should not be added together; Total Processed remains the authoritative total.

History is available for Today, Last 7 days, Last 30 days, and All time. The dashboard also provides 7-day and 30-day charts plus usage breakdowns by model and project/workspace label.

Provider-reported 5-hour and weekly limit windows are shown when available, including reset countdowns. Observed burn rate is calculated only from local percentage observations within the same reset window and is shown only when enough observations exist. It is descriptive of observed percentage change, not a prediction of remaining tokens, allowance, or exhaustion time.

Token processing totals are not equivalent to a ChatGPT Plus quota. The extension does not claim a fixed Plus token allowance and does not convert processed tokens into a plan quota.

## Commands

- AI Usage Monitor: Open Dashboard
- AI Usage Monitor: Show Usage
- AI Usage Monitor: Reset Local Usage History

Reset requires confirmation and only removes extension-maintained history. Provider files are never changed.

## Settings

- aiUsageMonitor.enabled: enable or pause tracking and provider watchers; default true.
- aiUsageMonitor.statusBar.enabled: show the status-bar item; default true.
- aiUsageMonitor.statusBar.showRateLimits: show provider-reported rate-limit details in the status bar; default true.
- aiUsageMonitor.history.enabled: add new accounting data; default true. Disabling preserves existing history.
- aiUsageMonitor.history.retentionDays: retain daily buckets for 1–3650 days; default 365. Session lifetime totals and checkpoints remain available.
- aiUsageMonitor.dashboard.defaultRange: 7d or 30d; default 7d.

## Privacy and local architecture

The extension is local-only. It has no telemetry, backend, network requests, authentication, cloud storage, or external runtime service. It does not store or send prompts, responses, source code, tool arguments, credentials, API keys, or raw provider events.

Only normalized numeric usage metadata and privacy-safe model/project dimensions are retained in VS Code globalState. Raw JSONL is never copied into extension history. Provider files, including Codex files, are read-only from the extension. History and rate-limit observations are bounded; expired daily buckets are pruned while cumulative session totals and checkpoints are retained.

## Limitations

- Only Codex usage is currently tracked end to end.
- Claude Code and Gemini CLI detection does not imply usage support.
- Rate-limit data is shown only when the provider reports it, and observed burn rate needs multiple observations from the same reset window.
- Multiple VS Code windows can update the same globalState; VS Code does not provide a cross-window transaction primitive, so perfectly serialized concurrent writes cannot be promised.
- Manual GUI testing requires a VS Code version satisfying the engine requirement in package.json.

## Development

Install dependencies and run npm run check-types, npm run lint, npm run package, and npm test.

Use Run Extension in VS Code to open an Extension Development Host. The default build task runs the TypeScript and esbuild watchers.

## Release metadata

Before Marketplace publishing, the project owner must supply a publisher ID, repository URL, and legal license, and add a suitable Marketplace icon. No publisher, repository, license, or icon is claimed by this project yet.
# token_monitor
# token_monitor
