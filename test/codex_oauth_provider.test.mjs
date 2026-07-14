import assert from 'node:assert/strict';
import {Buffer} from 'node:buffer';
import {constants as fsConstants} from 'node:fs';
import {chmod, mkdtemp, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import process from 'node:process';
import jitiFactory from 'jiti';

const jiti = jitiFactory(import.meta.url);
const {
	CODEX_MAX_OUTPUT_CHARS,
	CODEX_MAX_RESPONSE_CHARS,
	CODEX_MAX_SSE_EVENT_CHARS,
	CODEX_MAX_SSE_EVENTS,
	CodexOAuthProvider,
} = jiti('../src/llm/providers/codex_oauth_provider.ts');
const {summarizeWithFallback} = jiti('../src/llm/fallback.ts');

const ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses';
const RESOURCE_SENTINEL = 'raw-resource-limit-sentinel';
const INCREMENTAL_SPLIT_SENTINEL = 'incremental-split-sentinel';
const AUTH_READ_LIMIT = 1024 * 1024 + 1;
const SECRET_VALUES = [
	'fake.jwt.secret',
	'fake-refresh-secret',
	'account-secret',
	'Bearer fake.jwt.secret',
	'{"auth_mode":"chatgpt"}',
	RESOURCE_SENTINEL,
	INCREMENTAL_SPLIT_SENTINEL,
];
const params = {systemPrompt: 'Summarize safely.', userContent: '<html>paper</html>'};

function auth(accessToken = 'fake.jwt.secret', accountId = 'account-secret') {
	return {accessToken, accountId};
}

function sse(events, lineEnding = '\n') {
	return events.map((event) => event.map((line) => line.replaceAll('\n', lineEnding)).join(lineEnding)).join(`${lineEnding}${lineEnding}`) + `${lineEnding}${lineEnding}`;
}

function delta(value) {
	return [`event: response.output_text.delta`, `data: ${JSON.stringify({type: 'response.output_text.delta', delta: value})}`];
}

function completed(outputText = undefined) {
	const response = outputText === undefined
		? {status: 'completed'}
		: {status: 'completed', output: [{content: [{type: 'output_text', text: outputText}]}]};
	return ['event: response.completed', `data: ${JSON.stringify({type: 'response.completed', response})}`];
}

function response(status, text, headers = {}) {
	return {status, text, headers};
}

function deferred() {
	let resolve;
	const promise = new Promise((resolvePromise) => {
		resolve = resolvePromise;
	});
	return {promise, resolve};
}

function providerWith({authReader = async () => auth(), replies = [response(200, sse([delta('summary'), completed()]))], model = 'codex-mini'} = {}) {
	const requests = [];
	let replyIndex = 0;
	const provider = new CodexOAuthProvider(model, {
		authReader,
		httpClient: async (request) => {
			requests.push(request);
			const reply = replies[replyIndex++];
			if (reply instanceof Error) throw reply;
			return reply;
		},
	});
	return {provider, requests};
}

function containsSecret(value, seen = new WeakSet()) {
	if (typeof value === 'string') return SECRET_VALUES.some((secret) => value.includes(secret));
	if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
		try {
			const rendered = JSON.stringify(value);
			return typeof rendered === 'string' && SECRET_VALUES.some((secret) => rendered.includes(secret));
		} catch {
			return false;
		}
	}
	if (seen.has(value)) return false;
	seen.add(value);
	for (const key of Reflect.ownKeys(value)) {
		let descriptor;
		try {
			descriptor = Object.getOwnPropertyDescriptor(value, key);
		} catch {
			continue;
		}
		if (descriptor && Object.hasOwn(descriptor, 'value') && containsSecret(descriptor.value, seen)) return true;
	}
	return false;
}

async function rejectsWithCode(action, code) {
	await assert.rejects(action, (error) => {
		assert.equal(error instanceof Error ? error.message : error, code);
		assert.equal(containsSecret(error), false, 'provider error leaked a secret');
		return true;
	});
}

async function doesNotRejectWithCode(action, code) {
	try {
		await action();
	} catch (error) {
		assert.notEqual(error instanceof Error ? error.message : error, code);
		assert.equal(containsSecret(error), false, 'provider error leaked a secret');
	}
}

async function withTempDir(test) {
	const directory = await mkdtemp(path.join(tmpdir(), 'codex-auth-test-'));
	try {
		await test(directory);
	} finally {
		await rm(directory, {recursive: true, force: true});
	}
}

