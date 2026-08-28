/**
 * Resolve API keys for background LLM calls via the same path as the main agent.
 */
import type { Model } from "@cornfield/ai";
import type { ExtensionContext } from "@cornfield/coding-agent/extensibility/extensions";
import type { BackgroundLlmAuth } from "./llm";

export function createBackgroundLlmAuth(
	ctx: Pick<ExtensionContext, "modelRegistry" | "sessionManager">,
): BackgroundLlmAuth {
	const sessionId = ctx.sessionManager.getSessionId();
	return {
		getApiKey: (model: Model) => ctx.modelRegistry.getApiKey(model, sessionId),
	};
}
