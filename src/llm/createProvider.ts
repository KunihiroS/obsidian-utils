import type {MyPluginSettings} from '../settings';
import {readEnvFileOrThrow, type EnvVars} from './env';
import type {ProviderAttempt} from './fallback';
import type {LlmProvider} from './types';
import {OpenAiChatProvider} from './providers/openai_chat_provider';
import {CodexOAuthProvider} from './providers/codex_oauth_provider';
import {GeminiProvider} from './providers/gemini_provider';
import * as os from 'os';
import * as path from 'path';

export type ProviderChainDependencies = {
	readEnv?: (envPath: string) => Promise<EnvVars>;
	createOpenAi?: (apiKey: string, model: string) => LlmProvider;
	createCodex?: (model: string) => LlmProvider;
	createGemini?: (apiKey: string, model: string) => LlmProvider;
};

function throwingProvider(code: string): LlmProvider {
	return {
		async summarize(): Promise<string> {
			throw new Error(code);
		},
	};
}

function isValidModel(model: string): boolean {
	return model.length <= 256 && /^[!-~]+$/.test(model);
}

function createProviderOrFailure(factory: () => LlmProvider, failureCode: string): LlmProvider {
	try {
		return factory();
	} catch {
		return throwingProvider(failureCode);
	}
}

export async function createProviderChain(
	settings: MyPluginSettings,
	dependencies: ProviderChainDependencies = {}
): Promise<ProviderAttempt[]> {
	const envPath = expandHomeDir(settings.envPath?.trim() ?? '');
	if (envPath.length === 0) throw new Error('ENV_PATH_MISSING');

	const env = await (dependencies.readEnv ?? readEnvFileOrThrow)(envPath);
	const openAiModel = env.OPENAI_MODEL?.trim() ?? '';
	const openAiApiKey = env.OPENAI_API_KEY?.trim() ?? '';
	const codexModel = env.CODEX_MODEL?.trim() || 'gpt-5.4-mini';
	const geminiApiKey = env.GEMINI_API_KEY?.trim() ?? '';
	const geminiModel = env.GEMINI_MODEL?.trim() ?? '';
	const createOpenAi = dependencies.createOpenAi ?? ((apiKey, model) => new OpenAiChatProvider(apiKey, model));
	const createCodex = dependencies.createCodex ?? ((model) => new CodexOAuthProvider(model));
	const createGemini = dependencies.createGemini ?? ((apiKey, model) => new GeminiProvider(apiKey, model));
	const openAiModelIsInvalid = openAiModel.length > 0 && !isValidModel(openAiModel);
	const codexModelIsInvalid = !isValidModel(codexModel);
	const geminiModelIsInvalid = geminiModel.length > 0 && !isValidModel(geminiModel);

	return [
		{
			providerName: 'openai',
			model: openAiModelIsInvalid ? '<invalid>' : openAiModel,
			provider: openAiModel.length === 0
				? throwingProvider('OPENAI_MODEL_MISSING')
				: openAiModelIsInvalid
					? throwingProvider('OPENAI_MODEL_INVALID')
					: openAiApiKey.length === 0
						? throwingProvider('OPENAI_API_KEY_MISSING')
						: createProviderOrFailure(
							() => createOpenAi(openAiApiKey, openAiModel),
							'OPENAI_PROVIDER_CREATE_FAILED'
						),
		},
		{
			providerName: 'codex',
			model: codexModelIsInvalid ? '<invalid>' : codexModel,
			provider: codexModelIsInvalid
				? throwingProvider('CODEX_MODEL_INVALID')
				: createProviderOrFailure(() => createCodex(codexModel), 'CODEX_PROVIDER_CREATE_FAILED'),
		},
		{
			providerName: 'gemini',
			model: geminiModelIsInvalid ? '<invalid>' : geminiModel,
			provider: geminiApiKey.length === 0
				? throwingProvider('GEMINI_API_KEY_MISSING')
				: geminiModel.length === 0
					? throwingProvider('GEMINI_MODEL_MISSING')
					: geminiModelIsInvalid
						? throwingProvider('GEMINI_MODEL_INVALID')
						: createProviderOrFailure(
							() => createGemini(geminiApiKey, geminiModel),
							'GEMINI_PROVIDER_CREATE_FAILED'
						),
		},
	];
}

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
