import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import jitiFactory from 'jiti';

const jiti = jitiFactory(import.meta.url);
const providerModule = jiti('../src/llm/createProvider.ts');
const {createProviderChain} = providerModule;
const {summarizeWithFallback} = jiti('../src/llm/fallback.ts');
const params = {systemPrompt: 'Summarize safely.', userContent: '<html>paper</html>'};

function provider(summary = 'summary') {
	return {summarize: async () => summary};
}

function settings(envPath = '/test/.env') {
	return {envPath};
}

function dependencies(env, overrides = {}) {
	return {
		readEnv: async () => env,
		createOpenAi: () => provider('openai summary'),
		createCodex: () => provider('codex summary'),
		createGemini: () => provider('gemini summary'),
		...overrides,
	};
}

async function rejectionCode(action) {
	try {
		await action();
		assert.fail('Expected provider to reject');
	} catch (error) {
		return error instanceof Error ? error.message : error;
	}
}

async function withEnvFile(content, test) {
	const directory = await mkdtemp(path.join(tmpdir(), 'llm-chain-test-'));
	const envPath = path.join(directory, '.env');
	try {
		await writeFile(envPath, content, 'utf8');
		await test(envPath);
	} finally {
		await rm(directory, {recursive: true, force: true});
	}
}

async function testExportExists() {
	assert.equal(typeof createProviderChain, 'function');
}

async function testFixedOrderAndMetadataIgnoreLegacySelector() {
	for (const legacyProvider of ['openai', 'gemini', 'invalid', undefined]) {
		const chain = await createProviderChain(settings(), dependencies({
			LLM_PROVIDER: legacyProvider,
			OPENAI_API_KEY: ' openai-key ',
			OPENAI_MODEL: ' openai-model ',
			CODEX_MODEL: ' codex-model ',
			GEMINI_API_KEY: ' gemini-key ',
			GEMINI_MODEL: ' gemini-model ',
		}));

		assert.deepEqual(chain.map(({providerName, model}) => ({providerName, model})), [
			{providerName: 'openai', model: 'openai-model'},
			{providerName: 'codex', model: 'codex-model'},
			{providerName: 'gemini', model: 'gemini-model'},
		]);
	}
}

async function testCodexModelConfiguredTrimAndDefault() {
	for (const testCase of [
		{line: 'CODEX_MODEL=  configured-codex  ', expected: 'configured-codex'},
		{line: 'CODEX_MODEL=   ', expected: 'gpt-5.4-mini'},
		{line: '# CODEX_MODEL absent', expected: 'gpt-5.4-mini'},
	]) {
		await withEnvFile(testCase.line, async (envPath) => {
			const chain = await createProviderChain(settings(envPath), {
				createOpenAi: () => provider(),
				createCodex: () => provider(),
				createGemini: () => provider(),
			});
			assert.equal(chain.length, 3);
			assert.equal(chain[1].model, testCase.expected);
		});
	}
}

async function testFactoryExceptionsAreIsolatedWithoutRawValues() {
	const secret = 'factory-secret-must-not-survive';
	const thrownValues = [new Error(`constructor failed: ${secret}`), {token: secret}, secret];
	const factoryCases = [
		{factory: 'createOpenAi', attempt: 0, code: 'OPENAI_PROVIDER_CREATE_FAILED'},
		{factory: 'createCodex', attempt: 1, code: 'CODEX_PROVIDER_CREATE_FAILED'},
		{factory: 'createGemini', attempt: 2, code: 'GEMINI_PROVIDER_CREATE_FAILED'},
	];

	for (const factoryCase of factoryCases) {
		for (const thrownValue of thrownValues) {
			const chain = await createProviderChain(settings(), dependencies({
				OPENAI_API_KEY: 'openai-key',
				OPENAI_MODEL: 'openai-model',
				CODEX_MODEL: 'codex-model',
				GEMINI_API_KEY: 'gemini-key',
				GEMINI_MODEL: 'gemini-model',
			}, {
				[factoryCase.factory]: () => {
					throw thrownValue;
				},
			}));

			assert.equal(chain.length, 3, factoryCase.factory);
			const failedAttempt = chain[factoryCase.attempt];
			assert.equal(
				await rejectionCode(() => failedAttempt.provider.summarize(params)),
				factoryCase.code,
				factoryCase.factory
			);
			await assert.rejects(failedAttempt.provider.summarize(params), (error) => {
				assert.equal(error instanceof Error, true);
				assert.equal('cause' in error, false);
				assert.equal(JSON.stringify(error).includes(secret), false);
				assert.equal(error.message.includes(secret), false);
				return true;
			});
		}
	}
}

