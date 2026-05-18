/**
 * SqliteFitScoreStore — SQLite-backed storage for fit evaluation scores.
 */
import type { Database } from "bun:sqlite";
import type { FitScoreRecord } from "../types";
import type { FitScoreStore } from "./types";

export class SqliteFitScoreStore implements FitScoreStore {
	constructor(private db: Database) {
		this.ensureTable();
	}

	private ensureTable(): void {
		this.db.run(`
			CREATE TABLE IF NOT EXISTS fit_scores (
				date TEXT PRIMARY KEY,
				total_score INTEGER NOT NULL,
				memory_score INTEGER NOT NULL,
				thinking_score INTEGER NOT NULL,
				style_score INTEGER NOT NULL,
				prediction_score INTEGER NOT NULL,
				history_score INTEGER NOT NULL,
				change_from_last INTEGER,
				verdict TEXT NOT NULL,
				detail_json TEXT NOT NULL,
				computed_at INTEGER NOT NULL
			)
		`);
	}

	async upsert(record: FitScoreRecord): Promise<void> {
		const stmt = this.db.prepare(`
			INSERT INTO fit_scores (date, total_score, memory_score, thinking_score, style_score, prediction_score, history_score, change_from_last, verdict, detail_json, computed_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(date) DO UPDATE SET
				total_score = excluded.total_score,
				memory_score = excluded.memory_score,
				thinking_score = excluded.thinking_score,
				style_score = excluded.style_score,
				prediction_score = excluded.prediction_score,
				history_score = excluded.history_score,
				change_from_last = excluded.change_from_last,
				verdict = excluded.verdict,
				detail_json = excluded.detail_json,
				computed_at = excluded.computed_at
		`);
		stmt.run(
			record.date,
			record.totalScore,
			record.memoryScore,
			record.thinkingScore,
			record.styleScore,
			record.predictionScore,
			record.historyScore,
			record.changeFromLast,
			record.verdict,
			record.detailJson,
			record.computedAt,
		);
		stmt.finalize();
	}

	async get(date: string): Promise<FitScoreRecord | undefined> {
		const stmt = this.db.prepare("SELECT * FROM fit_scores WHERE date = ?");
		const row = stmt.get(date) as
			| {
					date: string;
					total_score: number;
					memory_score: number;
					thinking_score: number;
					style_score: number;
					prediction_score: number;
					history_score: number;
					change_from_last: number | null;
					verdict: string;
					detail_json: string;
					computed_at: number;
			  }
			| undefined;
		stmt.finalize();

		if (!row) return undefined;

		return {
			date: row.date,
			totalScore: row.total_score,
			memoryScore: row.memory_score,
			thinkingScore: row.thinking_score,
			styleScore: row.style_score,
			predictionScore: row.prediction_score,
			historyScore: row.history_score,
			changeFromLast: row.change_from_last,
			verdict: row.verdict as import("../types").FitVerdict,
			detailJson: row.detail_json,
			computedAt: row.computed_at,
		};
	}

	async getLast(): Promise<FitScoreRecord | undefined> {
		const stmt = this.db.prepare("SELECT * FROM fit_scores ORDER BY date DESC LIMIT 1");
		const row = stmt.get() as
			| {
					date: string;
					total_score: number;
					memory_score: number;
					thinking_score: number;
					style_score: number;
					prediction_score: number;
					history_score: number;
					change_from_last: number | null;
					verdict: string;
					detail_json: string;
					computed_at: number;
			  }
			| undefined;
		stmt.finalize();

		if (!row) return undefined;

		return {
			date: row.date,
			totalScore: row.total_score,
			memoryScore: row.memory_score,
			thinkingScore: row.thinking_score,
			styleScore: row.style_score,
			predictionScore: row.prediction_score,
			historyScore: row.history_score,
			changeFromLast: row.change_from_last,
			verdict: row.verdict as import("../types").FitVerdict,
			detailJson: row.detail_json,
			computedAt: row.computed_at,
		};
	}

	async listRecent(limit: number): Promise<import("../types").FitScoreRecord[]> {
		const stmt = this.db.prepare("SELECT * FROM fit_scores ORDER BY date DESC LIMIT ?");
		const rows = stmt.all(limit) as Array<{
			date: string;
			total_score: number;
			memory_score: number;
			thinking_score: number;
			style_score: number;
			prediction_score: number;
			history_score: number;
			change_from_last: number | null;
			verdict: string;
			detail_json: string;
			computed_at: number;
		}>;
		stmt.finalize();

		return rows.map(row => ({
			date: row.date,
			totalScore: row.total_score,
			memoryScore: row.memory_score,
			thinkingScore: row.thinking_score,
			styleScore: row.style_score,
			predictionScore: row.prediction_score,
			historyScore: row.history_score,
			changeFromLast: row.change_from_last,
			verdict: row.verdict as import("../types").FitVerdict,
			detailJson: row.detail_json,
			computedAt: row.computed_at,
		}));
	}
}
