/**
 * Generate session titles using a smol, fast model.
 */
import * as path from "node:path";
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { completeSimple } from "@oh-my-pi/pi-ai";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { resolveRoleSelection } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import titleSystemPrompt from "../prompts/system/title-system.md" with { type: "text" };
import { toReasoningEffort } from "../thinking";

const TITLE_SYSTEM_PROMPT = prompt.render(titleSystemPrompt);

const DEFAULT_TERMINAL_TITLE = "π";
const TERMINAL_TITLE_CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

const MAX_INPUT_CHARS = 2000;

/** Heuristic for OpenAI-compat + DashScope-style credential errors (exported for tests). */
export function isLikelyCredentialAuthFailureForTitle(message: string | undefined): boolean {
	if (!message) return false;
	return /\b401\b|invalid[_\s-]*api[_\s-]*key|Invalid API-key|invalid access token|token expired|param=invalid_api_key/i.test(
		message,
	);
}

function titleModelsDiffer(a: Model<Api>, b: Model<Api>): boolean {
	return a.provider !== b.provider || a.id !== b.id;
}

function getTitleModel(
	registry: ModelRegistry,
	settings: Settings,
	currentModel?: Model<Api>,
): { model: Model<Api>; thinkingLevel?: ThinkingLevel } | undefined {
	const availableModels = registry.getAvailable();
	if (availableModels.length === 0) return undefined;

	const titleModel = resolveRoleSelection(["commit", "smol"], settings, availableModels, registry);
	if (titleModel) {
		return { model: titleModel.model, thinkingLevel: titleModel.thinkingLevel };
	}

	if (currentModel) {
		return { model: currentModel };
	}

	return undefined;
}

/**
 * Generate a title for a session based on the first user message.
 *
 * @param firstMessage The first user message
 * @param registry Model registry
 * @param settings Settings used to resolve the smol role, including per-role thinking
 * @param sessionId Optional session id for sticky API key selection
 */