async function testRequestContractAndSseSuccess() {
	const bodyText = sse([
		[': keepalive'],
		['event: future.event', 'data: {"ignored":true}'],
		delta(' first'),
		delta(' summary '),
		completed(' first summary '),
		['data: [DONE]'],
	], '\r\n');
	const {provider, requests} = providerWith({replies: [response(200, bodyText)]});

	const summary = await provider.summarize(params);
	const request = requests[0];
	assert.equal(summary, 'first summary');
	assert.deepEqual({
		url: request.url,
		method: request.method,
		headerNames: Object.keys(request.headers).sort(),
		authorizationScheme: request.headers.Authorization.split(' ')[0],
		accountHeaderPresent: Object.hasOwn(request.headers, 'ChatGPT-Account-ID'),
		contentType: request.headers['Content-Type'],
		accept: request.headers.Accept,
		throw: request.throw,
		body: JSON.parse(request.body),
	}, {
		url: ENDPOINT,
		method: 'POST',
		headerNames: ['Accept', 'Authorization', 'ChatGPT-Account-ID', 'Content-Type'],
		authorizationScheme: 'Bearer',
		accountHeaderPresent: true,
		contentType: 'application/json',
		accept: 'text/event-stream',
		throw: false,
		body: {
			model: 'codex-mini',
			instructions: 'Summarize safely.',
			input: [{role: 'user', content: [{type: 'input_text', text: '<html>paper</html>'}]}],
			tools: [],
			tool_choice: 'auto',
			parallel_tool_calls: false,
			reasoning: {effort: 'low', summary: 'concise'},
			store: false,
			stream: true,
			include: [],
		},
	});
}

async function testSseParsingDoesNotSplitTheWholeRawResponse() {
	const bodyText = `${(': keepalive\r\n\r\n').repeat(2_000)}: ${RESOURCE_SENTINEL}\r\n\r\n${sse([
		delta('incremental summary'),
		completed('incremental summary'),
		['data: [DONE]'],
	], '\r\n')}`;
	const {provider} = providerWith({replies: [response(200, bodyText)]});
	const originalSplit = String.prototype.split;
	let summary;
	let caught;

	String.prototype.split = function(separator, limit) {
		if (
			String(this) === bodyText
			&& separator instanceof RegExp
			&& separator.source === '\\r\\n|\\r|\\n'
		) {
			throw new Error(INCREMENTAL_SPLIT_SENTINEL);
		}
		return originalSplit.call(this, separator, limit);
	};
	try {
		summary = await provider.summarize(params);
	} catch (error) {
		caught = error;
	} finally {
		String.prototype.split = originalSplit;
	}

	if (caught !== undefined) {
		assert.equal(containsSecret(caught), false, 'parser error leaked the split sentinel or raw SSE');
		throw caught;
	}
	assert.equal(summary, 'incremental summary');
}

async function test401ReloadsSameAccountAndRetriesWithNewToken() {
	const authReads = [auth('first-token', 'stable-account'), auth('second-token', 'stable-account')];
	let reads = 0;
	const {provider, requests} = providerWith({
		authReader: async () => authReads[reads++],
		replies: [response(401, 'raw secret response'), response(200, sse([delta('retried'), completed()]))],
	});

	assert.equal(await provider.summarize(params), 'retried');
	assert.deepEqual({reads, requestCount: requests.length, schemes: requests.map((request) => request.headers.Authorization.split(' ')[0])}, {
		reads: 2,
		requestCount: 2,
		schemes: ['Bearer', 'Bearer'],
	});
	assert.equal(requests[0].headers.Authorization === requests[1].headers.Authorization, false);
}

async function testAbortDuringFirstRequestStopsBefore401AuthReload() {
	const firstHttp = deferred();
	const controller = new AbortController();
	let authReads = 0;
	let httpRequests = 0;
	const provider = new CodexOAuthProvider('model', {
		authReader: async () => {
			authReads++;
			return auth(`token-${authReads}`, 'stable-account');
		},
		httpClient: async () => {
			httpRequests++;
			return await firstHttp.promise;
		},
	});

	const summary = provider.summarize({...params, signal: controller.signal});
	while (httpRequests === 0) await Promise.resolve();
	controller.abort();
	firstHttp.resolve(response(401, 'late unauthorized response'));

	await rejectsWithCode(() => summary, 'CODEX_REQUEST_ABORTED');
	assert.deepEqual({authReads, httpRequests}, {authReads: 1, httpRequests: 1});
}

async function testPreAbortedSignalSkipsAuthAndHttp() {
	const controller = new AbortController();
	controller.abort();
	let authReads = 0;
	let httpRequests = 0;
	const provider = new CodexOAuthProvider('model', {
		authReader: async () => {
			authReads++;
			return auth();
		},
		httpClient: async () => {
			httpRequests++;
			return response(200, 'unused');
		},
	});

	await rejectsWithCode(() => provider.summarize({...params, signal: controller.signal}), 'CODEX_REQUEST_ABORTED');
	assert.deepEqual({authReads, httpRequests}, {authReads: 0, httpRequests: 0});
}

