/**
 * Episode storage with FTS5 full-text search.
 */
import type { Database } from "bun:sqlite";
import { logger } from "@oh-my-pi/pi-utils";
import type { Episode } from "../types";
import type { EpisodeStore } from "./types";

/** Tokenize user text into FTS5-safe terms (avoids MATCH syntax errors from . < ^ etc.). */
function fts5MatchTerms(query: string): string[] {
	const seen = new Set<string>();
	const normalized = query.normalize("NFKC").toLowerCase();
	for (const raw of normalized.split(/[^\p{L}\p{N}_]+/gu)) {
		if (raw.length >= 2 && !seen.has(raw)) seen.add(raw);
	}
	return [...seen];
}

function buildFts5MatchExpression(query: string): string | undefined {
	const terms = fts5MatchTerms(query);
	if (terms.length === 0) return undefined;
	return terms.map(t => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}

export class SqliteEpisodeStore implements EpisodeStore {
	constructor(private db: Database) {}

	async insert(episode: Episode): Promise<void> {
		const stmt = this.db.prepare(`
			INSERT OR REPLACE INTO episodes (
				id, session_id, cwd, user_prompt, timestamp, duration_ms,
				tool_call_count, error_count, had_recovery, completed_successfully,
				summary, tools_used, files_modified
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		stmt.run(
			episode.id,
			episode.sessionId,
			episode.cwd,
			episode.userPrompt,
			episode.timestamp,
			episode.durationMs,
			episode.toolCallCount,
			episode.errorCount,
			episode.hadRecovery ? 1 : 0,
			episode.completedSuccessfully ? 1 : 0,
			episode.summary,
			JSON.stringify(episode.toolsUsed),
			JSON.stringify(episode.filesModified),
		);
		stmt.finalize();
	}

	async listRecent(limit: number): Promise<Episode[]> {
		const stmt = this.db.prepare(`
			SELECT * FROM episodes ORDER BY timestamp DESC LIMIT ?
		`);
		const rows = stmt.all(limit) as RawEpisodeRow[];
		stmt.finalize();
		return rows.map(rowToEpisode);
	}
	async get(id: string): Promise<Episode | undefined> {
		const stmt = this.db.prepare(`SELECT * FROM episodes WHERE id = ?`);
		const row = stmt.get(id) as RawEpisodeRow | undefined;
		stmt.finalize();
		if (!row) return undefined;
		return rowToEpisode(row);
	}

	async searchByKeyword(query: string, limit: number): Promise<Episode[]> {
		const likeFallback = (): Episode[] => {
			const tokens = fts5MatchTerms(query);
			const useTokens = tokens.length > 0 ? tokens.slice(0, 16) : [];
			const singlePattern =
				useTokens.length === 0
					? [`%${query.replace(/[%_]/g, "\\$&")}%`]
					: useTokens.map(t => `%${t.replace(/[%_]/g, "\\$&")}%`);
			let rows: RawEpisodeRow[];
			if (useTokens.length > 0) {
				const where = singlePattern
					.map(() => "(user_prompt LIKE ? OR summary LIKE ? OR tools_used LIKE ?)")
					.join(" OR ");
				const binds: string[] = [];
				for (const pat of singlePattern) {
					binds.push(pat, pat, pat);
				}
				const stmtLike = this.db.prepare(`
					SELECT * FROM episodes
					WHERE ${where}
					ORDER BY timestamp DESC
					LIMIT ?
				`);
				rows = stmtLike.all(...binds, limit) as RawEpisodeRow[];
				stmtLike.finalize();
			} else {
				const pat = singlePattern[0]!;
				const stmtLike = this.db.prepare(`
					SELECT * FROM episodes
					WHERE user_prompt LIKE ? OR summary LIKE ? OR tools_used LIKE ?
					ORDER BY timestamp DESC
					LIMIT ?
				`);
				rows = stmtLike.all(pat, pat, pat, limit) as RawEpisodeRow[];
				stmtLike.finalize();
			}
			return rows.map(rowToEpisode);
		};

		// Use FTS5 for full-text search, fallback to LIKE if FTS5 index is empty
		const countStmt = this.db.prepare(`SELECT COUNT(*) as c FROM episodes_fts`);
		const countRow = countStmt.get() as { c: number };
		countStmt.finalize();

		if (countRow.c === 0) return likeFallback();

		const ftsExpression = buildFts5MatchExpression(query);
		if (!ftsExpression) return likeFallback();

		try {
			const stmt = this.db.prepare(`
SELECT e.* FROM episodes e
INNER JOIN episodes_fts ON e.rowid = episodes_fts.rowid
WHERE episodes_fts MATCH ?
ORDER BY e.timestamp DESC
LIMIT ?
`);
			const rows = stmt.all(ftsExpression, limit) as RawEpisodeRow[];
			stmt.finalize();
			return rows.map(rowToEpisode);
		} catch (err) {
			logger.warn("episode FTS5 search failed, using LIKE fallback", { error: String(err) });
			return likeFallback();
		}
	}
	async searchFailedByKeyword(query: string, limit: number): Promise<Episode[]> {
		// Fallback to LIKE search on failed episodes
		const pattern = `%${query.replace(/[%_]/g, "\\$&")}%`;
		const stmt = this.db.prepare(`
      SELECT * FROM episodes
      WHERE completed_successfully = 0
        AND (user_prompt LIKE ? OR summary LIKE ?)
      ORDER BY timestamp DESC
      LIMIT ?
    `);
		const rows = stmt.all(pattern, pattern, limit) as RawEpisodeRow[];
		stmt.finalize();
		return rows.map(rowToEpisode);
	}

	async deleteOld(keepCount: number): Promise<number> {
		const countStmt = this.db.prepare(`SELECT COUNT(*) as c FROM episodes`);
		const countRow = countStmt.get() as { c: number };
		countStmt.finalize();

		const toDelete = countRow.c - keepCount;
		if (toDelete <= 0) return 0;

		const stmt = this.db.prepare(`
			DELETE FROM episodes
			WHERE id IN (
				SELECT id FROM episodes ORDER BY timestamp ASC LIMIT ?
			)
		`);
		stmt.run(toDelete);
		stmt.finalize();
		return toDelete;
	}

	async count(): Promise<number> {
		const stmt = this.db.prepare(`SELECT COUNT(*) as c FROM episodes`);
		const row = stmt.get() as { c: number };
		stmt.finalize();
		return row.c;
	}
}

interface RawEpisodeRow {
	id: string;
	session_id: string;
	cwd: string;
	user_prompt: string;
	timestamp: number;
	duration_ms: number;
	tool_call_count: number;
	error_count: number;
	had_recovery: number;
	completed_successfully: number;
	summary: string;
	tools_used: string;
	files_modified: string;
}

function rowToEpisode(row: RawEpisodeRow): Episode {
	return {
		id: row.id,
		sessionId: row.session_id,
		cwd: row.cwd,
		userPrompt: row.user_prompt,
		timestamp: row.timestamp,
		durationMs: row.duration_ms,
		toolCallCount: row.tool_call_count,
		errorCount: row.error_count,
		hadRecovery: Boolean(row.had_recovery),
		completedSuccessfully: Boolean(row.completed_successfully),
		summary: row.summary,
		toolsUsed: safeJsonParse(row.tools_used, []),
		filesModified: safeJsonParse(row.files_modified, []),
	};
}

function safeJsonParse<T>(json: string, fallback: T): T {
	try {
		return JSON.parse(json) as T;
	} catch {
		return fallback;
	}
}
