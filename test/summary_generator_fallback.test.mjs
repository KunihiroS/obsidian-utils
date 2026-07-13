import assert from 'node:assert/strict';
import process from 'node:process';
import jitiFactory from 'jiti';

const jiti = jitiFactory(import.meta.url);
// The npm "obsidian" test stub exports no runtime values. Populate only the
// boundaries exercised by the legacy path so a missing dependency seam fails
// as a behavior assertion rather than as an unrelated DOM/module setup error.
const obsidianRuntime = jiti('obsidian');
obsidianRuntime.normalizePath = (value) => value.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
obsidianRuntime.Notice = class TestNotice {};
obsidianRuntime.TFile = class TestTFile {};
const {generateSummary} = jiti('../src/summary_generator.ts');

const INPUT_URL = 'https://arxiv.org/abs/2501.12345';
const HTML_PATH = 'Papers/Test Paper/2501.12345.html';
const PROMPT_PATH = 'prompts/summary.md';
const SUMMARY_START = '<!-- paper_extractor:summary:start -->';
const SUMMARY_END = '<!-- paper_extractor:summary:end -->';
const MAX_TIMEOUT_SEC = Math.floor(2_147_483_647 / 1000);

function attempt(providerName, model, summarize) {
	return {providerName, model, provider: {summarize}};
}

function createHarness(overrides = {}) {
	let noteText = overrides.noteText ?? '# Test Paper\n\nBody';
	const noteFile = overrides.noteFile ?? {
		path: 'Papers/Test Paper.md',
		basename: 'Test Paper',
		parent: {path: 'Papers'},
	};
	const files = new Map([
		[HTML_PATH, '<html><article>paper body</article></html>'],
		[PROMPT_PATH, 'Summarize in Japanese.'],
	]);
	for (const [path, value] of Object.entries(overrides.adapterFiles ?? {})) {
		if (value === undefined) files.delete(path);
		else files.set(path, value);
	}

	const calls = [];
	const notices = [];
	const logs = [];
	const modifications = [];
	const startedIntervals = [];
	const clearedIntervals = [];
	let providerChainCalls = 0;
	let nextIntervalId = 40;
	const chain = overrides.chain ?? [
		attempt('openai', 'openai-model', async () => 'default summary'),
	];

	const adapter = {
		exists: async (path) => {
			calls.push(`adapter.exists:${path}`);
			if (overrides.existsError) throw overrides.existsError;
			return files.has(path);
		},
		read: async (path) => {
			calls.push(`adapter.read:${path}`);
			if (overrides.adapterReadErrors?.has(path)) throw overrides.adapterReadErrors.get(path);
			if (!files.has(path)) throw new Error('FILE_NOT_FOUND');
			return files.get(path);
		},
		write: async (path, text) => {
			files.set(path, text);
		},
	};

	const vault = {
		adapter,
		createFolder: async () => {},
		getAbstractFileByPath: (path) => {
			calls.push(`vault.lookup:${path}`);
			return overrides.latestFile === undefined ? noteFile : overrides.latestFile;
		},
		read: async (file) => {
			calls.push(`vault.read:${file?.path ?? '<missing>'}`);
			if (overrides.noteReadError) throw overrides.noteReadError;
			return noteText;
		},
		modify: async (file, text) => {
			calls.push(`vault.modify:${file?.path ?? '<missing>'}`);
			if (overrides.noteWriteError) throw overrides.noteWriteError;
			modifications.push({file, text});
			noteText = text;
		},
	};

	const app = {vault};
	const settings = {
		logDir: 'logs',
		systemPromptPath: PROMPT_PATH,
		envPath: '/unused/test.env',
		templatePath: '',
		summaryEnabled: true,
		llmTimeoutSec: overrides.llmTimeoutSec ?? 1,
		...(overrides.settings ?? {}),
	};
	const dependencies = {
		notice: (message, duration) => notices.push({message, duration}),
		createProviderChain: async (receivedSettings) => {
			providerChainCalls += 1;
			calls.push('createProviderChain');
			assert.equal(receivedSettings, settings);
			return chain;
		},
		startLogBlock: async (_app, logDir, message) => {
			logs.push(message);
			return {logDir, logPath: 'logs/test.log', runId: 'test-run'};
		},
		appendLogLine: async (_app, logDir, message) => {
			assert.equal(logDir, settings.logDir);
			logs.push(message);
		},
		endLogBlock: async (_app, block, message) => {
			assert.equal(block.runId, 'test-run');
			logs.push(message);
		},
		setInterval: (callback, ms) => {
			const id = nextIntervalId++;
			startedIntervals.push({id, callback, ms});
			return id;
		},
		clearInterval: (id) => clearedIntervals.push(id),
		isTFile: (file) => file === noteFile,
		...(overrides.dependencies ?? {}),
	};

	return {
		app,
		settings,
		noteFile,
		dependencies,
		calls,
		notices,
		logs,
		modifications,
		startedIntervals,
		clearedIntervals,
		get noteText() { return noteText; },
		get providerChainCalls() { return providerChainCalls; },
	};
}