async function testFallbackTimeoutPreventsLateCodex401SideEffectsAfterGeminiWins() {
	const originalSetTimeout = globalThis.setTimeout;
	const originalClearTimeout = globalThis.clearTimeout;
	const firstHttp = deferred();
	const codexSettled = deferred();
	let timeoutCallback;
	let authReads = 0;
	let httpRequests = 0;
	const codex = new CodexOAuthProvider('model', {
		authReader: async () => {
			authReads++;
			return auth(`token-${authReads}`, 'stable-account');
		},
		httpClient: async () => {
			httpRequests++;
			return await firstHttp.promise;
		},
	});

	globalThis.setTimeout = (callback) => {
		timeoutCallback = callback;
		return 1;
	};
	globalThis.clearTimeout = () => {};
	try {
		const fallback = summarizeWithFallback([
			{
				providerName: 'codex',
				model: 'model',
				provider: {
					summarize: async (attemptParams) => {
						try {
							return await codex.summarize(attemptParams);
						} finally {
							codexSettled.resolve();
						}
					},
				},
			},
			{providerName: 'gemini', model: 'gemini-model', provider: {summarize: async () => 'gemini summary'}},
		], params, {timeoutMs: 10});
		while (httpRequests === 0) await Promise.resolve();
		timeoutCallback();
		const result = await fallback;
		firstHttp.resolve(response(401, 'late unauthorized response'));
		await codexSettled.promise;

		assert.deepEqual(
			{summary: result.summary, providerName: result.providerName, authReads, httpRequests},
			{summary: 'gemini summary', providerName: 'gemini', authReads: 1, httpRequests: 1}
		);
	} finally {
		globalThis.setTimeout = originalSetTimeout;
		globalThis.clearTimeout = originalClearTimeout;
	}
}

async function test401AccountMismatchOrMissingDoesNotRetry() {
	for (const reloaded of [auth('second-token', 'different-account'), {accessToken: 'second-token'}]) {
		let reads = 0;
		let requests = 0;
		const provider = new CodexOAuthProvider('model', {
			authReader: async () => reads++ === 0 ? auth('first-token', 'stable-account') : reloaded,
			httpClient: async () => {
				requests++;
				return response(401, 'raw');
			},
		});
		await rejectsWithCode(() => provider.summarize(params), 'CODEX_AUTH_RELOAD_INVALID');
		assert.deepEqual({reads, requests}, {reads: 2, requests: 1});
	}
}

async function testSecond401StopsWithoutThirdRequest() {
	let reads = 0;
	const {provider, requests} = providerWith({
		authReader: async () => {
			reads++;
			return auth(`token-${reads}`, 'stable-account');
		},
		replies: [response(401, 'first'), response(401, 'second')],
	});
	await rejectsWithCode(() => provider.summarize(params), 'CODEX_UNAUTHORIZED');
	assert.deepEqual({reads, requests: requests.length}, {reads: 2, requests: 2});
}

async function testNon401DoesNotReloadOrRetry() {
	for (const status of [400, 403, 429, 500]) {
		let reads = 0;
		const {provider, requests} = providerWith({
			authReader: async () => {
				reads++;
				return auth();
			},
			replies: [response(status, 'fake.jwt.secret raw body', {'x-secret': 'fake-refresh-secret'})],
		});
		await rejectsWithCode(() => provider.summarize(params), 'CODEX_REQUEST_FAILED');
		assert.deepEqual({status, reads, requests: requests.length}, {status, reads: 1, requests: 1});
	}
}

async function testInjectedAuthValidation() {
	const cases = [
		{value: undefined, code: 'CODEX_AUTH_INVALID'},
		{value: {}, code: 'CODEX_AUTH_ACCESS_TOKEN_INVALID'},
		{value: {accessToken: '', accountId: 'ok'}, code: 'CODEX_AUTH_ACCESS_TOKEN_INVALID'},
		{value: {accessToken: 'token'}, code: 'CODEX_AUTH_ACCOUNT_ID_INVALID'},
		{value: {accessToken: 'token', accountId: ''}, code: 'CODEX_AUTH_ACCOUNT_ID_INVALID'},
		{value: {accessToken: 'token', accountId: 'unsafe account'}, code: 'CODEX_AUTH_ACCOUNT_ID_INVALID'},
		{value: {accessToken: 'token', accountId: 'x'.repeat(257)}, code: 'CODEX_AUTH_ACCOUNT_ID_INVALID'},
	];
	for (const testCase of cases) {
		const {provider, requests} = providerWith({authReader: async () => testCase.value});
		await rejectsWithCode(() => provider.summarize(params), testCase.code);
		assert.equal(requests.length, 0);
	}
}

async function testUnsafeAccessTokensAreRejectedBeforeHttpRequest() {
	const invalidTokens = [
		'',
		'token\r\nInjected: header',
		'token	value',
		' token',
		'token ',
		'tok en',
		'tokén',
		'tok=en',
		'x'.repeat(16_385),
	];
	for (const accessToken of invalidTokens) {
		const {provider, requests} = providerWith({authReader: async () => auth(accessToken, 'safe-account')});
		let error;
		try {
			await provider.summarize(params);
		} catch (caught) {
			error = caught;
		}
		if (error !== undefined) assert.equal(containsSecret(error), false, 'provider error leaked a secret');
		assert.deepEqual({
			code: error instanceof Error ? error.message : error,
			requestCount: requests.length,
		}, {
			code: 'CODEX_AUTH_ACCESS_TOKEN_INVALID',
			requestCount: 0,
		});
	}
}

