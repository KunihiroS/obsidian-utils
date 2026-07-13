export type SummarizeParams = {
	systemPrompt: string;
	userContent: string;
	readonly signal?: AbortSignal;
};

export interface LlmProvider {
	summarize(params: SummarizeParams): Promise<string>;
}
