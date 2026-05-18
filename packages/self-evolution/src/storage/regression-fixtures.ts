/**
 * Regression fixtures derived from failed sessions.
 * Tool entries are hydrated from session_traces at read time.
 */
import type { Database } from "bun:sqlite";
import { loadFixtureEntriesFromDb } from "../regression/fixture-entries";
import type { RegressionFixture } from "../types";

interface RawFixtureRow {
	id: string;
	session_id: string;
	episode_id: string;
	cwd: string;
	user_prompt: string;
	error_count: number;
	completed_successfully: number;
	dominant_error_tool: string | null;
	dominant_error_pattern: string | null;
	created_at: number;
}

export class SqliteRegressionFixtureStore {
	#db: Database;

	constructor(db: Database) {
		this.#db = db;
	}

	async insert(fixture: RegressionFixture): Promise<void> {
		const stmt = this.#db.prepare(`
			INSERT OR REPLACE INTO regression_fixtures (
				id, session_id, episode_id, cwd, user_prompt, error_count,
				completed_successfully, dominant_error_tool, dominant_error_pattern,
				created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		stmt.run(
			fixture.id,
			fixture.sessionId,
			fixture.episodeId,
			fixture.cwd,
			fixture.userPrompt,
			fixture.errorCount,
			fixture.completedSuccessfully ? 1 : 0,
			fixture.dominantErrorTool ?? null,
			fixture.dominantErrorPattern ?? null,
			fixture.createdAt,
		);
		stmt.finalize();
	}

	async listRecent(limit: number): Promise<RegressionFixture[]> {
		const stmt = this.#db.prepare("SELECT * FROM regression_fixtures ORDER BY created_at DESC LIMIT ?");
		const rows = stmt.all(limit) as RawFixtureRow[];
		stmt.finalize();
		return rows.map(row => this.#rowToFixture(row));
	}

	async listAll(): Promise<RegressionFixture[]> {
		const stmt = this.#db.prepare("SELECT * FROM regression_fixtures ORDER BY created_at DESC");
		const rows = stmt.all() as RawFixtureRow[];
		stmt.finalize();
		return rows.map(row => this.#rowToFixture(row));
	}

	async updateDominantError(id: string, dominantErrorTool?: string, dominantErrorPattern?: string): Promise<void> {
		const stmt = this.#db.prepare(`
			UPDATE regression_fixtures
			SET dominant_error_tool = ?, dominant_error_pattern = ?
			WHERE id = ?
		`);
		stmt.run(dominantErrorTool ?? null, dominantErrorPattern ?? null, id);
		stmt.finalize();
	}

	async listForErrorTool(tool: string | undefined, limit: number): Promise<RegressionFixture[]> {
		if (!tool) return this.listRecent(limit);
		const stmt = this.#db.prepare(
			"SELECT * FROM regression_fixtures WHERE dominant_error_tool = ? ORDER BY created_at DESC LIMIT ?",
		);
		const rows = stmt.all(tool, limit) as RawFixtureRow[];
		stmt.finalize();
		if (rows.length > 0) return rows.map(row => this.#rowToFixture(row));
		return this.listRecent(limit);
	}

	#rowToFixture(row: RawFixtureRow): RegressionFixture {
		return {
			id: row.id,
			sessionId: row.session_id,
			episodeId: row.episode_id,
			cwd: row.cwd,
			userPrompt: row.user_prompt,
			errorCount: row.error_count,
			completedSuccessfully: row.completed_successfully === 1,
			dominantErrorTool: row.dominant_error_tool ?? undefined,
			dominantErrorPattern: row.dominant_error_pattern ?? undefined,
			entries: loadFixtureEntriesFromDb(this.#db, row.session_id),
			createdAt: row.created_at,
		};
	}
}
