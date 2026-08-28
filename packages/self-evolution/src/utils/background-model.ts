/**
 * Resolve a model for background (non-blocking) LLM calls in self-evolution.
 */
import type { Model } from "@cornfield/ai";
import type { ExtensionContext } from "@cornfield/coding-agent/extensibility/extensions";

/**
 * Prefer the active session model. Extensions receive `ctx.model` from the agent runtime.
 */
export function resolveBackgroundModel(ctx: Pick<ExtensionContext, "model">): Model | undefined {
	return ctx.model;
}
