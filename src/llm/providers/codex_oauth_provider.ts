/* Safe auth-file access intentionally requires Node.js POSIX filesystem APIs. */
/* eslint-disable import/no-nodejs-modules */
import {constants as fsConstants} from 'fs';
import {open as openFile} from 'fs/promises';
import {Buffer} from 'buffer';
import {homedir} from 'os';
import path from 'path';
import process from 'process';
import {requestUrl} from 'obsidian';
import type {LlmProvider, SummarizeParams} from '../types';

const CODEX_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses';
const MAX_AUTH_FILE_SIZE = 1024 * 1024;
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

type CodexAuth = {
	accessToken: string;
	accountId: string;
};

type HttpRequest = {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: string;
	throw: false;
};

type HttpResponse = {
	status: number;
	text: string;
	headers?: Record<string, string>;
};

type SafeStat = {
	isFile(): boolean;
	uid: number;
	mode: number;
	size: number;
};

type SafeFileHandle = {
	stat(): Promise<SafeStat>;
	readFile(options: {encoding: 'utf8'}): Promise<string>;
	close(): Promise<void>;
};

type SafeReaderDependencies = {
	getUid?: (() => number | undefined) | undefined;
	open?: ((authPath: string, flags: number) => Promise<SafeFileHandle>) | undefined;
	noFollowFlag?: number | undefined;
};

type CodexOAuthProviderDependencies = {
	authReader?: (() => Promise<unknown>) | undefined;
	httpClient?: ((request: HttpRequest) => Promise<HttpResponse>) | undefined;
	authPath?: string | undefined;
	safeReaderDependencies?: SafeReaderDependencies | undefined;
};

class CodexProviderError extends Error {
	constructor(code: string) {
		super(code);
		this.name = 'CodexProviderError';
	}
}

function fail(code: string): CodexProviderError {
	return new CodexProviderError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateAuth(value: unknown): CodexAuth {
	if (!isRecord(value)) throw fail('CODEX_AUTH_INVALID');
	const accessToken = value.accessToken;
	const accountId = value.accountId;
	if (typeof accessToken !== 'string' || accessToken.length === 0) {
		throw fail('CODEX_AUTH_ACCESS_TOKEN_INVALID');
	}
	if (
		typeof accountId !== 'string'
		|| accountId.length === 0
		|| accountId.length > 256
		|| !ACCOUNT_ID_PATTERN.test(accountId)
	) {
		throw fail('CODEX_AUTH_ACCOUNT_ID_INVALID');
	}
	return {accessToken, accountId};
}

function parseAuthJson(raw: string): CodexAuth {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw) as unknown;
	} catch {
		throw fail('CODEX_AUTH_JSON_INVALID');
	}
	if (!isRecord(parsed) || parsed.auth_mode !== 'chatgpt') {
		throw fail('CODEX_AUTH_MODE_INVALID');
	}
	if (!isRecord(parsed.tokens)) throw fail('CODEX_AUTH_TOKENS_INVALID');
	return validateAuth({
		accessToken: parsed.tokens.access_token,
		accountId: parsed.tokens.account_id,
	});
}

async function defaultOpen(authPath: string, flags: number): Promise<SafeFileHandle> {
	return await openFile(authPath, flags) as SafeFileHandle;
}

