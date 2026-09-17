/**
 * report_tool_issue — automated QA tool for tracking unexpected tool behavior.
 *
 * Enabled when PI_AUTO_QA=1 or the dev.autoqa setting is on.
 * Always injected into every agent (including subagents) regardless of tool selection.
 * Records grievances to a local SQLite database.
 *
 * A QA side channel must never break the caller's turn, so this tool does not
 * throw — but it does not lie either: when a row cannot be written (or the
 * report targets something this channel does not cover) the result says so
 * instead of reporting a save that never happened.
 *
 * This module owns the grievances database: path, schema, migration and the
 * connection cache are all here so the tool, the `grievances` CLI and any future
 * exporter cannot drift into three different ideas of what the table looks like.
 */

import { Database } from "bun:sqlite";
import path from "node:path";
import type { AgentTool } from "@cornfield/agent";
import { StringEnum } from "@cornfield/ai";
import { $flag, getClientDir, logger, VERSION } from "@cornfield/utils";
import { Type } from "@sinclair/typebox";
import type { Settings } from "..";
import { normalizeToolName } from "./builtin-names";
import type { ToolSession } from "./index";

const TOOL_PARAM_DESCRIPTION = "tool name (built-in tools only)";
/** Reports travel (they are exported and read by humans), so the schema asks for
 *  the failure shape, not the content that happened to be in front of the tool. */
const REPORT_PARAM_DESCRIPTION =
	"unexpected behavior; generic, NEVER PII (paths, file contents, identifiers, prompt text)";

/**
 * `tool` is an enum over the built-ins this session actually constructed, so MCP
 * servers, extensions and typos never enter the table. An empty list means the
 * factory was called without a known active set — fall back to a free string and
 * the legacy "record everything" behaviour.
 */
function buildReportToolIssueParams(activeBuiltinNames: readonly string[]) {
	const names = [...activeBuiltinNames].sort();
	return Type.Object({
		tool:
			names.length > 0
				? StringEnum(names, { description: TOOL_PARAM_DESCRIPTION })
				: Type.String({ description: TOOL_PARAM_DESCRIPTION, examples: ["bash", "read"] }),
		report: Type.String({ description: REPORT_PARAM_DESCRIPTION }),
	});
}

export function isAutoQaEnabled(settings?: Settings): boolean {
	return $flag("PI_AUTO_QA") || !!settings?.get("dev.autoqa");
}

export function getAutoQaDbPath(): string {
	return path.join(getClientDir(), "autoqa.db");
}

const GRIEVANCES_SCHEMA = `
	CREATE TABLE IF NOT EXISTS grievances (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		model TEXT NOT NULL,
		version TEXT NOT NULL,
		tool TEXT NOT NULL,
		report TEXT NOT NULL,
		createdAt INTEGER,
		sessionId TEXT,
		exported INTEGER NOT NULL DEFAULT 0
	);
`;

/**
 * Columns added after the first release. SQLite cannot add a NOT NULL column
 * without a default, so `createdAt`/`sessionId` are nullable and rows written
 * before the upgrade keep NULL — readers must treat "no timestamp" as a real,
 * distinguishable state rather than as epoch 0. `exported` carries a default, so
 * legacy rows are born un-exported and get picked up by the next export.
 */
const ADDED_COLUMNS: ReadonlyArray<readonly [name: string, type: string]> = [
	["createdAt", "INTEGER"],
	["sessionId", "TEXT"],
	["exported", "INTEGER NOT NULL DEFAULT 0"],
];

/** Speeds up the `WHERE exported = 0` scan that drives exports. */
const EXPORTED_INDEX = "CREATE INDEX IF NOT EXISTS grievances_exported_idx ON grievances(exported, id)";

const INSERT_GRIEVANCE =
	"INSERT INTO grievances (model, version, tool, report, createdAt, sessionId) VALUES (?, ?, ?, ?, ?, ?)";

// Keyed by path, not cached blindly: the agent dir can change at runtime
// (`setAgentDir` is used by gateway/serve), and a connection opened for the
// previous agent dir would keep filing reports into the previous agent's
// database.
let cachedDb: { path: string; db: Database } | null = null;

