import * as assert from 'assert';

import { ProviderRegistry } from '../core/providerRegistry';
import { UsageAggregator } from '../core/usageAggregator';
import { ClaudeProvider } from '../providers/claude/claudeProvider';
import { CodexProvider } from '../providers/codex/codexProvider';
import { GeminiProvider } from '../providers/gemini/geminiProvider';

suite('Core Foundation Test Suite', () => {
	test('provider registry registers and retrieves providers', () => {
		const registry = new ProviderRegistry();
		const provider = new CodexProvider();

		registry.register(provider);

		assert.strictEqual(registry.get('codex'), provider);
		assert.strictEqual(registry.getAll().length, 1);
		registry.dispose();
	});

	test('placeholder providers are not detected and have no usage', async () => {
		const registry = new ProviderRegistry();
		registry.register(new CodexProvider({
			discover: async () => ({ detected: false, reason: 'test' }),
		}));
		registry.register(new ClaudeProvider());
		registry.register(new GeminiProvider());

		assert.deepStrictEqual(await registry.detectAvailable(), []);
		assert.strictEqual(await registry.get('codex')?.getCurrentUsage(), undefined);
		registry.dispose();
	});

	test('usage aggregator keeps the newest snapshot per provider', () => {
		const aggregator = new UsageAggregator();
		const latest = {
			provider: 'codex' as const,
			timestamp: 2,
			inputTokens: 10,
			outputTokens: 5,
			totalTokens: 15,
		};
		const older = { ...latest, timestamp: 1, totalTokens: 3 };

		aggregator.update(latest);
		aggregator.update(older);

		assert.strictEqual(aggregator.getLatest('codex'), latest);
		assert.deepStrictEqual(aggregator.getLatestSnapshots(), [latest]);
	});
});
