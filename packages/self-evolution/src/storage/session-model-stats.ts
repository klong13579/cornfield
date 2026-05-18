/**
 * Per-session model performance statistics storage.
 */
import type { Database } from "bun:sqlite";
import { logger } from "@oh-my-pi/pi-utils";

export interface SessionModelStats {
	sessionId: string;
	modelName: string;
	promptTokens: number;
	completionTokens: number;
	durationMs: number;
	successCount: number;
	errorCount: number;
	timestamp: number;
	taskType?: string;
}

interface RawSessionModelStatsRow {
	session_id: string;
	model_name: string;
	prompt_tokens: number;
	completion_tokens: number;
	duration_ms: number;
	success_count: number;
	error_count: number;
	timestamp: number;
	task_type: string | null;
}

export interface ModelStatsAggregate {
	avgTokens: number;
	avgDuration: number;
	successRate: number;
	totalSessions: number;
}

export class SqliteSessionModelStatsStore {
	#db: Database;

	constructor(db: Database) {
		this.#db = db;
	}

	async insert(stats: SessionModelStats): Promise<void> {
		this.#db
			.prepare(`
            INSERT INTO session_model_stats (session_id, model_name, prompt_tokens, completion_tokens, duration_ms, success_count, error_count, timestamp, task_type)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
			.run(
				stats.sessionId,
				stats.modelName,
				stats.promptTokens,
				stats.completionTokens,
				stats.durationMs,
				stats.successCount,
				stats.errorCount,
				stats.timestamp,
				stats.taskType ?? null,
			);
		logger.debug("Model evaluation recorded", {
			modelName: stats.modelName,
			sessionId: stats.sessionId,
		});
	}

	async listByModel(modelName: string, limit: number = 50): Promise<SessionModelStats[]> {
		const stmt = this.#db.prepare(
			"SELECT * FROM session_model_stats WHERE model_name = ? ORDER BY timestamp DESC LIMIT ?",
		);
		const rows = stmt.all(modelName, limit) as RawSessionModelStatsRow[];
		stmt.finalize();
		return rows.map(this.#rowToStats);
	}

	async getAggregates(modelName?: string): Promise<ModelStatsAggregate> {
		const whereClause = modelName ? "WHERE model_name = ?" : "";
		const params = modelName ? [modelName] : [];

		const stmt = this.#db.prepare(
			`SELECT COUNT(*) as count, AVG(prompt_tokens + completion_tokens) as avg_tokens, AVG(duration_ms) as avg_duration, SUM(success_count) as total_success, SUM(error_count) as total_errors FROM session_model_stats ${whereClause}`,
		);
		const row = stmt.get(...params) as {
			count: number;
			avg_tokens: number | null;
			avg_duration: number | null;
			total_success: number | null;
			total_errors: number | null;
		};
		stmt.finalize();

		const total = (row.total_success || 0) + (row.total_errors || 0);
		return {
			avgTokens: row.avg_tokens || 0,
			avgDuration: row.avg_duration || 0,
			successRate: total > 0 ? (row.total_success || 0) / total : 0,
			totalSessions: row.count || 0,
		};
	}

	#rowToStats(row: RawSessionModelStatsRow): SessionModelStats {
		return {
			sessionId: row.session_id,
			modelName: row.model_name,
			promptTokens: row.prompt_tokens,
			completionTokens: row.completion_tokens,
			durationMs: row.duration_ms,
			successCount: row.success_count,
			errorCount: row.error_count,
			timestamp: row.timestamp,
			taskType: row.task_type ?? undefined,
		};
	}
}
