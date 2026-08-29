/**
 * Rewrite internal retry/fallback machinery text into a stable, actionable
 * user-facing message. The raw errorMessage may be an omp auto-retry chain
 * status ("Max retries exhausted — trying fallback…"), a model-fallback
 * transition note, or a provider error body quoted verbatim (which can carry
 * the upstream gateway's internal wording). IM users cannot act on any of
 * that — they can retry, or wait. Recognizable provider idioms (rate limit,
 * overload, timeout, auth) are mapped to concrete hints; everything else
 * collapses to a generic retry suggestion. The full raw message always
 * stays in the gateway log for diagnosis.
 */
export function friendlyLlmError(raw: string): string {
	const msg = raw.toLowerCase();
	if (/rate.?limit|too many requests|429/.test(msg)) {
		return "请求频率受限，请稍等一分钟再重试。";
	}
	if (/overload|50[023]/.test(msg)) {
		return "模型服务暂时过载，请稍后重试。";
	}
	if (/timeout|timed out/.test(msg)) {
		return "模型响应超时，请重试。";
	}
	if (/401|unauthorized|invalid.*key|credential/.test(msg)) {
		return "模型凭据异常（已通知管理员）。";
	}
	if (/context.*(overflow|too.*(large|long))|maximum context/.test(msg)) {
		return "对话过长超出模型上下文，请开新会话（发 /new）。";
	}
	return "服务暂时不稳定，已自动重试未成功，请稍后重试。";
}

/**
 * ResponseMetaBuilder — extracts AgentResponseMeta from a stream of AgentEvents.
 *
 * Two paths:
 *   - build(): happy path with parsed agent events (model, tool calls, usage)
 *   - fallback(): empty/error path (model=null, tool calls=[], etc.)
 *
 * Pure functions: no state, no I/O. Testable in isolation.
 */

import type { AssistantMessage, ToolCall, ToolResultMessage, Usage } from "@cornfield/ai";
import type { AgentEvent } from "./agent-transport-wire";
import type { AgentResponseMeta, AgentResponseToolCall, AgentResponseToolResult } from "./types";

type WireMessage = AssistantMessage | ToolResultMessage | { role: string; [k: string]: unknown };
type WireEvent = { type: string; message?: WireMessage; [k: string]: unknown };

export interface BuildOverrides {
	isFallback: boolean;
	error?: string | null;
	aborted?: boolean;
}

function lastAssistantMessage(events: WireEvent[]): AssistantMessage | undefined {
	for (let i = events.length - 1; i >= 0; i--) {
		const ev = events[i];
		if (ev.type !== "message_end") continue;
		const msg = ev.message;
		if (msg && msg.role === "assistant") return msg as AssistantMessage;
	}
	return undefined;
}

function collectToolResults(events: WireEvent[]): AgentResponseToolResult[] {
	const out: AgentResponseToolResult[] = [];
	for (const ev of events) {
		if (ev.type !== "message_end") continue;
		const msg = ev.message;
		if (msg?.role !== "toolResult") continue;
		const tr = msg as ToolResultMessage;
		out.push({
			id: tr.toolCallId,
			name: tr.toolName,
			isError: tr.isError === true,
		});
	}
	return out;
}

function collectToolCallsFromAssistant(assistant: AssistantMessage): AgentResponseToolCall[] {
	const out: AgentResponseToolCall[] = [];
	for (const item of assistant.content) {
		if (item.type !== "toolCall") continue;
		const tc = item as ToolCall;
		out.push({
			id: tc.id,
			name: tc.name,
			args: tc.arguments ?? null,
		});
	}
	return out;
}

function extractUsage(usage: Usage): NonNullable<AgentResponseMeta["usage"]> {
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
	};
}

/** Pull the assistant's text content from the last assistant message. */
export function extractAssistantText(events: AgentEvent[]): string | null {
	const assistantEvents = events.filter(e => e.type === "message_end" && e.message?.role === "assistant");
	const last = assistantEvents[assistantEvents.length - 1];
	if (!last?.message?.content) return null;
	const textContent = last.message.content.find((c: { type: string }) => c.type === "text");
	return (textContent as { text?: string })?.text ?? null;
}

/** Extract error details from the last assistant message if it errored. */
export function extractAssistantError(events: AgentEvent[]): { stopReason: string; errorMessage: string } | null {
	const assistantEvents = events.filter(e => e.type === "message_end" && e.message?.role === "assistant");
	const last = assistantEvents[assistantEvents.length - 1];
	if (!last?.message) return null;
	const wire = last.message as { stopReason?: string; errorMessage?: string };
	if (wire.stopReason === "error" && wire.errorMessage) {
		return { stopReason: wire.stopReason, errorMessage: wire.errorMessage };
	}
	return null;
}

export class ResponseMetaBuilder {
	build(
		events: AgentEvent[],
		rawText: string,
		formattedText: string,
		startedAt: number,
		overrides: BuildOverrides = { isFallback: false },
	): AgentResponseMeta {
		const wireEvents = events as unknown as Array<WireEvent>;

		const lastAssistant = lastAssistantMessage(wireEvents);
		const toolResults = collectToolResults(wireEvents);
		const toolCalls = lastAssistant ? collectToolCallsFromAssistant(lastAssistant) : [];

		const model = lastAssistant?.model ?? null;
		const provider = (lastAssistant?.provider as string | undefined) ?? null;
		const agentDurationMs = lastAssistant?.duration ?? null;
		const usage: AgentResponseMeta["usage"] = lastAssistant?.usage ? extractUsage(lastAssistant.usage) : null;

		return {
			text: formattedText,
			rawText,
			model,
			provider,
			usage,
			agentDurationMs,
			taskDurationMs: Date.now() - startedAt,
			effort: null,
			toolCalls,
			toolResults,
			error: overrides.error ?? null,
			aborted: overrides.aborted ?? false,
			isFallback: overrides.isFallback,
		};
	}

	fallback(
		text: string,
		startedAt: number,
		overrides: { error?: string | null; aborted?: boolean } = {},
	): AgentResponseMeta {
		return {
			text,
			rawText: text,
			model: null,
			provider: null,
			usage: null,
			agentDurationMs: null,
			taskDurationMs: Date.now() - startedAt,
			effort: null,
			toolCalls: [],
			toolResults: [],
			error: overrides.error ?? null,
			aborted: overrides.aborted ?? false,
			isFallback: true,
		};
	}
}
