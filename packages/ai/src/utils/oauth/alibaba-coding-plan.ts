/**
 * Alibaba Coding Plan login flow.
 *
 * Alibaba Coding Plan provides OpenAI-compatible models via https://dashscope.aliyuncs.com/compatible-mode/v1.
 *
 * This is not OAuth - it's a simple API key flow:
 * 1. Open browser to Alibaba Cloud DashScope API key settings
 * 2. User copies their API key
 * 3. User pastes the API key into the CLI
 */

import type { OAuthController } from "./types";

const AUTH_URL = "https://modelstudio.console.alibabacloud.com/";
const API_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const VALIDATION_MODEL_CLASSIC = "qwen3.5-plus";
const VALIDATION_MODEL_SK_SP = "qwen3-coder-plus";
const VALIDATION_TIMEOUT_MS = 15_000;

/**
 * DashScope coding OpenAI-compatible endpoint accepts classic keys as raw `Authorization`,
 * but `sk-sp-*` (Bailian-style) keys require `Bearer` or the server returns 401.
 */
export function alibabaCodingPlanAuthorizationHeader(apiKey: string): string {
	const trimmed = apiKey.trim();
	if (trimmed.startsWith("sk-sp-")) {
		return `Bearer ${trimmed}`;
	}
	return trimmed;
}

async function validateAlibabaApiKey(options: {
	apiKey: string;
	baseUrl: string;
	model: string;
	signal?: AbortSignal;
}): Promise<void> {
	const timeoutSignal = AbortSignal.timeout(VALIDATION_TIMEOUT_MS);
	const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;

	const response = await fetch(`${options.baseUrl}/chat/completions`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: alibabaCodingPlanAuthorizationHeader(options.apiKey),
		},
		body: JSON.stringify({
			model: options.model,
			messages: [{ role: "user", content: "ping" }],
			max_tokens: 1,
			temperature: 0,
		}),
		signal,
	});

	if (response.ok) {
		return;
	}

	let details = "";
	try {
		details = (await response.text()).trim();
	} catch {
		// ignore body parse errors, status is enough
	}

	const message = details
		? `Alibaba Coding Plan API key validation failed (${response.status}): ${details}`
		: `Alibaba Coding Plan API key validation failed (${response.status})`;
	throw new Error(message);
}

/**
 * Login to Alibaba Coding Plan.
 *
 * Opens browser to API keys page, prompts user to paste their API key.
 * Returns the API key directly (not OAuthCredentials - this isn't OAuth).
 */
export async function loginAlibabaCodingPlan(options: OAuthController): Promise<string> {
	if (!options.onPrompt) {
		throw new Error("Alibaba Coding Plan login requires onPrompt callback");
	}

	options.onAuth?.({
		url: AUTH_URL,
		instructions: "Copy your API key from the Alibaba Cloud DashScope console",
	});

	const apiKey = await options.onPrompt({
		message: "Paste your Alibaba Coding Plan API key",
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
	const validationModel = trimmed.startsWith("sk-sp-") ? VALIDATION_MODEL_SK_SP : VALIDATION_MODEL_CLASSIC;
	await validateAlibabaApiKey({
		apiKey: trimmed,
		baseUrl: API_BASE_URL,
		model: validationModel,
		signal: options.signal,
	});

	return trimmed;
}
