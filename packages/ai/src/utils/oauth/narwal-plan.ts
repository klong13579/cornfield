/**
 * Narwal Plan login flow.
 *
 * Narwal Plan is an API-key gateway (https://coder.narwal.com/v1) exposing
 * frontier models (GLM, GPT, Claude, MiniMax, Qwen, Kimi, DeepSeek, ...)
 * through an OpenAI-compatible API.
 *
 * This is not OAuth - it's a simple API key flow:
 * 1. Open browser to the gateway console
 * 2. User copies their API key
 * 3. User pastes the API key back into the CLI
 */

import { validateOpenAICompatibleApiKey } from "./api-key-validation";
import type { OAuthController } from "./types";

const AUTH_URL = "https://coder.narwal.com";
const API_BASE_URL = "https://coder.narwal.com/v1";
const VALIDATION_MODEL = "minimax-m3";

/**
 * Login to Narwal Plan.
 *
 * Opens the gateway console, prompts the user to paste their API key,
 * validates it against the chat completions endpoint, and returns the key
 * (stored as an api_key credential by AuthStorage).
 */
export async function loginNarwalPlan(options: OAuthController): Promise<string> {
	if (!options.onPrompt) {
		throw new Error("Narwal Plan login requires onPrompt callback");
	}
	options.onAuth?.({
		url: AUTH_URL,
		instructions: "Open the Narwal AI gateway console and copy your API key",
	});
	const apiKey = await options.onPrompt({
		message: "Paste your Narwal Plan API key",
		placeholder: "sk-...",
	});
	if (options.signal?.aborted) {
		throw new Error("Login cancelled");
	}
	const trimmed = apiKey.trim();
	if (!trimmed) {
		throw new Error("API key is required");
	}

	options.onProgress?.("Validating API key...");
	await validateOpenAICompatibleApiKey({
		provider: "Narwal Plan",
		apiKey: trimmed,
		baseUrl: API_BASE_URL,
		model: VALIDATION_MODEL,
		signal: options.signal,
	});
	return trimmed;
}
