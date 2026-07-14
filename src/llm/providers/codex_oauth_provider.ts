/* Safe auth-file access intentionally requires Node.js POSIX filesystem APIs. */
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
const MAX_AUTH_READ_CHUNK_SIZE = 64 * 1024;
const MAX_ACCESS_TOKEN_LENGTH = 16_384;
const ACCESS_TOKEN_PATTERN = /^[A-Za-z0-9._~+/-]+=*$/;
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export const CODEX_MAX_RESPONSE_CHARS = 4 * 1024 * 1024;
export const CODEX_MAX_SSE_EVENT_CHARS = 256 * 1024;
export const CODEX_MAX_SSE_EVENTS = 10_000;
export const CODEX_MAX_OUTPUT_CHARS = 512 * 1024;

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
	read(
		buffer: Buffer,
		offset: number,
		length: number,
		position: number
	): Promise<{bytesRead: number; buffer: Buffer}>;
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

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted === true) throw fail('CODEX_REQUEST_ABORTED');
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateAuth(value: unknown): CodexAuth {
	if (!isRecord(value)) throw fail('CODEX_AUTH_INVALID');
	const accessToken = value.accessToken;
	const accountId = value.accountId;
	if (
		typeof accessToken !== 'string'
		|| accessToken.length === 0
		|| accessToken.length > MAX_ACCESS_TOKEN_LENGTH
		|| !ACCESS_TOKEN_PATTERN.test(accessToken)
	) {
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
		const buffer = Buffer.alloc(MAX_AUTH_FILE_SIZE + 1);
		let totalBytesRead = 0;
		while (totalBytesRead < buffer.length) {
			const remaining = buffer.length - totalBytesRead;
			const length = Math.min(remaining, MAX_AUTH_READ_CHUNK_SIZE);
			const result = await handle.read(buffer, totalBytesRead, length, totalBytesRead);
			const bytesRead = result?.bytesRead;
			if (
				typeof bytesRead !== 'number'
				|| !Number.isInteger(bytesRead)
				|| bytesRead < 0
				|| bytesRead > length
			) {
				throw fail('CODEX_AUTH_READ_FAILED');
			}
			if (bytesRead === 0) break;
			totalBytesRead += bytesRead;
		}
		if (totalBytesRead > MAX_AUTH_FILE_SIZE) throw fail('CODEX_AUTH_TOO_LARGE');
		raw = buffer.toString('utf8', 0, totalBytesRead);
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

function appendCompletedOutputText(
	payload: Record<string, unknown>,
	appendOutput: (addition: string) => void
): void {
	const response = payload.response;
	if (!isRecord(response)) throw fail('CODEX_RESPONSE_INVALID');
	if (!Array.isArray(response.output)) return;
	for (const output of response.output) {
		if (!isRecord(output) || !Array.isArray(output.content)) continue;
		for (const content of output.content) {
			if (isRecord(content) && content.type === 'output_text' && typeof content.text === 'string') {
				appendOutput(content.text);
			}
		}
	}
}

function parseSse(raw: string): string {
	if (raw.length > CODEX_MAX_RESPONSE_CHARS) throw fail('CODEX_RESPONSE_TOO_LARGE');
	let output = '';
	let outputLength = 0;
	let sawDelta = false;
	let sawCompleted = false;
	let state: 'open' | 'completed' | 'done' = 'open';
	let eventName: string | undefined;
	let dataLines: string[] = [];
	let eventDataLength = 0;
	let eventCount = 0;
	let eventBlockNonEmpty = false;
	const isDone = (): boolean => state === 'done';
	const appendOutput = (addition: string): void => {
		if (addition.length > CODEX_MAX_OUTPUT_CHARS - outputLength) {
			throw fail('CODEX_OUTPUT_TOO_LARGE');
		}
		output += addition;
		outputLength += addition.length;
	};

	const processEvent = (): void => {
		if (state === 'done') return;
		if (eventBlockNonEmpty) {
			eventCount += 1;
			if (eventCount > CODEX_MAX_SSE_EVENTS) throw fail('CODEX_SSE_EVENT_LIMIT');
		}
		eventBlockNonEmpty = false;
		if (dataLines.length === 0) {
			eventName = undefined;
			eventDataLength = 0;
			return;
		}
		const event = {eventName, data: dataLines.join('\n')};
		eventName = undefined;
		dataLines = [];
		eventDataLength = 0;
		if (event.data === '[DONE]') {
			state = 'done';
			return;
		}
		if (state === 'completed') throw fail('CODEX_RESPONSE_SEQUENCE_INVALID');
		const knownEventNames = new Set(['response.output_text.delta', 'response.completed', 'response.failed', 'error']);
		if (event.eventName !== undefined && !knownEventNames.has(event.eventName)) return;
		const payload = parseJsonData(event);
		const type = typeof payload.type === 'string' ? payload.type : event.eventName;
		if (type === 'error' || event.eventName === 'error') throw fail('CODEX_RESPONSE_ERROR');
		if (type === 'response.failed' || event.eventName === 'response.failed') throw fail('CODEX_RESPONSE_FAILED');
		if (type === 'response.output_text.delta' || event.eventName === 'response.output_text.delta') {
			if (typeof payload.delta !== 'string') throw fail('CODEX_RESPONSE_INVALID');
			appendOutput(payload.delta);
			sawDelta = true;
			return;
		}
		if (type === 'response.completed' || event.eventName === 'response.completed') {
			if (!sawDelta) appendCompletedOutputText(payload, appendOutput);
			sawCompleted = true;
			state = 'completed';
		}
	};

	const processLine = (line: string): void => {
		if (line === '') {
			processEvent();
			return;
		}
		eventBlockNonEmpty = true;
		if (line.startsWith(':')) return;
		const separator = line.indexOf(':');
		const field = separator === -1 ? line : line.slice(0, separator);
		let value = separator === -1 ? '' : line.slice(separator + 1);
		if (value.startsWith(' ')) value = value.slice(1);
		if (field === 'event') eventName = value;
		if (field === 'data') {
			const separatorLength = dataLines.length === 0 ? 0 : 1;
			if (value.length + separatorLength > CODEX_MAX_SSE_EVENT_CHARS - eventDataLength) {
				throw fail('CODEX_SSE_EVENT_TOO_LARGE');
			}
			dataLines.push(value);
			eventDataLength += separatorLength + value.length;
		}
	};

	let lineStart = 0;
	while (lineStart < raw.length && !isDone()) {
		let lineEnd = lineStart;
		while (lineEnd < raw.length && raw[lineEnd] !== '\r' && raw[lineEnd] !== '\n') {
			lineEnd += 1;
		}
		processLine(raw.slice(lineStart, lineEnd));
		if (isDone() || lineEnd === raw.length) break;
		lineStart = lineEnd + 1;
		if (raw[lineEnd] === '\r' && raw[lineStart] === '\n') lineStart += 1;
	}
	if (!isDone() && eventBlockNonEmpty) processEvent();
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
		throwIfAborted(params.signal);
		const initialAuth = validateAuth(await this.readInitialAuth(params.signal));
		throwIfAborted(params.signal);
		const first = await this.request(params, initialAuth, params.signal);
		throwIfAborted(params.signal);
		if (first.status !== 401) return this.finish(first);

		throwIfAborted(params.signal);
		let reloadedAuth: CodexAuth;
		try {
			const auth = await this.authReader();
			throwIfAborted(params.signal);
			reloadedAuth = validateAuth(auth);
		} catch {
			throwIfAborted(params.signal);
			throw fail('CODEX_AUTH_RELOAD_INVALID');
		}
		if (reloadedAuth.accountId !== initialAuth.accountId) {
			throw fail('CODEX_AUTH_RELOAD_INVALID');
		}
		throwIfAborted(params.signal);
		const second = await this.request(params, reloadedAuth, params.signal);
		throwIfAborted(params.signal);
		if (second.status === 401) throw fail('CODEX_UNAUTHORIZED');
		return this.finish(second);
	}

	private async readInitialAuth(signal: AbortSignal | undefined): Promise<unknown> {
		throwIfAborted(signal);
		try {
			const auth = await this.authReader();
			throwIfAborted(signal);
			return auth;
		} catch (error) {
			throwIfAborted(signal);
			if (error instanceof CodexProviderError) throw error;
			throw fail('CODEX_AUTH_READ_FAILED');
		}
	}

	private async request(
		params: SummarizeParams,
		auth: CodexAuth,
		signal: AbortSignal | undefined
	): Promise<RequestResult> {
		throwIfAborted(signal);
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
			throwIfAborted(signal);
			throw fail('CODEX_REQUEST_FAILED');
		}
		throwIfAborted(signal);

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
