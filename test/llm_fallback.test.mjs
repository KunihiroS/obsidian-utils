import assert from 'node:assert/strict';
import process from 'node:process';
import jitiFactory from 'jiti';

const jiti = jitiFactory(import.meta.url);
const {FallbackAggregateError, summarizeWithFallback} = jiti('../src/llm/fallback.ts');

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
		{summary: result.summary, providerName: result.providerName, model: result.model, attempts: result.attempts, calls},
		{
			summary: 'primary summary',
			providerName: 'openai',
			model: 'openai-model',
			attempts: [
				{attempt: 1, providerName: 'openai', model: 'openai-model', outcome: 'success'},
			],
			calls: ['openai'],
		}
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
		{summary: result.summary, providerName: result.providerName, model: result.model, attempts: result.attempts, calls},
		{
			summary: 'codex summary',
			providerName: 'codex',
			model: 'codex-model',
			attempts: [
				{attempt: 1, providerName: 'openai', model: 'openai-model', outcome: 'failure', reason: 'PROVIDER_ERROR'},
				{attempt: 2, providerName: 'codex', model: 'codex-model', outcome: 'success'},
			],
			calls: ['openai', 'codex'],
		}
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
		{summary: result.summary, providerName: result.providerName, model: result.model, attempts: result.attempts, calls},
		{
			summary: 'gemini summary',
			providerName: 'gemini',
			model: 'gemini-model',
			attempts: [
				{attempt: 1, providerName: 'openai', model: 'openai-model', outcome: 'failure', reason: 'PROVIDER_ERROR'},
				{attempt: 2, providerName: 'codex', model: 'codex-model', outcome: 'failure', reason: 'PROVIDER_ERROR'},
				{attempt: 3, providerName: 'gemini', model: 'gemini-model', outcome: 'success'},
			],
			calls: ['openai', 'codex', 'gemini'],
		}
	);
}

async function testAttemptCallbackExceptionsDoNotAffectProviderChain() {
	const cases = [
		{eventType: 'start', mode: 'sync'},
		{eventType: 'start', mode: 'async'},
		{eventType: 'success', mode: 'sync'},
		{eventType: 'success', mode: 'async'},
		{eventType: 'failure', mode: 'sync'},
		{eventType: 'failure', mode: 'async'},
	];

	for (const testCase of cases) {
		const calls = [];
		const observedEventTypes = [];
		const primaryFails = testCase.eventType === 'failure';
		const result = await summarizeWithFallback([
			attempt('openai', 'openai-model', async () => {
				calls.push('openai');
				if (primaryFails) throw new Error('provider failed');
				return 'primary summary';
			}),
			attempt('codex', 'codex-model', async () => {
				calls.push('codex');
				return 'fallback summary';
			}),
		], params, {
			timeoutMs: 100,
			onAttempt: (event) => {
				observedEventTypes.push(event.type);
				if (event.type !== testCase.eventType) return undefined;
				if (testCase.mode === 'async') return Promise.reject(new Error('observer failed'));
				throw new Error('observer failed');
			},
		});

		assert.deepEqual(
			{
				case: `${testCase.eventType}/${testCase.mode}`,
				summary: result.summary,
				providerName: result.providerName,
				attempts: result.attempts,
				calls,
				observedEventTypes,
			},
			primaryFails
				? {
					case: `${testCase.eventType}/${testCase.mode}`,
					summary: 'fallback summary',
					providerName: 'codex',
					attempts: [
						{attempt: 1, providerName: 'openai', model: 'openai-model', outcome: 'failure', reason: 'PROVIDER_ERROR'},
						{attempt: 2, providerName: 'codex', model: 'codex-model', outcome: 'success'},
					],
					calls: ['openai', 'codex'],
					observedEventTypes: ['start', 'failure', 'start', 'success'],
				}
				: {
					case: `${testCase.eventType}/${testCase.mode}`,
					summary: 'primary summary',
					providerName: 'openai',
					attempts: [
						{attempt: 1, providerName: 'openai', model: 'openai-model', outcome: 'success'},
					],
					calls: ['openai'],
					observedEventTypes: ['start', 'success'],
				}
		);
	}
}

