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
	| Readonly<{attempt: number; providerName: string; model: string; outcome: 'success'}>
	| Readonly<{attempt: number; providerName: string; model: string; outcome: 'failure'; reason: AttemptFailureReason}>;

export type FallbackResult = Readonly<{
	summary: string;
	providerName: string;
	model: string;
	attempts: readonly AttemptResult[];
}>;

export type FallbackOptions = {
	timeoutMs: number;
	onAttempt?: (event: AttemptEvent) => void | Promise<void>;
};

class ProviderTimeoutError extends Error {}

const MAX_TIMEOUT_MS = 2_147_483_647;

export class FallbackAggregateError extends Error {
	readonly attempts: readonly AttemptResult[];

	constructor(attempts: readonly AttemptResult[]) {
		super('All LLM provider attempts failed');
		this.name = 'FallbackAggregateError';
		this.attempts = immutableAttempts(attempts);
	}
}

function immutableAttempts(attempts: readonly AttemptResult[]): readonly AttemptResult[] {
	return Object.freeze(attempts.map((attempt) => Object.freeze({...attempt})));
}

function emitAttempt(
	onAttempt: FallbackOptions['onAttempt'],
	event: AttemptEvent
): void {
	try {
		Promise.resolve(onAttempt?.(event)).catch(() => {});
	} catch {
		// Observability failures must not alter provider-chain behavior.
	}
}

function runWithTimeout<T>(
	run: () => Promise<T>,
	timeoutMs: number,
	controller: AbortController
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const timeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			controller.abort();
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
	if (
		!Number.isFinite(options.timeoutMs)
		|| options.timeoutMs <= 0
		|| options.timeoutMs > MAX_TIMEOUT_MS
	) {
		throw new RangeError(`timeoutMs must be between 1 and ${MAX_TIMEOUT_MS}`);
	}

	const results: AttemptResult[] = [];

	for (let index = 0; index < attempts.length; index += 1) {
		const current = attempts[index];
		if (current === undefined) continue;
		const base = eventBase(current, index + 1);
		emitAttempt(options.onAttempt, {type: 'start', ...base});

		try {
			const controller = new AbortController();
			const summary = await runWithTimeout(
				() => current.provider.summarize({...params, signal: controller.signal}),
				options.timeoutMs,
				controller
			);
			const success: AttemptResult = {...base, outcome: 'success'};
			results.push(success);
			emitAttempt(options.onAttempt, {type: 'success', ...base});
			return {
				summary,
				providerName: current.providerName,
				model: current.model,
				attempts: immutableAttempts(results),
			};
		} catch (error) {
			const reason: AttemptFailureReason = error instanceof ProviderTimeoutError
				? 'TIMEOUT'
				: 'PROVIDER_ERROR';
			results.push({...base, outcome: 'failure', reason});
			emitAttempt(options.onAttempt, {type: 'failure', ...base, reason});
		}
	}

	throw new FallbackAggregateError(results);
}
