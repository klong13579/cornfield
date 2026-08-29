/**
 * Request audit log — one JSONL line per user request to an IM agent.
 *
 * Written by the gateway into the account's own agent workspace
 * (`<agentDir>/logs/requests.jsonl`) so each agent can read its own request
 * history ("最近谁找过我" / "上次老板让我干嘛") without gateway help, and the
 * operator can audit who asked what and whether it succeeded.
 *
 * The file is deliberately NOT registered in prompt-includes.json — it is
 * read on demand, not injected into every session's context.
 *
 * Line shape:
 *   { ts, sender, senderId, request, status, errorType, durationMs,
 *     model, conversationTitle, isGroup }
 *
 * status: "ok" | "error" | "aborted"
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "@cornfield/utils";
import type { AgentResponseMeta, InboundMessage } from "./types";

const MAX_REQUEST_CHARS = 500;

export interface RequestAuditEntry {
	/** ISO timestamp of request arrival. */
	ts: string;
	/** Sender nickname. */
	sender: string;
	/** Sender staff/user id. */
	senderId: string;
	/** Request text (truncated to MAX_REQUEST_CHARS). */
	request: string;
	/** Outcome of the agent run. */
	status: "ok" | "error" | "aborted";
	/** Short error classification when status != ok (e.g. "repetitive_tool_calls"). */
	errorType?: string;
	/** Gateway-measured end-to-end duration in ms. */
	durationMs: number | null;
	/** Model id if reported. */
	model: string | null;
	/** Group title when the request came from a group @-mention. */
	conversationTitle: string | null;
	/** True when the request arrived via group @-mention. */
	isGroup: boolean;
}

/** Classify an error message into a short, stable error type tag. */
export function classifyError(errorMessage: string): string {
	const msg = errorMessage.toLowerCase();
	if (msg.includes("repetitive tool calls")) return "repetitive_tool_calls";
	if (msg.includes("timeout") || msg.includes("timed out")) return "timeout";
	if (msg.includes("llm") || msg.includes("model") || msg.includes("completion")) return "llm_error";
	if (msg.includes("abort")) return "aborted";
	if (msg.includes("crash") || msg.includes("rpc")) return "bridge_error";
	return "error";
}

/**
 * Append one audit entry to `<agentDir>/logs/requests.jsonl`.
 * Never throws — audit logging must not break the reply path.
 */
export async function appendRequestAudit(
	agentDir: string,
	msg: InboundMessage,
	meta: AgentResponseMeta | null,
): Promise<void> {
	try {
		const request = messageText(msg).slice(0, MAX_REQUEST_CHARS);
		let status: RequestAuditEntry["status"] = "error";
		let errorType: string | undefined;
		if (meta?.aborted) {
			status = "aborted";
		} else if (meta && !meta.error && !meta.isFallback) {
			status = "ok";
		} else if (meta?.error) {
			errorType = classifyError(meta.error);
		} else if (meta?.isFallback) {
			errorType = "fallback";
		} else {
			errorType = "no_response";
		}

		const entry: RequestAuditEntry = {
			ts: new Date().toISOString(),
			sender: msg.userName ?? "unknown",
			senderId: msg.userId,
			request,
			status,
			errorType,
			durationMs: meta?.taskDurationMs ?? null,
			model: meta?.model ?? null,
			conversationTitle: msg.isGroup ? (msg.conversationTitle ?? null) : null,
			isGroup: msg.isGroup,
		};

		const dir = path.join(agentDir, "logs");
		await fs.mkdir(dir, { recursive: true });
		await fs.appendFile(path.join(dir, "requests.jsonl"), `${JSON.stringify(entry)}\n`, "utf8");
	} catch (err) {
		logger.error("Failed to append request audit entry", { error: String(err) });
	}
}

function messageText(msg: InboundMessage): string {
	const c = msg.content;
	if (c.type === "text") return c.text;
	if (c.type === "markdown") return c.markdown;
	if (c.type === "voice") return c.text ?? "[voice]";
	return `[${c.type}]`;
}
