/**
 * Structured cron run diagnostics.
 *
 * Replaces raw text stderr/exitCode tracking with typed diagnostic entries
 * collected throughout a cron execution. Each entry carries a source (which
 * subsystem produced it), severity, timestamp, and message. Diagnostics are
 * accumulated in-memory during onTrigger() and written atomically to JSONL
 * at the end of execution, guaranteeing no intermediate-state loss.
 *
 * Design follows OpenClaw's CronRunDiagnostics pattern:
 * - normalizeCronRunDiagnostics: validates and bounds untrusted input
 * - summarizeCronRunDiagnostics: extracts the most severe message as summary
 * - mergeCronRunDiagnostics: combines multiple diagnostic sets into one
 * - createDiagnosticFromError: constructs a single-entry diagnostic from an Error
 */

import * as fs from "node:fs";
import { isEnoent } from "@oh-my-pi/pi-utils";

export type CronRunDiagnosticSource =
	| "cron-preflight" // 任务定义/配置校验
	| "cron-setup" // 启动/预热/Operator 取消
	| "model-preflight" // 模型/Provider 预检
	| "agent-run" // Agent 执行异常/超时
	| "tool" // 工具调用失败
	| "exec" // Subprocess 执行失败
	| "delivery" // 结果投递失败
	| "cron-debug"; // 调试用 override（如 forceFail）

export type CronRunDiagnosticSeverity = "info" | "warn" | "error";

export interface CronRunDiagnosticEntry {
	ts: number;
	source: CronRunDiagnosticSource;
	severity: CronRunDiagnosticSeverity;
	message: string;
	toolName?: string;
	exitCode?: number | null;
	truncated?: boolean;
}

export interface CronRunDiagnostics {
	summary?: string;
	entries: CronRunDiagnosticEntry[];
}

const MAX_ENTRIES = 10;
const MAX_ENTRY_CHARS = 1_000;
const MAX_SUMMARY_CHARS = 2_000;

function normalizeSeverity(value: unknown): CronRunDiagnosticSeverity {
	if (value === "info" || value === "warn" || value === "error") return value;
	return "error";
}

function normalizeSource(value: unknown): CronRunDiagnosticSource {
	switch (value) {
		case "cron-preflight":
		case "cron-setup":
		case "model-preflight":
		case "agent-run":
		case "tool":
		case "exec":
		case "delivery":
			return value;
		default:
			return "agent-run";
	}
}

function normalizeTimestamp(value: unknown, nowMs: () => number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : nowMs();
}

function normalizeOptionalString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeDiagnosticMessage(value: unknown): { message?: string; truncated?: boolean } {
	if (typeof value !== "string") return {};
	const normalized = normalizeOptionalString(value);
	if (!normalized) return {};
	if (normalized.length <= MAX_ENTRY_CHARS) {
		return { message: normalized };
	}
	return { message: `${normalized.slice(0, MAX_ENTRY_CHARS - 1)}…`, truncated: true };
}

function trimSummary(value: string | undefined): string | undefined {
	const normalized = normalizeOptionalString(value);
	if (!normalized) return undefined;
	if (normalized.length <= MAX_SUMMARY_CHARS) return normalized;
	return `${normalized.slice(0, MAX_SUMMARY_CHARS - 1)}…`;
}

