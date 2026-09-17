/** Browser-side dashboard code. It uses textContent and DOM APIs for all dynamic values. */
export const DASHBOARD_CLIENT_SCRIPT = String.raw`
(function () {
    const vscode = acquireVsCodeApi();
    let dashboardState;
    let selectedProvider = 'codex';
    let chartRange = 7;
    let insightRange = 'today';
    let countdownTimer;

    function byId(id) { return document.getElementById(id); }
    function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
    function text(node, value) { node.textContent = value == null ? '' : String(value); }
    function element(tag, className, value) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (value !== undefined) text(node, value);
        return node;
    }
    function exact(value) { return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value); }
    function compact(value) {
        if (value < 1000) return exact(value);
        if (value >= 1000000000) return (value / 1000000000).toFixed(value / 1000000000 < 10 ? 2 : 1).replace(/\.0+$/, '') + 'B';
        if (value >= 1000000) return (value / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
        return (value / 1000).toFixed(value / 1000 < 10 ? 1 : 0).replace(/\.0$/, '') + 'K';
    }
    function percent(value) {
        return value === undefined ? undefined : new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(value) + '%';
    }
    function planLabel(value) {
        return value ? value.charAt(0).toUpperCase() + value.slice(1) : 'Unavailable';
    }
    function countdown(resetsAt) {
        if (resetsAt === undefined) return undefined;
        const minutes = Math.max(0, Math.ceil((resetsAt - Date.now()) / 60000));
        if (minutes === 0) return 'now';
        if (minutes >= 1440) {
            const days = Math.floor(minutes / 1440);
            const hours = Math.floor((minutes % 1440) / 60);
            return days + 'd' + (hours ? ' ' + hours + 'h' : '');
        }
        if (minutes >= 60) {
            const hours = Math.floor(minutes / 60);
            const rest = minutes % 60;
            return hours + 'h' + (rest ? ' ' + rest + 'm' : '');
        }
        return minutes + 'm';
    }
    function metricValue(metric) { return metric && Number.isFinite(metric.totalTokens) ? metric.totalTokens : 0; }
    function inputValue(metric) { return metric && Number.isFinite(metric.inputTokens) ? metric.inputTokens : 0; }
    function cachedValue(metric) { return metric && Number.isFinite(metric.cachedInputTokens) ? Math.max(0, metric.cachedInputTokens) : 0; }
    function freshValue(metric) { return metric && Number.isFinite(metric.freshInputTokens) ? Math.max(0, metric.freshInputTokens) : Math.max(0, inputValue(metric) - cachedValue(metric)); }
    function cacheRate(metric) { return inputValue(metric) <= 0 ? 0 : Math.min(100, cachedValue(metric) / inputValue(metric) * 100); }
    function elapsedLabel(minutes) { return minutes < 60 ? Math.round(minutes) + ' minutes' : (minutes / 60).toFixed(minutes / 60 < 10 ? 1 : 0).replace(/\.0$/, '') + ' hours'; }
    function appendMetric(target, label, metric) {
        const card = element('article', 'metric-card');
        const heading = element('span', 'metric-label', label);
        const value = element('strong', 'metric-value', compact(metricValue(metric)));
        value.title = exact(metricValue(metric)) + ' tokens';
        card.append(heading, value);
        target.appendChild(card);
    }
    function renderCurrent() {
        const current = dashboardState.currentSession;
        const summary = byId('codex-summary');
        clear(summary);
        if (!dashboardState.detected) {
            summary.appendChild(element('p', 'empty-state', 'Codex not detected'));
            return;
        }
        if (!current) {
            summary.appendChild(element('p', 'empty-state', 'No usage data yet'));
            return;
        }
        const grid = element('div', 'overview-grid');
        const values = [
            ['Total Processed', current.totalTokens],
            ['Fresh Input', current.freshInputTokens],
            ['Cached input', current.cachedInputTokens],
            ['Output', current.outputTokens],
            ['Reasoning', current.reasoningTokens],
        ];
        values.forEach(function (entry) {
            const card = element('article', 'metric-card');
            const label = element('span', 'metric-label', entry[0]);
            const value = element('strong', 'metric-value', entry[1] === undefined ? 'Unavailable' : compact(entry[1]));
            if (entry[1] !== undefined) value.title = exact(entry[1]) + ' tokens';
            card.append(label, value);
            grid.appendChild(card);
        });
        summary.appendChild(grid);
        const notes = element('p', 'help-text', 'Input: ' + compact(current.inputTokens) + ' · Cache rate: ' + percent(current.cacheRate) + ' · Fresh rate: ' + percent(current.freshRate) + '. Cached input is included in Input; reasoning is included in Output.');
        summary.appendChild(notes);
        text(byId('model-value'), current.model || 'Unavailable');
        text(byId('plan-value'), planLabel(current.planType));
    }
    function renderLimits() {
        const target = byId('limits');
        clear(target);
        const limits = dashboardState.limits;
        if (!limits || !limits.windows.length) {
            target.appendChild(element('p', 'empty-state', 'Quota data unavailable'));
            return;
        }
        limits.windows.forEach(function (limit) {
            const card = element('article', 'limit-card');
            card.appendChild(element('h3', '', limit.label));
            const used = percent(limit.usedPercent);
            if (used !== undefined) {
                const usageLine = element('div', 'limit-line');
                usageLine.append(element('strong', '', used + ' used'), element('span', 'muted', percent(limit.remainingPercent) ? percent(limit.remainingPercent) + ' remaining' : ''));
                card.appendChild(usageLine);
                const progress = element('div', 'progress-track');
                progress.setAttribute('role', 'progressbar');
                progress.setAttribute('aria-label', limit.label + ' used');
                progress.setAttribute('aria-valuemin', '0');
                progress.setAttribute('aria-valuemax', '100');
                progress.setAttribute('aria-valuenow', String(Math.min(100, Math.max(0, limit.usedPercent))));
                const fill = element('div', 'progress-fill');
                fill.style.width = Math.min(100, Math.max(0, limit.usedPercent)) + '%';
                progress.appendChild(fill);
                card.appendChild(progress);
            } else {
                card.appendChild(element('p', 'muted', 'Usage percentage unavailable'));
            }
            const reset = countdown(limit.resetsAt);
            if (reset !== undefined) card.appendChild(element('p', 'reset-line', 'Resets in ' + reset));
            if (limit.burnRate) {
                if (limit.burnRate.changePoints === 0) {
                    card.appendChild(element('p', 'reset-line', 'No measurable change yet'));
                } else {
                    card.appendChild(element('p', 'reset-line', 'Observed change: +' + percent(limit.burnRate.changePoints) + ' over ' + elapsedLabel(limit.burnRate.elapsedMinutes)));
                    card.appendChild(element('p', 'reset-line', 'Observed burn: +' + percent(limit.burnRate.pointsPerHour) + ' per hour'));
                }
            } else {
                card.appendChild(element('p', 'reset-line', 'Observed burn rate: Not enough data yet'));
            }
            target.appendChild(card);
        });
        if (limits.planType) target.appendChild(element('p', 'help-text', 'Plan: ' + planLabel(limits.planType)));
    }
    function renderHistory() {
        const target = byId('history-metrics');
        clear(target);
        appendMetric(target, 'Today', dashboardState.history.today);
        appendMetric(target, 'Last 7 days', dashboardState.history.last7Days);
        appendMetric(target, 'Last 30 days', dashboardState.history.last30Days);
        appendMetric(target, 'All time', dashboardState.history.allTime);
    }
    function renderInsights() {
        const ranges = {
            today: ['Today', dashboardState.history.today],
            '7d': ['7 Days', dashboardState.history.last7Days],
            '30d': ['30 Days', dashboardState.history.last30Days],
            all: ['All Time', dashboardState.history.allTime]
        };
        const selected = ranges[insightRange] || ranges.today;
        const metric = selected[1];
        text(byId('insight-range-label'), selected[0]);
        const target = byId('insight-metrics');
        clear(target);
        appendMetric(target, 'Total Processed', metric);
        appendMetric(target, 'Fresh Input', { totalTokens: freshValue(metric) });
        appendMetric(target, 'Cached Input', { totalTokens: cachedValue(metric) });
        appendMetric(target, 'Output', { totalTokens: metric.outputTokens });
        appendMetric(target, 'Reasoning', { totalTokens: metric.reasoningTokens });
        appendMetric(target, 'Cache Rate', { totalTokens: cacheRate(metric) });
        const cacheCard = target.lastChild;
        if (cacheCard) cacheCard.querySelector('.metric-value').textContent = percent(cacheRate(metric));
        document.querySelectorAll('[data-insight-range]').forEach(function (button) { button.setAttribute('aria-pressed', button.getAttribute('data-insight-range') === insightRange ? 'true' : 'false'); });
    }
    function renderBreakdown(targetId, entries, emptyLabel) {
        const target = byId(targetId);
        clear(target);
        if (!entries.length) {
            target.appendChild(element('p', 'empty-state', emptyLabel));
            return;
        }
        const max = Math.max.apply(null, entries.map(function (entry) { return metricValue(entry); }).concat([1]));
        entries.forEach(function (entry) {
            const row = element('div', 'breakdown-row');
            const header = element('div', 'breakdown-header');
            header.append(element('span', '', entry.label || 'Unknown / Unattributed'), element('strong', '', compact(metricValue(entry))));
            const bar = element('div', 'breakdown-track');
            const fill = element('div', 'breakdown-fill');
            fill.style.width = Math.min(100, Math.max(0, metricValue(entry) / max * 100)) + '%';
            bar.appendChild(fill);
            row.append(header, bar);
            target.appendChild(row);
        });
    }
    function svgElement(tag) { return document.createElementNS('http://www.w3.org/2000/svg', tag); }
    function renderChart() {
        const svg = byId('usage-chart');
        const empty = byId('chart-empty');
        clear(svg);
        const points = chartRange === 7 ? dashboardState.dailyUsage7 : dashboardState.dailyUsage30;
        const hasUsage = points.some(function (point) { return metricValue(point) > 0; });
        empty.hidden = hasUsage;
        svg.hidden = !hasUsage;
        if (!hasUsage) return;
        const width = 720;
        const height = 260;
        const left = 52;
        const right = 16;
        const top = 18;
        const bottom = 38;
        const max = Math.max.apply(null, points.map(function (point) { return metricValue(point); }).concat([1]));
        svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
        const axis = svgElement('line');
        axis.setAttribute('x1', String(left)); axis.setAttribute('x2', String(width - right));
        axis.setAttribute('y1', String(height - bottom)); axis.setAttribute('y2', String(height - bottom));
        axis.setAttribute('class', 'chart-axis'); svg.appendChild(axis);
        const maxLabel = svgElement('text'); maxLabel.setAttribute('x', '4'); maxLabel.setAttribute('y', String(top + 4)); maxLabel.setAttribute('class', 'chart-label'); maxLabel.textContent = compact(max); svg.appendChild(maxLabel);
        const zeroLabel = svgElement('text'); zeroLabel.setAttribute('x', '22'); zeroLabel.setAttribute('y', String(height - bottom + 4)); zeroLabel.setAttribute('class', 'chart-label'); zeroLabel.textContent = '0'; svg.appendChild(zeroLabel);
        const coordinates = points.map(function (point, index) {
            const x = points.length === 1 ? left : left + index * (width - left - right) / (points.length - 1);
            const y = height - bottom - metricValue(point) / max * (height - top - bottom);
            return { x: x, y: y, point: point };
        });
        const line = svgElement('polyline');
        line.setAttribute('points', coordinates.map(function (coordinate) { return coordinate.x + ',' + coordinate.y; }).join(' '));
        line.setAttribute('class', 'chart-line'); svg.appendChild(line);
        coordinates.forEach(function (coordinate, index) {
            const circle = svgElement('circle');
            circle.setAttribute('cx', String(coordinate.x)); circle.setAttribute('cy', String(coordinate.y)); circle.setAttribute('r', '4'); circle.setAttribute('class', 'chart-point'); circle.setAttribute('tabindex', '0');
            circle.setAttribute('aria-label', coordinate.point.label + ': ' + exact(metricValue(coordinate.point)) + ' tokens');
            circle.addEventListener('mouseenter', function () { text(byId('chart-tooltip'), coordinate.point.label + ': ' + exact(metricValue(coordinate.point)) + ' tokens'); });
            circle.addEventListener('focus', function () { text(byId('chart-tooltip'), coordinate.point.label + ': ' + exact(metricValue(coordinate.point)) + ' tokens'); });
            svg.appendChild(circle);
            if (index === 0 || index === points.length - 1 || chartRange === 7) {
                const label = svgElement('text'); label.setAttribute('x', String(coordinate.x)); label.setAttribute('y', String(height - 12)); label.setAttribute('text-anchor', 'middle'); label.setAttribute('class', 'chart-label'); label.textContent = coordinate.point.label.slice(5); svg.appendChild(label);
            }
        });
    }
    function render() {
        if (!dashboardState) return;
        byId('loading').hidden = true;
        byId('dashboard-content').hidden = false;
        byId('live-badge').hidden = !dashboardState.live;
        byId('error-banner').hidden = !dashboardState.error;
        text(byId('error-banner'), dashboardState.error || '');
        renderCurrent(); renderLimits(); renderInsights(); renderHistory(); renderChart();
        renderBreakdown('models', dashboardState.models, 'No model usage yet');
        renderBreakdown('projects', dashboardState.projects, 'No project usage yet');
        selectProvider(selectedProvider);
        if (!countdownTimer) countdownTimer = setInterval(renderLimits, 60000);
    }
    function selectProvider(provider) {
        selectedProvider = provider === 'claude' || provider === 'gemini' ? provider : 'codex';
        provider = selectedProvider;
        document.querySelectorAll('[data-provider]').forEach(function (button) {
            const active = button.getAttribute('data-provider') === provider;
            button.classList.toggle('active', active);
            button.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        byId('codex-view').hidden = provider !== 'codex';
        byId('placeholder-view').hidden = provider === 'codex';
        document.querySelectorAll('.codex-only').forEach(function (section) { section.hidden = provider !== 'codex'; });
        text(byId('placeholder-name'), provider === 'claude' ? 'Claude Code' : 'Gemini CLI');
        const detected = dashboardState && (provider === 'claude' ? dashboardState.claudeDetected : dashboardState.geminiDetected);
        text(byId('placeholder-status'), detected ? 'Detected locally / Usage metadata unavailable' : 'Coming soon / Not tracked yet');
    }
    window.addEventListener('message', function (event) {
        if (!event.data || event.data.type !== 'state') return;
        dashboardState = event.data.state;
        chartRange = dashboardState.defaultRange === '30d' ? 30 : 7;
        document.querySelectorAll('[data-range]').forEach(function (button) { button.setAttribute('aria-pressed', Number(button.getAttribute('data-range')) === chartRange ? 'true' : 'false'); });
        render();
    });
    document.querySelectorAll('[data-provider]').forEach(function (button) {
        button.addEventListener('click', function () { selectProvider(button.getAttribute('data-provider')); });
    });
    document.querySelectorAll('[data-range]').forEach(function (button) {
        button.addEventListener('click', function () {
            chartRange = Number(button.getAttribute('data-range')) === 30 ? 30 : 7;
            document.querySelectorAll('[data-range]').forEach(function (candidate) { candidate.setAttribute('aria-pressed', candidate === button ? 'true' : 'false'); });
            renderChart();
        });
    });
    document.querySelectorAll('[data-insight-range]').forEach(function (button) {
        button.addEventListener('click', function () {
            insightRange = button.getAttribute('data-insight-range') || 'today';
            renderInsights();
        });
    });
    byId('refresh-button').addEventListener('click', function () { vscode.postMessage({ type: 'refresh' }); });
    byId('reset-button').addEventListener('click', function () { vscode.postMessage({ type: 'resetHistory' }); });
    selectProvider('codex');
    vscode.postMessage({ type: 'ready' });
})();
`;