/**
 * Open (and cache) the writable grievances database for the current agent dir,
 * creating and migrating it as needed. Throws when the database is unusable.
 */
export function openAutoQaDb(): Database {
	const dbPath = getAutoQaDbPath();
	if (cachedDb?.path === dbPath) return cachedDb.db;
	// Different path (or none): drop the stale handle instead of writing into the
	// previous agent's database.
	closeAutoQaDb();
	const db = new Database(dbPath);
	db.run("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;");
	db.run(GRIEVANCES_SCHEMA);
	migrateGrievances(db);
	cachedDb = { path: dbPath, db };
	return db;
}

/**
 * Drop the cached connection. Callers that close a handle obtained from
 * `openAutoQaDb` must go through here — closing directly would leave the cache
 * holding a dead handle and hand it to the next caller.
 */
export function closeAutoQaDb(): void {
	const current = cachedDb;
	cachedDb = null;
	try {
		current?.db.close();
	} catch {}
}

/** Read-only handle for listing. Returns null when there is no database yet. */
export function openAutoQaDbReadonly(): Database | null {
	try {
		return new Database(getAutoQaDbPath(), { readonly: true });
	} catch {
		return null;
	}
}

/** Widen a pre-existing table in place; a no-op on databases we just created. */
function migrateGrievances(db: Database): void {
	const existing = new Set(
		(db.prepare("PRAGMA table_info(grievances)").all() as Array<{ name?: unknown }>).map(row => String(row.name)),
	);
	for (const [name, type] of ADDED_COLUMNS) {
		if (!existing.has(name)) db.run(`ALTER TABLE grievances ADD COLUMN ${name} ${type}`);
	}
	db.run(EXPORTED_INDEX);
}

export function createReportToolIssueTool(session: ToolSession, activeBuiltinNames: readonly string[] = []): AgentTool {
	const getModel = () => session.getActiveModelString?.() ?? "unknown";
	// Snapshotted at construction time: the enum the model sees and the runtime
	// guard below are built from the same set, so they cannot disagree.
	const allowedToolNames = new Set(activeBuiltinNames);

	return {
		name: "report_tool_issue",
		label: "Report Tool Issue",
		loadMode: "internal" as const,
		summary: "Records unexpected tool behavior so it can be followed up.",
		strict: false,
		description: "Report unexpected tool behavior for automated QA tracking.",
		parameters: buildReportToolIssueParams(activeBuiltinNames),
		intent: "omit",
		async execute(_toolCallId, rawParams) {
			const params = rawParams as { tool: string; report: string };
			// Legacy spellings (`find`, `search`, `todo_write`) normalize onto the
			// canonical built-in, so an old name is never rejected for being old.
			const canonicalTool = normalizeToolName(params.tool);
			// Models occasionally ignore the enum. This channel only covers the
			// built-ins we ship (MCP servers and extensions are the caller's own
			// configuration), so say so instead of filing a row nobody can act on —
			// and instead of the old silent "Noted, thanks!".
			if (allowedToolNames.size > 0 && !allowedToolNames.has(canonicalTool)) {
				const reason = `"${params.tool}" is not a built-in tool in this session`;
				return {
					content: [{ type: "text", text: `Not recorded: ${reason}. Nothing was saved.` }],
					details: { error: true, reason, tool: params.tool },
				};
			}
			try {
				const db = openAutoQaDb();
				db.prepare(INSERT_GRIEVANCE).run(
					getModel(),
					VERSION,
					canonicalTool,
					params.report,
					Date.now(),
					session.getSessionId?.() ?? null,
				);
			} catch (error) {
				logger.error("Failed to record tool issue", { error });
				const reason = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `Not recorded (${reason}). This report was NOT saved.` }],
					details: { error: true, reason, dbPath: getAutoQaDbPath() },
				};
			}
			return {
				content: [{ type: "text", text: "Noted, thanks!" }],
				details: { recorded: true },
			};
		},
	};
}
