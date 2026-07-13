import {App, Notice, TFile, normalizePath} from 'obsidian';
import {extractArxivIdFromUrl} from './arxiv';
import {
	appendLogLine,
	endLogBlock,
	formatErrorForLog,
	safeLogMetadataValue,
	startLogBlock,
} from './logger';
import type {LogBlock} from './logger';
import type {MyPluginSettings} from './settings';
import {createProviderChain} from './llm/createProvider';
import {summarizeWithFallback} from './llm/fallback';

export type SummaryGeneratorDependencies = {
	notice?: (message: string, duration?: number) => void;
	createProviderChain?: typeof createProviderChain;
	startLogBlock?: typeof startLogBlock;
	appendLogLine?: typeof appendLogLine;
	endLogBlock?: typeof endLogBlock;
	setInterval?: (callback: () => void, ms: number) => number;
	clearInterval?: (id: number) => void;
	isTFile?: (file: unknown) => file is TFile;
};

const defaultDependencies = {
	notice: (message: string, duration?: number): void => {
		new Notice(message, duration);
	},
	createProviderChain,
	startLogBlock,
	appendLogLine,
	endLogBlock,
	setInterval: (callback: () => void, ms: number): number => window.setInterval(callback, ms),
	clearInterval: (id: number): void => window.clearInterval(id),
	isTFile: (file: unknown): file is TFile => file instanceof TFile,
};

// Summary is written as a replaceable block.
// This keeps reruns idempotent (re-run replaces the previous summary instead of appending).
const SUMMARY_START_MARKER = '<!-- paper_extractor:summary:start -->';
const SUMMARY_END_MARKER = '<!-- paper_extractor:summary:end -->';
const MAX_TIMEOUT_MS = 2_147_483_647;

function buildSummaryBlock(summaryMarkdown: string): string {
	return `${SUMMARY_START_MARKER}\n\n${summaryMarkdown}\n\n${SUMMARY_END_MARKER}`;
}

function upsertSummaryBlock(noteText: string, summaryMarkdown: string): string {
	const block = buildSummaryBlock(summaryMarkdown);
	const startIdx = noteText.indexOf(SUMMARY_START_MARKER);
	const endIdx = noteText.indexOf(SUMMARY_END_MARKER);
	if (startIdx !== -1 && endIdx !== -1 && startIdx < endIdx) {
		const endAfter = endIdx + SUMMARY_END_MARKER.length;
		return `${noteText.slice(0, startIdx)}${block}${noteText.slice(endAfter)}`;
	}

	const suffix = noteText.endsWith('\n') ? '\n' : '\n\n';
	return `${noteText}${suffix}${block}`;
}

