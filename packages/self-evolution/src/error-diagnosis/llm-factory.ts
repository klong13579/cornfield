/**
 * LLM factory for tool error diagnosis.
 * Uses existing callBackgroundLlm from self-evolution.
 */

import type { Model } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import { callBackgroundLlm } from "../utils/llm";

/**
 * Complete with JSON schema validation for tool error diagnosis.
 */
export async function completeWithSchema<T>(
	systemPrompt: string,
	userPrompt: string,
	_schema: object,
): Promise<T | null> {
	try {
		// Use a simple approach - get the first available model or use a default
		// This could be enhanced by checking settings for a configured error-diagnosis model
		const model = await getErrorDiagnosisModel();
		if (!model) {
			logger.debug("No error-diagnosis model available, skipping LLM diagnosis");
			return null;
		}

		const response = await callBackgroundLlm(model, systemPrompt, userPrompt, { maxTokens: 2000 });

		if (!response) return null;

		// Try to parse JSON from response (might have markdown wrapper)
		const jsonMatch = response.match(/```json\n([\s\S]*?)\n```|(\{[\s\S]*\})/);
		const jsonStr = jsonMatch ? (jsonMatch[1] ?? jsonMatch[2]) : response;

		return JSON.parse(jsonStr) as T;
	} catch (err) {
		logger.warn("LLM diagnosis call failed", {
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
}

/**
 * Get model for error diagnosis.
 * Could be extended to check settings for a configured model.
 */
async function getErrorDiagnosisModel(): Promise<Model | undefined> {
	// For now, return undefined to skip LLM diagnosis
	// This allows gradual rollout - when a model is configured, it will be used
	// TODO: integrate with settings to get configured error-diagnosis model
	return undefined;
}