async function testMaximumLengthSafeAccessTokenIsAccepted() {
	const accessToken = 'Ab0._~+/-'.padEnd(16_382, 'A') + '==';
	const {provider, requests} = providerWith({authReader: async () => auth(accessToken, 'safe-account')});
	assert.equal(await provider.summarize(params), 'summary');
	assert.equal(requests.length, 1);
}

async function testAuthJsonShapeValidationAndUnknownFields() {
	await withTempDir(async (directory) => {
		const authPath = path.join(directory, 'auth.json');
		const cases = [
			{json: {}, code: 'CODEX_AUTH_MODE_INVALID'},
			{json: {auth_mode: 'apikey', tokens: {}}, code: 'CODEX_AUTH_MODE_INVALID'},
			{json: {auth_mode: 'chatgpt'}, code: 'CODEX_AUTH_TOKENS_INVALID'},
			{json: {auth_mode: 'chatgpt', tokens: []}, code: 'CODEX_AUTH_TOKENS_INVALID'},
			{json: {auth_mode: 'chatgpt', tokens: {account_id: 'ok'}}, code: 'CODEX_AUTH_ACCESS_TOKEN_INVALID'},
			{json: {auth_mode: 'chatgpt', tokens: {access_token: 'token'}}, code: 'CODEX_AUTH_ACCOUNT_ID_INVALID'},
			{json: {auth_mode: 'chatgpt', tokens: {access_token: 'token', account_id: 'bad/header'}}, code: 'CODEX_AUTH_ACCOUNT_ID_INVALID'},
		];
		for (const testCase of cases) {
			await writeFile(authPath, JSON.stringify(testCase.json), {mode: 0o600});
			const provider = new CodexOAuthProvider('model', {authPath, httpClient: async () => response(200, '')});
			await rejectsWithCode(() => provider.summarize(params), testCase.code);
		}

		await writeFile(authPath, JSON.stringify({
			auth_mode: 'chatgpt',
			refresh_token: 'fake-refresh-secret',
			unknown: {ignored: true},
			tokens: {access_token: 'token', account_id: 'safe_account-1', refresh_token: 'fake-refresh-secret', extra: 1},
		}), {mode: 0o600});
		const provider = new CodexOAuthProvider('model', {
			authPath,
			httpClient: async () => response(200, sse([delta('ok'), completed()])),
		});
		assert.equal(await provider.summarize(params), 'ok');
	});
}

async function testDefaultPathAndSafeOpenFlags() {
	let openedPath;
	let openedFlags;
	let closed = 0;
	const authBytes = Buffer.from(JSON.stringify({auth_mode: 'chatgpt', tokens: {access_token: 'token', account_id: 'account'}}));
	let position = 0;
	const provider = new CodexOAuthProvider('model', {
		safeReaderDependencies: {
			getUid: () => 123,
			open: async (authPath, flags) => {
				openedPath = authPath;
				openedFlags = flags;
				return {
					stat: async () => ({isFile: () => true, uid: 123, mode: 0o100600, size: authBytes.length}),
					read: async (buffer, offset = 0, length = buffer.length - offset) => {
						const bytesRead = Math.min(length, authBytes.length - position);
						if (bytesRead > 0) authBytes.copy(buffer, offset, position, position + bytesRead);
						position += bytesRead;
						return {bytesRead, buffer};
					},
					close: async () => { closed++; },
				};
			},
		},
		httpClient: async () => response(200, sse([delta('ok'), completed()])),
	});
	assert.equal(await provider.summarize(params), 'ok');
	assert.deepEqual({
		pathSuffix: openedPath.slice(-path.join('.codex', 'auth.json').length),
		flags: openedFlags,
		closed,
	}, {
		pathSuffix: path.join('.codex', 'auth.json'),
		flags: fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
		closed: 1,
	});
}

async function testSafeAuthReaderUsesBoundedHandleReadsInsteadOfReadFile() {
	const authBytes = Buffer.from(JSON.stringify({
		auth_mode: 'chatgpt',
		tokens: {access_token: 'token', account_id: 'account'},
	}));
	const requestedLengths = [];
	let position = 0;
	let readCalls = 0;
	let readFileCalls = 0;
	let closed = 0;
	let httpRequests = 0;
	const provider = new CodexOAuthProvider('model', {
		safeReaderDependencies: {
			getUid: () => 123,
			open: async () => ({
				stat: async () => ({isFile: () => true, uid: 123, mode: 0o100600, size: authBytes.length}),
				read: async (buffer, offset = 0, length = buffer.length - offset) => {
					readCalls++;
					requestedLengths.push(length);
					const bytesRead = Math.min(length, authBytes.length - position);
					if (bytesRead > 0) authBytes.copy(buffer, offset, position, position + bytesRead);
					position += bytesRead;
					return {bytesRead, buffer};
				},
				readFile: async () => {
					readFileCalls++;
					throw new Error(INCREMENTAL_SPLIT_SENTINEL);
				},
				close: async () => { closed++; },
			}),
		},
		httpClient: async () => {
			httpRequests++;
			return response(200, sse([delta('bounded auth'), completed()]));
		},
	});

	assert.equal(await provider.summarize(params), 'bounded auth');
	assert.equal(readCalls > 0, true);
	assert.equal(readFileCalls, 0);
	assert.equal(requestedLengths.every((length) => length <= AUTH_READ_LIMIT), true);
	assert.equal(requestedLengths.reduce((total, length) => total + length, 0) <= AUTH_READ_LIMIT, true);
	assert.deepEqual({httpRequests, closed}, {httpRequests: 1, closed: 1});
}

