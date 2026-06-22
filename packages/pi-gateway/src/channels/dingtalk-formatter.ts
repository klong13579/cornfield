/**
 * DingTalk reply formatter — composes the user-facing agent response into
 * a single markdown message with three visual sections:
 *
 *   ┌─ quoteContent (blockquote) ─┐   <— original triggering message
 *   ├─ tool summary (optional) ───┤   <— list of tool calls invoked
 *   ├─ main answer ───────────────┤   <— the agent's text response
 *   └─ status line (small text) ──┘   <— model / effort / taskTime / tokens / dapi / agent
 *
 * Markdown stays single-message: AI Card streaming is the v2/v3 upgrade. v1
 * ships the same information density (matched to the OpenClaw status line
 * fields) in plain markdown, so the bot already looks like a richer product
 * before we invest in the card infra.
 *
 * The formatter is pure: no I/O, no shared state. The gateway assembles
 * the input context from `AgentResponseMeta` + the inbound message and
 * account config, then delegates rendering to this module.
 */

import { logger } from "@oh-my-pi/pi-utils";
import type { AgentResponseMeta, InboundMessage } from "../types";

/** Hard ceiling for a single DingTalk markdown body (group chats cap at ~4000). */
const MAX_REPLY_LENGTH = 4000;
/** Length budget for the quoted original message in the header blockquote. */
const MAX_QUOTE_LENGTH = 120;
/** Marker that we cut a long answer for the IM char cap. */
const TRUNCATE_NOTICE = "\n\n...(内容已截断，请使用终端查看完整输出)";

export interface DingTalkFormatterContext {
	/** Structured agent run metadata (model, usage, tools, timing). */
	meta: AgentResponseMeta;
	/** The inbound message that triggered this reply (for quoteContent). */
	inbound: InboundMessage;
	/** Per-account agent name for the status line "agent" field. */
	agentName: string | null;
	/** Account id — used as the "agent" fallback when `agentName` is null. */
	accountId: string;
	/** Count of DingTalk API calls made during this turn (status line "dapi"). */
	dapiCalls: number;
}

export interface DingTalkFormatterOutput {
	/** The complete markdown to send as a single DingTalk message. */
	markdown: string;
	/** Byte/char length of the rendered markdown. */
	length: number;
	/** True if the answer body was truncated to fit the DingTalk char cap. */
	truncated: boolean;
}

/**
 * Render the agent response + chrome into a single markdown message.
 *
 * For `meta.isFallback` (circuit open, recovery, error), returns just the
 * localized fallback text — no quoteContent, no tool summary, no status
 * line. These are user-facing error messages, not agent output.
 */
export function formatDingTalkReply(ctx: DingTalkFormatterContext): DingTalkFormatterOutput {
	const { meta, inbound, agentName, accountId, dapiCalls } = ctx;

	if (meta.isFallback) {
		const text = sanitizeMarkdown(meta.text);
		return { markdown: text, length: text.length, truncated: false };
	}

	const sections: string[] = [];

	const quote = formatQuoteContent(inbound);
	if (quote) sections.push(quote);

	const toolSummary = formatToolSummary(meta);
	if (toolSummary) sections.push(toolSummary);

	sections.push(sanitizeMarkdown(meta.text));

	const statusLine = formatStatusLine(meta, agentName, accountId, dapiCalls);
	if (statusLine) sections.push(statusLine);

	let markdown = sections.join("\n\n");
	let truncated = false;

	if (markdown.length > MAX_REPLY_LENGTH) {
		truncated = true;
		markdown = truncateReply(sections);
	}

	return { markdown, length: markdown.length, truncated };
}

// ═══════════════════════════════════════════════════════════════════════
// Section builders
// ═══════════════════════════════════════════════════════════════════════

/**
 * Build the header blockquote showing the inbound message that triggered
 * the response. Helps users in busy group chats remember "oh, this card
 * was a reply to THAT message".
 *
 * Returns null when the inbound has no displayable content (shouldn't
 * happen, but defensive against malformed messages).
 */
function formatQuoteContent(inbound: InboundMessage): string | null {
	const description = describeInboundForQuote(inbound);
	if (!description) return null;
	const truncated = description.length > MAX_QUOTE_LENGTH ? `${description.slice(0, MAX_QUOTE_LENGTH)}…` : description;
	const sender = escapeForBlockquote(inbound.userName ?? "user");
	// Markdown blockquote + bold sender + body.
	return `> 💬 **${sender}**: ${truncated}`;
}

function describeInboundForQuote(msg: InboundMessage): string {
	switch (msg.content.type) {
		case "text":
			return msg.content.text.trim();
		case "markdown":
			return msg.content.markdown.trim();
		case "image":
			return "[图片]";
		case "file":
			return `[文件: ${msg.content.filename}]`;
		case "voice":
			return msg.content.text ? `[语音转文字] ${msg.content.text.trim()}` : "[语音]";
		case "video":
			return `[视频: ${msg.content.filename}]`;
	}
}

