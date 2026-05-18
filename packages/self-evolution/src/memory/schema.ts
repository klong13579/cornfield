/**
 * Memory namespace tables (threads, stage1, jobs, vector_embeddings).
 * Shared by project evolution.db and test-only standalone DB files.
 */
import type { Database } from "bun:sqlite";

export function initMemoryTables(db: Database): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS threads (
			id TEXT PRIMARY KEY,
			updated_at INTEGER NOT NULL,
			rollout_path TEXT NOT NULL,
			cwd TEXT NOT NULL,
			source_kind TEXT NOT NULL
		);
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS stage1_outputs (
			thread_id TEXT PRIMARY KEY,
			source_updated_at INTEGER NOT NULL,
			raw_memory TEXT NOT NULL,
			rollout_summary TEXT NOT NULL,
			rollout_slug TEXT,
			generated_at INTEGER NOT NULL
		);
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS jobs (
			kind TEXT NOT NULL,
			job_key TEXT NOT NULL,
			status TEXT NOT NULL,
			worker_id TEXT,
			ownership_token TEXT,
			started_at INTEGER,
			finished_at INTEGER,
			lease_until INTEGER,
			retry_at INTEGER,
			retry_remaining INTEGER NOT NULL DEFAULT 3,
			last_error TEXT,
			input_watermark INTEGER,
			last_success_watermark INTEGER,
			PRIMARY KEY (kind, job_key)
		);
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS vector_embeddings (
			id TEXT PRIMARY KEY,
			namespace TEXT NOT NULL,
			content TEXT NOT NULL,
			embedding_json TEXT NOT NULL,
			metadata_json TEXT,
			importance REAL NOT NULL DEFAULT 0.5,
			created_at INTEGER NOT NULL,
			last_accessed_at INTEGER NOT NULL
		);
	`);

	db.exec(`CREATE INDEX IF NOT EXISTS idx_vec_accessed ON vector_embeddings(last_accessed_at);`);
}
