/**
 * Helper: record external tool calls to a JSONL trace file.
 *
 * Usage from external environments (Cursor, IDE, CI):
 *
 *   import { recordToolCall, recordToolResult, beginTrace, endTrace } from "./record-trace-jsonl";
 *
 *   const sessionId = crypto.randomUUID();
 *   const writer = await beginTrace(sessionId, process.cwd(), "user prompt here");
 *   // ...
 *   await recordToolCall(writer, "bash", { command: "dws ..." });
 *   // ... after tool completes:
 *   await recordToolResult(writer, "bash", "output", false);
 *   // ...
 *   await endTrace(writer, true);
 *
 * Each file is written to: ~/.omp/traces/external/<sessionId>.jsonl
 * The self-evolution pipeline will pick it up on the next omp start.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

export interface TraceWriter {
	filePath: string;
	sessionId: string;
	append(line: string): Promise<void>;
}

const TRACE_DIR = path.join(os.homedir(), ".omp", "traces", "external");

async function ensureDir(dir: string): Promise<void> {
	await fs.mkdir(dir, { recursive: true });
}

function isoTimestamp(): string {
	return new Date().toISOString();
}

/**
 * Start a new external trace session.
 * Writes the session header to a new JSONL file in ~/.omp/traces/external/.
 */
export async function beginTrace(sessionId: string, cwd: string, userPrompt: string): Promise<TraceWriter> {
	await ensureDir(TRACE_DIR);
	const filePath = path.join(TRACE_DIR, `${sessionId}.jsonl`);

	const header = JSON.stringify({
		type: "session",
		id: sessionId,
		cwd,
		timestamp: isoTimestamp(),
	});

	const userEntry = JSON.stringify({
		type: "message",
		timestamp: isoTimestamp(),
		message: { role: "user", content: userPrompt },
	});

	await fs.writeFile(filePath, `${header}\n${userEntry}\n`, "utf-8");

	return {
		filePath,
		sessionId,
		async append(line: string) {
			await fs.appendFile(filePath, `${line}\n`, "utf-8");
		},
	};
}

/**
 * Record a tool call event to the trace file.
 */
export async function recordToolCall(writer: TraceWriter, toolName: string, args: unknown): Promise<void> {
	const line = JSON.stringify({
		type: "message",
		timestamp: isoTimestamp(),
		message: {
			role: "assistant",
			content: [{ type: "toolCall", name: toolName, arguments: args }],
		},
	});
	await writer.append(line);
}

/**
 * Record a tool result event to the trace file.
 */
export async function recordToolResult(
	writer: TraceWriter,
	toolName: string,
	result: unknown,
	isError: boolean,
): Promise<void> {
	const line = JSON.stringify({
		type: "message",
		timestamp: isoTimestamp(),
		message: { role: "toolResult", toolName, content: result, isError },
	});
	await writer.append(line);
}

/**
 * End a trace session with a session_end marker.
 * After this, the file is ready for ingestion by the self-evolution pipeline.
 */
export async function endTrace(
	writer: TraceWriter,
	completedSuccessfully: boolean,
	options?: { toolCallCount?: number; errorCount?: number },
): Promise<void> {
	const line = JSON.stringify({
		type: "session_end",
		timestamp: isoTimestamp(),
		completedSuccessfully,
		toolCallCount: options?.toolCallCount,
		errorCount: options?.errorCount,
	});
	await writer.append(line);
}