function defaultGetUid(): number | undefined {
	return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

async function readAuthFile(
	authPath: string,
	dependencies: SafeReaderDependencies = {}
): Promise<CodexAuth> {
	const getUid = Object.prototype.hasOwnProperty.call(dependencies, 'getUid')
		? dependencies.getUid
		: defaultGetUid;
	const open = dependencies.open ?? defaultOpen;
	const noFollowFlag = dependencies.noFollowFlag ?? fsConstants.O_NOFOLLOW;
	if (typeof getUid !== 'function' || typeof noFollowFlag !== 'number') {
		throw fail('CODEX_AUTH_UNSUPPORTED');
	}
	let uid: number | undefined;
	try {
		uid = getUid();
	} catch {
		throw fail('CODEX_AUTH_UNSUPPORTED');
	}
	if (typeof uid !== 'number' || !Number.isInteger(uid) || uid < 0) {
		throw fail('CODEX_AUTH_UNSUPPORTED');
	}

	let handle: SafeFileHandle;
	try {
		handle = await open(authPath, fsConstants.O_RDONLY | noFollowFlag);
	} catch {
		throw fail('CODEX_AUTH_OPEN_FAILED');
	}

	let raw: string | undefined;
	let operationError: unknown;
	try {
		const stat = await handle.stat();
		if (!stat.isFile()) throw fail('CODEX_AUTH_NOT_REGULAR');
		if (stat.uid !== uid) throw fail('CODEX_AUTH_OWNER_INVALID');
		if ((stat.mode & 0o077) !== 0) throw fail('CODEX_AUTH_PERMISSIONS_INVALID');
		if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > MAX_AUTH_FILE_SIZE) {
			throw fail('CODEX_AUTH_TOO_LARGE');
		}
		raw = await handle.readFile({encoding: 'utf8'});
		if (Buffer.byteLength(raw, 'utf8') > MAX_AUTH_FILE_SIZE) {
			throw fail('CODEX_AUTH_TOO_LARGE');
		}
	} catch (error) {
		operationError = error;
	} finally {
		try {
			await handle.close();
		} catch (error) {
			if (operationError === undefined) operationError = error;
		}
	}
	if (operationError instanceof CodexProviderError) throw operationError;
	if (operationError !== undefined || raw === undefined) throw fail('CODEX_AUTH_READ_FAILED');
	return parseAuthJson(raw);
}

type ParsedSseEvent = {
	eventName: string | undefined;
	data: string;
};

function parseJsonData(event: ParsedSseEvent): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(event.data) as unknown;
	} catch {
		throw fail('CODEX_RESPONSE_JSON_INVALID');
	}
	if (!isRecord(parsed)) throw fail('CODEX_RESPONSE_INVALID');
	return parsed;
}

function completedOutputText(payload: Record<string, unknown>): string {
	const response = payload.response;
	if (!isRecord(response)) throw fail('CODEX_RESPONSE_INVALID');
	if (!Array.isArray(response.output)) return '';
	let text = '';
	for (const output of response.output) {
		if (!isRecord(output) || !Array.isArray(output.content)) continue;
		for (const content of output.content) {
			if (isRecord(content) && content.type === 'output_text' && typeof content.text === 'string') {
				text += content.text;
			}
		}
	}
	return text;
}

function parseSse(raw: string): string {
	let output = '';
	let sawDelta = false;
	let sawCompleted = false;
	let eventName: string | undefined;
	let dataLines: string[] = [];

	const processEvent = (): void => {
		if (dataLines.length === 0) {
			eventName = undefined;
			return;
		}
		const event = {eventName, data: dataLines.join('\n')};
		eventName = undefined;
		dataLines = [];
		if (event.data === '[DONE]') return;
		const knownEventNames = new Set(['response.output_text.delta', 'response.completed', 'response.failed', 'error']);
		if (event.eventName !== undefined && !knownEventNames.has(event.eventName)) return;
		const payload = parseJsonData(event);
		const type = typeof payload.type === 'string' ? payload.type : event.eventName;
		if (type === 'error' || event.eventName === 'error') throw fail('CODEX_RESPONSE_ERROR');
		if (type === 'response.failed' || event.eventName === 'response.failed') throw fail('CODEX_RESPONSE_FAILED');
		if (type === 'response.output_text.delta' || event.eventName === 'response.output_text.delta') {
			if (typeof payload.delta !== 'string') throw fail('CODEX_RESPONSE_INVALID');
			output += payload.delta;
			sawDelta = true;
			return;
		}
		if (type === 'response.completed' || event.eventName === 'response.completed') {
			const finalText = completedOutputText(payload);
			if (!sawDelta) output += finalText;
			sawCompleted = true;
		}
	};

	for (const line of raw.split(/\r?\n/)) {
		if (line === '') {
			processEvent();
			continue;
		}
		if (line.startsWith(':')) continue;
		const separator = line.indexOf(':');
		const field = separator === -1 ? line : line.slice(0, separator);
		let value = separator === -1 ? '' : line.slice(separator + 1);
		if (value.startsWith(' ')) value = value.slice(1);
		if (field === 'event') eventName = value;
		if (field === 'data') dataLines.push(value);
	}
	processEvent();
	if (!sawCompleted) throw fail('CODEX_RESPONSE_INCOMPLETE');
	const summary = output.trim();
	if (summary.length === 0) throw fail('CODEX_RESPONSE_EMPTY');
	return summary;
}

