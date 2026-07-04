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
	| "delivery"; // 结果投递失败

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
