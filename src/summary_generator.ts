import {App, Notice, TFile, normalizePath} from 'obsidian';
import {extractArxivIdFromUrl} from './arxiv';
import {endLogBlock, formatErrorForLog, startLogBlock} from './logger';
import type {MyPluginSettings} from './settings';
import {createProvider} from './llm/createProvider';

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	return Promise.race([
		promise,
		new Promise<T>((_, reject) =>
			setTimeout(() => reject(new Error(`${label}_TIMEOUT`)), ms)
		),
	]);
}

// Summary is written as a replaceable block.
// This keeps reruns idempotent (re-run replaces the previous summary instead of appending).
const SUMMARY_START_MARKER = '<!-- paper_extractor:summary:start -->';
const SUMMARY_END_MARKER = '<!-- paper_extractor:summary:end -->';

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
	inputUrl: string
): Promise<void> {
	const id = extractArxivIdFromUrl(inputUrl);

	const logDir = settings.logDir.trim();
	if (logDir.length === 0) {
		new Notice('logDir is required (Settings → Log directory)');
		return;
	}

	const logBlock = await startLogBlock(
		app,
		logDir,
		`component=summary_generator notePath=${noteFile.path} noteBaseName=${noteFile.basename} id=${id}`
	);

	let reason: string = '';
	let result: 'OK' | 'NG' = 'NG';
	let htmlPath: string = '';
	let promptPath: string = '';
	let model: string = '';
	let providerName: string = '';
	let summaryChars: number = 0;
	let errorName: string = '';
	let errorCode: string = '';
	let errorSummary: string = '';

	try {
		// Skip policy: user can disable summarization explicitly via settings.
		// In this case, it is treated as a successful run (result=OK) with a skip reason.
		if (settings.summaryEnabled === false) {
			reason = 'SUMMARY_DISABLED_SKIP';
			result = 'OK';
			new Notice('Summary is disabled (Settings).');
			return;
		}

		new Notice('(1/4) reading html');
		const parentPath = noteFile.parent?.path ?? '';
		const folderPath = normalizePath(parentPath ? `${parentPath}/${noteFile.basename}` : noteFile.basename);
		htmlPath = normalizePath(`${folderPath}/${id}.html`);

		const adapter = app.vault.adapter;
		const htmlExists = await adapter.exists(htmlPath);
		if (!htmlExists) {
			reason = 'HTML_MISSING';
			new Notice('HTML file not found. Cannot generate summary.', 10000);
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
			new Notice('Failed to read HTML.', 10000);
			return;
		}

		new Notice('(2/4) loading prompt');
		promptPath = settings.systemPromptPath?.trim() ?? '';
		if (promptPath.length === 0) {
			reason = 'PROMPT_READ_FAILED';
			new Notice('systemPromptPath is required (Settings).', 10000);
			return;
		}
		if (promptPath.startsWith('/') || promptPath.startsWith('~')) {
			reason = 'PROMPT_PATH_INVALID';
			new Notice('systemPromptPath must be a Vault-relative path (not absolute).', 10000);
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
			new Notice('Failed to read system prompt.', 10000);
			return;
		}

		let providerResult;
		try {
			providerResult = await createProvider(settings);
		} catch (e) {
			reason = e instanceof Error ? e.message : 'PROVIDER_CREATE_FAILED';
			const info = formatErrorForLog(e);
			errorName = info.errorName;
			errorCode = info.errorCode;
			errorSummary = info.errorSummary;
			new Notice('LLM provider configuration error.', 10000);
			return;
		}

		if (providerResult.status === 'disabled') {
			// `reason` is a short identifier intended for log searching/aggregation.
			// User-facing detail is communicated via Notice.
			reason = providerResult.reason;
			if (reason === 'OPENAI_MODEL_EMPTY_SKIP') {
				result = 'OK';
				new Notice('OPENAI_MODEL is empty in .env. Skipping AI request.');
				return;
			}
			if (reason === 'ENV_PATH_MISSING') {
				new Notice('envPath is required (Settings).', 10000);
				return;
			}
			if (reason === 'LLM_PROVIDER_MISSING') {
				new Notice('LLM_PROVIDER is required in .env.', 10000);
				return;
			}
			new Notice('LLM provider is disabled.');
			return;
		}

		providerName = providerResult.providerName;
		model = providerResult.model;

		new Notice('(3/4) requesting AI');
		new Notice('AI response waiting... (Do not delete/move the note until completion)');
		let summary: string;
		let waitNoticeInterval: number | null = null;
		try {
			waitNoticeInterval = window.setInterval(() => {
				new Notice('AI response waiting...');
			}, 3000);

			const userContent = `You will be given HTML extracted from an arXiv paper. Summarize it in Japanese as Markdown.\n\n[HTML]\n${htmlText}`;
			const timeoutMs = (settings.llmTimeoutSec ?? 180) * 1000;
			summary = await withTimeout(
				providerResult.provider.summarize({ systemPrompt, userContent }),
				timeoutMs,
				providerName.toUpperCase()
			);
		} catch (e) {
			reason = `${providerName.toUpperCase()}_REQUEST_FAILED`;
			const info = formatErrorForLog(e);
			errorName = info.errorName;
			errorCode = info.errorCode;
			errorSummary = info.errorSummary;
			new Notice('AI request failed.', 10000);
			return;
		} finally {
			if (waitNoticeInterval !== null) {
				window.clearInterval(waitNoticeInterval);
			}
		}
		summaryChars = summary.length;

		new Notice('(4/4) writing note');
		const latestFile = app.vault.getAbstractFileByPath(noteFile.path);
		if (!(latestFile instanceof TFile)) {
			reason = 'NOTE_MOVED_OR_DELETED';
			new Notice('Target note was moved or deleted.', 10000);
			return;
		}

		const currentNoteText = await app.vault.read(latestFile);
		const updated = upsertSummaryBlock(currentNoteText, summary);
		try {
			await app.vault.modify(latestFile, updated);
		} catch (e) {
			reason = 'NOTE_WRITE_FAILED';
			const info = formatErrorForLog(e);
			errorName = info.errorName;
			errorCode = info.errorCode;
			errorSummary = info.errorSummary;
			new Notice('Failed to write note.', 10000);
			return;
		}

		result = 'OK';
		new Notice('Summary generated.');
	} catch (e) {
		reason = reason || 'UNKNOWN';
		const info = formatErrorForLog(e);
		errorName = info.errorName;
		errorCode = info.errorCode;
		errorSummary = info.errorSummary;
		new Notice('Summary generation failed.', 10000);
	} finally {
		if (result === 'OK') {
			await endLogBlock(
				app,
				logBlock,
				`result=OK reason=${reason || 'OK'} htmlPath=${htmlPath} provider=${providerName} model=${model} summaryChars=${summaryChars}`
			);
		} else {
			const errorPart = errorName.length > 0 || errorCode.length > 0 || errorSummary.length > 0
				? ` errorName=${errorName} errorCode=${errorCode} errorSummary=${errorSummary}`
				: '';
			await endLogBlock(app, logBlock, `result=NG reason=${reason || 'UNKNOWN'} htmlPath=${htmlPath} promptPath=${promptPath} provider=${providerName} model=${model}${errorPart}`);
		}
	}
}