type RequestResult = {
	status: number;
	text?: string;
};

export class CodexOAuthProvider implements LlmProvider {
	private readonly authReader: () => Promise<unknown>;
	private readonly httpClient: (request: HttpRequest) => Promise<HttpResponse>;

	constructor(
		private readonly model: string,
		dependencies: CodexOAuthProviderDependencies = {}
	) {
		const authPath = dependencies.authPath ?? path.join(homedir(), '.codex', 'auth.json');
		this.authReader = dependencies.authReader
			?? (async () => await readAuthFile(authPath, dependencies.safeReaderDependencies));
		this.httpClient = dependencies.httpClient
			?? (async (request) => await requestUrl(request));
	}

	async summarize(params: SummarizeParams): Promise<string> {
		const initialAuth = validateAuth(await this.readInitialAuth());
		const first = await this.request(params, initialAuth);
		if (first.status !== 401) return this.finish(first);

		let reloadedAuth: CodexAuth;
		try {
			reloadedAuth = validateAuth(await this.authReader());
		} catch {
			throw fail('CODEX_AUTH_RELOAD_INVALID');
		}
		if (reloadedAuth.accountId !== initialAuth.accountId) {
			throw fail('CODEX_AUTH_RELOAD_INVALID');
		}
		const second = await this.request(params, reloadedAuth);
		if (second.status === 401) throw fail('CODEX_UNAUTHORIZED');
		return this.finish(second);
	}

	private async readInitialAuth(): Promise<unknown> {
		try {
			return await this.authReader();
		} catch (error) {
			if (error instanceof CodexProviderError) throw error;
			throw fail('CODEX_AUTH_READ_FAILED');
		}
	}

	private async request(params: SummarizeParams, auth: CodexAuth): Promise<RequestResult> {
		let response: HttpResponse;
		try {
			response = await this.httpClient({
				url: CODEX_ENDPOINT,
				method: 'POST',
				headers: {
					Authorization: `Bearer ${auth.accessToken}`,
					'ChatGPT-Account-ID': auth.accountId,
					'Content-Type': 'application/json',
					Accept: 'text/event-stream',
				},
				body: JSON.stringify({
					model: this.model,
					instructions: params.systemPrompt,
					input: [{role: 'user', content: [{type: 'input_text', text: params.userContent}]}],
					tools: [],
					tool_choice: 'auto',
					parallel_tool_calls: false,
					reasoning: {effort: 'low', summary: 'concise'},
					store: false,
					stream: true,
					include: [],
				}),
				throw: false,
			});
		} catch {
			throw fail('CODEX_REQUEST_FAILED');
		}

		let status: number;
		try {
			status = response.status;
		} catch {
			throw fail('CODEX_REQUEST_FAILED');
		}
		if (!Number.isInteger(status)) throw fail('CODEX_REQUEST_FAILED');
		if (status < 200 || status >= 300) return {status};
		try {
			return {status, text: response.text};
		} catch {
			throw fail('CODEX_RESPONSE_READ_FAILED');
		}
	}

	private finish(result: RequestResult): string {
		if (result.status < 200 || result.status >= 300) throw fail('CODEX_REQUEST_FAILED');
		if (typeof result.text !== 'string') throw fail('CODEX_RESPONSE_READ_FAILED');
		try {
			return parseSse(result.text);
		} catch (error) {
			if (error instanceof CodexProviderError) throw error;
			throw fail('CODEX_RESPONSE_INVALID');
		}
	}
}