export async function generateSummary(
	app: App,
	settings: MyPluginSettings,
	noteFile: TFile,
	inputUrl: string,
	injectedDependencies: SummaryGeneratorDependencies = {}
): Promise<void> {
	const originalNotePath = noteFile.path;
	const originalNoteBaseName = noteFile.basename;
	const originalParentPath = noteFile.parent?.path ?? '';
	const dependencies = {...defaultDependencies, ...injectedDependencies};
	const id = extractArxivIdFromUrl(inputUrl);

	const logDir = settings.logDir.trim();
	if (logDir.length === 0) {
		dependencies.notice('Log directory is required (Settings → Log directory).');
		return;
	}

	const logBlock: LogBlock = await dependencies.startLogBlock(
		app,
		logDir,
		`component=summary_generator notePath=${safeLogMetadataValue(originalNotePath)} noteBaseName=${safeLogMetadataValue(originalNoteBaseName)} id=${id}`
	);

	let reason = '';
	let result: 'OK' | 'NG' = 'NG';
	let htmlPath = '';
	let promptPath = '';
	let model = '';
	let providerName = '';
	let summaryChars = 0;
	let errorName = '';
	let errorCode = '';
	let errorSummary = '';

	try {
		if (settings.summaryEnabled === false) {
			reason = 'SUMMARY_DISABLED_SKIP';
			result = 'OK';
			dependencies.notice('Summary is disabled (Settings).');
			return;
		}

		dependencies.notice('(1/4) Reading HTML.');
		const folderPath = normalizePath(originalParentPath
			? `${originalParentPath}/${originalNoteBaseName}`
			: originalNoteBaseName);
		htmlPath = normalizePath(`${folderPath}/${id}.html`);

		const adapter = app.vault.adapter;
		const htmlExists = await adapter.exists(htmlPath);
		if (!htmlExists) {
			reason = 'HTML_MISSING';
			dependencies.notice('HTML file not found. Cannot generate summary.', 10000);
			return;
		}

		let htmlText: string;
		try {
			htmlText = await adapter.read(htmlPath);
		} catch (e) {
			reason = 'HTML_READ_FAILED';
			const info = formatErrorForLog(e);
			errorName = info.errorName;
			errorCode = info.errorCode;
			errorSummary = info.errorSummary;
			dependencies.notice('Failed to read HTML.', 10000);
			return;
		}

		dependencies.notice('(2/4) Loading prompt.');
		promptPath = settings.systemPromptPath?.trim() ?? '';
		if (promptPath.length === 0) {
			reason = 'PROMPT_READ_FAILED';
			dependencies.notice('System prompt path is required (Settings).', 10000);
			return;
		}
		if (promptPath.startsWith('/') || promptPath.startsWith('~')) {
			reason = 'PROMPT_PATH_INVALID';
			dependencies.notice('System prompt path must be a Vault-relative path (not absolute).', 10000);
			return;
		}

		let systemPrompt: string;
		try {
			systemPrompt = await adapter.read(promptPath);
		} catch (e) {
			reason = 'PROMPT_READ_FAILED';
			const info = formatErrorForLog(e);
			errorName = info.errorName;
			errorCode = info.errorCode;
			errorSummary = info.errorSummary;
			dependencies.notice('Failed to read system prompt.', 10000);
			return;
		}

		const timeoutSec = settings.llmTimeoutSec ?? 180;
		const timeoutMs = timeoutSec * 1000;
		if (!Number.isFinite(timeoutSec) || timeoutSec <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
			reason = 'LLM_TIMEOUT_INVALID';
			dependencies.notice('LLM timeout must be a positive, supported value.', 10000);
			return;
		}

		let providerChain;
		try {
			providerChain = await dependencies.createProviderChain(settings);
		} catch (e) {
			const info = formatErrorForLog(e);
			errorName = info.errorName;
			errorCode = info.errorCode;
			errorSummary = info.errorSummary;
			const errorToken = e instanceof Error ? e.message.trim().split(/\s+/, 1)[0] : '';
			if (errorToken === 'ENV_PATH_MISSING') {
				reason = 'ENV_PATH_MISSING';
				dependencies.notice('envPath is required (Settings).', 10000);
			} else if (errorToken === 'ENV_READ_FAILED') {
				reason = 'ENV_READ_FAILED';
				dependencies.notice('Failed to read env file.', 10000);
			} else {
				reason = 'PROVIDER_CHAIN_CREATE_FAILED';
				dependencies.notice('LLM provider chain could not be created.', 10000);
			}
			return;
		}

		dependencies.notice('(3/4) Requesting AI.');
		dependencies.notice('Waiting for AI response. Do not delete or move the note until completion.');
		const waitNoticeInterval = dependencies.setInterval(() => {
			dependencies.notice('Waiting for AI response.');
		}, 3000);

		let fallbackResult;
		try {
			const userContent = `You will be given HTML extracted from an arXiv paper. Summarize it in Japanese as Markdown.\n\n[HTML]\n${htmlText}`;
			fallbackResult = await summarizeWithFallback(
				providerChain,
				{systemPrompt, userContent},
				{
					timeoutMs,
					onAttempt: async (event) => {
						const eventReason = event.type === 'failure'
							? ` reason=${safeLogMetadataValue(event.reason)}`
							: '';
						await dependencies.appendLogLine(
							app,
							logDir,
							`component=summary_generator event=${event.type} attempt=${event.attempt} provider=${safeLogMetadataValue(event.providerName)} model=${safeLogMetadataValue(event.model)}${eventReason}`
						);
					},
				}
			);
		} catch {
			reason = 'ALL_LLM_ATTEMPTS_FAILED';
			dependencies.notice('All AI requests failed.', 10000);
			return;
		} finally {
			dependencies.clearInterval(waitNoticeInterval);
		}

		providerName = fallbackResult.providerName;
		model = fallbackResult.model;
		summaryChars = fallbackResult.summary.length;

		dependencies.notice('(4/4) Writing note.');
		const latestFile = app.vault.getAbstractFileByPath(originalNotePath);
		if (noteFile.path !== originalNotePath || latestFile !== noteFile || !dependencies.isTFile(latestFile)) {
			reason = 'NOTE_MOVED_OR_DELETED';
			dependencies.notice('Target note was moved or deleted.', 10000);
			return;
		}

		let currentNoteText: string;
		try {
			currentNoteText = await app.vault.read(latestFile);
		} catch (e) {
			reason = 'NOTE_READ_FAILED';
			const info = formatErrorForLog(e);
			errorName = info.errorName;
			errorCode = info.errorCode;
			errorSummary = info.errorSummary;
			dependencies.notice('Failed to read note.', 10000);
			return;
		}

		const updated = upsertSummaryBlock(currentNoteText, fallbackResult.summary);
		try {
			await app.vault.modify(latestFile, updated);
		} catch (e) {
			reason = 'NOTE_WRITE_FAILED';
			const info = formatErrorForLog(e);
			errorName = info.errorName;
			errorCode = info.errorCode;
			errorSummary = info.errorSummary;
			dependencies.notice('Failed to write note.', 10000);
			return;
		}

		result = 'OK';
		dependencies.notice('Summary generated.');
	} catch (e) {
		reason = reason || 'UNKNOWN';
		const info = formatErrorForLog(e);
		errorName = info.errorName;
		errorCode = info.errorCode;
		errorSummary = info.errorSummary;
		dependencies.notice('Summary generation failed.', 10000);
	} finally {
		const safeReason = safeLogMetadataValue(reason || (result === 'OK' ? 'OK' : 'UNKNOWN'));
		const safeProvider = safeLogMetadataValue(providerName);
		const safeModel = safeLogMetadataValue(model);
		const safeHtmlPath = safeLogMetadataValue(htmlPath);
		const safePromptPath = safeLogMetadataValue(promptPath);
		if (result === 'OK') {
			await dependencies.endLogBlock(
				app,
				logBlock,
				`result=OK reason=${safeReason} htmlPath=${safeHtmlPath} provider=${safeProvider} model=${safeModel} summaryChars=${summaryChars}`
			);
		} else {
			const errorPart = errorName.length > 0 || errorCode.length > 0 || errorSummary.length > 0
				? ` errorName=${safeLogMetadataValue(errorName)} errorCode=${safeLogMetadataValue(errorCode)} errorSummary=${safeLogMetadataValue(errorSummary)}`
				: '';
			await dependencies.endLogBlock(
				app,
				logBlock,
				`result=NG reason=${safeReason} htmlPath=${safeHtmlPath} promptPath=${safePromptPath} provider=${safeProvider} model=${safeModel}${errorPart}`
			);
		}
	}
}
