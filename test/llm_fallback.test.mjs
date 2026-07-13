import assert from 'node:assert/strict';
import process from 'node:process';
import jitiFactory from 'jiti';

const jiti = jitiFactory(import.meta.url);
const {summarizeWithFallback} = jiti('../src/llm/fallback.ts');

const params = {
	systemPrompt: 'Summarize safely.',
	userContent: '<html>paper</html>',
};

function attempt(providerName, model, summarize) {
	return {
		providerName,
		model,
		provider: {summarize},
	};
}

async function testPrimarySuccessShortCircuits() {
	const calls = [];
	const result = await summarizeWithFallback([
		attempt('openai', 'openai-model', async () => {
			calls.push('openai');
			return 'primary summary';
		}),
		attempt('codex', 'codex-model', async () => {
			calls.push('codex');
			return 'unused';
		}),
	], params, {timeoutMs: 100});

	assert.deepEqual(
		{summary: result.summary, providerName: result.providerName, model: result.model, calls},
		{summary: 'primary summary', providerName: 'openai', model: 'openai-model', calls: ['openai']}
	);
}

async function testPrimaryFailureFallsBackToCodex() {
	const calls = [];
	const result = await summarizeWithFallback([
		attempt('openai', 'openai-model', async () => {
			calls.push('openai');
			throw new Error('primary failed');
		}),
		attempt('codex', 'codex-model', async () => {
			calls.push('codex');
			return 'codex summary';
		}),
	], params, {timeoutMs: 100});

	assert.deepEqual(
		{summary: result.summary, providerName: result.providerName, calls},
		{summary: 'codex summary', providerName: 'codex', calls: ['openai', 'codex']}
	);
}

async function testFirstTwoFailuresFallBackToGemini() {
	const calls = [];
	const result = await summarizeWithFallback([
		attempt('openai', 'openai-model', async () => {
			calls.push('openai');
			throw new Error('openai failed');
		}),
		attempt('codex', 'codex-model', async () => {
			calls.push('codex');
			throw new TypeError('codex failed');
		}),
		attempt('gemini', 'gemini-model', async () => {
			calls.push('gemini');
			return 'gemini summary';
		}),
	], params, {timeoutMs: 100});

	assert.deepEqual(
		{summary: result.summary, providerName: result.providerName, calls},
		{summary: 'gemini summary', providerName: 'gemini', calls: ['openai', 'codex', 'gemini']}
	);
}

async function testAllFailuresAreAggregatedWithoutRawErrors() {
	const secret = 'sk-test-secret-value';
	const events = [];

	await assert.rejects(
		summarizeWithFallback([
			attempt('openai', 'openai-model', async () => {
				throw new Error(`Authorization: Bearer ${secret}`);
			}),
			attempt('codex', 'codex-model', async () => {
				throw {token: secret};
			}),
		], params, {timeoutMs: 100, onAttempt: (event) => events.push(event)}),
		(error) => {
			assert.equal(error.name, 'FallbackAggregateError');
			assert.equal(error.message, 'All LLM provider attempts failed');
			assert.equal('cause' in error, false);
			assert.equal(JSON.stringify(error).includes(secret), false);
			return true;
		}
	);

	assert.deepEqual(events, [
		{type: 'start', attempt: 1, providerName: 'openai', model: 'openai-model'},
		{type: 'failure', attempt: 1, providerName: 'openai', model: 'openai-model', reason: 'PROVIDER_ERROR'},
		{type: 'start', attempt: 2, providerName: 'codex', model: 'codex-model'},
		{type: 'failure', attempt: 2, providerName: 'codex', model: 'codex-model', reason: 'PROVIDER_ERROR'},
	]);
}

async function testTimeoutFallsBackToNextProvider() {
	const never = new Promise(() => {});
	const result = await summarizeWithFallback([
		attempt('openai', 'openai-model', () => never),
		attempt('codex', 'codex-model', async () => 'after timeout'),
	], params, {timeoutMs: 10});

	assert.deepEqual(
		{summary: result.summary, providerName: result.providerName, attempts: result.attempts},
		{
			summary: 'after timeout',
			providerName: 'codex',
			attempts: [
				{attempt: 1, providerName: 'openai', model: 'openai-model', outcome: 'failure', reason: 'TIMEOUT'},
				{attempt: 2, providerName: 'codex', model: 'codex-model', outcome: 'success'},
			],
		}
	);
}

async function testLateCompletionCannotBecomeSuccessOrEmitSideEffects() {
	let resolvePrimary;
	const primary = new Promise((resolve) => {
		resolvePrimary = resolve;
	});
	const events = [];

	const result = await summarizeWithFallback([
		attempt('openai', 'openai-model', () => primary),
		attempt('codex', 'codex-model', async () => 'fallback summary'),
	], params, {timeoutMs: 10, onAttempt: (event) => events.push(event)});

	resolvePrimary('late primary summary');
	await new Promise((resolve) => setTimeout(resolve, 20));

	assert.deepEqual(
		{summary: result.summary, providerName: result.providerName, events},
		{
			summary: 'fallback summary',
			providerName: 'codex',
			events: [
				{type: 'start', attempt: 1, providerName: 'openai', model: 'openai-model'},
				{type: 'failure', attempt: 1, providerName: 'openai', model: 'openai-model', reason: 'TIMEOUT'},
				{type: 'start', attempt: 2, providerName: 'codex', model: 'codex-model'},
				{type: 'success', attempt: 2, providerName: 'codex', model: 'codex-model'},
			],
		}
	);
}

async function run(name, test) {
	await test();
	console.log(`ok - ${name}`);
}

async function main() {
	await run('primary success short-circuits', testPrimarySuccessShortCircuits);
	await run('primary failure falls back to Codex', testPrimaryFailureFallsBackToCodex);
	await run('first two failures fall back to Gemini', testFirstTwoFailuresFallBackToGemini);
	await run('all failures are safe and aggregated', testAllFailuresAreAggregatedWithoutRawErrors);
	await run('timeout falls back to next provider', testTimeoutFallsBackToNextProvider);
	await run('late completion is isolated', testLateCompletionCannotBecomeSuccessOrEmitSideEffects);
	console.log('llm_fallback local tests passed');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