async function runSummary(harness) {
	return generateSummary(
		harness.app,
		harness.settings,
		harness.noteFile,
		INPUT_URL,
		harness.dependencies
	);
}

function parseLogFields(line) {
	return Object.fromEntries(line.split(' ').flatMap((token) => {
		const separator = token.indexOf('=');
		return separator === -1 ? [] : [[token.slice(0, separator), token.slice(separator + 1)]];
	}));
}

function attemptLogs(logs) {
	return logs.filter((line) => {
		const {event, attempt} = parseLogFields(line);
		return attempt !== undefined && ['start', 'failure', 'success'].includes(event);
	});
}

function finalLog(logs) {
	return logs.findLast((line) => line.includes('result='));
}

function assertSingleLineBoundedLogs(logs) {
	for (const line of logs) {
		assert.equal(/[\r\n\t]/.test(line), false, 'log entry must be one physical line');
		assert.ok(line.length <= 1024, `log entry exceeded bound: ${line.length}`);
	}
}

async function testDisabledSummarySkipsAllSummaryWorkAsSuccessfulRun() {
	const providerCalls = [];
	const harness = createHarness({
		settings: {summaryEnabled: false},
		chain: [attempt('openai', 'must-not-run', async () => {
			providerCalls.push('summarize:openai');
			return 'must not be written';
		})],
	});

	await runSummary(harness);

	assert.deepEqual(harness.calls, []);
	assert.equal(harness.providerChainCalls, 0);
	assert.deepEqual(providerCalls, []);
	assert.deepEqual(harness.startedIntervals, []);
	assert.deepEqual(harness.clearedIntervals, []);
	assert.deepEqual(harness.modifications, []);
	assert.deepEqual(harness.notices, [
		{message: 'Summary is disabled (Settings).', duration: undefined},
	]);
	assert.equal(harness.logs.length, 2);
	assert.match(harness.logs[0], /component=summary_generator .*id=2501\.12345(?: |$)/);
	assert.match(finalLog(harness.logs), /result=OK reason=SUMMARY_DISABLED_SKIP(?: |$)/);
}

async function testOpenAiFailureFallsBackToCodexAndLogsSelectedProvider() {
	const calls = [];
	const harness = createHarness({chain: [
		attempt('openai', 'gpt-primary', async () => {
			calls.push('summarize:openai');
			throw new Error('primary unavailable');
		}),
		attempt('codex', 'gpt-codex', async () => {
			calls.push('summarize:codex');
			return '## Codex summary';
		}),
		attempt('gemini', 'gemini-fallback', async () => {
			calls.push('summarize:gemini');
			return 'must not run';
		}),
	]});

	await runSummary(harness);

	assert.deepEqual(calls, ['summarize:openai', 'summarize:codex']);
	assert.equal(harness.modifications.length, 1);
	assert.ok(harness.noteText.includes(`${SUMMARY_START}\n\n## Codex summary\n\n${SUMMARY_END}`));
	assert.deepEqual(attemptLogs(harness.logs).map((line) => {
		const {event, attempt, provider, model, reason} = parseLogFields(line);
		return {event, attempt: Number(attempt), provider, model, ...(reason === undefined ? {} : {reason})};
	}), [
		{event: 'start', attempt: 1, provider: 'openai', model: 'gpt-primary'},
		{event: 'failure', attempt: 1, provider: 'openai', model: 'gpt-primary', reason: 'PROVIDER_ERROR'},
		{event: 'start', attempt: 2, provider: 'codex', model: 'gpt-codex'},
		{event: 'success', attempt: 2, provider: 'codex', model: 'gpt-codex'},
	]);
	assert.match(finalLog(harness.logs), /result=OK .*provider=codex model=gpt-codex(?: |$)/);
}