async function testSafeAuthReaderRejectsGrowthAfterStatWithinBoundedRead() {
	const requestedLengths = [];
	let bytesSupplied = 0;
	let readFileCalls = 0;
	let closed = 0;
	let httpRequests = 0;
	const provider = new CodexOAuthProvider('model', {
		safeReaderDependencies: {
			getUid: () => 123,
			open: async () => ({
				stat: async () => ({isFile: () => true, uid: 123, mode: 0o100600, size: 16}),
				read: async (buffer, offset = 0, length = buffer.length - offset) => {
					requestedLengths.push(length);
					const bytesRead = Math.min(length, AUTH_READ_LIMIT - bytesSupplied);
					if (bytesRead > 0) buffer.fill(0x20, offset, offset + bytesRead);
					bytesSupplied += bytesRead;
					return {bytesRead, buffer};
				},
				readFile: async () => {
					readFileCalls++;
					throw new Error(INCREMENTAL_SPLIT_SENTINEL);
				},
				close: async () => { closed++; },
			}),
		},
		httpClient: async () => {
			httpRequests++;
			return response(200, 'unused');
		},
	});

	await rejectsWithCode(() => provider.summarize(params), 'CODEX_AUTH_TOO_LARGE');
	assert.equal(requestedLengths.every((length) => length <= AUTH_READ_LIMIT), true);
	assert.equal(requestedLengths.reduce((total, length) => total + length, 0) <= AUTH_READ_LIMIT, true);
	assert.equal(bytesSupplied <= AUTH_READ_LIMIT, true);
	assert.deepEqual({readFileCalls, httpRequests, closed}, {readFileCalls: 0, httpRequests: 0, closed: 1});
}

async function testSafeOpenRealFileBoundaries() {
	await withTempDir(async (directory) => {
		const validPath = path.join(directory, 'auth.json');
		const validJson = JSON.stringify({auth_mode: 'chatgpt', tokens: {access_token: 'token', account_id: 'account'}});
		await writeFile(validPath, validJson, {mode: 0o600});
		const makeProvider = (authPath) => new CodexOAuthProvider('model', {
			authPath,
			httpClient: async () => response(200, sse([delta('ok'), completed()])),
		});
		assert.equal(await makeProvider(validPath).summarize(params), 'ok');

		const missingPath = path.join(directory, 'missing.json');
		await rejectsWithCode(() => makeProvider(missingPath).summarize(params), 'CODEX_AUTH_OPEN_FAILED');

		const linkPath = path.join(directory, 'link.json');
		await symlink(validPath, linkPath);
		await rejectsWithCode(() => makeProvider(linkPath).summarize(params), 'CODEX_AUTH_OPEN_FAILED');
		await rejectsWithCode(() => makeProvider(directory).summarize(params), 'CODEX_AUTH_NOT_REGULAR');

		await chmod(validPath, 0o644);
		await rejectsWithCode(() => makeProvider(validPath).summarize(params), 'CODEX_AUTH_PERMISSIONS_INVALID');
		await chmod(validPath, 0o600);

		const oversizedPath = path.join(directory, 'oversized.json');
		await writeFile(oversizedPath, 'x'.repeat(1024 * 1024 + 1), {mode: 0o600});
		await rejectsWithCode(() => makeProvider(oversizedPath).summarize(params), 'CODEX_AUTH_TOO_LARGE');

		const partialPath = path.join(directory, 'partial.json');
		await writeFile(partialPath, '{"auth_mode":"chatgpt"', {mode: 0o600});
		await rejectsWithCode(() => makeProvider(partialPath).summarize(params), 'CODEX_AUTH_JSON_INVALID');
	});
}

