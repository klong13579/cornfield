/**
 * Resolve a model for background (non-blocking) LLM calls in self-evolution.
 */
import type { Model } from "@oh-my-pi/pi-ai";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";

/**
 * Prefer the active session model. Extensions receive `ctx.model` from the agent runtime.
 */
export function resolveBackgroundModel(ctx: Pick<ExtensionContext, "model">): Model | undefined {
	return ctx.model;
}
