/**
 * EpisodicBackend: interface for storing and retrieving episodic memories.
 *
 * Episodic memories are session-level traces that provide context for
 * understanding how the agent behaved in specific situations.
 */
import type { Database, Statement } from "bun:sqlite";
import type { EpisodicRecord } from "../types";

export interface EpisodicBackend {
	store(record: EpisodicRecord): Promise<void>;
	getBySession(sessionId: string): Promise<EpisodicRecord[]>;
	getRecent(limit: number): Promise<EpisodicRecord[]>;
	search(query: string, limit: number): Promise<EpisodicRecord[]>;
	markExpiredAsArchived(now: number): Promise<number>;
	cleanupArchived(retentionMs: number): Promise<number>;
	close(): void;

	/** Mark all records for a session as pending_review. */
	markSessionPendingReview(sessionId: string): Promise<number>;
	/** Get records by review status, optionally filtered by session. */
	getByReviewStatus(status: string, sessionId?: string): Promise<EpisodicRecord[]>;
	/** Update a single record's review status. */
	updateReviewStatus(id: string, status: string, reviewedAt: number): Promise<void>;
}

/**
 * SQLite implementation of EpisodicBackend.
 */
export class SqliteEpisodicBackend implements EpisodicBackend {
	constructor(private db: Database) {}

	async store(record: EpisodicRecord): Promise<void> {
		const insert = this.db.prepare(`
			INSERT INTO episodic_records (
				id, session_id, cwd, timestamp, event_type, event_data,
				importance_score, ttl_seconds, expiration_time, archived,
				review_status, reviewed_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);

		insert.run(
			record.id,
			record.sessionId,
			record.cwd,
			record.timestamp,
			record.eventType,
			JSON.stringify(record.eventData),
			record.importanceScore ?? 0,
			record.ttlSeconds ?? null,
			record.expirationTime ?? null,
			record.archived ? 1 : 0,
			record.reviewStatus ?? "active",
			record.reviewedAt ?? null,
		);
	}

	async getBySession(sessionId: string): Promise<EpisodicRecord[]> {
		const stmt = this.db.prepare(`
			SELECT * FROM episodic_records 
			WHERE session_id = ? AND archived = 0
			ORDER BY timestamp DESC
		`);

		const rows = stmt.all(sessionId) as any[];
		return rows.map(this.rowToRecord);
	}

	async getRecent(limit: number): Promise<EpisodicRecord[]> {
		const stmt = this.db.prepare(`
			SELECT * FROM episodic_records 
			WHERE archived = 0
			ORDER BY timestamp DESC
			LIMIT ?
		`);

		const rows = stmt.all(limit) as any[];
		return rows.map(this.rowToRecord);
	}

	async search(query: string, limit: number): Promise<EpisodicRecord[]> {
		// Simple text search - in a real implementation, this might use FTS
		const stmt = this.db.prepare(`
			SELECT * FROM episodic_records 
			WHERE archived = 0 
			AND (event_data LIKE ? OR session_id LIKE ?)
			ORDER BY timestamp DESC
			LIMIT ?
		`);

		const searchTerm = `%${query}%`;
		const rows = stmt.all(searchTerm, searchTerm, limit) as any[];
		return rows.map(this.rowToRecord);
	}

	async markExpiredAsArchived(now: number): Promise<number> {
		const stmt = this.db.prepare(`
			UPDATE episodic_records 
			SET archived = 1 
			WHERE expiration_time IS NOT NULL AND expiration_time < ? AND archived = 0
		`);

		const result = stmt.run(now);
		return result.changes as number;
	}

	async cleanupArchived(retentionMs: number): Promise<number> {
		const cutoff = Date.now() - retentionMs;
		const stmt = this.db.prepare(`
			DELETE FROM episodic_records 
			WHERE archived = 1 AND timestamp < ?
		`);

		const result = stmt.run(cutoff);
		return result.changes as number;
	}

	close(): void {
		// Connection is managed externally
	}

	private rowToRecord(row: any): EpisodicRecord {
		return {
			id: row.id,
			sessionId: row.session_id,
			cwd: row.cwd,
			timestamp: row.timestamp,
			eventType: row.event_type,
			eventData: JSON.parse(row.event_data),
			importanceScore: row.importance_score,
			ttlSeconds: row.ttl_seconds,
			expirationTime: row.expiration_time,
			archived: row.archived === 1,
			reviewStatus: row.review_status ?? "active",
			reviewedAt: row.reviewed_at ?? undefined,
		};
	}

	async markSessionPendingReview(sessionId: string): Promise<number> {
		const stmt = this.db.prepare(`
			UPDATE episodic_records
			SET review_status = 'pending_review'
			WHERE session_id = ? AND review_status = 'active'
		`);
		const result = stmt.run(sessionId);
		return result.changes as number;
	}

	async getByReviewStatus(status: string, sessionId?: string): Promise<EpisodicRecord[]> {
		let stmt: Statement;
		if (sessionId) {
			stmt = this.db.prepare(`
				SELECT * FROM episodic_records
				WHERE review_status = ? AND session_id = ?
				ORDER BY timestamp DESC
			`);
			const rows = stmt.all(status, sessionId) as any[];
			return rows.map(this.rowToRecord);
		}
		stmt = this.db.prepare(`
			SELECT * FROM episodic_records
			WHERE review_status = ?
			ORDER BY timestamp DESC
		`);
		const rows = stmt.all(status) as any[];
		return rows.map(this.rowToRecord);
	}

	async updateReviewStatus(id: string, status: string, reviewedAt: number): Promise<void> {
		const stmt = this.db.prepare(`
			UPDATE episodic_records
			SET review_status = ?, reviewed_at = ?
			WHERE id = ?
		`);
		stmt.run(status, reviewedAt, id);
	}
}