async function testTwoFailuresFallBackToGeminiAndWriteOnce() {
	const calls = [];
	const harness = createHarness({chain: [
		attempt('openai', 'openai-model', async () => {
			calls.push('summarize:openai');
			throw new Error('openai failed');
		}),
		attempt('codex', 'codex-model', async () => {
			calls.push('summarize:codex');
			throw new Error('codex failed');
		}),
		attempt('gemini', 'gemini-model', async () => {
			calls.push('summarize:gemini');
			return 'Gemini summary';
		}),
	]});

	await runSummary(harness);

	assert.deepEqual(calls, ['summarize:openai', 'summarize:codex', 'summarize:gemini']);
	assert.equal(harness.modifications.length, 1);
	assert.ok(harness.noteText.includes('Gemini summary'));
	assert.match(finalLog(harness.logs), /result=OK .*provider=gemini model=gemini-model(?: |$)/);
}

async function testPrimaryTimeoutLateResolveCannotWriteOrLogAgain() {
	let resolvePrimary;
	const primary = new Promise((resolve) => { resolvePrimary = resolve; });
	const calls = [];
	const harness = createHarness({
		llmTimeoutSec: 0.01,
		chain: [
			attempt('openai', 'slow-model', () => {
				calls.push('summarize:openai');
				return primary;
			}),
			attempt('codex', 'fast-model', async () => {
				calls.push('summarize:codex');
				return 'fallback wins';
			}),
		],
	});

	await runSummary(harness);
	const completedSnapshot = {
		calls: [...calls],
		logs: [...harness.logs],
		modifications: [...harness.modifications],
		noteText: harness.noteText,
	};
	resolvePrimary('late primary must be ignored');
	await new Promise((resolve) => setTimeout(resolve, 30));

	assert.deepEqual({
		calls,
		logs: harness.logs,
		modifications: harness.modifications,
		noteText: harness.noteText,
	}, completedSnapshot);
	assert.equal(harness.noteText.includes('late primary'), false);
	assert.equal(attemptLogs(harness.logs).filter((line) => line.includes('provider=openai') && line.includes('event=success')).length, 0);
}

async function testExistingSummaryBlockIsReplacedWithoutDuplication() {
	const harness = createHarness({
		noteText: `before\n\n${SUMMARY_START}\n\nold summary\n\n${SUMMARY_END}\n\nafter`,
		chain: [attempt('openai', 'model', async () => 'new summary')],
	});

	await runSummary(harness);

	assert.equal(harness.modifications.length, 1);
	assert.equal(harness.noteText, `before\n\n${SUMMARY_START}\n\nnew summary\n\n${SUMMARY_END}\n\nafter`);
	assert.equal(harness.noteText.split(SUMMARY_START).length - 1, 1);
	assert.equal(harness.noteText.split(SUMMARY_END).length - 1, 1);
}

async function testAllAttemptsFailWithoutChangingNoteOrLeakingSecret() {
	const secret = 'sk-test-secret-should-never-appear';
	const original = '# Exact bytes\n\nKeep me.\n';
	const harness = createHarness({
		noteText: original,
		chain: [
			attempt('openai', 'openai-model', async () => { throw new Error(`Authorization: Bearer ${secret}`); }),
			attempt('codex', 'codex-model', async () => { throw {token: secret}; }),
		],
	});

	await runSummary(harness);

	assert.equal(harness.noteText, original);
	assert.equal(harness.modifications.length, 0);
	assert.equal(harness.logs.join('\n').includes(secret), false, 'logs leaked a provider secret');
	assert.match(finalLog(harness.logs), /result=NG reason=ALL_LLM_ATTEMPTS_FAILED(?: |$)/);
}

