/**
 * SQLite-based session store.
 *
 * Persists sessions and messages to SQLite for durability across restarts.
 * Each session is keyed by (channelId, conversationId) for 1:1 mapping
 * between an IM conversation and an agent session.
 */

import { Database, type Statement } from "bun:sqlite";
import type { SessionRecord, SessionStore } from "./types";

// ═══════════════════════════════════════════════════════════════════════
// Schema
// ═══════════════════════════════════════════════════════════════════════

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  account_id TEXT NOT NULL DEFAULT '__default__',
  user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_message_id TEXT,
  omp_session_path TEXT,
  session_webhook TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  UNIQUE(channel_id, account_id, conversation_id)
);`;

// ═══════════════════════════════════════════════════════════════════════
// Implementation
// ═══════════════════════════════════════════════════════════════════════

export class SQLiteSessionStore implements SessionStore {
	#db: Database;
	#getSessionByConv: Statement<SessionRecord, [string, string, string]>;
	#insertSession: Statement<
		void,
		[string, string, string, string, string, number, number, string | null, string | null, string | null, string]
	>;
	#updateSession: Statement<void, [number, string | null, string | null, string | null, string, string]>;
	#closeSession: Statement<void, [number, string]>;
	#getActiveSessions: Statement<SessionRecord, [string | null]>;

	constructor(dbPath: string) {
		this.#db = new Database(dbPath);
		this.#db.exec("PRAGMA journal_mode = WAL;");
		this.#migrateLegacySchema();

		this.#getSessionByConv = this.#db.prepare<SessionRecord, [string, string, string]>(`
			SELECT id, channel_id as channelId, account_id as accountId, user_id as userId, conversation_id as conversationId,
			       created_at as createdAt, updated_at as updatedAt,
			       last_message_id as lastMessageId, omp_session_path as ompSessionPath, session_webhook as sessionWebhook, status
			FROM sessions
			WHERE channel_id = ? AND account_id = ? AND conversation_id = ? AND status != 'closed'
		`);

		this.#insertSession = this.#db.prepare(`
			INSERT INTO sessions (id, channel_id, account_id, user_id, conversation_id, created_at, updated_at, last_message_id, omp_session_path, session_webhook, status)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);

		this.#updateSession = this.#db.prepare(`
			UPDATE sessions SET updated_at = ?, last_message_id = COALESCE(?, last_message_id),
			                    omp_session_path = COALESCE(?, omp_session_path),
			                    session_webhook = COALESCE(?, session_webhook),
			                    status = COALESCE(NULLIF(?, ''), status)
			WHERE id = ?
		`);

		this.#closeSession = this.#db.prepare(`
			UPDATE sessions SET status = 'closed', updated_at = ? WHERE id = ?
		`);

		this.#getActiveSessions = this.#db.prepare<SessionRecord, [string | null]>(`
			SELECT id, channel_id as channelId, account_id as accountId, user_id as userId, conversation_id as conversationId,
			       created_at as createdAt, updated_at as updatedAt,
			       last_message_id as lastMessageId, omp_session_path as ompSessionPath, session_webhook as sessionWebhook, status
			FROM sessions
			WHERE status != 'closed' AND channel_id = COALESCE(?, channel_id)
		`);
	}
	#migrateLegacySchema(): void {
		const existing = this.#db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'").get() as
			| { name: string }
			| null;
		if (!existing) {
			this.#db.exec(SCHEMA);
			return;
		}

		const columns = this.#db.query("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
		const hasAccountId = columns.some(c => c.name === "account_id");
		const hasWebhook = columns.some(c => c.name === "session_webhook");

		// Add session_webhook column if missing (online migration, no table rebuild)
		if (!hasWebhook) {
			this.#db.exec("ALTER TABLE sessions ADD COLUMN session_webhook TEXT;");
		}

		// If account_id already exists, we're fully migrated
		if (hasAccountId) {
			return;
		}

		// Legacy migration: add account_id column (full table rebuild)

		this.#db.exec(`
			ALTER TABLE sessions RENAME TO sessions_legacy;
			CREATE TABLE sessions (
			  id TEXT PRIMARY KEY,
			  channel_id TEXT NOT NULL,
			  account_id TEXT NOT NULL DEFAULT '__default__',
			  user_id TEXT NOT NULL,
			  conversation_id TEXT NOT NULL,
			  created_at INTEGER NOT NULL,
			  updated_at INTEGER NOT NULL,
			  last_message_id TEXT,
			  omp_session_path TEXT,
			  session_webhook TEXT,
			  status TEXT NOT NULL DEFAULT 'active',
			  UNIQUE(channel_id, account_id, conversation_id)
			);
			INSERT INTO sessions (id, channel_id, account_id, user_id, conversation_id, created_at, updated_at, last_message_id, omp_session_path, session_webhook, status)
			SELECT id, channel_id, '__default__', user_id, conversation_id, created_at, updated_at, last_message_id, omp_session_path, null, status FROM sessions_legacy;
			DROP TABLE sessions_legacy;
		`);
	}


	async getSession(channelId: string, accountId: string, conversationId: string): Promise<SessionRecord | null> {
		return this.#getSessionByConv.get(channelId, accountId, conversationId) ?? null;
	}

	async createSession(session: Omit<SessionRecord, "id">): Promise<SessionRecord> {
		const id = crypto.randomUUID();
		this.#insertSession.run(
			id,
			session.channelId,
			session.accountId,
			session.userId,
			session.conversationId,
			session.createdAt,
			session.updatedAt,
			session.lastMessageId ?? null,
			session.ompSessionPath ?? null,
			session.sessionWebhook ?? null,
			session.status ?? "active",
		);
		return { ...session, id };
	}

	async updateSession(id: string, updates: Partial<SessionRecord>): Promise<void> {
		const now = Date.now();
		this.#updateSession.run(
			now,
			updates.lastMessageId ?? null,
			updates.ompSessionPath ?? null,
			updates.sessionWebhook ?? null,
			updates.status ?? "",
			id,
		);
	}

	async closeSession(id: string): Promise<void> {
		this.#closeSession.run(Date.now(), id);
	}

	async getActiveSessions(channelId?: string): Promise<SessionRecord[]> {
		return this.#getActiveSessions.all(channelId ?? null);
	}

	close(): void {
		this.#db.close();
	}
}