/** Normalizes untrusted diagnostic payloads into bounded, validated entries. */
export function normalizeCronRunDiagnostics(
	value: unknown,
	opts?: { nowMs?: () => number },
): CronRunDiagnostics | undefined {
	if (!value || typeof value !== "object") return undefined;

	const record = value as { summary?: unknown; entries?: unknown };
	const nowMs = opts?.nowMs ?? Date.now;
	const entriesRaw = Array.isArray(record.entries) ? record.entries : [];

	const entries: CronRunDiagnosticEntry[] = [];
	for (const item of entriesRaw) {
		if (!item || typeof item !== "object") continue;

		const entry = item as Partial<CronRunDiagnosticEntry>;
		const normalized = normalizeDiagnosticMessage(entry.message);
		if (!normalized.message) continue;

		entries.push({
			ts: normalizeTimestamp(entry.ts, nowMs),
			source: normalizeSource(entry.source),
			severity: normalizeSeverity(entry.severity),
			message: normalized.message,
			...(typeof entry.toolName === "string" && entry.toolName.trim() ? { toolName: entry.toolName.trim() } : {}),
			...(typeof entry.exitCode === "number" && Number.isFinite(entry.exitCode)
				? { exitCode: entry.exitCode }
				: entry.exitCode === null
					? { exitCode: null }
					: {}),
			...(normalized.truncated || entry.truncated === true ? { truncated: true } : {}),
		});

		if (entries.length > MAX_ENTRIES) {
			// Keep the latest diagnostics — late failures explain the final
			// result better than setup noise.
			entries.shift();
		}
	}

	const summary =
		typeof record.summary === "string"
			? trimSummary(record.summary)
			: entries.length > 0
				? trimSummary(entries[entries.length - 1]?.message)
				: undefined;

	if (entries.length === 0 && !summary) return undefined;
	return { ...(summary ? { summary } : {}), entries };
}

/** Returns the operator-facing summary for persisted cron diagnostics. */
export function summarizeCronRunDiagnostics(diagnostics: CronRunDiagnostics | undefined): string | undefined {
	if (!diagnostics) return undefined;
	return trimSummary(diagnostics.summary ?? diagnostics.entries[0]?.message);
}

/**
 * Merges multiple diagnostic sets while preferring the highest-severity,
 * most-recent summary text.
 */
export function mergeCronRunDiagnostics(
	...values: Array<CronRunDiagnostics | undefined>
): CronRunDiagnostics | undefined {
	const entries: CronRunDiagnosticEntry[] = [];
	let summaryCandidate: { summary: string; severity: number; order: number } | undefined;

	for (const value of values) {
		const normalized = normalizeCronRunDiagnostics(value);
		if (!normalized) continue;

		const entryCandidate =
			normalized.entries
				.slice()
				.reverse()
				.find(e => e.severity === "error") ??
			normalized.entries
				.slice()
				.reverse()
				.find(e => e.severity === "warn") ??
			normalized.entries
				.slice()
				.reverse()
				.find(e => e.severity === "info");

		const summary = entryCandidate?.message;
		if (summary) {
			const severity = entryCandidate.severity === "error" ? 2 : entryCandidate.severity === "warn" ? 1 : 0;
			const order = entries.length + normalized.entries.length;

			if (
				!summaryCandidate ||
				severity > summaryCandidate.severity ||
				(severity === summaryCandidate.severity && order >= summaryCandidate.order)
			) {
				summaryCandidate = { summary, severity, order };
			}
		}

		entries.push(...normalized.entries);
	}

	return normalizeCronRunDiagnostics({
		...(summaryCandidate ? { summary: summaryCandidate.summary } : {}),
		entries,
	});
}

/** Converts an error into a single-entry structured diagnostic. */
export function createDiagnosticFromError(
	source: CronRunDiagnosticSource,
	error: unknown,
	opts?: {
		severity?: CronRunDiagnosticSeverity;
		nowMs?: () => number;
		toolName?: string;
		exitCode?: number | null;
	},
): CronRunDiagnostics | undefined {
	const message =
		error instanceof Error ? error.message || error.name : typeof error === "string" ? error : String(error);

	return normalizeCronRunDiagnostics(
		{
			summary: message,
			entries: [
				{
					ts: opts?.nowMs?.() ?? Date.now(),
					source,
					severity: opts?.severity ?? "error",
					message,
					toolName: opts?.toolName,
					exitCode: opts?.exitCode,
				},
			],
		},
		{ nowMs: opts?.nowMs },
	);
}

// ---------------------------------------------------------------------------
// Agent session parsing — scan JSONL for tool failures
// ---------------------------------------------------------------------------

/**
 * Read an OMP agent session JSONL file and extract tool failures.
 *
 * The session file is a JSONL where each line is a `SessionEntry`. Lines
 * with `type === "message"` and `message.role === "toolResult"` indicate
 * tool execution results. Entries with `isError === true` (or non-zero
 * `details.exitCode`) represent tool failures.
 *
 * Returns `CronRunDiagnostics` with one `tool` entry per failed tool call,
 * or undefined if the file cannot be read or has no failures.
 */
