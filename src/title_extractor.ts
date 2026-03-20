import {App, TFile, normalizePath, requestUrl} from 'obsidian';
import {extractArxivIdFromUrl, getArxivAbsUrl} from './arxiv';
import {endLogBlock, formatErrorForLog, startLogBlock} from './logger';
import {extractCitationTitleFromAbsHtml, sanitizeTitleAsNoteBaseName} from './title_parser';

export type TitleExtractResult = {
	id: string;
	oldNotePath: string;
	newNotePath: string;
	newTitle: string;
};

export async function extractAndRenameNoteTitle(
	app: App,
	logDir: string,
	noteFile: TFile,
	inputUrl: string
): Promise<TitleExtractResult> {
	const id = extractArxivIdFromUrl(inputUrl);
	const logBlock = await startLogBlock(
		app,
		logDir,
		`component=title_extractor notePath=${noteFile.path} noteBaseName=${noteFile.basename} id=${id}`
	);

	const absUrl = getArxivAbsUrl(id);
	let absStatus: number | 'EXCEPTION' = 'EXCEPTION';
	let newTitle = '';
	let newNotePath = '';
	let oldNotePath = '';
	try {
		const absResp = await requestUrl({url: absUrl, method: 'GET'});
		absStatus = absResp.status;
		if (absResp.status < 200 || absResp.status >= 300) {
			throw new Error(`Failed to fetch arXiv abs (status:${absResp.status})`);
		}

		const rawTitle = extractCitationTitleFromAbsHtml(absResp.text);
		newTitle = sanitizeTitleAsNoteBaseName(rawTitle);
		if (newTitle.length === 0) {
			throw new Error('Invalid title after sanitization');
		}

		const parentPath = noteFile.parent?.path ?? '';
		newNotePath = normalizePath(parentPath ? `${parentPath}/${newTitle}.md` : `${newTitle}.md`);
		const newFolderPath = normalizePath(parentPath ? `${parentPath}/${newTitle}` : newTitle);

		// Safety invariant:
		// - Abort if the target note path already exists (avoid overwriting user content).
		// - Do NOT abort if the attachment folder already exists; paper_fetcher will only overwrite fetched files.

		const noteConflict = app.vault.getAbstractFileByPath(newNotePath);
		if (noteConflict) {
			throw new Error(`Target note already exists: ${newNotePath}`);
		}

		oldNotePath = noteFile.path;
		await app.fileManager.renameFile(noteFile, newNotePath);

		await endLogBlock(
			app,
			logBlock,
			`result=OK absUrl=${absUrl} absStatus=${absStatus} newTitle=${newTitle} newNotePath=${newNotePath}`
		);

		return {
			id,
			oldNotePath,
			newNotePath,
			newTitle,
		};
	} catch (e) {
		const info = formatErrorForLog(e);
		await endLogBlock(
			app,
			logBlock,
			`result=NG absUrl=${absUrl} absStatus=${absStatus} errorName=${info.errorName} errorCode=${info.errorCode} errorSummary=${info.errorSummary}`
		);
		throw e;
	}
}