async function testLocalPrerequisiteFailuresDoNotConstructOrCallProviders() {
	const cases = [
		{
			name: 'HTML missing',
			configure: {adapterFiles: {[HTML_PATH]: undefined}},
			reason: 'HTML_MISSING',
		},
		{
			name: 'HTML read error',
			configure: {adapterReadErrors: new Map([[HTML_PATH, new Error('read failed')]])},
			reason: 'HTML_READ_FAILED',
		},
		{
			name: 'prompt missing',
			configure: {settings: {systemPromptPath: '   '}},
			reason: 'PROMPT_READ_FAILED',
		},
		{
			name: 'prompt absolute',
			configure: {settings: {systemPromptPath: '/outside/prompt.md'}},
			reason: 'PROMPT_PATH_INVALID',
		},
		{
			name: 'prompt read error',
			configure: {adapterReadErrors: new Map([[PROMPT_PATH, new Error('read failed')]])},
			reason: 'PROMPT_READ_FAILED',
		},
	];

	for (const testCase of cases) {
		const calls = [];
		const harness = createHarness({
			...testCase.configure,
			chain: [attempt('openai', 'model', async () => {
				calls.push('summarize:openai');
				return 'unused';
			})],
		});
		await runSummary(harness);
		assert.equal(harness.providerChainCalls, 0, testCase.name);
		assert.deepEqual(calls, [], testCase.name);
		assert.equal(harness.modifications.length, 0, testCase.name);
		assert.match(finalLog(harness.logs), new RegExp(`result=NG reason=${testCase.reason}(?: |$)`), testCase.name);
	}
}

async function testPostProviderNoteFailuresDoNotRunLaterProviders() {
	const cases = [
		{name: 'note moved or deleted', configure: {latestFile: null}, reason: 'NOTE_MOVED_OR_DELETED'},
		{name: 'note read failure', configure: {noteReadError: new Error('read failed')}, reason: 'NOTE_READ_FAILED'},
		{name: 'note write failure', configure: {noteWriteError: new Error('write failed')}, reason: 'NOTE_WRITE_FAILED'},
	];

	for (const testCase of cases) {
		const calls = [];
		const harness = createHarness({
			...testCase.configure,
			chain: [
				attempt('openai', 'winner', async () => {
					calls.push('summarize:openai');
					return 'accepted summary';
				}),
				attempt('codex', 'must-not-run', async () => {
					calls.push('summarize:codex');
					return 'incorrect retry';
				}),
			],
		});
		await runSummary(harness);
		assert.deepEqual(calls, ['summarize:openai'], testCase.name);
		assert.equal(harness.modifications.length, 0, testCase.name);
		assert.match(finalLog(harness.logs), new RegExp(`result=NG reason=${testCase.reason}(?: |$)`), testCase.name);
	}
}

async function testMaliciousProviderMetadataCannotForgeLogEntries() {
	const maliciousProvider = `openai\nresult=OK provider=forged${'p'.repeat(1500)}`;
	const maliciousModel = `model\tresult=OK\nreason=FORGED${'m'.repeat(1500)}`;
	const harness = createHarness({chain: [
		attempt(maliciousProvider, maliciousModel, async () => 'safe summary'),
	]});

	await runSummary(harness);

	assertSingleLineBoundedLogs(harness.logs);
	assert.equal(harness.logs.join('\n').includes('provider=forged'), false);
	assert.equal(harness.logs.join('\n').includes('reason=FORGED'), false);
	assert.equal(harness.logs.join('\n').includes(maliciousProvider), false);
	assert.equal(harness.logs.join('\n').includes(maliciousModel), false);
	assert.equal(attemptLogs(harness.logs).length, 2);
	assert.match(finalLog(harness.logs), /result=OK/);
}