export async function generateSessionTitle(
	firstMessage: string,
	registry: ModelRegistry,
	settings: Settings,
	sessionId?: string,
	currentModel?: Model<Api>,
): Promise<string | null> {
	const candidate = getTitleModel(registry, settings, currentModel);
	if (!candidate) {
		logger.debug("title-generator: no title model found");
		return null;
	}

	// Truncate message if too long
	const truncatedMessage =
		firstMessage.length > MAX_INPUT_CHARS ? `${firstMessage.slice(0, MAX_INPUT_CHARS)}…` : firstMessage;
	const userMessage = `<user-message>
${truncatedMessage}
</user-message>`;

	const apiKey = await registry.getApiKey(candidate.model, sessionId);
	if (!apiKey) {
		logger.debug("title-generator: no API key for smol model", {
			provider: candidate.model.provider,
			id: candidate.model.id,
		});
		return null;
	}

	const request = {
		model: `${candidate.model.provider}/${candidate.model.id}`,
		systemPrompt: TITLE_SYSTEM_PROMPT,
		userMessage,
		maxTokens: 30,
	};
	logger.debug("title-generator: request", request);

	async function runCompletionForModel(
		model: Model<Api>,
		thinkingLevel: ThinkingLevel | undefined,
		key: string,
	): Promise<AssistantMessage> {
		return completeSimple(
			model,
			{
				systemPrompt: TITLE_SYSTEM_PROMPT,
				messages: [{ role: "user", content: userMessage, timestamp: Date.now() }],
			},
			{
				apiKey: key,
				maxTokens: 30,
				reasoning: toReasoningEffort(thinkingLevel),
			},
		);
	}

	function extractTitleText(response: AssistantMessage): string {
		let title = "";
		for (const content of response.content) {
			if (content.type === "text") {
				title += content.text;
			}
		}
		return title.trim();
	}

	try {
		let response = await runCompletionForModel(candidate.model, candidate.thinkingLevel, apiKey);
		let modelLabelForLog = request.model;

		if (
			response.stopReason === "error" &&
			isLikelyCredentialAuthFailureForTitle(response.errorMessage) &&
			currentModel &&
			titleModelsDiffer(currentModel, candidate.model)
		) {
			const fallbackKey = await registry.getApiKey(currentModel, sessionId);
			if (fallbackKey) {
				logger.debug("title-generator: retrying with active session model after credential error", {
					failedModel: request.model,
					fallbackModel: `${currentModel.provider}/${currentModel.id}`,
				});
				response = await runCompletionForModel(currentModel, undefined, fallbackKey);
				modelLabelForLog = `${currentModel.provider}/${currentModel.id}`;
			}
		}

		if (response.stopReason === "error") {
			logger.debug("title-generator: response error", {
				model: modelLabelForLog,
				stopReason: response.stopReason,
				errorMessage: response.errorMessage,
			});
			return null;
		}

		const titleRaw = extractTitleText(response);

		logger.debug("title-generator: response", {
			model: modelLabelForLog,
			title: titleRaw,
			usage: response.usage,
			stopReason: response.stopReason,
		});

		if (!titleRaw) {
			return null;
		}

		return titleRaw.replace(/^["']|["']$/g, "").replace(/[.!?]$/, "");
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (
			isLikelyCredentialAuthFailureForTitle(msg) &&
			currentModel &&
			titleModelsDiffer(currentModel, candidate.model)
		) {
			const fallbackKey = await registry.getApiKey(currentModel, sessionId);
			if (fallbackKey) {
				try {
					logger.debug("title-generator: retrying with active session model after thrown credential error", {
						failedModel: request.model,
						fallbackModel: `${currentModel.provider}/${currentModel.id}`,
					});
					const response = await runCompletionForModel(currentModel, undefined, fallbackKey);
					if (response.stopReason !== "error") {
						const titleRaw = extractTitleText(response);
						if (titleRaw) {
							logger.debug("title-generator: response", {
								model: `${currentModel.provider}/${currentModel.id}`,
								title: titleRaw,
								usage: response.usage,
								stopReason: response.stopReason,
							});
							return titleRaw.replace(/^["']|["']$/g, "").replace(/[.!?]$/, "");
						}
					}
					logger.debug("title-generator: response error after retry", {
						model: `${currentModel.provider}/${currentModel.id}`,
						stopReason: response.stopReason,
						errorMessage: response.errorMessage,
					});
				} catch (retryErr) {
					logger.debug("title-generator: error on credential retry", {
						model: `${currentModel.provider}/${currentModel.id}`,
						error: retryErr instanceof Error ? retryErr.message : String(retryErr),
					});
				}
			}
		}
		logger.debug("title-generator: error", {
			model: request.model,
			error: msg,
		});
		return null;
	}
}

/**
 * Remove control characters so model-generated titles cannot inject terminal escapes.
 */
function sanitizeTerminalTitlePart(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const sanitized = value.replace(TERMINAL_TITLE_CONTROL_CHARS, "").trim();
	return sanitized || undefined;
}

function getFallbackTerminalTitle(cwd: string | undefined): string | undefined {
	if (!cwd) return undefined;
	const resolvedCwd = path.resolve(cwd);
	const baseName = path.basename(resolvedCwd);
	if (!baseName || baseName === path.parse(resolvedCwd).root) return undefined;
	return sanitizeTerminalTitlePart(baseName);
}

export function formatSessionTerminalTitle(
	sessionName: string | undefined,
	cwd?: string,
	titleSource?: "auto" | "user" | undefined,
): string {
	const label =
		sanitizeTerminalTitlePart(titleSource === "auto" ? undefined : sessionName) ?? getFallbackTerminalTitle(cwd);
	return label ? `${DEFAULT_TERMINAL_TITLE}: ${label}` : DEFAULT_TERMINAL_TITLE;
}

/**
 * Set the terminal title using OSC 0 (sets both tab and window title). Unsupported terminals ignore it.
 */
export function setTerminalTitle(title: string): void {
	process.stdout.write(`\x1b]0;${sanitizeTerminalTitlePart(title) ?? DEFAULT_TERMINAL_TITLE}\x07`);
}

export function setSessionTerminalTitle(
	sessionName: string | undefined,
	cwd?: string,
	titleSource?: "auto" | "user" | undefined,
): void {
	setTerminalTitle(formatSessionTerminalTitle(sessionName, cwd, titleSource));
}

/**
 * Save the current terminal title on terminals that support xterm window ops.
 */
export function pushTerminalTitle(): void {
	process.stdout.write("\x1b[22;2t");
}

/**
 * Restore the previously saved terminal title on terminals that support xterm window ops.
 */
export function popTerminalTitle(): void {
	process.stdout.write("\x1b[23;2t");
}
