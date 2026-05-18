/**
 * Storage dedup migrations: drop duplicated columns after backfill where needed.
 */
import type { Database } from "bun:sqlite";
import { sliceTraceEntriesForFixture } from "../../regression/fixture-entries";
import type { SessionTrace, TraceEntry } from "../../types";

function tableHasColumn(db: Database, table: string, column: string): boolean {
	const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
	return rows.some(r => r.name === column);
}

function backfillSessionTracesFromLegacyFixtureEntries(db: Database): void {
	if (!tableHasColumn(db, "regression_fixtures", "entries_json")) return;

	const stmt = db.prepare(`
		SELECT rf.session_id, rf.episode_id, rf.cwd, rf.user_prompt, rf.error_count,
			rf.completed_successfully, rf.entries_json, rf.created_at
		FROM regression_fixtures rf
		LEFT JOIN session_traces st ON st.session_id = rf.session_id
		WHERE st.session_id IS NULL
			AND rf.entries_json IS NOT NULL
			AND rf.entries_json != '[]'
			AND length(rf.entries_json) > 2
	`);
	const rows = stmt.all() as Array<{
		session_id: string;
		episode_id: string;
		cwd: string;
		user_prompt: string;
		error_count: number;
		completed_successfully: number;
		entries_json: string;
		created_at: number;
	}>;
	stmt.finalize();

	const insert = db.prepare(`
		INSERT INTO session_traces (
			session_id, episode_id, cwd, trace_json, error_count,
			completed_successfully, created_at
		) VALUES (?, ?, ?, ?, ?, ?, ?)
	`);

	for (const row of rows) {
		let entries: TraceEntry[];
		try {
			entries = JSON.parse(row.entries_json) as TraceEntry[];
			if (!Array.isArray(entries)) continue;
		} catch {
			continue;
		}

		const toolCallCount = entries.filter(e => e.type === "tool_call").length;
		let sawError = false;
		let sawSuccessAfterError = false;
		for (const entry of entries) {
			if (entry.type === "tool_result" && entry.isError) {
				sawError = true;
			} else if (sawError && entry.type === "tool_result" && !entry.isError) {
				sawSuccessAfterError = true;
			}
		}

		const trace: SessionTrace = {
			sessionId: row.session_id,
			cwd: row.cwd,
			userPrompt: row.user_prompt,
			startTime: row.created_at,
			endTime: row.created_at,
			toolCallCount,
			errorCount: row.error_count,
			hadRecovery: sawSuccessAfterError,
			completedSuccessfully: row.completed_successfully === 1,
			entries,
		};
		const sliced = sliceTraceEntriesForFixture(trace);
		const stored: SessionTrace = { ...trace, entries: sliced };

		insert.run(
			row.session_id,
			row.episode_id,
			row.cwd,
			JSON.stringify(stored),
			row.error_count,
			row.completed_successfully,
			row.created_at,
		);
	}
	insert.finalize();
}

export function migrateRegressionFixturesDropEntriesJson(db: Database): void {
	if (!tableHasColumn(db, "regression_fixtures", "entries_json")) return;

	backfillSessionTracesFromLegacyFixtureEntries(db);

	const fkWasOn = (db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys === 1;
	db.exec("PRAGMA foreign_keys = OFF");
	try {
		db.exec(`
			CREATE TABLE regression_fixtures_new (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				episode_id TEXT NOT NULL,
				cwd TEXT NOT NULL,
				user_prompt TEXT NOT NULL,
				error_count INTEGER NOT NULL DEFAULT 0,
				completed_successfully INTEGER NOT NULL DEFAULT 0,
				dominant_error_tool TEXT,
				dominant_error_pattern TEXT,
				created_at INTEGER NOT NULL
			);
			INSERT INTO regression_fixtures_new (
				id, session_id, episode_id, cwd, user_prompt, error_count,
				completed_successfully, dominant_error_tool, dominant_error_pattern, created_at
			)
			SELECT
				id, session_id, episode_id, cwd, user_prompt, error_count,
				completed_successfully, dominant_error_tool, dominant_error_pattern, created_at
			FROM regression_fixtures;
			DROP TABLE regression_fixtures;
			ALTER TABLE regression_fixtures_new RENAME TO regression_fixtures;
		`);
	} finally {
		db.exec(fkWasOn ? "PRAGMA foreign_keys = ON" : "PRAGMA foreign_keys = OFF");
	}
}

export function migrateSkillPopulationDropContent(db: Database): void {
	if (!tableHasColumn(db, "skill_population", "content")) return;

	const fkWasOn = (db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys === 1;
	db.exec("PRAGMA foreign_keys = OFF");
	try {
		db.exec(`
			CREATE TABLE skill_population_new (
				name TEXT PRIMARY KEY,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				usage_count INTEGER NOT NULL DEFAULT 0,
				success_rate REAL NOT NULL DEFAULT 0,
				state TEXT NOT NULL DEFAULT 'candidate' CHECK(state IN ('candidate', 'experimental', 'graduated', 'deprecated', 'archived')),
				evolution_score INTEGER NOT NULL DEFAULT 0,
				last_evaluated_at INTEGER,
				next_evaluation_at INTEGER,
				quality_metrics_json TEXT,
				evolution_history_json TEXT
			);
			INSERT INTO skill_population_new (
				name, created_at, updated_at, usage_count, success_rate, state,
				evolution_score, last_evaluated_at, next_evaluation_at,
				quality_metrics_json, evolution_history_json
			)
			SELECT
				name, created_at, updated_at, usage_count, success_rate, state,
				evolution_score, last_evaluated_at, next_evaluation_at,
				quality_metrics_json, evolution_history_json
			FROM skill_population;
			DROP TABLE skill_population;
			ALTER TABLE skill_population_new RENAME TO skill_population;
		`);
	} finally {
		db.exec(fkWasOn ? "PRAGMA foreign_keys = ON" : "PRAGMA foreign_keys = OFF");
	}
}

export function runStorageDedupMigrations(db: Database): void {
	migrateRegressionFixturesDropEntriesJson(db);
	migrateSkillPopulationDropContent(db);
}
