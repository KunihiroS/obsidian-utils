import * as fs from 'fs/promises';
import {formatErrorForLog} from '../logger';

export type EnvVars = {
	OPENAI_API_KEY?: string;
	OPENAI_MODEL?: string;
	CODEX_MODEL?: string;
	GEMINI_API_KEY?: string;
	GEMINI_MODEL?: string;
};

// Minimal .env parser.
// - Supports KEY=VALUE lines (optional single/double quotes).
// - Intentionally ignores advanced dotenv features to keep runtime small.
// - The env file is expected to live outside the Vault (to avoid committing secrets).
function parseDotEnv(content: string): Record<string, string> {
	const vars: Record<string, string> = {};
	const lines = content.split(/\r?\n/);
	for (const raw of lines) {
		const line = raw.trim();
		if (line.length === 0) continue;
		if (line.startsWith('#')) continue;
		const idx = line.indexOf('=');
		if (idx <= 0) continue;
		const key = line.slice(0, idx).trim();
		let value = line.slice(idx + 1).trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		if (key.length === 0) continue;
		vars[key] = value;
	}
	return vars;
}

export async function readEnvFileOrThrow(envPath: string): Promise<EnvVars> {
	let content: string;
	try {
		content = await fs.readFile(envPath, 'utf-8');
	} catch (e) {
		const info = formatErrorForLog(e);
		throw new Error(`ENV_READ_FAILED ${info.errorName} ${info.errorSummary}`);
	}

	const vars = parseDotEnv(content);
	return {
		OPENAI_API_KEY: vars.OPENAI_API_KEY,
		OPENAI_MODEL: vars.OPENAI_MODEL,
		CODEX_MODEL: vars.CODEX_MODEL,
		GEMINI_API_KEY: vars.GEMINI_API_KEY,
		GEMINI_MODEL: vars.GEMINI_MODEL,
	};
}
