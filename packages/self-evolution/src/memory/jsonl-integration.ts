/**
 * JSONL dual-write integration for agent session hooks.
 *
 * Maintains parallel .jsonl traces alongside SQLite storage for:
 * - Backup/fallback when SQLite unavailable
 * - External tooling compatibility
 * - Debugging and forensics
 * - Migration capabilities
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SessionTrace, TraceEntry } from "../types";

/** Minimal session surface for JSONL dual-write hooks. */
interface JsonlHookSession {
	sessionId: string;
	options?: { prompt?: string };
	startTime?: number;
	jsonlWriter?: JsonlDualWriter;
}

export interface JsonlWriter {
	write(entry: TraceEntry): Promise<void>;
	flush(): Promise<void>;
	close(): Promise<void>;
}

/**
 * Implements JSONL dual-write for agent session traces.
 */
export class JsonlDualWriter implements JsonlWriter {
	private writeQueue: string[] = [];
	private flushPromise: Promise<void> | null = null;
	private closed = false;

	constructor(private readonly filePath: string) {}

	async write(entry: TraceEntry): Promise<void> {
		if (this.closed) {
			throw new Error("JsonlDualWriter is closed");
		}

		const serialized = JSON.stringify(entry);
		this.writeQueue.push(serialized);

		// If queue is getting large, initiate flush
		if (this.writeQueue.length >= 10) {
			this.flush();
		}
	}

	async flush(): Promise<void> {
		if (this.flushPromise) {
			await this.flushPromise;
		}

		if (this.writeQueue.length === 0 || this.closed) {
			return;
		}

		const entries = this.writeQueue;
		this.writeQueue = [];

		this.flushPromise = (async () => {
			const content = `${entries.join("\n")}\n`;

			// Ensure directory exists
			await fs.mkdir(path.dirname(this.filePath), { recursive: true });

			await fs.appendFile(this.filePath, content, "utf8");
		})();

		return this.flushPromise;
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;

		// Flush any remaining entries
		await this.flush();
	}
}

/**
 * Session hook that integrates JSONL dual-write with agent sessions.
 */
export class JsonlSessionHook {
	constructor(private readonly baseDir: string) {}

	async onSessionStart(session: JsonlHookSession, cwd: string): Promise<void> {
		// Initialize JSONL writer for this session
		const sessionDir = path.join(this.baseDir, "sessions");
		await fs.mkdir(sessionDir, { recursive: true });

		const tracePath = path.join(sessionDir, `${session.sessionId}.jsonl`);
		const writer = new JsonlDualWriter(tracePath);

		// Store writer in session context for later use
		session.jsonlWriter = writer;

		// Write session start event
		await writer.write({
			type: "session_start",
			timestamp: Date.now(),
			sessionId: session.sessionId,
			cwd,
			userPrompt: session.options?.prompt || "",
		});
	}

	async onToolCall(session: JsonlHookSession, toolCall: { id: string; name: string; args: unknown }): Promise<void> {
		const writer = session.jsonlWriter;
		if (!writer) return;

		await writer.write({
			type: "tool_call",
			timestamp: Date.now(),
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.args,
		});
	}

	async onToolResult(
		session: JsonlHookSession,
		toolCallId: string,
		result: { isError?: boolean; content?: unknown; output?: unknown },
	): Promise<void> {
		const writer = session.jsonlWriter;
		if (!writer) return;

		const content =
			typeof result.content === "string"
				? result.content
				: result.content !== undefined
					? JSON.stringify(result.content)
					: undefined;
		await writer.write({
			type: "tool_result",
			timestamp: Date.now(),
			toolCallId,
			isError: result.isError,
			content,
			output: result.output,
		});
	}

	async onUserInput(session: JsonlHookSession, content: string): Promise<void> {
		const writer = session.jsonlWriter;
		if (!writer) return;

		await writer.write({
			type: "user_input",
			timestamp: Date.now(),
			content,
		});
	}

	async onAssistantMessage(session: JsonlHookSession, content: string): Promise<void> {
		const writer = session.jsonlWriter;
		if (!writer) return;

		await writer.write({
			type: "assistant_message",
			timestamp: Date.now(),
			content,
		});
	}

	async onSessionEnd(session: JsonlHookSession, success: boolean): Promise<void> {
		const writer = session.jsonlWriter;
		if (!writer) return;

		await writer.write({
			type: "session_end",
			timestamp: Date.now(),
			sessionId: session.sessionId,
			success,
			duration: Date.now() - (session.startTime ?? Date.now()),
		});

		await writer.flush();
		await writer.close();
	}
}

/**
 * Utility to replay JSONL traces for analysis or migration.
 */
export async function* replayJsonlTrace(tracePath: string): AsyncGenerator<TraceEntry, void, unknown> {
	const content = await Bun.file(tracePath).text();
	const lines = content.split("\n").filter(line => line.trim() !== "");

	for (const line of lines) {
		try {
			const entry = JSON.parse(line) as TraceEntry;
			yield entry;
		} catch (error) {
			console.warn(`Invalid JSONL entry in ${tracePath}: ${line}`, error);
		}
	}
}

/**
 * Utility to convert JSONL trace to SessionTrace object.
 */
export async function jsonlTraceToSessionTrace(tracePath: string, sessionId: string): Promise<SessionTrace> {
	const entries: TraceEntry[] = [];
	let startTime: number | undefined;
	let endTime: number | undefined;
	let toolCallCount = 0;
	let errorCount = 0;
	let hadRecovery = false;
	let completedSuccessfully = false;
	let userPrompt = "";

	for await (const entry of replayJsonlTrace(tracePath)) {
		entries.push(entry);

		if (entry.type === "session_start") {
			startTime = entry.timestamp;
			userPrompt = (entry as any).userPrompt || "";
		} else if (entry.type === "session_end") {
			endTime = entry.timestamp;
			completedSuccessfully = (entry as any).success ?? false;
		} else if (entry.type === "tool_call") {
			toolCallCount++;
		} else if (entry.type === "tool_result" && entry.isError) {
			errorCount++;
			// Recovery is indicated by successful operations after errors
			if (
				errorCount > 0 &&
				entries.some(
					(e, idx) => idx > entries.indexOf(entry) && (e.type === "tool_call" || e.type === "assistant_message"),
				)
			) {
				hadRecovery = true;
			}
		}
	}

	return {
		sessionId,
		cwd: (entries.find(e => e.type === "session_start") as any)?.cwd || "",
		userPrompt,
		startTime: startTime ?? Date.now(),
		endTime: endTime ?? Date.now(),
		entries,
		toolCallCount,
		errorCount,
		hadRecovery,
		completedSuccessfully,
	};
}
