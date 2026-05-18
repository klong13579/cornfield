/**
 * Reconstruct SessionTrace from omp session JSONL (type: message entries).
 */
import type { Episode, SessionTrace, TraceEntry } from "../types";

interface SessionHeader {
	type: "session";
	id: string;
	cwd?: string;
	timestamp?: string;
}

interface SessionMessageEntry {
	type: "message";
	timestamp: string;
	message: {
		role: string;
		content?: unknown;
		toolName?: string;
		isError?: boolean;
		stopReason?: string;
		errorMessage?: string;
	};
}

function parseTimestamp(iso: string | undefined, fallback: number): number {
	if (!iso) return fallback;
	const ms = Date.parse(iso);
	return Number.isFinite(ms) ? ms : fallback;
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const b = block as Record<string, unknown>;
		if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
		if (b.type === "toolCall" && typeof b.name === "string") parts.push(b.name);
	}
	return parts.join(" ");
}

function extractToolCalls(content: unknown): Array<{ name: string; args?: unknown }> {
	if (!Array.isArray(content)) return [];
	const calls: Array<{ name: string; args?: unknown }> = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const b = block as Record<string, unknown>;
		if (b.type === "toolCall" && typeof b.name === "string") {
			calls.push({ name: b.name, args: b.arguments ?? b.input });
		}
	}
	return calls;
}

export function parseOmpSessionJsonlToTrace(jsonlText: string, episode: Episode): SessionTrace | undefined {
	const lines = jsonlText.split("\n").filter(l => l.trim().length > 0);
	let header: SessionHeader | undefined;
	const entries: TraceEntry[] = [];
	let userPrompt = episode.userPrompt;
	let startTime = episode.timestamp;
	let endTime = episode.timestamp + episode.durationMs;
	let toolCallCount = 0;
	let errorCount = 0;
	let hadRecovery = episode.hadRecovery;
	let sawError = false;

	for (const line of lines) {
		let parsed: SessionHeader | SessionMessageEntry | { type: string };
		try {
			parsed = JSON.parse(line) as SessionHeader | SessionMessageEntry;
		} catch {
			continue;
		}

		if (parsed.type === "session") {
			header = parsed as SessionHeader;
			startTime = parseTimestamp(header.timestamp, startTime);
			continue;
		}

		if (parsed.type !== "message") continue;
		const entry = parsed as SessionMessageEntry;
		const ts = parseTimestamp(entry.timestamp, startTime);
		const msg = entry.message;
		if (!msg) continue;

		if (msg.role === "user") {
			const text = extractText(msg.content);
			if (text && !userPrompt) userPrompt = text;
			entries.push({ type: "user_input", timestamp: ts, content: text });
			continue;
		}

		if (msg.role === "assistant") {
			if (msg.stopReason === "error" && msg.errorMessage) {
				errorCount++;
				sawError = true;
				entries.push({ type: "model_error", timestamp: ts, content: msg.errorMessage });
			}
			const text = extractText(msg.content);
			if (text) {
				entries.push({ type: "assistant_message", timestamp: ts, content: text });
			}
			for (const call of extractToolCalls(msg.content)) {
				toolCallCount++;
				entries.push({
					type: "tool_call",
					timestamp: ts,
					toolName: call.name,
					args: call.args,
				});
			}
			continue;
		}

		if (msg.role === "toolResult") {
			const isError = Boolean(msg.isError);
			if (isError) {
				errorCount++;
				sawError = true;
			} else if (sawError) {
				hadRecovery = true;
			}
			entries.push({
				type: "tool_result",
				timestamp: ts,
				toolName: msg.toolName,
				result: msg.content,
				isError,
			});
		}
	}

	if (entries.length === 0 && episode.toolCallCount === 0) {
		return undefined;
	}

	endTime = entries.length > 0 ? (entries[entries.length - 1]?.timestamp ?? endTime) : endTime;
	toolCallCount = Math.max(toolCallCount, episode.toolCallCount);
	errorCount = Math.max(errorCount, episode.errorCount);

	return {
		sessionId: episode.sessionId,
		cwd: header?.cwd ?? episode.cwd,
		userPrompt,
		startTime,
		endTime,
		entries,
		toolCallCount,
		errorCount,
		hadRecovery,
		completedSuccessfully: episode.completedSuccessfully,
	};
}
