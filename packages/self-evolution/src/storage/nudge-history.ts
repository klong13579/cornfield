/**
 * SQLite implementation of NudgeHistoryStore.
 */
import type { Database } from "bun:sqlite";
import type { NudgeOutcomeUpdate, NudgeRecord } from "../types";
import type { NudgeHistoryStore } from "./types";

export class SqliteNudgeHistoryStore implements NudgeHistoryStore {
	constructor(private db: Database) {}

	async insert(record: NudgeRecord): Promise<void> {
		const stmt = this.db.prepare(`
			INSERT INTO nudge_history (
				id, session_id, project, type, severity, message, suggestion, detected_at,
				dismissed_at, acknowledged, context_injected, injected_at, post_tool_calls,
				pattern_repeated, outcome_score, outcome_recorded_at
			)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		stmt.run(
			record.id,
			record.sessionId,
			record.project,
			record.type,
			record.severity,
			record.message,
			record.suggestion,
			record.detectedAt,
			record.dismissedAt ?? null,
			record.acknowledged ? 1 : 0,
			record.contextInjected ? 1 : 0,
			record.injectedAt ?? null,
			record.postToolCalls ?? 0,
			record.patternRepeated ? 1 : 0,
			record.outcomeScore ?? null,
			record.outcomeRecordedAt ?? null,
		);
		stmt.finalize();
	}

	async get(id: string): Promise<NudgeRecord | undefined> {
		const stmt = this.db.prepare(`SELECT * FROM nudge_history WHERE id = ?`);
		const row = stmt.get(id) as RawNudgeRow | undefined;
		stmt.finalize();
		return row ? rowToNudgeRecord(row) : undefined;
	}

	async listRecent(limit: number): Promise<NudgeRecord[]> {
		const stmt = this.db.prepare(`
			SELECT * FROM nudge_history ORDER BY detected_at DESC LIMIT ?
		`);
		const rows = stmt.all(limit) as RawNudgeRow[];
		stmt.finalize();
		return rows.map(rowToNudgeRecord);
	}

	async listByType(type: string, limit: number): Promise<NudgeRecord[]> {
		const stmt = this.db.prepare(`
			SELECT * FROM nudge_history WHERE type = ? ORDER BY detected_at DESC LIMIT ?
		`);
		const rows = stmt.all(type, limit) as RawNudgeRow[];
		stmt.finalize();
		return rows.map(rowToNudgeRecord);
	}

	async countByType(type: string, since: number): Promise<number> {
		const stmt = this.db.prepare(`
			SELECT COUNT(*) as c FROM nudge_history WHERE type = ? AND detected_at >= ?
		`);
		const row = stmt.get(type, since) as { c: number };
		stmt.finalize();
		return row.c;
	}

	async acknowledge(id: string): Promise<void> {
		const stmt = this.db.prepare(`
			UPDATE nudge_history SET acknowledged = 1 WHERE id = ?
		`);
		stmt.run(id);
		stmt.finalize();
	}

	async dismiss(id: string): Promise<void> {
		const stmt = this.db.prepare(`
			UPDATE nudge_history SET dismissed_at = ? WHERE id = ?
		`);
		stmt.run(Date.now(), id);
		stmt.finalize();
	}

	async markContextInjected(ids: string[], injectedAt: number): Promise<void> {
		if (ids.length === 0) return;
		const stmt = this.db.prepare(`
			UPDATE nudge_history
			SET context_injected = 1, injected_at = ?
			WHERE id = ?
		`);
		for (const id of ids) {
			stmt.run(injectedAt, id);
		}
		stmt.finalize();
	}

	async listUnscoredInjectedForSession(sessionId: string): Promise<NudgeRecord[]> {
		const stmt = this.db.prepare(`
			SELECT * FROM nudge_history
			WHERE session_id = ? AND context_injected = 1 AND outcome_recorded_at IS NULL
			ORDER BY injected_at ASC
		`);
		const rows = stmt.all(sessionId) as RawNudgeRow[];
		stmt.finalize();
		return rows.map(rowToNudgeRecord);
	}

	async recordOutcome(id: string, update: NudgeOutcomeUpdate): Promise<void> {
		const stmt = this.db.prepare(`
			UPDATE nudge_history
			SET post_tool_calls = ?, pattern_repeated = ?, outcome_score = ?, outcome_recorded_at = ?
			WHERE id = ?
		`);
		stmt.run(update.postToolCalls, update.patternRepeated ? 1 : 0, update.outcomeScore, Date.now(), id);
		stmt.finalize();
	}
}

interface RawNudgeRow {
	id: string;
	session_id: string;
	project: string;
	type: string;
	severity: string;
	message: string;
	suggestion: string;
	detected_at: number;
	dismissed_at: number | null;
	acknowledged: number;
	context_injected: number;
	injected_at: number | null;
	post_tool_calls: number;
	pattern_repeated: number;
	outcome_score: number | null;
	outcome_recorded_at: number | null;
}

function rowToNudgeRecord(row: RawNudgeRow): NudgeRecord {
	return {
		id: row.id,
		sessionId: row.session_id,
		project: row.project,
		type: row.type,
		severity: row.severity,
		message: row.message,
		suggestion: row.suggestion,
		detectedAt: row.detected_at,
		dismissedAt: row.dismissed_at ?? undefined,
		acknowledged: Boolean(row.acknowledged),
		contextInjected: Boolean(row.context_injected),
		injectedAt: row.injected_at ?? undefined,
		postToolCalls: row.post_tool_calls,
		patternRepeated: Boolean(row.pattern_repeated),
		outcomeScore: row.outcome_score ?? undefined,
		outcomeRecordedAt: row.outcome_recorded_at ?? undefined,
	};
}