/**
 * Tool-call summary line. Compact format for v1: a single bold "工具: "
 * line listing the tools invoked in order. If the same tool was called
 * multiple times we show the count after the name (`read × 3`).
 *
 * Returns null when no tools were invoked (most short replies).
 */
function formatToolSummary(meta: AgentResponseMeta): string | null {
	if (meta.toolCalls.length === 0) return null;
	const counts = new Map<string, number>();
	for (const call of meta.toolCalls) {
		counts.set(call.name, (counts.get(call.name) ?? 0) + 1);
	}
	const order: string[] = [];
	const seen = new Set<string>();
	for (const call of meta.toolCalls) {
		if (seen.has(call.name)) continue;
		seen.add(call.name);
		const count = counts.get(call.name) ?? 1;
		order.push(count > 1 ? `${call.name} × ${count}` : call.name);
	}
	const errorCount = meta.toolResults.filter((r: { isError: boolean }) => r.isError).length;
	const tail = errorCount > 0 ? ` (${errorCount} 错误)` : "";
	return `**工具**: ${order.join(", ")}${tail}`;
}

/**
 * Build the status line (model / effort / taskTime / tokens / dapi / agent).
 * Always shown unless every field is unknown (e.g. no meta, no account).
 *
 * Renders as a single muted line. Fields use a backtick span where
 * distinguishing them aids scanning; the dim "·" separator renders fine
 * in DingTalk markdown.
 */
function formatStatusLine(
	meta: AgentResponseMeta,
	agentName: string | null,
	accountId: string,
	dapiCalls: number,
): string | null {
	const parts: string[] = [];

	if (meta.model) {
		parts.push(`\`${meta.model}\``);
	} else if (meta.provider) {
		parts.push(`\`${meta.provider}/?\``);
	}

	if (meta.effort) {
		parts.push(`effort \`${meta.effort}\``);
	}

	parts.push(formatDuration(meta.taskDurationMs));

	if (meta.usage) {
		const total = meta.usage.input + meta.usage.output + meta.usage.cacheRead + meta.usage.cacheWrite;
		parts.push(formatTokens(total));
	} else {
		parts.push("— tokens");
	}

	parts.push(`${dapiCalls} dapi`);

	if (agentName) {
		parts.push(`agent \`${agentName}\``);
	} else if (accountId && accountId !== "__default__") {
		parts.push(`agent \`${accountId}\``);
	} else {
		parts.push("agent `default`");
	}

	if (parts.length === 0) return null;
	// Prepend a divider so the status line reads as a separate footer even
	// when DingTalk ignores horizontal-rule rendering.
	return `---\n${parts.join(" · ")}`;
}

// ═══════════════════════════════════════════════════════════════════════
// Formatting helpers
// ═══════════════════════════════════════════════════════════════════════

/** Format a duration in ms as a compact human-readable string. */
function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.floor((ms % 60_000) / 1000);
	return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
}

/** Format a token count with k/M abbreviation for 4-digit+ values. */
function formatTokens(n: number): string {
	if (n < 1000) return `${n} tok`;
	if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k tok`;
	return `${(n / 1_000_000).toFixed(2)}M tok`;
}

/**
 * Strip `<think>` blocks and trim. The agent bridge already strips these
 * when computing `text`, but a defensive pass here guarantees nothing
 * leaks into the rendered markdown (e.g. if a future bridge change forgets).
 */
function sanitizeMarkdown(text: string): string {
	return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

/**
 * Escape characters that would break the blockquote render when the
 * sender name contains markdown special chars (e.g. `*` in the name).
 */
function escapeForBlockquote(s: string): string {
	return s.replace(/[*_`]/g, m => `\\${m}`);
}

/**
 * Truncate the middle (answer) section when the composed reply exceeds
 * the DingTalk char cap. Preserves the quoteContent (header) and status
 * line (footer) intact — these are the most important context bits.
 */
function truncateReply(sections: string[]): string {
	const header = sections[0] ?? "";
	const footer = sections[sections.length - 1] ?? "";
	const middle = sections.slice(1, -1).join("\n\n");

	const fixedBudget = header.length + footer.length + 4; // joining newlines
	const middleBudget = MAX_REPLY_LENGTH - fixedBudget - TRUNCATE_NOTICE.length;

	let trimmedMiddle = middle;
	if (middle.length > middleBudget) {
		const cutAt = Math.max(middleBudget * 0.5, middleBudget - 1);
		trimmedMiddle = `${middle.slice(0, cutAt)}${TRUNCATE_NOTICE}`;
		logger.debug("[DingTalkFormatter] answer body truncated to fit reply cap", {
			originalLength: middle.length,
			truncatedLength: trimmedMiddle.length,
		});
	}

	if (footer) {
		return `${header}\n\n${trimmedMiddle}\n\n${footer}`;
	}
	return `${header}\n\n${trimmedMiddle}`;
}
