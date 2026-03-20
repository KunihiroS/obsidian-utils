import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import jitiFactory from 'jiti';

const jiti = jitiFactory(import.meta.url);
const {extractCitationTitleFromAbsHtml, sanitizeTitleAsNoteBaseName} = jiti('../src/title_parser.ts');

const fixtureDir = path.resolve('test/fixtures');

async function readFixture(name) {
	return readFile(path.join(fixtureDir, name), 'utf8');
}

async function main() {
	const decodedQuotesHtml = await readFixture('arxiv_abs_2509_19783_decoded_quotes.html');
	assert.equal(
		extractCitationTitleFromAbsHtml(decodedQuotesHtml),
		'Agentic Metacognition: Designing a "Self-Aware" Low-Code Agent for Failure Prediction and Human Handoff'
	);
	assert.equal(
		sanitizeTitleAsNoteBaseName(
			'Agentic Metacognition: Designing a "Self-Aware" Low-Code Agent for Failure Prediction and Human Handoff'
		),
		'Agentic Metacognition_ Designing a _Self-Aware_ Low-Code Agent for Failure Prediction and Human Handoff'
	);

	const contentFirstHtml = await readFixture('arxiv_abs_content_first_quotes.html');
	assert.equal(
		extractCitationTitleFromAbsHtml(contentFirstHtml),
		'A "Quoted" Title With Content First'
	);

	assert.equal(
		sanitizeTitleAsNoteBaseName('  Title  with   spaces  #[]^  '),
		'Title with spaces ____'
	);

	const missingTitleHtml = await readFixture('arxiv_abs_missing_citation_title.html');
	assert.throws(() => extractCitationTitleFromAbsHtml(missingTitleHtml), /citation_title not found/);

	console.log('title_parser local tests passed');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
