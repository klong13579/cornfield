import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import type { LogEntry } from "../types";

export type { LogEntry };

export interface EvolutionLogOptions {
	outputDir: string;
	/** Max events per day (default: 100) */
	maxEventsPerDay?: number;
	/** Only include these event types (default: all evolution-related) */
	eventFilter?: Set<string>;
}

const DEFAULT_EVOLUTION_EVENTS = new Set([
	"skill_extracted",
	"skill_merged",
	"skill_deprecated",
	"skill_rolled_back",
	"skill_auto_optimized",
	"skill_optimized",
	"skill_user_rated",
	"conventions_extracted",
	"diagnosis_conventions_extracted",
	"profile_updated",
	"audit_report_generated",
	"episode_archived",
	"workflow_mined",
	"intent_classified",
	"trace_diagnosed",
]);

function formatTime(ts: number): string {
	const d = new Date(ts);
	return d.toTimeString().slice(0, 5); // HH:MM
}

function formatDate(ts: number): string {
	return new Date(ts).toISOString().split("T")[0]!;
}

function renderEvent(entry: LogEntry): string {
	const time = formatTime(entry.timestamp);
	const { event, details } = entry;

	switch (event) {
		case "skill_extracted": {
			const name = details.skillName as string;
			const score = details.qualityScore as number | undefined;
			return `- [${time}] **Skill extracted**: \`${name}\`${score !== undefined ? ` (quality: ${score})` : ""}`;
		}
		case "skill_merged": {
			const name = details.skillName as string;
			const oldV = details.oldVersion as number;
			const newV = details.newVersion as number;
			return `- [${time}] **Skill merged**: \`${name}\` v${oldV} → v${newV}`;
		}
		case "skill_deprecated": {
			const name = details.skillName as string;
			const reason = details.reason as string;
			return `- [${time}] **Skill deprecated**: \`${name}\`${reason ? ` — ${reason}` : ""}`;
		}
		case "skill_rolled_back": {
			const name = details.skillName as string;
			const from = details.fromVersion as number;
			const to = details.toVersion as number;
			return `- [${time}] **Skill rolled back**: \`${name}\` v${from} → v${to}`;
		}
		case "skill_auto_optimized":
		case "skill_optimized": {
			const name = details.skillName as string;
			const score = details.qualityScore as number | undefined;
			return `- [${time}] **Skill optimized**: \`${name}\`${score !== undefined ? ` (quality: ${score})` : ""}`;
		}
		case "skill_user_rated": {
			const name = details.skillName as string;
			const rating = details.rating as number;
			return `- [${time}] **Skill rated**: \`${name}\` — ${rating}/5 stars`;
		}
		case "conventions_extracted": {
			const count = details.count as number;
			return `- [${time}] **Conventions extracted**: ${count} rule(s)`;
		}
		case "diagnosis_conventions_extracted": {
			const count = details.count as number;
			return `- [${time}] **Diagnosis conventions**: ${count} rule(s)`;
		}
		case "profile_updated": {
			const sessions = details.sessionCount as number;
			const topIntent = details.topIntent as string | undefined;
			return `- [${time}] **Profile updated**: ${sessions} sessions${topIntent ? `, top intent: ${topIntent}` : ""}`;
		}
		case "audit_report_generated": {
			const episodes = details.episodeCount as number;
			const skills = details.skillCount as number;
			return `- [${time}] **Audit report**: ${episodes} episodes, ${skills} skills`;
		}
		case "episode_archived": {
			const episodeId = details.episodeId as string;
			return `- [${time}] **Episode archived**: \`${episodeId}\``;
		}
		case "workflow_mined": {
			const intent = details.intent as string;
			const seq = details.sequence as string[];
			return `- [${time}] **Workflow mined**: ${intent} (${seq?.length ?? 0} tools)`;
		}
		case "intent_classified": {
			const intent = details.intent as string;
			const confidence = details.confidence as number;
			return `- [${time}] **Intent classified**: ${intent} (${Math.round(confidence * 100)}%)`;
		}
		case "trace_diagnosed": {
			const fails = details.readFailureCount as number;
			const cascades = details.cascadePatternCount as number;
			return `- [${time}] **Trace diagnosed**: ${fails} read failure(s), ${cascades} cascade pattern(s)`;
		}
		default: {
			const detailStr = Object.entries(details)
				.map(([k, v]) => `${k}=${String(v)}`)
				.join(", ");
			return `- [${time}] **${event}**: ${detailStr}`;
		}
	}
}

