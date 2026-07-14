import {App, normalizePath} from 'obsidian';

const logWriteQueues = new WeakMap<App, Map<string, Promise<void>>>();

function pad2(n: number): string {
	return String(n).padStart(2, '0');
}

// Security invariant:
// - Never write secrets (API keys, tokens, Authorization headers, etc.) to log files.
// - All log output must pass through redaction. If redaction fails, suppress the original content.
function redact(text: string): string {
	let out = text;

	out = out.replace(/(Authorization\s*:\s*Bearer\s+)([^\s]+)/gi, '$1***REDACTED***');
	out = out.replace(/\bBearer\s+([A-Za-z0-9._~+/-]+=*)\b/g, 'Bearer ***REDACTED***');

	out = out.replace(/\bsk-[A-Za-z0-9]{10,}\b/g, '***REDACTED***');
	out = out.replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, '***REDACTED***');
	out = out.replace(/\b(?:xoxb|xoxp|xoxa|xoxr)-[0-9A-Za-z-]{10,}\b/g, '***REDACTED***');
	out = out.replace(/\bghp_[0-9A-Za-z]{20,}\b/g, '***REDACTED***');
	out = out.replace(/\bgithub_pat_[0-9A-Za-z_]{20,}\b/g, '***REDACTED***');

	out = out.replace(/\b([A-Z0-9_]{2,})(?:API)?_?KEY\s*=\s*([^\s"']+)/g, '$1KEY=***REDACTED***');
	out = out.replace(/([?&](?:api_key|apikey|access_token|token|key)=)([^&#\s]+)/gi, '$1***REDACTED***');

	return out;
}

function safeRedact(message: string, fallback: string): string {
	try {
		return redact(message);
	} catch {
		return fallback;
	}
}

function oneLineAndTruncate(text: string, maxLen: number): string {
	const oneLine = text.split('	').join(' ').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
	if (oneLine.length <= maxLen) return oneLine;
	return oneLine.slice(0, maxLen);
}

export function safeLogMetadataValue(
	value: unknown,
	maxLen: number = 128,
	fallback: string = 'unknown'
): string {
	const text = typeof value === 'string'
		|| typeof value === 'number'
		|| typeof value === 'boolean'
		|| typeof value === 'bigint'
		? String(value)
		: '';
	const redacted = safeRedact(text, fallback);
	const safe = oneLineAndTruncate(redacted, maxLen)
		.replace(/[^A-Za-z0-9._~+/:<>-]/g, '_')
		.replace(/_+/g, '_')
		.replace(/^_+|_+$/g, '');
	return safe.length > 0 ? safe : fallback;
}

export type ErrorLogInfo = {
	errorName: string;
	errorCode: string;
	errorSummary: string;
};

export function formatErrorForLog(e: unknown, maxLen: number = 200): ErrorLogInfo {
	const errorName = e instanceof Error ? e.name : 'UNKNOWN';
	const codeMaybe = (e as {code?: unknown} | null)?.code;
	const errorCode = typeof codeMaybe === 'string' ? codeMaybe : '';
	const message = e instanceof Error ? e.message : '';
	const redacted = safeRedact(message, '');
	const errorSummary = oneLineAndTruncate(redacted, maxLen);
	return {errorName, errorCode, errorSummary};
}

function formatYYYYMMDD(d: Date): string {
	return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
}

export function getDailyLogFilePath(logDir: string, now: Date = new Date()): string {
	const yyyymmdd = formatYYYYMMDD(now);
	return normalizePath(`${logDir}/paper_extractor_${yyyymmdd}.log`);
}

export function formatLogLine(message: string, now: Date = new Date()): string {
	return `${now.toISOString()} ${message}`;
}

async function ensureFolderExists(app: App, folderPath: string): Promise<void> {
	const adapter = app.vault.adapter;
	const exists = await adapter.exists(folderPath);
	if (exists) return;
	await app.vault.createFolder(folderPath);
}

async function appendTextFile(app: App, filePath: string, contentToAppend: string): Promise<void> {
	const adapter = app.vault.adapter;
	let current = '';
	try {
		current = await adapter.read(filePath);
	} catch {
		current = '';
	}
	await adapter.write(filePath, `${current}${contentToAppend}`);
}

function queueLogAppend(
	app: App,
	logDir: string,
	logPath: string,
	contentToAppend: string
): Promise<void> {
	let queuesByPath = logWriteQueues.get(app);
	if (queuesByPath === undefined) {
		queuesByPath = new Map<string, Promise<void>>();
		logWriteQueues.set(app, queuesByPath);
	}

	const previous = queuesByPath.get(logPath) ?? Promise.resolve();
	const current = previous
		.catch(() => undefined)
		.then(async () => {
			await ensureFolderExists(app, logDir);
			await appendTextFile(app, logPath, contentToAppend);
		});
	queuesByPath.set(logPath, current);

	const cleanup = (): void => {
		if (queuesByPath.get(logPath) !== current) return;
		queuesByPath.delete(logPath);
		if (queuesByPath.size === 0 && logWriteQueues.get(app) === queuesByPath) {
			logWriteQueues.delete(app);
		}
	};
	void current.then(cleanup, cleanup);
	return current;
}

export async function appendLogLine(app: App, logDir: string, message: string): Promise<void> {
	const logPath = getDailyLogFilePath(logDir);
	const redactedMessage = safeRedact(message, 'redact=FAILED message="Log redaction failed; original content suppressed."');
	await queueLogAppend(app, logDir, logPath, `${formatLogLine(redactedMessage)}\n`);
}

export type LogBlock = {
	logDir: string;
	logPath: string;
	runId: string;
};

export async function startLogBlock(app: App, logDir: string, startMessage: string): Promise<LogBlock> {
	const now = new Date();
	const logPath = getDailyLogFilePath(logDir, now);
	const runId = `${now.toISOString()}_${Math.random().toString(16).slice(2)}`;
	const fallback = `block=START runId=${runId} redact=FAILED message="Log redaction failed; original content suppressed."`;
	const redactedMessage = safeRedact(`block=START runId=${runId} ${startMessage}`, fallback);
	await queueLogAppend(app, logDir, logPath, `${formatLogLine(redactedMessage, now)}\n`);
	return {logDir, logPath, runId};
}

export async function endLogBlock(app: App, block: LogBlock, endMessage: string): Promise<void> {
	const fallback = `block=END runId=${block.runId} redact=FAILED message="Log redaction failed; original content suppressed."`;
	const redactedMessage = safeRedact(`block=END runId=${block.runId} ${endMessage}`, fallback);
	await queueLogAppend(app, block.logDir, block.logPath, `${formatLogLine(redactedMessage)}\n`);
}
