import * as assert from 'assert';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';

import { CodexProvider } from '../providers/codex/codexProvider';
import { UsageCommands } from '../ui/commands';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Sample test', () => {
		assert.strictEqual(-1, [1, 2, 3].indexOf(5));
		assert.strictEqual(-1, [1, 2, 3].indexOf(0));
	});

	test('usage command is registered and executable', async () => {
		const provider = new CodexProvider({
			discover: async () => ({ detected: false, reason: 'test' }),
		});
		const commands = new UsageCommands(provider, 'ai-usage-monitor.testShowUsage');

		try {
			await vscode.commands.executeCommand('ai-usage-monitor.testShowUsage');
		} finally {
			commands.dispose();
		}
	});
});
