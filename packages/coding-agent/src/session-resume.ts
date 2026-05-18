/**
 * Session resume helper: load historical context from episodic store for resumed sessions.
 *
 * When a user resumes a session, this module queries recent episodic events
 * and generates a summary of what was happening, so the agent can pick up
 * where it left off.
 */
import type { Database } from "bun:sqlite";
import { logger } from "@oh-my-pi/pi-utils";

export interface ResumeContext {
	/** Previous session ID */
	previousSessionId: string;
	/** When the previous session ended */
	lastActiveAt: number;
	/** Summary of what the user was working on */
	workSummary: string;
	/** Recent tool calls from the previous session */
	recentTools: string[];
	/** Files that were being modified */
	activeFiles: string[];
	/** Any errors that occurred */
	recentErrors: Array<{ type: string; message: string }>;
	/** Whether the previous session ended successfully */
	completedSuccessfully: boolean;
}

export interface ResumeOptions {
	/** CWD to filter by */
	cwd: string;
	/** Max age of previous session in days (default: 7) */
	maxAgeDays?: number;
	/** Max events to analyze (default: 50) */
	maxEvents?: number;
}

/**
 * Find the most recent session for a given cwd and load its context.
 */
export async function loadResumeContext(db: Database, options: ResumeOptions): Promise<ResumeContext | undefined> {
	const maxAgeMs = (options.maxAgeDays ?? 7) * 24 * 60 * 60 * 1000;
	const since = Date.now() - maxAgeMs;
	const maxEvents = options.maxEvents ?? 50;

	// Find the most recent session_ended event for this cwd
	const sessionRow = db
		.prepare(
			`SELECT session_id, timestamp, event_data
			FROM episodic_records
			WHERE cwd = ? AND event_type = 'session_ended' AND timestamp >= ? AND archived = 0
			ORDER BY timestamp DESC LIMIT 1`,
		)
		.get(options.cwd, since) as { session_id: string; timestamp: number; event_data: string } | undefined;

	if (!sessionRow) return undefined;

	const sessionData = JSON.parse(sessionRow.event_data) as {
		toolCallCount?: number;
		errorCount?: number;
		hadRecovery?: boolean;
		completedSuccessfully?: boolean;
		durationMs?: number;
	};

	// Load recent events from that session
	const events = db
		.prepare(
			`SELECT event_type, event_data
			FROM episodic_records
			WHERE session_id = ? AND archived = 0
			ORDER BY timestamp DESC LIMIT ?`,
		)
		.all(sessionRow.session_id, maxEvents) as Array<{ event_type: string; event_data: string }>;

	const recentTools: string[] = [];
	const activeFiles = new Set<string>();
	const recentErrors: Array<{ type: string; message: string }> = [];

	for (const event of events) {
		const data = JSON.parse(event.event_data) as Record<string, unknown>;

		if (event.event_type === "tool_called") {
			const toolName = data.toolName as string | undefined;
			if (toolName && !recentTools.includes(toolName)) {
				recentTools.push(toolName);
			}
			const path = data.path as string | undefined;
			if (path) activeFiles.add(path);
		}

		if (event.event_type === "error_occurred") {
			recentErrors.push({
				type: (data.errorType as string) ?? "unknown",
				message: (data.message as string) ?? "",
			});
		}
	}

	// Build work summary
	const parts: string[] = [];
	parts.push(`Previous session had ${sessionData.toolCallCount ?? 0} tool calls`);
	if (sessionData.errorCount) {
		parts.push(`${sessionData.errorCount} error(s)`);
	}
	if (sessionData.hadRecovery) {
		parts.push("agent recovered from errors");
	}
	if (!sessionData.completedSuccessfully) {
		parts.push("session ended prematurely");
	}

	return {
		previousSessionId: sessionRow.session_id,
		lastActiveAt: sessionRow.timestamp,
		workSummary: parts.join(", "),
		recentTools: recentTools.slice(0, 10),
		activeFiles: Array.from(activeFiles).slice(0, 10),
		recentErrors: recentErrors.slice(0, 5),
		completedSuccessfully: sessionData.completedSuccessfully ?? false,
	};
}

/**
 * Format resume context as a markdown summary for the user.
 */
export function formatResumeContext(ctx: ResumeContext): string {
	const lines: string[] = [
		"## Resumed Session Context",
		"",
		`Previous session ended ${Math.round((Date.now() - ctx.lastActiveAt) / (60 * 60 * 1000))} hours ago.`,
		"",
		"### What you were working on",
		ctx.workSummary,
		"",
	];

	if (ctx.activeFiles.length > 0) {
		lines.push("### Active files", ...ctx.activeFiles.map(f => `- ${f}`), "");
	}

	if (ctx.recentTools.length > 0) {
		lines.push("### Recent tools", ...ctx.recentTools.map(t => `- ${t}`), "");
	}

	if (ctx.recentErrors.length > 0) {
		lines.push("### Recent errors");
		for (const err of ctx.recentErrors) {
			lines.push(`- ${err.type}: ${err.message}`);
		}
		lines.push("");
	}

	if (!ctx.completedSuccessfully) {
		lines.push(
			"> Note: The previous session did not complete successfully. You may want to review what was left unfinished.",
		);
	}

	return lines.join("\n");
}

/**
 * Main entry point: attempt to load and format resume context.
 */
export async function getResumeSummary(db: Database, options: ResumeOptions): Promise<string | undefined> {
	try {
		const ctx = await loadResumeContext(db, options);
		if (!ctx) return undefined;
		return formatResumeContext(ctx);
	} catch (err) {
		logger.warn("Failed to load resume context", { error: String(err), cwd: options.cwd });
		return undefined;
	}
}