async function testAttemptsAreRuntimeImmutableSnapshots() {
	const result = await summarizeWithFallback([
		attempt('openai', 'openai-model', async () => 'summary'),
	], params, {timeoutMs: 100});

	assert.equal(Object.isFrozen(result.attempts), true);
	assert.equal(Object.isFrozen(result.attempts[0]), true);
	assert.throws(() => result.attempts.push({}), TypeError);
	assert.throws(() => {
		result.attempts[0].providerName = 'mutated';
	}, TypeError);
	assert.deepEqual(result.attempts, [
		{attempt: 1, providerName: 'openai', model: 'openai-model', outcome: 'success'},
	]);

	const sourceAttempts = [
		{attempt: 1, providerName: 'openai', model: 'openai-model', outcome: 'failure', reason: 'PROVIDER_ERROR'},
	];
	const aggregateError = new FallbackAggregateError(sourceAttempts);
	sourceAttempts[0].providerName = 'mutated source';
	sourceAttempts.push({attempt: 2, providerName: 'codex', model: 'codex-model', outcome: 'failure', reason: 'TIMEOUT'});

	assert.equal(Object.isFrozen(aggregateError.attempts), true);
	assert.equal(Object.isFrozen(aggregateError.attempts[0]), true);
	assert.throws(() => aggregateError.attempts.push({}), TypeError);
	assert.throws(() => {
		aggregateError.attempts[0].providerName = 'mutated snapshot';
	}, TypeError);
	assert.deepEqual(aggregateError.attempts, [
		{attempt: 1, providerName: 'openai', model: 'openai-model', outcome: 'failure', reason: 'PROVIDER_ERROR'},
	]);
}

async function testInvalidTimeoutIsRejectedBeforeAttemptsStart() {
	for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
		const calls = [];
		const events = [];
		await assert.rejects(
			summarizeWithFallback([
				attempt('openai', 'openai-model', async () => {
					calls.push('openai');
					return 'unused';
				}),
			], params, {timeoutMs, onAttempt: (event) => events.push(event)}),
			RangeError
		);
		assert.deepEqual({calls, events}, {calls: [], events: []});
	}
}

async function testNonErrorThrowFallsBackToNextProvider() {
	const calls = [];
	const result = await summarizeWithFallback([
		attempt('openai', 'openai-model', async () => {
			calls.push('openai');
			throw {token: '«redacted:sk-…»'};
		}),
		attempt('codex', 'codex-model', async () => {
			calls.push('codex');
			return 'codex summary after non-Error';
		}),
	], params, {timeoutMs: 100});

	assert.deepEqual(
		{summary: result.summary, providerName: result.providerName, model: result.model, attempts: result.attempts, calls},
		{
			summary: 'codex summary after non-Error',
			providerName: 'codex',
			model: 'codex-model',
			attempts: [
				{attempt: 1, providerName: 'openai', model: 'openai-model', outcome: 'failure', reason: 'PROVIDER_ERROR'},
				{attempt: 2, providerName: 'codex', model: 'codex-model', outcome: 'success'},
			],
			calls: ['openai', 'codex'],
		}
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
			assert.deepEqual(error.attempts, [
				{attempt: 1, providerName: 'openai', model: 'openai-model', outcome: 'failure', reason: 'PROVIDER_ERROR'},
				{attempt: 2, providerName: 'codex', model: 'codex-model', outcome: 'failure', reason: 'PROVIDER_ERROR'},
			]);
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
	await run('attempt callback exceptions do not affect provider chain', testAttemptCallbackExceptionsDoNotAffectProviderChain);
	await run('attempt histories are runtime immutable snapshots', testAttemptsAreRuntimeImmutableSnapshots);
	await run('invalid timeout is rejected before attempts start', testInvalidTimeoutIsRejectedBeforeAttemptsStart);
	await run('non-Error throw falls back to next provider', testNonErrorThrowFallsBackToNextProvider);
	await run('all failures are safe and aggregated', testAllFailuresAreAggregatedWithoutRawErrors);
	await run('timeout falls back to next provider', testTimeoutFallsBackToNextProvider);
	await run('late completion is isolated', testLateCompletionCannotBecomeSuccessOrEmitSideEffects);
	console.log('llm_fallback local tests passed');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
