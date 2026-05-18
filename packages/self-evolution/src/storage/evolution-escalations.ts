/**
 * Persist evolution deadlock escalations for human intervention.
 */
import type { Database } from "bun:sqlite";
import type { EscalationCandidate } from "../escalation/detector";
import type { EvolutionEscalation, EvolutionEscalationStatus } from "../types";

interface RawRow {
	id: string;
	pattern_key: string;
	pattern_label: string;
	dominant_error_tool: string | null;
	dominant_error_pattern: string | null;
	occurrence_count: number;
	failed_improvement_count: number;
	status: string;
	message: string;
	suggestion: string;
	created_at: number;
	updated_at: number;
	acknowledged_at: number | null;
	resolved_at: number | null;
}

export class SqliteEvolutionEscalationStore {
	#db: Database;

	constructor(db: Database) {
		this.#db = db;
	}

	async upsertOpen(candidate: EscalationCandidate): Promise<EvolutionEscalation> {
		const existing = await this.#getOpenByPatternKey(candidate.patternKey);
		const now = Date.now();

		if (existing) {
			const stmt = this.#db.prepare(`
				UPDATE evolution_escalations SET
					occurrence_count = ?,
					failed_improvement_count = ?,
					message = ?,
					suggestion = ?,
					dominant_error_tool = ?,
					dominant_error_pattern = ?,
					updated_at = ?
				WHERE id = ?
			`);
			stmt.run(
				candidate.occurrenceCount,
				Math.max(existing.failedImprovementCount, candidate.failedImprovementCount),
				candidate.message,
				candidate.suggestion,
				candidate.dominantErrorTool ?? null,
				candidate.dominantErrorPattern ?? null,
				now,
				existing.id,
			);
			stmt.finalize();
			return (await this.get(existing.id))!;
		}

		const id = `esc_${Bun.hash(`${candidate.patternKey}:${now}`).toString(36)}`;
		const stmt = this.#db.prepare(`
			INSERT INTO evolution_escalations (
				id, pattern_key, pattern_label, dominant_error_tool, dominant_error_pattern,
				occurrence_count, failed_improvement_count, status, message, suggestion,
				created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)
		`);
		stmt.run(
			id,
			candidate.patternKey,
			candidate.patternLabel,
			candidate.dominantErrorTool ?? null,
			candidate.dominantErrorPattern ?? null,
			candidate.occurrenceCount,
			candidate.failedImprovementCount,
			candidate.message,
			candidate.suggestion,
			now,
			now,
		);
		stmt.finalize();
		return (await this.get(id))!;
	}

	async get(id: string): Promise<EvolutionEscalation | undefined> {
		const stmt = this.#db.prepare("SELECT * FROM evolution_escalations WHERE id = ?");
		const row = stmt.get(id) as RawRow | undefined;
		stmt.finalize();
		return row ? rowToEscalation(row) : undefined;
	}

	async listOpen(): Promise<EvolutionEscalation[]> {
		const stmt = this.#db.prepare(
			"SELECT * FROM evolution_escalations WHERE status IN ('open', 'acknowledged') ORDER BY updated_at DESC",
		);
		const rows = stmt.all() as RawRow[];
		stmt.finalize();
		return rows.map(rowToEscalation);
	}

	async listRecent(limit: number): Promise<EvolutionEscalation[]> {
		const stmt = this.#db.prepare("SELECT * FROM evolution_escalations ORDER BY updated_at DESC LIMIT ?");
		const rows = stmt.all(limit) as RawRow[];
		stmt.finalize();
		return rows.map(rowToEscalation);
	}

	async isPatternSuppressed(patternKey: string): Promise<boolean> {
		const stmt = this.#db.prepare(
			"SELECT 1 FROM evolution_escalations WHERE pattern_key = ? AND status IN ('open', 'acknowledged') LIMIT 1",
		);
		const row = stmt.get(patternKey);
		stmt.finalize();
		return row !== undefined && row !== null;
	}

	async acknowledge(id: string): Promise<void> {
		await this.#setStatus(id, "acknowledged", { acknowledgedAt: Date.now() });
	}

	async resolve(id: string): Promise<void> {
		await this.#setStatus(id, "resolved", { resolvedAt: Date.now() });
	}

	async countOpen(): Promise<number> {
		const stmt = this.#db.prepare(
			"SELECT COUNT(*) as c FROM evolution_escalations WHERE status IN ('open', 'acknowledged')",
		);
		const row = stmt.get() as { c: number };
		stmt.finalize();
		return row.c;
	}

	async #getOpenByPatternKey(patternKey: string): Promise<EvolutionEscalation | undefined> {
		const stmt = this.#db.prepare(
			"SELECT * FROM evolution_escalations WHERE pattern_key = ? AND status IN ('open', 'acknowledged') LIMIT 1",
		);
		const row = stmt.get(patternKey) as RawRow | undefined;
		stmt.finalize();
		return row ? rowToEscalation(row) : undefined;
	}

	async #setStatus(
		id: string,
		status: EvolutionEscalationStatus,
		timestamps: { acknowledgedAt?: number; resolvedAt?: number },
	): Promise<void> {
		const stmt = this.#db.prepare(`
			UPDATE evolution_escalations SET
				status = ?,
				updated_at = ?,
				acknowledged_at = COALESCE(?, acknowledged_at),
				resolved_at = COALESCE(?, resolved_at)
			WHERE id = ?
		`);
		stmt.run(status, Date.now(), timestamps.acknowledgedAt ?? null, timestamps.resolvedAt ?? null, id);
		stmt.finalize();
	}
}

function rowToEscalation(row: RawRow): EvolutionEscalation {
	return {
		id: row.id,
		patternKey: row.pattern_key,
		patternLabel: row.pattern_label,
		dominantErrorTool: row.dominant_error_tool ?? undefined,
		dominantErrorPattern: row.dominant_error_pattern ?? undefined,
		occurrenceCount: row.occurrence_count,
		failedImprovementCount: row.failed_improvement_count,
		status: row.status as EvolutionEscalationStatus,
		message: row.message,
		suggestion: row.suggestion,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		acknowledgedAt: row.acknowledged_at ?? undefined,
		resolvedAt: row.resolved_at ?? undefined,
	};
}
