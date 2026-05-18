/**
 * Persist full session traces for regression replay.
 */
import type { Database } from "bun:sqlite";
import type { SessionTrace } from "../types";

export class SqliteSessionTraceStore {
	#db: Database;

	constructor(db: Database) {
		this.#db = db;
	}

	async upsert(trace: SessionTrace, episodeId: string): Promise<void> {
		const stmt = this.#db.prepare(`
			INSERT INTO session_traces (
				session_id, episode_id, cwd, trace_json, error_count,
				completed_successfully, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(session_id) DO UPDATE SET
				episode_id = excluded.episode_id,
				trace_json = excluded.trace_json,
				error_count = excluded.error_count,
				completed_successfully = excluded.completed_successfully,
				created_at = excluded.created_at
		`);
		stmt.run(
			trace.sessionId,
			episodeId,
			trace.cwd,
			JSON.stringify(trace),
			trace.errorCount,
			trace.completedSuccessfully ? 1 : 0,
			Date.now(),
		);
		stmt.finalize();
	}

	async getBySessionId(sessionId: string): Promise<SessionTrace | undefined> {
		const stmt = this.#db.prepare("SELECT trace_json FROM session_traces WHERE session_id = ?");
		const row = stmt.get(sessionId) as { trace_json: string } | undefined;
		stmt.finalize();
		if (!row) return undefined;
		return JSON.parse(row.trace_json) as SessionTrace;
	}
}