async function testSafeReaderInjectedViolationsAndCloseFinally() {
	const cases = [
		{getUid: undefined, code: 'CODEX_AUTH_UNSUPPORTED', stat: {isFile: () => true, uid: 1, mode: 0o100600, size: 1}},
		{getUid: () => undefined, code: 'CODEX_AUTH_UNSUPPORTED', stat: {isFile: () => true, uid: 1, mode: 0o100600, size: 1}},
		{getUid: () => { throw new Error('fake.jwt.secret'); }, code: 'CODEX_AUTH_UNSUPPORTED', stat: {isFile: () => true, uid: 1, mode: 0o100600, size: 1}},
		{getUid: () => 1, code: 'CODEX_AUTH_NOT_REGULAR', stat: {isFile: () => false, uid: 1, mode: 0o040700, size: 1}},
		{getUid: () => 1, code: 'CODEX_AUTH_OWNER_INVALID', stat: {isFile: () => true, uid: 2, mode: 0o100600, size: 1}},
		{getUid: () => 1, code: 'CODEX_AUTH_PERMISSIONS_INVALID', stat: {isFile: () => true, uid: 1, mode: 0o100640, size: 1}},
		{getUid: () => 1, code: 'CODEX_AUTH_TOO_LARGE', stat: {isFile: () => true, uid: 1, mode: 0o100600, size: 1024 * 1024 + 1}},
	];
	for (const testCase of cases) {
		let closed = 0;
		const provider = new CodexOAuthProvider('model', {
			safeReaderDependencies: {
				getUid: testCase.getUid,
				open: async () => ({
					stat: async () => testCase.stat,
					readFile: async () => '{"auth_mode":"chatgpt"}',
					close: async () => { closed++; },
				}),
			},
			httpClient: async () => response(200, ''),
		});
		await rejectsWithCode(() => provider.summarize(params), testCase.code);
		assert.equal(closed, testCase.code === 'CODEX_AUTH_UNSUPPORTED' ? 0 : 1);
	}

	for (const operation of ['stat', 'read']) {
		let closed = 0;
		const provider = new CodexOAuthProvider('model', {
			safeReaderDependencies: {
				getUid: () => 1,
				open: async () => ({
					stat: async () => {
						if (operation === 'stat') throw new Error('fake.jwt.secret');
						return {isFile: () => true, uid: 1, mode: 0o100600, size: 10};
					},
					read: async () => {
						if (operation === 'read') throw new Error('fake-refresh-secret');
						return {bytesRead: 0};
					},
					close: async () => { closed++; },
				}),
			},
			httpClient: async () => response(200, ''),
		});
		await rejectsWithCode(() => provider.summarize(params), 'CODEX_AUTH_READ_FAILED');
		assert.equal(closed, 1);
	}
}

async function testHttpAndResponsePropertyErrorsAreSafe() {
	const thrownHttp = providerWith({replies: [new Error('Bearer fake.jwt.secret')]});
	await rejectsWithCode(() => thrownHttp.provider.summarize(params), 'CODEX_REQUEST_FAILED');

	for (const property of ['status', 'text']) {
		const poisoned = response(200, sse([delta('ok'), completed()]));
		Object.defineProperty(poisoned, property, {get() { throw new Error(`fake.jwt.secret ${property}`); }});
		const {provider} = providerWith({replies: [poisoned]});
		const expected = property === 'text' ? 'CODEX_RESPONSE_READ_FAILED' : 'CODEX_REQUEST_FAILED';
		await rejectsWithCode(() => provider.summarize(params), expected);
	}

	const unusedPoisonedHeaders = response(200, sse([delta('ok'), completed()]));
	Object.defineProperty(unusedPoisonedHeaders, 'headers', {get() { throw new Error('fake-refresh-secret'); }});
	const {provider} = providerWith({replies: [unusedPoisonedHeaders]});
	assert.equal(await provider.summarize(params), 'ok');
}

async function testSseFailureBoundaries() {
	const cases = [
		{name: 'malformed JSON', body: sse([['data: {not-json']]), code: 'CODEX_RESPONSE_JSON_INVALID'},
		{name: 'error event', body: sse([['event: error', 'data: {"type":"error","message":"fake.jwt.secret"}']]), code: 'CODEX_RESPONSE_ERROR'},
		{name: 'response failed', body: sse([['data: {"type":"response.failed","response":{"error":{"message":"fake.jwt.secret"}}}']]), code: 'CODEX_RESPONSE_FAILED'},
		{name: 'EOF without completed', body: sse([delta('partial')]), code: 'CODEX_RESPONSE_INCOMPLETE'},
		{name: 'DONE without completed', body: sse([delta('partial'), ['data: [DONE]']]), code: 'CODEX_RESPONSE_INCOMPLETE'},
		{name: 'empty output', body: sse([delta('   '), completed('')]), code: 'CODEX_RESPONSE_EMPTY'},
	];
	for (const testCase of cases) {
		const {provider} = providerWith({replies: [response(200, testCase.body)]});
		await rejectsWithCode(() => provider.summarize(params), testCase.code);
	}
}

async function testDuplicateCompletedIsRejected() {
	const body = sse([completed('first'), completed('second')]);
	const {provider} = providerWith({replies: [response(200, body)]});
	await rejectsWithCode(() => provider.summarize(params), 'CODEX_RESPONSE_SEQUENCE_INVALID');
}

async function testSemanticEventsAfterCompletedAreRejected() {
	const trailingEvents = [
		delta('late'),
		['event: error', 'data: {"type":"error"}'],
		['event: future.event', 'data: {"type":"future.event"}'],
	];
	for (const trailingEvent of trailingEvents) {
		const body = sse([completed('final'), trailingEvent]);
		const {provider} = providerWith({replies: [response(200, body)]});
		await rejectsWithCode(() => provider.summarize(params), 'CODEX_RESPONSE_SEQUENCE_INVALID');
	}
}

async function testDoneHardTerminatesAndIgnoresAllFollowingBytes() {
	const body = sse([
		completed('final output'),
		['data: [DONE]'],
		delta('late'),
		['event: error', 'data: {"type":"error"}'],
		['data: {malformed'],
	]);
	const {provider} = providerWith({replies: [response(200, body)]});
	assert.equal(await provider.summarize(params), 'final output');
}

