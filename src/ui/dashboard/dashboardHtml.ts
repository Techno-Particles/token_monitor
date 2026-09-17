import { randomBytes } from 'node:crypto';

import * as vscode from 'vscode';

import { DASHBOARD_CLIENT_SCRIPT } from './dashboardClient';

const DASHBOARD_CSS = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
    margin: 0;
    padding: 28px clamp(16px, 4vw, 48px) 36px;
    color: var(--vscode-editor-foreground);
    background: var(--vscode-editor-background);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    line-height: 1.5;
}
button { font: inherit; }
.shell { max-width: 1180px; margin: 0 auto; }
.app-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; margin-bottom: 24px; }
.eyebrow { margin: 0 0 3px; color: var(--vscode-textLink-foreground); font-size: 12px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; }
h1, h2, h3, p { margin-top: 0; }
h1 { margin-bottom: 4px; font-size: clamp(24px, 4vw, 34px); line-height: 1.15; letter-spacing: -.02em; }
h2 { margin-bottom: 14px; font-size: 17px; }
h3 { margin-bottom: 12px; font-size: 14px; }
.subtitle, .muted, .help-text { color: var(--vscode-descriptionForeground); }
.subtitle { margin-bottom: 0; }
.live-badge { display: inline-flex; align-items: center; gap: 7px; padding: 4px 9px; border: 1px solid var(--vscode-testing-iconPassed); border-radius: 999px; color: var(--vscode-testing-iconPassed); font-size: 11px; font-weight: 700; letter-spacing: .08em; }
.live-badge::before { width: 7px; height: 7px; border-radius: 50%; background: currentColor; content: ''; }
.provider-tabs { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 24px; border-bottom: 1px solid var(--vscode-panel-border); }
.tab { padding: 9px 13px; border: 0; border-bottom: 2px solid transparent; color: var(--vscode-descriptionForeground); background: transparent; cursor: pointer; }
.tab:hover, .tab:focus-visible { color: var(--vscode-editor-foreground); background: var(--vscode-toolbar-hoverBackground); }
.tab.active { border-bottom-color: var(--vscode-focusBorder); color: var(--vscode-editor-foreground); }
.section { margin-bottom: 28px; }
.section-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; }
.overview-grid, .history-grid, .limit-grid, .breakdown-grid { display: grid; gap: 10px; }
.overview-grid { grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
.insight-grid { grid-template-columns: repeat(auto-fit, minmax(145px, 1fr)); }
.history-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.limit-grid { grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); }
.breakdown-grid { grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
.metric-card, .limit-card, .breakdown-panel, .chart-panel, .placeholder-card {
    border: 1px solid var(--vscode-panel-border);
    border-radius: 6px;
    background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-editor-foreground));
}
.metric-card { display: flex; min-height: 88px; flex-direction: column; justify-content: space-between; padding: 13px 14px; }
.metric-label { color: var(--vscode-descriptionForeground); font-size: 12px; }
.metric-value { font-size: 22px; font-weight: 600; letter-spacing: -.02em; }
.limit-card { padding: 16px; }
.limit-line, .breakdown-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.breakdown-header { overflow-wrap: anywhere; }
.limit-line { margin-bottom: 11px; }
.progress-track, .breakdown-track { overflow: hidden; height: 7px; border-radius: 99px; background: var(--vscode-progressBar-background); }
.progress-fill, .breakdown-fill { height: 100%; border-radius: inherit; background: var(--vscode-textLink-foreground); }
.reset-line { margin: 13px 0 0; color: var(--vscode-descriptionForeground); font-size: 12px; }
.chart-panel { padding: 14px 16px 10px; }
.chart-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
.range-buttons { display: flex; gap: 3px; }
.range-button, .action-button { border: 1px solid var(--vscode-button-secondaryBackground); border-radius: 3px; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); cursor: pointer; }
.range-button { padding: 3px 8px; font-size: 12px; }
.range-button[aria-pressed="true"] { outline: 1px solid var(--vscode-focusBorder); }
.range-button:hover, .action-button:hover { background: var(--vscode-button-secondaryHoverBackground); }
.chart { display: block; width: 100%; height: auto; min-height: 190px; }
.chart-axis { stroke: var(--vscode-panel-border); stroke-width: 1; }
.chart-line { fill: none; stroke: var(--vscode-textLink-foreground); stroke-width: 3; stroke-linejoin: round; stroke-linecap: round; }
.chart-point { fill: var(--vscode-editor-background); stroke: var(--vscode-textLink-foreground); stroke-width: 3; cursor: pointer; }
.chart-point:focus, .chart-point:hover { fill: var(--vscode-textLink-foreground); outline: none; }
.chart-label { fill: var(--vscode-descriptionForeground); font-size: 11px; }
.chart-tooltip { min-height: 22px; margin: 0; color: var(--vscode-descriptionForeground); font-size: 12px; }
.breakdown-panel { padding: 16px; }
.breakdown-row { margin-bottom: 15px; }
.breakdown-row:last-child { margin-bottom: 0; }
.breakdown-header { margin-bottom: 6px; font-size: 12px; }
.breakdown-fill { background: var(--vscode-charts-blue); }
.empty-state { margin: 0; padding: 18px; border: 1px dashed var(--vscode-panel-border); color: var(--vscode-descriptionForeground); text-align: center; }
.help-text { margin: 11px 0 0; font-size: 12px; }
.insight-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
.insight-note { margin: 12px 0 0; color: var(--vscode-descriptionForeground); font-size: 12px; }
.model-project-row { display: contents; }
.meta-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; margin-bottom: 16px; }
.meta-item { padding: 11px 13px; border-left: 2px solid var(--vscode-focusBorder); background: var(--vscode-textCodeBlock-background); }
.meta-label { display: block; margin-bottom: 2px; color: var(--vscode-descriptionForeground); font-size: 11px; text-transform: uppercase; }
.meta-value { overflow-wrap: anywhere; font-weight: 600; }
.placeholder-card { padding: 36px 20px; text-align: center; }
.placeholder-card h2 { margin-bottom: 5px; }
.error-banner { margin-bottom: 18px; padding: 10px 12px; border-left: 3px solid var(--vscode-editorError-foreground); color: var(--vscode-editorError-foreground); background: var(--vscode-textBlockQuote-background); }
.loading { padding: 55px 20px; color: var(--vscode-descriptionForeground); text-align: center; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 24px; }
.action-button { padding: 6px 11px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
.action-button:hover { background: var(--vscode-button-hoverBackground); }
:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; }
@media (max-width: 620px) {
    body { padding: 20px 13px 28px; }
    .app-header { margin-bottom: 18px; }
    .history-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .metric-value { font-size: 19px; }
    .chart-toolbar { align-items: flex-start; flex-direction: column; }
}
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; } }
`;

const DASHBOARD_BODY = `
<div class="shell">
    <header class="app-header">
        <div>
            <p class="eyebrow">AI Usage Monitor</p>
            <h1>Dashboard</h1>
            <p class="subtitle">Live local usage analytics</p>
        </div>
        <span id="live-badge" class="live-badge" hidden>LIVE</span>
    </header>
    <nav class="provider-tabs" role="tablist" aria-label="AI providers">
        <button class="tab active" type="button" role="tab" aria-selected="true" data-provider="codex">Codex</button>
        <button class="tab" type="button" role="tab" aria-selected="false" data-provider="claude">Claude Code</button>
        <button class="tab" type="button" role="tab" aria-selected="false" data-provider="gemini">Gemini CLI</button>
    </nav>
    <p id="loading" class="loading" role="status">Loading local usage…</p>
    <main id="dashboard-content" hidden>
        <p id="error-banner" class="error-banner" role="alert" hidden></p>
        <section id="codex-view" class="section" role="tabpanel">
            <div class="section-heading"><h2>Codex overview</h2><span class="muted">Current provider state</span></div>
            <div class="meta-grid">
                <div class="meta-item"><span class="meta-label">Provider</span><span class="meta-value">Codex</span></div>
                <div class="meta-item"><span class="meta-label">Plan</span><span id="plan-value" class="meta-value">Unavailable</span></div>
                <div class="meta-item"><span class="meta-label">Model</span><span id="model-value" class="meta-value">Unavailable</span></div>
            </div>
            <div id="codex-summary"></div>
        </section>
        <section class="section codex-only" aria-labelledby="limits-heading">
            <div class="section-heading"><h2 id="limits-heading">Codex limits</h2><span class="muted">Provider-reported quota</span></div>
            <div id="limits" class="limit-grid"></div>
        </section>
        <section class="section codex-only" aria-labelledby="insights-heading">
            <div class="section-heading"><h2 id="insights-heading">Where your tokens went</h2><span id="insight-range-label" class="muted">Today</span></div>
            <div class="insight-toolbar"><span class="muted">Observed token composition</span><div class="range-buttons" role="group" aria-label="Token composition range"><button class="range-button" type="button" data-insight-range="today" aria-pressed="true">Today</button><button class="range-button" type="button" data-insight-range="7d" aria-pressed="false">7D</button><button class="range-button" type="button" data-insight-range="30d" aria-pressed="false">30D</button><button class="range-button" type="button" data-insight-range="all" aria-pressed="false">All</button></div></div>
            <div id="insight-metrics" class="overview-grid insight-grid"></div>
            <p class="insight-note">Cached Input ⊂ Input. Reasoning ⊂ Output. These categories are not additive; Total Processed is Codex’s authoritative total.</p>
        </section>
        <section class="section codex-only" aria-labelledby="history-heading">
            <div class="section-heading"><h2 id="history-heading">History</h2><span class="muted">Local calendar days</span></div>
            <div id="history-metrics" class="history-grid"></div>
        </section>
        <section class="section chart-panel codex-only" aria-labelledby="chart-heading">
            <div class="chart-toolbar"><h2 id="chart-heading">Usage over time</h2><div class="range-buttons" role="group" aria-label="Chart range"><button class="range-button" type="button" data-range="7" aria-pressed="true">7D</button><button class="range-button" type="button" data-range="30" aria-pressed="false">30D</button></div></div>
            <p id="chart-empty" class="empty-state" hidden>No historical usage yet</p>
            <svg id="usage-chart" class="chart" role="img" aria-label="Daily token usage chart" hidden></svg>
            <p id="chart-tooltip" class="chart-tooltip" aria-live="polite"></p>
        </section>
        <section class="section breakdown-grid codex-only" aria-label="Usage breakdowns">
            <article class="breakdown-panel"><h2>Usage by model</h2><div id="models"></div></article>
            <article class="breakdown-panel"><h2>Usage by project</h2><div id="projects"></div></article>
        </section>
    </main>
    <section id="placeholder-view" class="placeholder-card" role="tabpanel" hidden>
        <h2 id="placeholder-name">Claude Code</h2>
        <p id="placeholder-status" class="muted">Coming soon / Not tracked yet</p>
    </section>
    <div class="actions">
        <button id="refresh-button" class="action-button" type="button">Refresh</button>
        <button id="reset-button" class="action-button" type="button">Reset Local History</button>
    </div>
</div>
`;

export function getDashboardHtml(webview: vscode.Webview): string {
	const nonce = randomBytes(16).toString('hex');
	const csp = [
		"default-src 'none'",
		`style-src ${webview.cspSource} 'nonce-${nonce}'`,
		`script-src 'nonce-${nonce}'`,
		`img-src ${webview.cspSource} data:`,
	].join('; ');
	return `<!doctype html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <title>AI Usage Monitor</title>
    <style nonce="${nonce}">${DASHBOARD_CSS}</style>
</head>
<body>
${DASHBOARD_BODY}
<script nonce="${nonce}">${DASHBOARD_CLIENT_SCRIPT}</script>
</body>
</html>`;
}
