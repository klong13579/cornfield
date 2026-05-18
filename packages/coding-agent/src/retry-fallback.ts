import { logger } from "@oh-my-pi/pi-utils";

export interface FallbackConfig {
	maxConsecutiveFailures: number; // Default: 3
	maxTokenOverspendRatio: number; // Default: 2.0 (200% of expected)
	fallbackModels: string[]; // Ordered list of fallback models
	retryDelayMs: number; // Default: 1000
}

export interface TokenBudget {
	expectedPromptTokens: number;
	expectedCompletionTokens: number;
	maxTotalTokens: number;
}

export class PerformanceFallback {
	#config: FallbackConfig;
	#consecutiveFailures: Map<string, number> = new Map();
	#modelTokenUsage: Map<string, { totalTokens: number; expectedTotal: number; count: number }> = new Map();

	constructor(config: Partial<FallbackConfig> = {}) {
		this.#config = {
			maxConsecutiveFailures: 3,
			maxTokenOverspendRatio: 2.0,
			fallbackModels: ["gpt-4o", "claude-sonnet-4", "claude-haiku-4"],
			retryDelayMs: 1000,
			...config,
		};
	}

	shouldFallback(model: string, wasError: boolean): { fallback: boolean; nextModel?: string; reason?: string } {
		if (wasError) {
			const failures = (this.#consecutiveFailures.get(model) ?? 0) + 1;
			this.#consecutiveFailures.set(model, failures);

			if (failures >= this.#config.maxConsecutiveFailures) {
				const nextModel = this.#getNextFallback(model);
				logger.debug(
					`PerformanceFallback: model ${model} triggered fallback after ${failures} consecutive failures`,
					{ nextModel },
				);
				return { fallback: true, nextModel, reason: `${failures} consecutive failures` };
			}
		} else {
			this.#consecutiveFailures.set(model, 0);
		}

		return { fallback: false };
	}

	recordTokenUsage(model: string, actualTokens: number, expectedTokens: number): void {
		const entry = this.#modelTokenUsage.get(model) ?? { totalTokens: 0, expectedTotal: 0, count: 0 };
		entry.totalTokens += actualTokens;
		entry.expectedTotal += expectedTokens;
		entry.count++;
		this.#modelTokenUsage.set(model, entry);
	}

	isTokenOverspending(model: string): boolean {
		const stats = this.#modelTokenUsage.get(model);
		if (!stats || stats.count < 3) return false; // Need minimum samples
		const actualAvg = stats.totalTokens / stats.count;
		const expectedAvg = stats.expectedTotal / stats.count;
		return actualAvg / expectedAvg > this.#config.maxTokenOverspendRatio;
	}

	getFailureCount(model: string): number {
		return this.#consecutiveFailures.get(model) ?? 0;
	}

	resetFailures(model: string): void {
		this.#consecutiveFailures.set(model, 0);
	}

	#getNextFallback(currentModel: string): string | undefined {
		const idx = this.#config.fallbackModels.indexOf(currentModel);
		if (idx >= 0 && idx < this.#config.fallbackModels.length - 1) {
			return this.#config.fallbackModels[idx + 1];
		}
		return undefined; // No more fallbacks
	}
}