async function testDoneBeforeCompletedRemainsIncomplete() {
	const body = sse([['data: [DONE]'], completed('too late')]);
	const {provider} = providerWith({replies: [response(200, body)]});
	await rejectsWithCode(() => provider.summarize(params), 'CODEX_RESPONSE_INCOMPLETE');
}

async function testDeltaAndCompletedTextAreNotDoubleAppended() {
	const body = sse([delta('same output'), completed('same output'), ['data: [DONE]']]);
	const {provider} = providerWith({replies: [response(200, body)]});
	assert.equal(await provider.summarize(params), 'same output');
}

async function testCrOnlySseLineEndingsAreSupported() {
	const body = sse([delta('cr only'), completed('cr only'), ['data: [DONE]']], '\r');
	const {provider} = providerWith({replies: [response(200, body)]});
	assert.equal(await provider.summarize(params), 'cr only');
}

async function testUnknownSseEventsAndMultilineDataAreIgnoredOrParsed() {
	const body = [
		': comment',
		'event: future.event',
		'data: {"type":"future.event"}',
		'',
		'event: response.output_text.delta',
		'data: {"type":"response.output_text.delta",',
		'data: "delta":"multi"}',
		'',
		...completed(),
		'',
	].join('\n');
	const {provider} = providerWith({replies: [response(200, body)]});
	assert.equal(await provider.summarize(params), 'multi');
}

async function testMalformedDeltaAndCompletedPayloadAreFixedParserErrors() {
	const cases = [
		sse([['data: {"type":"response.output_text.delta","delta":1}']]),
		sse([['data: {"type":"response.completed","response":null}']]),
	];
	for (const body of cases) {
		const {provider} = providerWith({replies: [response(200, body)]});
		await rejectsWithCode(() => provider.summarize(params), 'CODEX_RESPONSE_INVALID');
	}
}

async function testCodexResourceLimitsAreExactPositiveIntegerExports() {
	const limits = {
		CODEX_MAX_RESPONSE_CHARS,
		CODEX_MAX_SSE_EVENT_CHARS,
		CODEX_MAX_SSE_EVENTS,
		CODEX_MAX_OUTPUT_CHARS,
	};
	assert.deepEqual(limits, {
		CODEX_MAX_RESPONSE_CHARS: 4 * 1024 * 1024,
		CODEX_MAX_SSE_EVENT_CHARS: 256 * 1024,
		CODEX_MAX_SSE_EVENTS: 10_000,
		CODEX_MAX_OUTPUT_CHARS: 512 * 1024,
	});
	assert.equal(Object.values(limits).every((limit) => Number.isInteger(limit) && limit > 0), true);
}

async function testResponseTextResourceLimitBoundaries() {
	const oversizedBody = RESOURCE_SENTINEL + 'x'.repeat((4 * 1024 * 1024 + 1) - RESOURCE_SENTINEL.length);
	const oversized = providerWith({replies: [response(200, oversizedBody)]});
	await rejectsWithCode(() => oversized.provider.summarize(params), 'CODEX_RESPONSE_TOO_LARGE');

	const exactBody = 'x'.repeat(4 * 1024 * 1024);
	const exact = providerWith({replies: [response(200, exactBody)]});
	await doesNotRejectWithCode(() => exact.provider.summarize(params), 'CODEX_RESPONSE_TOO_LARGE');
}

async function testSseEventDataResourceLimitBoundaries() {
	const makeUnknownEvent = (dataLength) => [
		'event: future.resource-limit',
		`data: ${RESOURCE_SENTINEL}${'x'.repeat(dataLength - RESOURCE_SENTINEL.length)}`,
	];
	const oversizedBody = sse([makeUnknownEvent(256 * 1024 + 1), completed('ok')]);
	const oversized = providerWith({replies: [response(200, oversizedBody)]});
	await rejectsWithCode(() => oversized.provider.summarize(params), 'CODEX_SSE_EVENT_TOO_LARGE');

	const exactBody = sse([makeUnknownEvent(256 * 1024), completed('ok')]);
	const exact = providerWith({replies: [response(200, exactBody)]});
	await doesNotRejectWithCode(() => exact.provider.summarize(params), 'CODEX_SSE_EVENT_TOO_LARGE');
}

async function testSseEventCountResourceLimitBoundaries() {
	const unknownBlock = 'event: future.resource-limit\ndata: {}\n\n';
	const oversizedBody = unknownBlock.repeat(10_000) + sse([completed('ok')]);
	const oversized = providerWith({replies: [response(200, oversizedBody)]});
	await rejectsWithCode(() => oversized.provider.summarize(params), 'CODEX_SSE_EVENT_LIMIT');

	const exactBody = unknownBlock.repeat(9_999) + sse([completed('ok')]);
	const exact = providerWith({replies: [response(200, exactBody)]});
	await doesNotRejectWithCode(() => exact.provider.summarize(params), 'CODEX_SSE_EVENT_LIMIT');
}

