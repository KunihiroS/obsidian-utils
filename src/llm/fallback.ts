import type {LlmProvider, SummarizeParams} from './types';

export type ProviderAttempt = {
	providerName: string;
	model: string;
	provider: LlmProvider;
};

export type AttemptFailureReason = 'PROVIDER_ERROR' | 'TIMEOUT';

export type AttemptEvent =
	| {type: 'start'; attempt: number; providerName: string; model: string}
	| {type: 'success'; attempt: number; providerName: string; model: string}
	| {type: 'failure'; attempt: number; providerName: string; model: string; reason: AttemptFailureReason};

export type AttemptResult =
	| {attempt: number; providerName: string; model: string; outcome: 'success'}
	| {attempt: number; providerName: string; model: string; outcome: 'failure'; reason: AttemptFailureReason};

export type FallbackResult = {
	summary: string;
	providerName: string;
	model: string;
	attempts: AttemptResult[];
};

export type FallbackOptions = {
	timeoutMs: number;
	onAttempt?: (event: AttemptEvent) => void;
};

class ProviderTimeoutError extends Error {}

export class FallbackAggregateError extends Error {
	readonly attempts: readonly AttemptResult[];

	constructor(attempts: readonly AttemptResult[]) {
		super('All LLM provider attempts failed');
		this.name = 'FallbackAggregateError';
		this.attempts = attempts;
	}
}

function runWithTimeout<T>(run: () => Promise<T>, timeoutMs: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const timeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			reject(new ProviderTimeoutError());
		}, timeoutMs);

		Promise.resolve()
			.then(run)
			.then(
				(value) => {
					if (settled) return;
					settled = true;
					clearTimeout(timeout);
					resolve(value);
				},
				(error: unknown) => {
					if (settled) return;
					settled = true;
					clearTimeout(timeout);
					reject(error instanceof Error ? error : new Error('Provider failed'));
				}
			);
	});
}

function eventBase(attempt: ProviderAttempt, attemptNumber: number) {
	return {
		attempt: attemptNumber,
		providerName: attempt.providerName,
		model: attempt.model,
	};
}

export async function summarizeWithFallback(
	attempts: readonly ProviderAttempt[],
	params: SummarizeParams,
	options: FallbackOptions
): Promise<FallbackResult> {
	const results: AttemptResult[] = [];

	for (let index = 0; index < attempts.length; index += 1) {
		const current = attempts[index];
		if (current === undefined) continue;
		const base = eventBase(current, index + 1);
		options.onAttempt?.({type: 'start', ...base});

		try {
			const summary = await runWithTimeout(
				() => current.provider.summarize(params),
				options.timeoutMs
			);
			const success: AttemptResult = {...base, outcome: 'success'};
			results.push(success);
			options.onAttempt?.({type: 'success', ...base});
			return {
				summary,
				providerName: current.providerName,
				model: current.model,
				attempts: results,
			};
		} catch (error) {
			const reason: AttemptFailureReason = error instanceof ProviderTimeoutError
				? 'TIMEOUT'
				: 'PROVIDER_ERROR';
			results.push({...base, outcome: 'failure', reason});
			options.onAttempt?.({type: 'failure', ...base, reason});
		}
	}

	throw new FallbackAggregateError(results);
}
