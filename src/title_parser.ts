const NAMED_HTML_ENTITIES: Record<string, string> = {
	amp: '&',
	apos: "'",
	gt: '>',
	lt: '<',
	quot: '"',
};

function decodeHtmlEntities(input: string): string {
	return input.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
		const normalized = entity.toLowerCase();
		if (normalized.startsWith('#x')) {
			const codePoint = Number.parseInt(normalized.slice(2), 16);
			return Number.isNaN(codePoint) ? match : String.fromCodePoint(codePoint);
		}

		if (normalized.startsWith('#')) {
			const codePoint = Number.parseInt(normalized.slice(1), 10);
			return Number.isNaN(codePoint) ? match : String.fromCodePoint(codePoint);
		}

		return NAMED_HTML_ENTITIES[normalized] ?? match;
	});
}

function parseAttributes(tag: string): Record<string, string> {
	const attributes: Record<string, string> = {};
	const body = tag.replace(/^<meta\b/i, '').replace(/\/?\s*>$/, '');
	let index = 0;

	while (index < body.length) {
		while (index < body.length && /\s/.test(body[index] ?? '')) {
			index += 1;
		}

		if (index >= body.length) {
			break;
		}

		const nameStart = index;
		while (index < body.length && !/[\s=]/.test(body[index] ?? '')) {
			index += 1;
		}
		const rawName = body.slice(nameStart, index).trim();
		if (!rawName) {
			break;
		}

		while (index < body.length && /\s/.test(body[index] ?? '')) {
			index += 1;
		}

		let value = '';
		if (body[index] === '=') {
			index += 1;
			while (index < body.length && /\s/.test(body[index] ?? '')) {
				index += 1;
			}

			const quote = body[index];
			if (quote === '"' || quote === "'") {
				index += 1;
				const valueStart = index;
				while (index < body.length) {
					if (body[index] === quote) {
						const next = body[index + 1];
						if (next === undefined || /[\s/>]/.test(next)) {
							break;
						}
					}
					index += 1;
				}
				value = body.slice(valueStart, index);
				if (body[index] === quote) {
					index += 1;
				}
			} else {
				const valueStart = index;
				while (index < body.length && !/[\s>]/.test(body[index] ?? '')) {
					index += 1;
				}
				value = body.slice(valueStart, index);
			}
		}

		attributes[rawName.toLowerCase()] = decodeHtmlEntities(value);
	}

	return attributes;
}

export function extractCitationTitleFromAbsHtml(html: string): string {
	const metaTags = html.match(/<meta\b[^>]*>/gi) ?? [];
	for (const tag of metaTags) {
		const attributes = parseAttributes(tag);
		if (attributes.name?.toLowerCase() === 'citation_title' && attributes.content) {
			return attributes.content;
		}
	}

	throw new Error('citation_title not found');
}

export function sanitizeTitleAsNoteBaseName(input: string): string {
	const collapsed = input.replace(/\s+/g, ' ').trim();
	return collapsed.replace(/[\\/:*?"<>|#\[\]^]/g, '_').trim();
}