async function testCumulativeOutputResourceLimitBoundaries() {
	const maxOutput = 512 * 1024;
	const chunk = 'x'.repeat(maxOutput / 4);
	const afterExactOutput = providerWith({replies: [response(200, sse([
		delta(chunk),
		delta(chunk),
		delta(chunk),
		delta(chunk),
		delta(RESOURCE_SENTINEL),
		completed(),
	]))]});
	await rejectsWithCode(() => afterExactOutput.provider.summarize(params), 'CODEX_OUTPUT_TOO_LARGE');

	const finalAddition = RESOURCE_SENTINEL + 'y'.repeat((maxOutput / 4 + 1) - RESOURCE_SENTINEL.length);
	const crossingAddition = providerWith({replies: [response(200, sse([
		delta(chunk),
		delta(chunk),
		delta(chunk),
		delta(finalAddition),
		completed(),
	]))]});
	await rejectsWithCode(() => crossingAddition.provider.summarize(params), 'CODEX_OUTPUT_TOO_LARGE');

	const exactChunk = 'o'.repeat(maxOutput / 4);
	const exactOutput = exactChunk.repeat(4);
	const exact = providerWith({replies: [response(200, sse([
		delta(exactChunk),
		delta(exactChunk),
		delta(exactChunk),
		delta(exactChunk),
		completed(RESOURCE_SENTINEL),
	]))]});
	assert.equal(await exact.provider.summarize(params), exactOutput);
}

async function run(name, test) {
	await test();
	console.log(`ok - ${name}`);
}

async function main() {
	await run('SSE parser scans incrementally without splitting the whole raw response', testSseParsingDoesNotSplitTheWholeRawResponse);
	await run('safe auth reader uses bounded handle reads instead of readFile', testSafeAuthReaderUsesBoundedHandleReadsInsteadOfReadFile);
	await run('safe auth reader rejects growth after fstat within the read bound', testSafeAuthReaderRejectsGrowthAfterStatWithinBoundedRead);
	await run('Codex resource limits are exact positive integer exports', testCodexResourceLimitsAreExactPositiveIntegerExports);
	await run('response text resource limit boundaries', testResponseTextResourceLimitBoundaries);
	await run('SSE event data resource limit boundaries', testSseEventDataResourceLimitBoundaries);
	await run('SSE event count resource limit boundaries', testSseEventCountResourceLimitBoundaries);
	await run('cumulative output resource limit boundaries', testCumulativeOutputResourceLimitBoundaries);
	await run('request contract and SSE success', testRequestContractAndSseSuccess);
	await run('401 reloads same account and retries with new token', test401ReloadsSameAccountAndRetriesWithNewToken);
	await run('abort during first request stops before 401 auth reload', testAbortDuringFirstRequestStopsBefore401AuthReload);
	await run('pre-aborted signal skips auth and HTTP', testPreAbortedSignalSkipsAuthAndHttp);
	await run('fallback timeout prevents late Codex 401 side effects after Gemini wins', testFallbackTimeoutPreventsLateCodex401SideEffectsAfterGeminiWins);
	await run('401 account mismatch or missing does not retry', test401AccountMismatchOrMissingDoesNotRetry);
	await run('second 401 stops without third request', testSecond401StopsWithoutThirdRequest);
	await run('non-401 does not reload or retry', testNon401DoesNotReloadOrRetry);
	await run('injected auth validation', testInjectedAuthValidation);
	await run('unsafe access tokens are rejected before HTTP request', testUnsafeAccessTokensAreRejectedBeforeHttpRequest);
	await run('maximum-length safe access token is accepted', testMaximumLengthSafeAccessTokenIsAccepted);
	await run('auth JSON shape validation and unknown fields', testAuthJsonShapeValidationAndUnknownFields);
	await run('default path and safe-open flags', testDefaultPathAndSafeOpenFlags);
	await run('safe-open real file boundaries', testSafeOpenRealFileBoundaries);
	await run('safe reader injected violations and close finally', testSafeReaderInjectedViolationsAndCloseFinally);
	await run('HTTP and response property errors are safe', testHttpAndResponsePropertyErrorsAreSafe);
	await run('SSE failure boundaries', testSseFailureBoundaries);
	await run('duplicate completed is rejected', testDuplicateCompletedIsRejected);
	await run('semantic events after completed are rejected', testSemanticEventsAfterCompletedAreRejected);
	await run('DONE hard-terminates and ignores following bytes', testDoneHardTerminatesAndIgnoresAllFollowingBytes);
	await run('DONE before completed remains incomplete', testDoneBeforeCompletedRemainsIncomplete);
	await run('delta and completed text are not double-appended', testDeltaAndCompletedTextAreNotDoubleAppended);
	await run('CR-only SSE line endings are supported', testCrOnlySseLineEndingsAreSupported);
	await run('unknown SSE events and multiline data', testUnknownSseEventsAndMultilineDataAreIgnoredOrParsed);
	await run('malformed SSE payload shapes are fixed parser errors', testMalformedDeltaAndCompletedPayloadAreFixedParserErrors);
	console.log('codex_oauth_provider local tests passed');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