async function testLocalErrorMetadataCannotForgeFinalNgLogFields() {
	const codeSecret = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456';
	const messageSecret = 'sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456';
	const localError = new Error(`note read failed with spaces result=OK Authorization: Bearer ${messageSecret}`);
	localError.name = `InjectedError\nresult=OK${'n'.repeat(200)}`;
	localError.code = `E_READ	forged=result=OK	Bearer ${codeSecret}${'c'.repeat(200)}`;
	const harness = createHarness({
		noteReadError: localError,
		chain: [attempt('openai', 'model', async () => 'accepted summary')],
	});

	await runSummary(harness);

	const line = finalLog(harness.logs);
	assert.equal(line.includes('\r') || line.includes('\n') || line.includes('	'), false, 'final NG log must be one physical line');
	assert.equal(line.match(/(?:^| )result=OK(?: |$)/g)?.length ?? 0, 0, 'error metadata forged result=OK');
	assert.equal(line.includes(codeSecret), false, 'final NG log leaked code secret');
	assert.equal(line.includes(messageSecret), false, 'final NG log leaked message secret');
	const fields = parseLogFields(line);
	assert.match(line, /result=NG reason=NOTE_READ_FAILED .*provider=openai model=model(?: |$)/);
	for (const field of ['errorName', 'errorCode', 'errorSummary']) {
		assert.ok(fields[field].length <= 128, `${field} exceeded metadata bound: ${fields[field].length}`);
	}
}

async function testMaliciousSummaryPathsCannotForgeStartOrFinalLogFields() {
	const noteSecret = `sk-${'n'.repeat(24)}`;
	const promptSecret = `ghp_${'p'.repeat(24)}`;
	const maliciousBaseName = `Paper\tresult=OK noteSecret=${noteSecret}=${'b'.repeat(1500)}`;
	const maliciousNotePath = `Papers/${maliciousBaseName}\nresult=OK forged=start.md`;
	const maliciousHtmlPath = `Papers/${maliciousBaseName}/2501.12345.html`;
	const maliciousPromptPath = `prompts/summary\nresult=OK promptSecret=${promptSecret}=${'q'.repeat(1500)}.md`;
	const harness = createHarness({
		noteFile: {
			path: maliciousNotePath,
			basename: maliciousBaseName,
			parent: {path: 'Papers'},
		},
		settings: {systemPromptPath: maliciousPromptPath},
		adapterFiles: {
			[maliciousHtmlPath]: '<html><article>paper body</article></html>',
			[maliciousPromptPath]: 'Summarize in Japanese.',
		},
		noteReadError: new Error('fixed local read failure'),
		chain: [attempt('openai', 'model', async () => 'safe summary')],
	});

	await runSummary(harness);

	assertSingleLineBoundedLogs(harness.logs);
	assert.equal(harness.logs.join('\n').includes(noteSecret), false, 'logs leaked note path secret');
	assert.equal(harness.logs.join('\n').includes(promptSecret), false, 'logs leaked prompt path secret');
	assert.equal(harness.logs[0].match(/(?:^| )result=OK(?: |$)/g)?.length ?? 0, 0, 'start log forged result=OK');
	assert.equal(finalLog(harness.logs).match(/(?:^| )result=OK(?: |$)/g)?.length ?? 0, 0, 'final log forged result=OK');
	assert.equal(finalLog(harness.logs).match(/(?:^| )result=NG(?: |$)/g)?.length ?? 0, 1, 'final log must have one result=NG');
	const startFields = parseLogFields(harness.logs[0]);
	const endFields = parseLogFields(finalLog(harness.logs));
	for (const [name, value] of Object.entries({
		notePath: startFields.notePath,
		noteBaseName: startFields.noteBaseName,
		htmlPath: endFields.htmlPath,
		promptPath: endFields.promptPath,
	})) {
		assert.ok(value.length <= 128, `${name} exceeded metadata bound: ${value.length}`);
	}
}

async function testSamePathReplacementIsNotReadOrModifiedAfterProviderSuccess() {
	const replacementFile = {
		path: 'Papers/Test Paper.md',
		basename: 'Test Paper',
		parent: {path: 'Papers'},
	};
	const providerCalls = [];
	const harness = createHarness({
		latestFile: replacementFile,
		chain: [
			attempt('openai', 'winner', async () => {
				providerCalls.push('summarize:openai');
				return 'accepted summary';
			}),
			attempt('codex', 'must-not-run', async () => {
				providerCalls.push('summarize:codex');
				return 'incorrect retry';
			}),
		],
		dependencies: {isTFile: (file) => file === replacementFile || file?.path === 'Papers/Test Paper.md'},
	});

	await runSummary(harness);

	assert.deepEqual(providerCalls, ['summarize:openai']);
	assert.equal(harness.calls.some((call) => call.startsWith('vault.read:')), false);
	assert.equal(harness.calls.some((call) => call.startsWith('vault.modify:')), false);
	assert.deepEqual(harness.modifications, []);
	assert.match(finalLog(harness.logs), /result=NG reason=NOTE_MOVED_OR_DELETED(?: |$)/);
}

