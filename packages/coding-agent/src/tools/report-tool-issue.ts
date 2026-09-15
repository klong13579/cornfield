/**
 * report_tool_issue — automated QA tool for tracking unexpected tool behavior.
 *
 * Enabled when PI_AUTO_QA=1 or the dev.autoqa setting is on.
 * Always injected into every agent (including subagents) regardless of tool selection.
 * Records grievances to a local SQLite database.
 *
 * A QA side channel must never break the caller's turn, so this tool does not
 * throw — but it does not lie either: when the row cannot be written the result
 * says so (`details.error` + the reason) instead of reporting a save that never
 * happened.
 */
import { Database } from "bun:sqlite";
import path from "node:path";
import type { AgentTool } from "@cornfield/agent";
import { $flag, getAgentDir, logger, VERSION } from "@cornfield/utils";
import { Type } from "@sinclair/typebox";
import type { Settings } from "..";
import type { ToolSession } from "./index";

const ReportToolIssueParams = Type.Object({
	tool: Type.String({ description: "tool name", examples: ["bash", "read"] }),
	report: Type.String({ description: "unexpected behavior" }),
});

export function isAutoQaEnabled(settings?: Settings): boolean {
	return $flag("PI_AUTO_QA") || !!settings?.get("dev.autoqa");
}

export function getAutoQaDbPath(): string {
	return path.join(getAgentDir(), "autoqa.db");
}

const GRIEVANCES_SCHEMA = `
	CREATE TABLE IF NOT EXISTS grievances (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		model TEXT NOT NULL,
		version TEXT NOT NULL,
		tool TEXT NOT NULL,
		report TEXT NOT NULL,
		createdAt INTEGER,
		sessionId TEXT
	);
`;

/**
 * Columns added after the first release. SQLite cannot add a NOT NULL column
 * without a default, so both are nullable and rows written before the upgrade
 * keep NULL — readers must treat "no timestamp" as a real, distinguishable
 * state rather than as epoch 0.
 */
const ADDED_COLUMNS: ReadonlyArray<readonly [name: string, type: string]> = [
	["createdAt", "INTEGER"],
	["sessionId", "TEXT"],
];

const INSERT_GRIEVANCE =
	"INSERT INTO grievances (model, version, tool, report, createdAt, sessionId) VALUES (?, ?, ?, ?, ?, ?)";

// Keyed by path, not cached blindly: the agent dir can change at runtime
// (`setAgentDir` is used by gateway/serve), and a connection opened for the
// previous agent dir would keep filing reports into the previous agent's
// database.
let cachedDb: { path: string; db: Database } | null = null;

/** Open the grievances database for the current agent dir. Throws on failure. */
function openDb(): Database {
	const dbPath = getAutoQaDbPath();
	if (cachedDb?.path === dbPath) return cachedDb.db;
	if (cachedDb) {
		try {
			cachedDb.db.close();
		} catch {}
		cachedDb = null;
	}
	const db = new Database(dbPath);
	db.run("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;");
	db.run(GRIEVANCES_SCHEMA);
	migrateGrievances(db);
	cachedDb = { path: dbPath, db };
	return db;
}

/** Widen a pre-existing table in place; a no-op on databases we just created. */
function migrateGrievances(db: Database): void {
	const existing = new Set(
		(db.prepare("PRAGMA table_info(grievances)").all() as Array<{ name?: unknown }>).map(row => String(row.name)),
	);
	for (const [name, type] of ADDED_COLUMNS) {
		if (!existing.has(name)) db.run(`ALTER TABLE grievances ADD COLUMN ${name} ${type}`);
	}
}

export function createReportToolIssueTool(session: ToolSession): AgentTool {
	const getModel = () => session.getActiveModelString?.() ?? "unknown";

	return {
		name: "report_tool_issue",
		label: "Report Tool Issue",
		loadMode: "internal" as const,
		summary: "Records unexpected tool behavior so it can be followed up.",
		strict: false,
		description: "Report unexpected tool behavior for automated QA tracking.",
		parameters: ReportToolIssueParams,
		intent: "omit",
		async execute(_toolCallId, rawParams) {
			const params = rawParams as { tool: string; report: string };
			try {
				const db = openDb();
				db.prepare(INSERT_GRIEVANCE).run(
					getModel(),
					VERSION,
					params.tool,
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