/**
 * Read activity log entries from a JSONL file.
 */
export async function readActivityLog(logPath: string): Promise<LogEntry[]> {
	try {
		const text = await Bun.file(logPath).text();
		const lines = text.split("\n").filter(Boolean);
		const entries: LogEntry[] = [];
		for (const line of lines) {
			try {
				entries.push(JSON.parse(line) as LogEntry);
			} catch {
				// skip corrupt line
			}
		}
		return entries;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException)?.code;
		if (code === "ENOENT") return [];
		throw err;
	}
}

/**
 * Group log entries by date.
 */
export function groupByDate(entries: LogEntry[]): Map<string, LogEntry[]> {
	const groups = new Map<string, LogEntry[]>();
	for (const entry of entries) {
		const date = formatDate(entry.timestamp);
		const list = groups.get(date) ?? [];
		list.push(entry);
		groups.set(date, list);
	}
	return groups;
}

/**
 * Generate evolution_log.md content from activity log entries.
 */
export function generateEvolutionLogMd(
	entries: LogEntry[],
	options?: { maxEventsPerDay?: number; eventFilter?: Set<string> },
): string {
	const maxEvents = options?.maxEventsPerDay ?? 100;
	const filter = options?.eventFilter ?? DEFAULT_EVOLUTION_EVENTS;

	const filtered = entries.filter(e => filter.has(e.event));
	if (filtered.length === 0) {
		return "# Evolution Log\n\nNo evolution events recorded yet.\n";
	}

	const byDate = groupByDate(filtered);
	const sortedDates = Array.from(byDate.keys()).sort().reverse();

	const lines: string[] = ["# Evolution Log", "", "Audit timeline of self-evolution events.", ""];

	for (const date of sortedDates) {
		lines.push(`## ${date}`, "");
		const dayEvents = byDate.get(date)!.sort((a, b) => b.timestamp - a.timestamp);
		const visible = dayEvents.slice(0, maxEvents);
		for (const entry of visible) {
			lines.push(renderEvent(entry));
		}
		if (dayEvents.length > maxEvents) {
			lines.push(`_... and ${dayEvents.length - maxEvents} more events_`);
		}
		lines.push("");
	}

	lines.push("---", `*Generated on ${new Date().toISOString()} | ${filtered.length} events*`);
	return lines.join("\n");
}

/**
 * Main entry point: read activity log and write evolution_log.md.
 */
export async function projectEvolutionLog(logPath: string, options: EvolutionLogOptions): Promise<string> {
	const entries = await readActivityLog(logPath);
	const md = generateEvolutionLogMd(entries, {
		maxEventsPerDay: options.maxEventsPerDay,
		eventFilter: options.eventFilter,
	});

	const outPath = path.join(options.outputDir, "evolution_log.md");
	await Bun.write(outPath, md);

	logger.debug("Evolution log projected", {
		path: outPath,
		events: entries.length,
	});

	return outPath;
}

/**
 * Append a single audit event as a JSONL line to the activity log file.
 *
 * Reuses the same JSONL format as `readActivityLog`: one JSON object per line
 * with keys `timestamp`, `event`, and `details`.
 */
export async function appendAuditEntry(
	logPath: string,
	event: string,
	details: Record<string, unknown>,
): Promise<void> {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const fs = require("node:fs");
	// Ensure parent directory exists (Bun.write auto-creates it, but appendFileSync doesn't)
	fs.mkdirSync(path.dirname(logPath), { recursive: true });
	const entry = JSON.stringify({
		timestamp: Date.now(),
		event,
		details,
	});
	fs.appendFileSync(logPath, `${entry}\n`);
}
