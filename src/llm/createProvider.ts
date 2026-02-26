import type {MyPluginSettings} from '../settings';
import {readEnvFileOrThrow} from './env';
import type {LlmProvider} from './types';
import {OpenAiChatProvider} from './providers/openai_chat_provider';
import {GeminiProvider} from './providers/gemini_provider';
import * as os from 'os';
import * as path from 'path';

export type ProviderCreateResult =
	| {status: 'disabled'; reason: string}
	| {status: 'enabled'; provider: LlmProvider; providerName: string; model: string};

function expandHomeDir(p: string): string {
	const v = p.trim();
	if (v === '~') {
		return os.homedir();
	}
	if (v.startsWith('~/') || v.startsWith('~\\')) {
		return path.join(os.homedir(), v.slice(2));
	}
	return v;
}

// Factory for LLM providers.
// - Reads `.env` from settings.envPath (Vault-external) and selects the provider implementation.
// - Returns {status:'disabled'} for non-fatal skip states (handled by caller with Notice/log reason).
// - Throws only for hard misconfiguration (e.g. missing required API key/model for the selected provider).
export async function createProvider(settings: MyPluginSettings): Promise<ProviderCreateResult> {
	const envPath = expandHomeDir(settings.envPath?.trim() ?? '');
	if (envPath.length === 0) {
		return {status: 'disabled', reason: 'ENV_PATH_MISSING'};
	}

	const env = await readEnvFileOrThrow(envPath);

	if (!env.LLM_PROVIDER) {
		return {status: 'disabled', reason: 'LLM_PROVIDER_MISSING'};
	}

	if (env.LLM_PROVIDER === 'openai') {
		const model = env.OPENAI_MODEL?.trim() ?? '';
		if (model.length === 0) {
			return {status: 'disabled', reason: 'OPENAI_MODEL_EMPTY_SKIP'};
		}
		const apiKey = env.OPENAI_API_KEY?.trim() ?? '';
		if (apiKey.length === 0) {
			throw new Error('OPENAI_API_KEY_MISSING');
		}
		return {
			status: 'enabled',
			provider: new OpenAiChatProvider(apiKey, model),
			providerName: 'openai',
			model,
		};
	}

	if (env.LLM_PROVIDER === 'gemini') {
		const apiKey = env.GEMINI_API_KEY?.trim() ?? '';
		if (apiKey.length === 0) {
			throw new Error('GEMINI_API_KEY_MISSING');
		}
		const model = env.GEMINI_MODEL?.trim() ?? '';
		if (model.length === 0) {
			throw new Error('GEMINI_MODEL_MISSING');
		}
		return {
			status: 'enabled',
			provider: new GeminiProvider(apiKey, model),
			providerName: 'gemini',
			model,
		};
	}

	return {status: 'disabled', reason: 'LLM_PROVIDER_INVALID'};
}
