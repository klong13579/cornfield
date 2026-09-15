/**
 * CLI handler for `cornfield grievances` — the auto-QA report store.
 *
 * Actions:
 *   list   (default) — read-only view, optionally time-ranged or as a digest
 *   export           — write a markdown digest of not-yet-exported rows and
 *                      mark exactly those rows exported
 *   clean            — delete rows by id, by tool, or all of them
 */
import type { Database } from "bun:sqlite";
import chalk from "chalk";
import { closeAutoQaDb, openAutoQaDb, openAutoQaDbReadonly } from "../tools/report-tool-issue";

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
	/** 1 once the row has been handed to a consumer (export). */
	exported: number;
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

export interface CleanGrievancesOptions {
	/** Delete a single grievance by id. */
	id?: number;
	/** Delete every grievance recorded for this tool name. */
	tool?: string;
	/** Delete every grievance regardless of tool/id. */
	all?: boolean;
	/** Output the deletion count as JSON instead of a status message. */
	json?: boolean;
}

export interface ExportGrievancesOptions {
	/** Destination file; stdout when omitted. */
	out?: string;
	/** Only rows filed at/after this cutoff. */
	since?: string;
	/** Only rows for this tool. */
	tool?: string;
	/** Cap the number of rows exported. Omitted = every unexported row. */
	limit?: number;
	/** Emit the export result as JSON instead of a status line. */
	json?: boolean;
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

const MISSING_DB_MESSAGE = "No grievances database found. Enable auto-QA with PI_AUTO_QA=1 or the dev.autoqa setting.";

/**
 * Writable handle for the write-shaped actions (`clean`, `export`).
 *
 * A missing database is reported, not created: running these on a machine that
 * never filed a report must not leave an empty file behind. The presence probe is
 * a read-only open — cheaper and more honest than an `exists()` check, which would
 * still race the writer.
 */
function openDbForWrite(): Database | null {
	const probe = openAutoQaDbReadonly();
	if (!probe) return null;
	probe.close();
	try {
		return openAutoQaDb();
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

/**
 * Column list for the read-only listing path. A database written before the
 * added columns existed has none of them; read them as NULL rather than failing
 * the whole command. (Write-shaped actions migrate on open, so they don't need
 * this.)
 */
function selectListColumns(db: Database): string {
	const columns = tableColumns(db);
	const parts = ["id", "model", "version", "tool", "report"];
	parts.push(columns.has("createdAt") ? "createdAt" : "NULL AS createdAt");
	parts.push(columns.has("sessionId") ? "sessionId" : "NULL AS sessionId");
	parts.push(columns.has("exported") ? "exported" : "0 AS exported");
	return parts.join(", ");
}

export interface MarkdownDigestInput {
	rows: GrievanceRow[];
	/** Human-readable range, e.g. `since 2026-09-08T00:00:00.000Z (--since 7d)`. */
	rangeLabel: string;
	/** Rows excluded from a time-ranged digest because they carry no timestamp. */
	untimedCount: number;
}

/** Render the digest used as the "get these in front of a human" exit. Rows are
 *  printed in the order given — callers decide whether a digest reads oldest-first. */
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
		for (const row of input.rows) {
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
	const db = openAutoQaDbReadonly();
	if (!db) {
		if (options.json) {
			console.log("[]");
		} else {
			console.log(chalk.dim(MISSING_DB_MESSAGE));
		}
		return;
	}

	try {
		const hasTimestamps = tableColumns(db).has("createdAt");
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
			.prepare(`SELECT ${selectListColumns(db)} FROM grievances${where} ORDER BY id DESC LIMIT ?`)
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
			// The listing is newest-first (a feed); a digest reads oldest-first (a story).
			console.log(renderGrievancesMarkdown({ rows: [...rows].reverse(), rangeLabel, untimedCount }));
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

/**
 * Delete grievances from the auto-QA database.
 *
 * Selectors are mutually exclusive in intent — exactly one of `id`, `tool`, or
 * `all` is required. Multiple selectors are rejected to prevent ambiguous deletes
 * (e.g. `--id 5 --all` would be a footgun).
 */
export async function cleanGrievances(options: CleanGrievancesOptions): Promise<void> {
	const selectors = [options.id !== undefined, !!options.tool, !!options.all].filter(Boolean).length;
	if (selectors === 0) throw new Error("Specify exactly one of --id, --tool, or --all.");
	if (selectors > 1) throw new Error("--id, --tool, and --all are mutually exclusive.");

	const db = openDbForWrite();
	if (!db) {
		if (options.json) {
			console.log(JSON.stringify({ deleted: 0, reason: "no-database" }));
		} else {
			console.log(chalk.dim(MISSING_DB_MESSAGE));
		}
		return;
	}

	try {
		let deleted = 0;
		if (options.id !== undefined) {
			deleted = Number(db.prepare("DELETE FROM grievances WHERE id = ?").run(options.id).changes);
		} else if (options.tool) {
			deleted = Number(db.prepare("DELETE FROM grievances WHERE tool = ?").run(options.tool).changes);
		} else {
			deleted = Number(db.prepare("DELETE FROM grievances").run().changes);
			// Reset the autoincrement counter so a fresh slate starts at #1 again.
			// `sqlite_sequence` only exists if AUTOINCREMENT was ever used.
			try {
				db.prepare("DELETE FROM sqlite_sequence WHERE name = 'grievances'").run();
			} catch {
				/* sequence table missing on a brand-new db — nothing to reset */
			}
		}

		const scope =
			options.id !== undefined ? `#${options.id}` : options.tool ? `for ${options.tool}` : "(all entries)";
		if (options.json) {
			console.log(JSON.stringify({ deleted, scope }));
			return;
		}
		if (deleted === 0) {
			console.log(chalk.dim(`No matching grievances to delete ${scope}.`));
			return;
		}
		console.log(chalk.green(`Deleted ${deleted} grievance${deleted === 1 ? "" : "s"} ${scope}.`));
	} finally {
		closeAutoQaDb();
	}
}

/**
 * Write a markdown digest of the rows that have not been exported yet and mark
 * exactly those rows exported.
 *
 * The marker is written only after the digest has been produced, so a failed
 * write leaves the rows queued for the next attempt — export is at-least-once,
 * never "dropped because someone redirected stdout to a broken pipe".
 */
export async function exportGrievances(options: ExportGrievancesOptions): Promise<void> {
	// JSON already owns stdout, so the digest needs a destination of its own — and
	// marking rows exported without producing a digest anywhere would be a lie.
	if (options.json && !options.out) {
		throw new Error("--json requires --out: the digest needs a destination, because the JSON result owns stdout.");
	}
	const db = openDbForWrite();
	if (!db) {
		if (options.json) {
			console.log(JSON.stringify({ exported: 0, out: null, reason: "no-database" }));
		} else {
			console.log(chalk.dim(MISSING_DB_MESSAGE));
		}
		return;
	}

	try {
		const hasTimestamps = tableColumns(db).has("createdAt");
		const cutoff = options.since ? parseSinceCutoff(options.since) : null;
		const filters = ["exported = 0"];
		const params: Array<string | number> = [];
		if (options.tool) {
			filters.push("tool = ?");
			params.push(options.tool);
		}
		if (cutoff !== null) {
			filters.push("createdAt >= ?");
			params.push(cutoff);
		}

		const rows = db
			.prepare(
				`SELECT id, model, version, tool, report, createdAt, sessionId, exported FROM grievances
				 WHERE ${filters.join(" AND ")} ORDER BY id ASC LIMIT ?`,
			)
			.all(...params, options.limit ?? -1) as GrievanceRow[];

		// Untimed rows can never match a window; an empty result must say so instead
		// of reading as "nothing new".
		const untimedCount = cutoff === null ? 0 : countUntimed(db, hasTimestamps);

		if (rows.length === 0) {
			if (options.json) {
				console.log(JSON.stringify({ exported: 0, out: options.out ?? null, excludedUntimed: untimedCount }));
			} else {
				console.log(chalk.dim("No new reports to export."));
				if (untimedCount > 0) {
					console.log(chalk.dim(`${untimedCount} report(s) have no timestamp and are excluded by --since.`));
				}
			}
			return;
		}

		const rangeLabel = cutoff === null ? "unexported reports" : `unexported since ${new Date(cutoff).toISOString()}`;
		const digest = renderGrievancesMarkdown({ rows, rangeLabel, untimedCount });

		if (options.out) {
			// Throws on an unwritable destination, which is why it happens before the
			// rows are marked: a failed export must stay queued.
			await Bun.write(options.out, digest);
		} else {
			process.stdout.write(digest);
		}

		const ids = rows.map(row => row.id);
		db.prepare(`UPDATE grievances SET exported = 1 WHERE id IN (${ids.map(() => "?").join(",")})`).run(...ids);

		if (options.json) {
			console.log(JSON.stringify({ exported: rows.length, out: options.out ?? null, ids }));
			return;
		}
		const destination = options.out ? options.out : "stdout";
		console.log(chalk.green(`Exported ${rows.length} report(s) to ${destination}.`));
	} finally {
		closeAutoQaDb();
	}
}