async function testFactoryFailureFallsBackToLaterProviderInFixedOrder() {
	const calls = [];
	const chain = await createProviderChain(settings(), dependencies({
		OPENAI_API_KEY: 'openai-key',
		OPENAI_MODEL: 'openai-model',
		CODEX_MODEL: 'codex-model',
		GEMINI_API_KEY: 'gemini-key',
		GEMINI_MODEL: 'gemini-model',
	}, {
		createOpenAi: () => {
			calls.push('construct-openai');
			throw new Error('Authorization: Bearer factory-secret');
		},
		createCodex: () => ({summarize: async () => {
			calls.push('summarize-codex');
			return 'codex recovered summary';
		}}),
		createGemini: () => {
			calls.push('construct-gemini');
			return provider('unused');
		},
	}));

	assert.equal(chain.length, 3);
	const result = await summarizeWithFallback(chain, params, {timeoutMs: 100});
	assert.deepEqual(
		{summary: result.summary, providerName: result.providerName, attempts: result.attempts, calls},
		{
			summary: 'codex recovered summary',
			providerName: 'codex',
			attempts: [
				{attempt: 1, providerName: 'openai', model: 'openai-model', outcome: 'failure', reason: 'PROVIDER_ERROR'},
				{attempt: 2, providerName: 'codex', model: 'codex-model', outcome: 'success'},
			],
			calls: ['construct-openai', 'construct-gemini', 'summarize-codex'],
		}
	);
}

async function testInvalidConfiguredModelsAreSafeDeferredFailures() {
	const invalidValues = [
		{name: 'space', value: 'model with space'},
		{name: 'newline', value: 'model\ninjected'},
		{name: 'non-ASCII', value: 'モデル'},
		{name: '257 characters', value: 'm'.repeat(257)},
	];
	const providerCases = [
		{envKey: 'OPENAI_MODEL', factory: 'createOpenAi', attempt: 0, code: 'OPENAI_MODEL_INVALID'},
		{envKey: 'CODEX_MODEL', factory: 'createCodex', attempt: 1, code: 'CODEX_MODEL_INVALID'},
		{envKey: 'GEMINI_MODEL', factory: 'createGemini', attempt: 2, code: 'GEMINI_MODEL_INVALID'},
	];

	for (const providerCase of providerCases) {
		for (const invalidValue of invalidValues) {
			let invalidFactoryCalls = 0;
			const env = {
				OPENAI_API_KEY: 'openai-key',
				OPENAI_MODEL: 'openai-model',
				CODEX_MODEL: 'codex-model',
				GEMINI_API_KEY: 'gemini-key',
				GEMINI_MODEL: 'gemini-model',
				[providerCase.envKey]: invalidValue.value,
			};
			const chain = await createProviderChain(settings(), dependencies(env, {
				[providerCase.factory]: () => {
					invalidFactoryCalls += 1;
					return provider();
				},
			}));

			assert.equal(chain.length, 3, `${providerCase.envKey}/${invalidValue.name}`);
			const failedAttempt = chain[providerCase.attempt];
			assert.equal(failedAttempt.model, '<invalid>', `${providerCase.envKey}/${invalidValue.name}`);
			assert.equal(invalidFactoryCalls, 0, `${providerCase.envKey}/${invalidValue.name}`);
			assert.equal(
				await rejectionCode(() => failedAttempt.provider.summarize(params)),
				providerCase.code,
				`${providerCase.envKey}/${invalidValue.name}`
			);
			assert.equal(
				[...failedAttempt.model].every((character) => {
					const codePoint = character.codePointAt(0);
					return codePoint !== undefined && codePoint >= 0x21 && codePoint <= 0x7e;
				}),
				true
			);
			assert.equal(failedAttempt.model.includes(invalidValue.value), false);
		}
	}
}

