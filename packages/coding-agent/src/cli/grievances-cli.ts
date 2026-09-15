/**
 * CLI handler for `omp grievances` — view reported tool issues from auto-QA.
 */
import { Database } from "bun:sqlite";
import chalk from "chalk";
import { getAutoQaDbPath } from "../tools/report-tool-issue";

interface GrievanceRow {
	id: number;
	model: string;
	version: string;
	tool: string;
	report: string;
	/** Epoch ms; NULL for rows filed before the column existed. */
	createdAt: number | null;
	/** Session that filed it; NULL for rows filed before the column existed. */
	sessionId: string | null;
}

export interface ListGrievancesOptions {
	limit: number;
	tool?: string;
	json: boolean;
	/** Only rows filed at/after this cutoff: a duration (`7d`, `36h`, `90m`, `2w`) or a date (`2026-09-01`). */
	since?: string;
	/** Emit a markdown digest (counts by tool + one section per report) instead of the plain list. */
	markdown?: boolean;
}

const DURATION_UNITS_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
const SINCE_DURATION = /^(\d+)\s*([mhdw])$/i;
// A bare number is not a date `Date.parse` can be trusted with (`"7"` parses as
// a year), and it is the shape a missing unit takes — reject it as such.
const SINCE_BARE_NUMBER = /^\d+$/;

function unrecognizedSince(raw: string): Error {
	return new Error(`Unrecognized --since value "${raw}". Use a duration (7d, 36h, 90m, 2w) or a date (2026-09-01).`);
}

/**
 * Resolve `--since` to an epoch-ms cutoff: a duration is relative to `now`,
 * anything else must be a date/timestamp `Date.parse` understands. Throws on an
 * unrecognized value — a silently dropped cutoff would show stale rows and look
 * like a real answer.
 */
export function parseSinceCutoff(raw: string, now: number = Date.now()): number {
	const value = raw.trim();
	const duration = SINCE_DURATION.exec(value);
	if (duration) {
		return now - Number(duration[1]) * DURATION_UNITS_MS[duration[2]!.toLowerCase()]!;
	}
	if (SINCE_BARE_NUMBER.test(value)) throw unrecognizedSince(raw);
	const parsed = Date.parse(value);
	if (Number.isNaN(parsed)) throw unrecognizedSince(raw);
	return parsed;
}

function openDb(): Database | null {
	try {
		return new Database(getAutoQaDbPath(), { readonly: true });
	} catch {
		return null;
	}
}

function tableColumns(db: Database): Set<string> {
	return new Set(
		(db.prepare("PRAGMA table_info(grievances)").all() as Array<{ name?: unknown }>).map(row => String(row.name)),
	);
}

function timestamp(ms: number | null): string {
	return ms === null ? "no timestamp" : new Date(ms).toISOString();
}

/**
 * Rows a time-ranged query cannot match: without the column every row is
 * untimed, otherwise only the ones filed before it existed.
 */
function countUntimed(db: Database, hasTimestamps: boolean): number {
	const sql = hasTimestamps
		? "SELECT COUNT(*) AS n FROM grievances WHERE createdAt IS NULL"
		: "SELECT COUNT(*) AS n FROM grievances";
	return Number((db.prepare(sql).get() as { n?: unknown } | null)?.n ?? 0);
}

export interface MarkdownDigestInput {
	rows: GrievanceRow[];
	/** Human-readable range, e.g. `since 2026-09-08T00:00:00.000Z (--since 7d)`. */
	rangeLabel: string;
	/** Rows excluded from a time-ranged digest because they carry no timestamp. */
	untimedCount: number;
}

