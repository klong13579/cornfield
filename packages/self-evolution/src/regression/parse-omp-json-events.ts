/**
 * Parse omp `--mode json` stdout (extension events, one JSON object per line).
 */

import type { TraceEntry } from "../types";
import type { FixtureReplayResult } from "./replay";
import { parseReplayVerdictFromResponse } from "./replay-contract";

function extractAssistantText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const b = block as Record<string, unknown>;
		if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
	}
	return parts.join("\n");
}

export function parseOmpJsonEventStreamToTraceEntries(stdout: string): TraceEntry[] {
	const entries: TraceEntry[] = [];
	let ts = 0;

	for (const line of stdout.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("{")) continue;

		let event: Record<string, unknown>;
		try {
			event = JSON.parse(trimmed) as Record<string, unknown>;
		} catch {
			continue;
		}

		ts += 1;
		const type = event.type;

		if (type === "tool_execution_start") {
			entries.push({
				type: "tool_call",
				timestamp: ts,
				toolName: typeof event.toolName === "string" ? event.toolName : undefined,
				args: event.args,
			});
			continue;
		}

		if (type === "tool_execution_end") {
			entries.push({
				type: "tool_result",
				timestamp: ts,
				toolName: typeof event.toolName === "string" ? event.toolName : undefined,
				result: event.result,
				isError: Boolean(event.isError),
			});
		}
	}

	return entries;
}

export function extractReplayVerdictFromJsonStream(stdout: string): FixtureReplayResult | undefined {
	const lines = stdout.split("\n").filter(l => l.trim().startsWith("{"));

	for (let i = lines.length - 1; i >= 0; i--) {
		try {
			const event = JSON.parse(lines[i]!) as Record<string, unknown>;
			if (event.type !== "message_end") continue;
			const message = event.message as Record<string, unknown> | undefined;
			if (message?.role !== "assistant") continue;
			const text = extractAssistantText(message.content);
			const verdict = parseReplayVerdictFromResponse(text);
			if (verdict) return verdict;
		} catch {}
	}

	return parseReplayVerdictFromResponse(stdout);
}
