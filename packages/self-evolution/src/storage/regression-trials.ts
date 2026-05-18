/**
 * Record keep/discard outcomes from regression replay.
 */
import type { Database } from "bun:sqlite";
import type { RegressionTrial, RegressionVerdict } from "../types";

export class SqliteRegressionTrialStore {
	#db: Database;

	constructor(db: Database) {
		this.#db = db;
	}

	async insert(trial: RegressionTrial): Promise<void> {
		const stmt = this.#db.prepare(`
			INSERT INTO regression_trials (
				id, target_type, target_id, fixture_id, verdict, reason, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?)
		`);
		stmt.run(
			trial.id,
			trial.targetType,
			trial.targetId,
			trial.fixtureId,
			trial.verdict,
			trial.reason,
			trial.createdAt,
		);
		stmt.finalize();
	}

	async listRecent(limit: number): Promise<RegressionTrial[]> {
		const stmt = this.#db.prepare("SELECT * FROM regression_trials ORDER BY created_at DESC LIMIT ?");
		const rows = stmt.all(limit) as RawRow[];
		stmt.finalize();
		return rows.map(rowToTrial);
	}

	async listByTarget(targetType: string, targetId: string, limit: number): Promise<RegressionTrial[]> {
		const stmt = this.#db.prepare(`
			SELECT * FROM regression_trials
			WHERE target_type = ? AND target_id = ?
			ORDER BY created_at DESC LIMIT ?
		`);
		const rows = stmt.all(targetType, targetId, limit) as RawRow[];
		stmt.finalize();
		return rows.map(rowToTrial);
	}
}

interface RawRow {
	id: string;
	target_type: string;
	target_id: string;
	fixture_id: string;
	verdict: string;
	reason: string;
	created_at: number;
}

function rowToTrial(row: RawRow): RegressionTrial {
	return {
		id: row.id,
		targetType: row.target_type as RegressionTrial["targetType"],
		targetId: row.target_id,
		fixtureId: row.fixture_id,
		verdict: row.verdict as RegressionVerdict,
		reason: row.reason,
		createdAt: row.created_at,
	};
}