async function testInvalidTimeoutFailsBeforeChainAndProviderAttempts() {
	for (const timeout of [0, -1, Number.NaN, MAX_TIMEOUT_SEC + 1, Number.POSITIVE_INFINITY]) {
		const calls = [];
		const harness = createHarness({
			llmTimeoutSec: timeout,
			chain: [attempt('openai', 'model', async () => {
				calls.push('summarize:openai');
				return 'unused';
			})],
		});

		await runSummary(harness);

		assert.equal(harness.providerChainCalls, 0, `timeout=${String(timeout)}`);
		assert.deepEqual(calls, [], `timeout=${String(timeout)}`);
		assert.equal(harness.modifications.length, 0, `timeout=${String(timeout)}`);
		assert.match(finalLog(harness.logs), /result=NG reason=LLM_TIMEOUT_INVALID(?: |$)/, `timeout=${String(timeout)}`);
	}
}

async function testWaitIntervalAlwaysClearedAfterItStarts() {
	const cases = [
		{
			name: 'success',
			configure: {chain: [attempt('openai', 'model', async () => 'summary')]},
		},
		{
			name: 'all fail',
			configure: {chain: [attempt('openai', 'model', async () => { throw new Error('failed'); })]},
		},
		{
			name: 'local write failure',
			configure: {
				noteWriteError: new Error('write failed'),
				chain: [attempt('openai', 'model', async () => 'summary')],
			},
		},
	];

	for (const testCase of cases) {
		const harness = createHarness(testCase.configure);
		await runSummary(harness);
		assert.equal(harness.startedIntervals.length, 1, testCase.name);
		assert.deepEqual(harness.clearedIntervals, [harness.startedIntervals[0].id], testCase.name);
	}
}

async function run(name, test) {
	await test();
	console.log(`ok - ${name}`);
}

async function main() {
	await run('disabled summary skips all summary work as a successful run', testDisabledSummarySkipsAllSummaryWorkAsSuccessfulRun);
	await run('OpenAI failure falls back to Codex and logs selected provider', testOpenAiFailureFallsBackToCodexAndLogsSelectedProvider);
	await run('OpenAI and Codex failures fall back to Gemini with one write', testTwoFailuresFallBackToGeminiAndWriteOnce);
	await run('late primary completion is isolated after timeout fallback', testPrimaryTimeoutLateResolveCannotWriteOrLogAgain);
	await run('existing summary block is replaced without duplication', testExistingSummaryBlockIsReplacedWithoutDuplication);
	await run('all failures preserve exact note bytes and do not leak secrets', testAllAttemptsFailWithoutChangingNoteOrLeakingSecret);
	await run('local prerequisites fail before provider chain construction', testLocalPrerequisiteFailuresDoNotConstructOrCallProviders);
	await run('post-provider note failures do not retry later providers', testPostProviderNoteFailuresDoNotRunLaterProviders);
	await run('malicious provider metadata cannot forge logs', testMaliciousProviderMetadataCannotForgeLogEntries);
	await run('local error metadata cannot forge final NG log fields', testLocalErrorMetadataCannotForgeFinalNgLogFields);
	await run('malicious summary paths cannot forge start or final log fields', testMaliciousSummaryPathsCannotForgeStartOrFinalLogFields);
	await run('same-path replacement is not read or modified after provider success', testSamePathReplacementIsNotReadOrModifiedAfterProviderSuccess);
	await run('invalid timeout fails before chain construction', testInvalidTimeoutFailsBeforeChainAndProviderAttempts);
	await run('wait interval is always cleared after starting', testWaitIntervalAlwaysClearedAfterItStarts);
	console.log('summary_generator_fallback integration tests passed');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