/** Render the digest used as the "get these in front of a human" exit. */
export function renderGrievancesMarkdown(input: MarkdownDigestInput): string {
	const lines: string[] = [`# Auto-QA grievances — ${input.rangeLabel}`, ""];
	if (input.rows.length === 0) {
		lines.push("No reports in range.", "");
	} else {
		const counts = new Map<string, number>();
		for (const row of input.rows) counts.set(row.tool, (counts.get(row.tool) ?? 0) + 1);
		const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
		lines.push(`${input.rows.length} reports · ${ranked.length} tools`, "", "| tool | reports |", "|---|---|");
		for (const [tool, count] of ranked) lines.push(`| ${tool} | ${count} |`);
		lines.push("");
		// Oldest first: a digest is read as a story, not as a feed.
		for (const row of [...input.rows].reverse()) {
			lines.push(`## #${row.id} ${row.tool}`, "");
			lines.push(`- when: ${timestamp(row.createdAt)}`);
			lines.push(`- model: ${row.model} (v${row.version})`);
			lines.push(`- session: ${row.sessionId ?? "unknown"}`, "");
			lines.push(row.report.trim(), "");
		}
	}
	if (input.untimedCount > 0) {
		lines.push(
			`_${input.untimedCount} report(s) carry no timestamp and are excluded from a time-ranged digest._`,
			"",
		);
	}
	return `${lines.join("\n").trimEnd()}\n`;
}

export async function listGrievances(options: ListGrievancesOptions): Promise<void> {
	if (options.json && options.markdown) {
		throw new Error("--json and --markdown are mutually exclusive.");
	}
	const db = openDb();
	if (!db) {
		if (options.json) {
			console.log("[]");
		} else {
			console.log(
				chalk.dim("No grievances database found. Enable auto-QA with PI_AUTO_QA=1 or the dev.autoqa setting."),
			);
		}
		return;
	}

	try {
		const columns = tableColumns(db);
		// A database that predates the added columns has no timestamps to select;
		// read them as NULL instead of failing the whole command.
		const hasTimestamps = columns.has("createdAt") && columns.has("sessionId");
		const selected = hasTimestamps ? "createdAt, sessionId" : "NULL AS createdAt, NULL AS sessionId";

		const cutoff = options.since ? parseSinceCutoff(options.since) : null;
		const filters: string[] = [];
		const params: Array<string | number> = [];
		if (options.tool) {
			filters.push("tool = ?");
			params.push(options.tool);
		}
		if (cutoff !== null) {
			filters.push("createdAt >= ?");
			params.push(cutoff);
		}
		const where = filters.length > 0 ? ` WHERE ${filters.join(" AND ")}` : "";

		const rows = db
			.prepare(
				`SELECT id, model, version, tool, report, ${selected} FROM grievances${where} ORDER BY id DESC LIMIT ?`,
			)
			.all(...params, options.limit) as GrievanceRow[];

		// Rows filed before the timestamp column can never match --since; say how
		// many were skipped rather than let an empty range look like "all quiet".
		const untimedCount = cutoff !== null ? countUntimed(db, hasTimestamps) : 0;

		if (options.json) {
			console.log(JSON.stringify(rows, null, 2));
			return;
		}

		if (options.markdown) {
			const rangeLabel =
				cutoff === null ? "all reports" : `since ${new Date(cutoff).toISOString()} (--since ${options.since})`;
			console.log(renderGrievancesMarkdown({ rows, rangeLabel, untimedCount }));
			return;
		}

		if (rows.length === 0) {
			// An empty window is not the same statement as an empty database.
			console.log(chalk.dim(cutoff === null ? "No grievances recorded yet." : "No reports in that window."));
			if (untimedCount > 0) {
				console.log(chalk.dim(`${untimedCount} record(s) have no timestamp and were excluded.`));
			}
			return;
		}

		for (const row of rows) {
			const meta = [row.model, `v${row.version}`, timestamp(row.createdAt), row.sessionId ?? "unknown session"].join(
				" · ",
			);
			console.log(`${chalk.dim(`#${row.id}`)} ${chalk.cyan(row.tool)} ${chalk.dim(`(${meta})`)}`);
			console.log(`  ${row.report}`);
			console.log();
		}

		console.log(chalk.dim(`Showing ${rows.length} most recent${options.tool ? ` for ${options.tool}` : ""}`));
		if (untimedCount > 0) {
			console.log(chalk.dim(`${untimedCount} record(s) have no timestamp and were excluded.`));
		}
	} finally {
		db.close();
	}
}