export function parseAgentSessionForToolFailures(agentSessionPath: string | undefined): CronRunDiagnostics | undefined {
	if (!agentSessionPath) return undefined;

	let content: string;
	try {
		content = fs.readFileSync(agentSessionPath, "utf-8");
	} catch (err) {
		if (isEnoent(err)) {
			return undefined;
		}
		throw err;
	}

	const entries: CronRunDiagnosticEntry[] = [];

	for (const line of content.split("\n")) {
		if (!line.trim()) continue;

		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue; // malformed line, skip
		}

		if (parsed.type !== "message") continue;
		const msg = parsed.message as Record<string, unknown> | undefined;
		if (!msg || msg.role !== "toolResult") continue;

		const toolName = typeof msg.toolName === "string" ? msg.toolName : undefined;
		const isError = msg.isError === true;

		// Also check details.exitCode for cases where isError is false
		// but exit code is non-zero (some tools don't set isError).
		const details = msg.details as Record<string, unknown> | undefined;
		const exitCode =
			typeof details?.exitCode === "number" && Number.isFinite(details.exitCode) ? details.exitCode : undefined;

		const hasFailure = isError || (exitCode !== undefined && exitCode !== 0);
		if (!hasFailure) continue;

		// Build a meaningful message: prefer stderr, then exitCode info.
		const stderrText = typeof details?.stderr === "string" ? details.stderr.trim() : undefined;
		const stdoutText = typeof details?.stdout === "string" ? details.stdout.trim() : undefined;
		let message = `Tool "${toolName ?? "unknown"}" failed`;
		if (exitCode !== undefined) message += ` (exit ${exitCode})`;
		if (stderrText) message += `: ${stderrText.slice(0, 200)}`;
		else if (stdoutText && stderrText === undefined) message += `: ${stdoutText.slice(0, 200)}`;

		entries.push({
			ts: typeof msg.timestamp === "number" ? msg.timestamp : Date.now(),
			source: "tool",
			severity: "error",
			message,
			toolName,
			exitCode,
		});
	}

	if (entries.length === 0) return undefined;

	return normalizeCronRunDiagnostics({
		summary: `${entries.length} tool failure(s)`,
		entries,
	});
}

// ---------------------------------------------------------------------------
// Agent session parsing — extract last N tool calls (any outcome) for context
// ---------------------------------------------------------------------------

/**
 * Compact summary of a single tool call extracted from an OMP agent session
 * JSONL. Used by the cron context prefix (Tier 3) to give the agent a
 * view of what it tried last time, especially when last run failed.
 */
export interface ToolCallSummary {
	toolName: string;
	/** JSON-stringified tool arguments, truncated to 200 chars. Empty string when absent. */
	argsPreview: string;
	/** Joined text content + stderr, truncated to 200 chars. */
	resultPreview: string;
	isError: boolean;
	ts: number;
}

const TOOL_CALL_PREVIEW_MAX_CHARS = 200;

/** Format a {@link ToolCallSummary} as a single-line cron-context entry. */
export function formatToolCallSummary(s: ToolCallSummary): string {
	const tag = s.isError ? " [ERROR]" : "";
	return `[tool: ${s.toolName}] ${s.argsPreview} \u2192 ${JSON.stringify(s.resultPreview)}${tag}`;
}

function safeJsonStringify(value: unknown): string {
	if (value === undefined || value === null) return "";
	try {
		const s = JSON.stringify(value);
		return s ?? "";
	} catch {
		return String(value);
	}
}