async function testEnvFileTabAndControlModelsAreSanitized() {
	await withEnvFile([
		'OPENAI_API_KEY=openai-key',
		'OPENAI_MODEL="openai\tmodel"',
		'CODEX_MODEL="codex\u0001model"',
		'GEMINI_API_KEY=gemini-key',
		'GEMINI_MODEL=gemini-model',
	].join('\n'), async (envPath) => {
		const calls = [];
		const chain = await createProviderChain(settings(envPath), {
			createOpenAi: () => {
				calls.push('openai');
				return provider();
			},
			createCodex: () => {
				calls.push('codex');
				return provider();
			},
			createGemini: () => provider(),
		});

		assert.equal(chain.length, 3);
		assert.deepEqual(chain.slice(0, 2).map(({model}) => model), ['<invalid>', '<invalid>']);
		assert.deepEqual(calls, []);
		assert.equal(await rejectionCode(() => chain[0].provider.summarize(params)), 'OPENAI_MODEL_INVALID');
		assert.equal(await rejectionCode(() => chain[1].provider.summarize(params)), 'CODEX_MODEL_INVALID');
	});
}

async function testValidModelIdBoundaryAndCommonCharacters() {
	const modelIds = ['vendor/model:v1.2_test-name+fast', 'm'.repeat(256)];
	for (const modelId of modelIds) {
		const received = [];
		const chain = await createProviderChain(settings(), dependencies({
			OPENAI_API_KEY: 'openai-key',
			OPENAI_MODEL: modelId,
			CODEX_MODEL: modelId,
			GEMINI_API_KEY: 'gemini-key',
			GEMINI_MODEL: modelId,
		}, {
			createOpenAi: (_apiKey, model) => {
				received.push(['openai', model]);
				return provider();
			},
			createCodex: (model) => {
				received.push(['codex', model]);
				return provider();
			},
			createGemini: (_apiKey, model) => {
				received.push(['gemini', model]);
				return provider();
			},
		}));

		assert.equal(chain.length, 3);
		assert.deepEqual(received, [
			['openai', modelId],
			['codex', modelId],
			['gemini', modelId],
		]);
	}
}

async function testMissingConfigurationIsDeferredPerAttempt() {
	const cases = [
		{
			name: 'OpenAI model takes precedence over key',
			env: {OPENAI_API_KEY: '', OPENAI_MODEL: '   ', GEMINI_API_KEY: 'gemini-key', GEMINI_MODEL: 'gemini-model'},
			attempt: 0,
			expectedModel: '',
			expectedCode: 'OPENAI_MODEL_MISSING',
		},
		{
			name: 'OpenAI key is checked after model',
			env: {OPENAI_API_KEY: '   ', OPENAI_MODEL: 'openai-model', GEMINI_API_KEY: 'gemini-key', GEMINI_MODEL: 'gemini-model'},
			attempt: 0,
			expectedModel: 'openai-model',
			expectedCode: 'OPENAI_API_KEY_MISSING',
		},
		{
			name: 'Gemini key takes precedence over model',
			env: {OPENAI_API_KEY: 'openai-key', OPENAI_MODEL: 'openai-model', GEMINI_API_KEY: '', GEMINI_MODEL: '   '},
			attempt: 2,
			expectedModel: '',
			expectedCode: 'GEMINI_API_KEY_MISSING',
		},
		{
			name: 'Gemini model is checked after key',
			env: {OPENAI_API_KEY: 'openai-key', OPENAI_MODEL: 'openai-model', GEMINI_API_KEY: 'gemini-key', GEMINI_MODEL: undefined},
			attempt: 2,
			expectedModel: '',
			expectedCode: 'GEMINI_MODEL_MISSING',
		},
	];

	for (const testCase of cases) {
		const calls = [];
		const chain = await createProviderChain(settings(), dependencies(testCase.env, {
			createOpenAi: () => provider('later openai usable'),
			createCodex: () => ({summarize: async () => {
				calls.push('codex');
				return 'codex usable';
			}}),
			createGemini: () => provider('later gemini usable'),
		}));

		assert.equal(chain.length, 3, testCase.name);
		assert.equal(chain[testCase.attempt].model, testCase.expectedModel, testCase.name);
		assert.equal(
			await rejectionCode(() => chain[testCase.attempt].provider.summarize(params)),
			testCase.expectedCode,
			testCase.name
		);
		assert.equal(await chain[1].provider.summarize(params), 'codex usable', testCase.name);
		assert.deepEqual(calls, ['codex'], testCase.name);
	}
}

