/**
 * SQLite implementation of SkillPopulationStore.
 *
 * Manages the skill_population table for evolutionary lifecycle tracking.
 */
import type { Database } from "bun:sqlite";
import { logger } from "@oh-my-pi/pi-utils";
import { normalizeEvolutionScore } from "../skill-score";
import type { SkillPopulationEvolutionEvent, SkillPopulationRecord, SkillPopulationState } from "../types";
import type { SkillPopulationStore } from "./types";

interface RawRow {
	name: string;
	created_at: number;
	updated_at: number;
	usage_count: number;
	success_rate: number;
	state: string;
	evolution_score: number;
	last_evaluated_at: number | null;
	next_evaluation_at: number | null;
	quality_metrics_json: string | null;
	evolution_history_json: string | null;
}

function rowToRecord(row: RawRow): SkillPopulationRecord {
	return {
		name: row.name,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		usageCount: row.usage_count,
		successRate: row.success_rate,
		state: row.state as SkillPopulationState,
		evolutionScore: normalizeEvolutionScore(row.evolution_score),
		lastEvaluatedAt: row.last_evaluated_at ?? undefined,
		nextEvaluationAt: row.next_evaluation_at ?? undefined,
		qualityMetrics: row.quality_metrics_json ? JSON.parse(row.quality_metrics_json) : undefined,
		evolutionHistory: row.evolution_history_json ? JSON.parse(row.evolution_history_json) : undefined,
	};
}

export class SqliteSkillPopulationStore implements SkillPopulationStore {
	#db: Database;

	constructor(db: Database) {
		this.#db = db;
	}

	async insert(record: SkillPopulationRecord): Promise<void> {
		const stmt = this.#db.prepare(`
			INSERT INTO skill_population (
				name, created_at, updated_at, usage_count, success_rate,
				state, evolution_score, last_evaluated_at, next_evaluation_at,
				quality_metrics_json, evolution_history_json
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		stmt.run(
			record.name,
			record.createdAt,
			record.updatedAt,
			record.usageCount,
			record.successRate,
			record.state,
			normalizeEvolutionScore(record.evolutionScore),
			record.lastEvaluatedAt ?? null,
			record.nextEvaluationAt ?? null,
			record.qualityMetrics ? JSON.stringify(record.qualityMetrics) : null,
			record.evolutionHistory ? JSON.stringify(record.evolutionHistory) : null,
		);
		stmt.finalize();
	}

	async get(name: string): Promise<SkillPopulationRecord | undefined> {
		const stmt = this.#db.prepare("SELECT * FROM skill_population WHERE name = ?");
		const row = stmt.get(name) as RawRow | undefined;
		stmt.finalize();
		return row ? rowToRecord(row) : undefined;
	}

	async list(filter?: { state?: SkillPopulationState; minScore?: number }): Promise<SkillPopulationRecord[]> {
		let sql = "SELECT * FROM skill_population";
		const conditions: string[] = [];
		const params: (string | number)[] = [];

		if (filter?.state) {
			conditions.push("state = ?");
			params.push(filter.state);
		}
		if (filter?.minScore !== undefined) {
			conditions.push("evolution_score >= ?");
			params.push(filter.minScore);
		}

		if (conditions.length > 0) {
			sql += ` WHERE ${conditions.join(" AND ")}`;
		}
		sql += " ORDER BY evolution_score DESC";

		const stmt = this.#db.prepare(sql);
		const rows = stmt.all(...params) as RawRow[];
		stmt.finalize();
		return rows.map(rowToRecord);
	}

	async update(record: SkillPopulationRecord): Promise<void> {
		const stmt = this.#db.prepare(`
			UPDATE skill_population SET
				updated_at = ?, usage_count = ?, success_rate = ?,
				state = ?, evolution_score = ?, last_evaluated_at = ?, next_evaluation_at = ?,
				quality_metrics_json = ?, evolution_history_json = ?
			WHERE name = ?
		`);
		stmt.run(
			record.updatedAt,
			record.usageCount,
			record.successRate,
			record.state,
			normalizeEvolutionScore(record.evolutionScore),
			record.lastEvaluatedAt ?? null,
			record.nextEvaluationAt ?? null,
			record.qualityMetrics ? JSON.stringify(record.qualityMetrics) : null,
			record.evolutionHistory ? JSON.stringify(record.evolutionHistory) : null,
			record.name,
		);
		stmt.finalize();
	}

	async delete(name: string): Promise<void> {
		const stmt = this.#db.prepare("DELETE FROM skill_population WHERE name = ?");
		stmt.run(name);
		stmt.finalize();
	}

	async transitionState(name: string, newState: SkillPopulationState, reason: string, score: number): Promise<void> {
		const existing = await this.get(name);
		if (!existing) {
			logger.warn("Skill population transition: skill not found", { name });
			return;
		}

		const normalizedScore = normalizeEvolutionScore(score);
		const event: SkillPopulationEvolutionEvent = {
			at: Date.now(),
			fromState: existing.state,
			toState: newState,
			reason,
			evolutionScore: normalizedScore,
		};

		const history = existing.evolutionHistory ?? [];
		history.push(event);

		const stmt = this.#db.prepare(`
			UPDATE skill_population SET
				state = ?, evolution_score = ?, updated_at = ?, last_evaluated_at = ?,
				evolution_history_json = ?
			WHERE name = ?
		`);
		stmt.run(newState, normalizedScore, Date.now(), Date.now(), JSON.stringify(history), name);
		stmt.finalize();

		logger.debug("Skill population state transitioned", {
			name,
			from: existing.state,
			to: newState,
			reason,
			score: normalizedScore,
		});
	}

	async countByState(state: SkillPopulationState): Promise<number> {
		const stmt = this.#db.prepare("SELECT COUNT(*) as count FROM skill_population WHERE state = ?");
		const row = stmt.get(state) as { count: number } | undefined;
		stmt.finalize();
		return row?.count ?? 0;
	}
}
