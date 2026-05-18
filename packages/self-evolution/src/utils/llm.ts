/**
 * LLM wrapper for background calls (skill refinement, reranking, prompt optimization).
 */

import type { Context, Model } from "@oh-my-pi/pi-ai";
import { completeSimple } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";

export interface BackgroundLlmAuth {
	getApiKey(model: Model): Promise<string | undefined>;
}

export interface CallBackgroundLlmOptions {
	signal?: AbortSignal;
	auth?: BackgroundLlmAuth;
	maxTokens?: number;
}

/**
 * Send a simple text-completion request to the given model.
 * When `auth` is provided, uses OMP model registry credentials (same as main agent).
 * Returns empty string on failure so callers can fall back to rule-based behavior.
 */
export async function callBackgroundLlm(
	model: Model | undefined,
	systemPrompt: string,
	userPrompt: string,
	options?: CallBackgroundLlmOptions,
): Promise<string> {
	if (!model) {
		logger.debug("Background LLM skipped: no model available");
		return "";
	}

	let apiKey: string | undefined;
	if (options?.auth) {
		apiKey = await options.auth.getApiKey(model);
		if (!apiKey) {
			logger.debug("Background LLM skipped: no API key from model registry", {
				provider: model.provider,
				id: model.id,
			});
			return "";
		}
	}

	const context: Context = {
		systemPrompt,
		messages: [{ role: "user", content: userPrompt, timestamp: Date.now() }],
	};

	try {
		const result = await completeSimple(model, context, {
			signal: options?.signal,
			maxTokens: options?.maxTokens ?? 2000,
			...(apiKey ? { apiKey } : {}),
		});
		if (result.stopReason === "error") {
			logger.warn("Background LLM returned error", {
				provider: model.provider,
				id: model.id,
				errorMessage: result.errorMessage,
			});
			return "";
		}
		const text = result.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map(c => c.text)
			.join("");
		return text.trim();
	} catch (err) {
		logger.warn("Background LLM call failed", {
			error: err instanceof Error ? err.message : String(err),
			provider: model.provider,
			id: model.id,
		});
		return "";
	}
}