async function testValidFactoriesReceiveTrimmedConfiguration() {
	const received = [];
	await createProviderChain(settings(), dependencies({
		OPENAI_API_KEY: ' openai-key ',
		OPENAI_MODEL: ' openai-model ',
		CODEX_MODEL: ' codex-model ',
		GEMINI_API_KEY: ' gemini-key ',
		GEMINI_MODEL: ' gemini-model ',
	}, {
		createOpenAi: (apiKey, model) => {
			received.push(['openai', apiKey, model]);
			return provider();
		},
		createCodex: (model) => {
			received.push(['codex', model]);
			return provider();
		},
		createGemini: (apiKey, model) => {
			received.push(['gemini', apiKey, model]);
			return provider();
		},
	}));

	assert.deepEqual(received, [
		['openai', 'openai-key', 'openai-model'],
		['codex', 'codex-model'],
		['gemini', 'gemini-key', 'gemini-model'],
	]);
}

async function testCodexAuthIsLazyAtConstruction() {
	let authReads = 0;
	const chain = await createProviderChain(settings(), dependencies({
		OPENAI_API_KEY: 'openai-key',
		OPENAI_MODEL: 'openai-model',
		CODEX_MODEL: 'codex-model',
		GEMINI_API_KEY: 'gemini-key',
		GEMINI_MODEL: 'gemini-model',
	}, {
		createCodex: () => ({summarize: async () => {
			authReads += 1;
			return 'codex summary';
		}}),
	}));

	assert.equal(chain.length, 3);
	assert.equal(authReads, 0);
	assert.equal(await chain[1].provider.summarize(params), 'codex summary');
	assert.equal(authReads, 1);
}

async function testEnvPathAndReadFailuresRemainFactoryFailures() {
	let readCalls = 0;
	await assert.rejects(
		() => createProviderChain(settings('   '), dependencies({})),
		(error) => error instanceof Error && error.message === 'ENV_PATH_MISSING'
	);
	await assert.rejects(
		() => createProviderChain(settings(), {
			...dependencies({}),
			readEnv: async () => {
				readCalls += 1;
				throw new Error('ENV_READ_FAILED SafeError unavailable');
			},
		}),
		(error) => error instanceof Error && error.message === 'ENV_READ_FAILED SafeError unavailable'
	);
	assert.equal(readCalls, 1);
}

async function testManifestDeclaresDesktopOnly() {
	const manifest = jiti('../manifest.json');
	assert.equal(manifest.isDesktopOnly, true);
}

await testExportExists();
await testFixedOrderAndMetadataIgnoreLegacySelector();
await testCodexModelConfiguredTrimAndDefault();
await testFactoryExceptionsAreIsolatedWithoutRawValues();
await testFactoryFailureFallsBackToLaterProviderInFixedOrder();
await testInvalidConfiguredModelsAreSafeDeferredFailures();
await testEnvFileTabAndControlModelsAreSanitized();
await testValidModelIdBoundaryAndCommonCharacters();
await testMissingConfigurationIsDeferredPerAttempt();
await testValidFactoriesReceiveTrimmedConfiguration();
await testCodexAuthIsLazyAtConstruction();
await testEnvPathAndReadFailuresRemainFactoryFailures();
await testManifestDeclaresDesktopOnly();

console.log('llm_provider_chain tests passed');
