/**
 * Add 'agent_written' to learnings source CHECK constraint.
 *
 * write-memory-tool writes with source='agent_written' but the DB constraint
 * only allowed 'user_explicit','session_llm','manual_pin'. This migration
 * recreates the table with the updated constraint.
 */
import type { Database } from "bun:sqlite";

function _tableHasColumn(db: Database, table: string, column: string): boolean {
	const row = db
		.prepare(`PRAGMA table_info(${table})`)
		.all()
		.find((r: unknown) => (r as { name: string }).name === column);
	return !!row;
}

export function migrateAddAgentWrittenSource(db: Database): void {
	// Check if migration is already done by looking for 'agent_written' in the CHECK constraint
	// Since SQLite doesn't expose DDL directly, check if any row uses the new value
	const existing = db.prepare("SELECT 1 FROM learnings WHERE source = 'agent_written' LIMIT 1").get() as
		| { "1": number }
		| undefined;
	if (existing) return;

	const fkWasOn = (db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys === 1;
	db.exec("PRAGMA foreign_keys = OFF");
	try {
		db.exec(`
			CREATE TABLE learnings_new (
				id TEXT PRIMARY KEY,
				cwd TEXT NOT NULL,
				kind TEXT NOT NULL CHECK(kind IN ('preference','fact','procedure','skill_hint')),
				content TEXT NOT NULL,
				source TEXT NOT NULL CHECK(source IN ('user_explicit','session_llm','manual_pin','agent_written')),
				confidence INTEGER NOT NULL CHECK(confidence BETWEEN 1 AND 5),
				lifecycle TEXT NOT NULL DEFAULT 'candidate' CHECK(lifecycle IN ('candidate','active','archived')),
				session_id TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				times_injected INTEGER NOT NULL DEFAULT 0,
				times_helped INTEGER NOT NULL DEFAULT 0,
				times_ignored INTEGER NOT NULL DEFAULT 0,
				scope TEXT NOT NULL DEFAULT 'project' CHECK(scope IN ('global','project','ephemeral'))
			);
			INSERT INTO learnings_new (
				id, cwd, kind, content, source, confidence, lifecycle, session_id,
				created_at, updated_at, times_injected, times_helped, times_ignored, scope
			)
			SELECT
				id, cwd, kind, content, source, confidence, lifecycle, session_id,
				created_at, updated_at, times_injected, times_helped, times_ignored, scope
			FROM learnings;
			DROP TABLE learnings;
			ALTER TABLE learnings_new RENAME TO learnings;
		`);
	} finally {
		// Recreate indexes that were dropped with the table
		db.exec(`
			CREATE INDEX IF NOT EXISTS idx_learnings_cwd_lifecycle ON learnings(cwd, lifecycle);
			CREATE INDEX IF NOT EXISTS idx_learnings_cwd_kind ON learnings(cwd, kind);
			CREATE INDEX IF NOT EXISTS idx_learnings_source ON learnings(source);
		`);
		db.exec(fkWasOn ? "PRAGMA foreign_keys = ON" : "PRAGMA foreign_keys = OFF");
	}
}