function truncatePreview(text: string, max = TOOL_CALL_PREVIEW_MAX_CHARS): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}\u2026`;
}

/**
 * Read an OMP agent session JSONL and return every correlated tool call
 * (any outcome) as {@link ToolCallSummary} entries, in chronological
 * order. Returns undefined when the session file is missing, empty, or
 * unparseable.
 *
 * Correlates `tool_execution_start` events (which carry the tool's input
 * arguments) with `toolResult` messages (which carry the result + error
 * flag) by `toolCallId`. Tool calls that never received a result (e.g.
 * the run was killed mid-flight) are dropped — there is no result to
 * show.
 *
 * **Selection / truncation policy is the caller's responsibility.** This
 * function intentionally returns all correlated calls; the cron context
 * prefix builder (in `cron-service.ts`) decides which slice to surface
 * (error-priority selection + count cap) so that the policy stays in one
 * place. Tests in `scheduler-parse-tool-calls.test.ts` cover the
 * parsing; tests in `scheduler-cron-context-prefix-from-storage.test.ts`
 * cover the selection policy.
 */
export function parseAgentSessionForToolCalls(agentSessionPath: string | undefined): ToolCallSummary[] | undefined {
	if (!agentSessionPath) return undefined;

	let content: string;
	try {
		content = fs.readFileSync(agentSessionPath, "utf-8");
	} catch (err) {
		if (isEnoent(err)) return undefined;
		throw err;
	}

	const argsByToolCallId = new Map<string, unknown>();
	const summaries: ToolCallSummary[] = [];

	for (const line of content.split("\n")) {
		if (!line.trim()) continue;

		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}

		// First pass role: capture tool input args for later correlation.
		// Two formats are emitted depending on the OMP client version:
		//   - legacy `tool_execution_start` event with a flat
		//     { toolCallId, toolName, args } shape
		//   - current `message` event with role=assistant and
		//     content[].type=toolCall entries that carry
		//     { id, name, arguments }
		// Both carry the same correlation key (toolCallId / id) that the
		// toolResult message below uses, so we merge them into the same
		// args map. Without the inline-format branch Tier 3 would
		// silently return no tool calls on every modern session,
		// because the assistant emits the tool_use inline rather than
		// as a separate event.
		if (parsed.type === "tool_execution_start") {
			const toolCallId = typeof parsed.toolCallId === "string" ? parsed.toolCallId : undefined;
			if (toolCallId) argsByToolCallId.set(toolCallId, parsed.args);
			continue;
		}
		if (parsed.type === "message") {
			const msg = parsed.message as Record<string, unknown> | undefined;
			if (msg?.role === "assistant" && Array.isArray(msg.content)) {
				for (const part of msg.content) {
					if (part && typeof part === "object") {
						const p = part as Record<string, unknown>;
						if (p.type === "toolCall" && typeof p.id === "string") {
							argsByToolCallId.set(p.id, p.arguments);
						}
					}
				}
			}
		}

		// Second pass role: collect toolResult messages
		if (parsed.type !== "message") continue;
		const msg = parsed.message as Record<string, unknown> | undefined;
		if (!msg || msg.role !== "toolResult") continue;

		const toolCallId = typeof msg.toolCallId === "string" ? msg.toolCallId : undefined;
		const toolName = typeof msg.toolName === "string" ? msg.toolName : "unknown";
		const isError = msg.isError === true;

		const args = toolCallId !== undefined ? argsByToolCallId.get(toolCallId) : undefined;
		const argsPreview = truncatePreview(safeJsonStringify(args));

		// Build result preview from content text parts + stderr
		const contentArr = Array.isArray(msg.content) ? msg.content : [];
		const textParts: string[] = [];
		for (const part of contentArr) {
			if (part && typeof part === "object") {
				const p = part as Record<string, unknown>;
				if (p.type === "text" && typeof p.text === "string") textParts.push(p.text);
			}
		}
		const details = msg.details as Record<string, unknown> | undefined;
		if (details && typeof details.stderr === "string" && details.stderr.trim()) {
			textParts.push(`[stderr] ${details.stderr.trim()}`);
		}
		const resultPreview = truncatePreview(textParts.join("\n").trim() || "(no output)");

		const ts = typeof msg.timestamp === "number" ? msg.timestamp : Date.now();

		summaries.push({ toolName, argsPreview, resultPreview, isError, ts });
	}

	if (summaries.length === 0) return undefined;
	return summaries;
}
