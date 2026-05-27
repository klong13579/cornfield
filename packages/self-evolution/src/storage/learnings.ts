import type { Database, Statement } from "bun:sqlite";
import {
	classifyLearningLifecycle,
	isLearningEligibleForInjection,
	validateLearningContent,
} from "../learning-admission";
import type { Learning, LearningKind, LearningLifecycle, LearningScope, LearningSource } from "../types";

interface RawLearningRow {
	id: string;
	cwd: string;
	kind: string;
	content: string;
	source: string;
	confidence: number;
	lifecycle: string;
	scope: string;
	session_id: string;
	created_at: number;
	updated_at: number;
	times_injected: number;
	times_helped: number;
	times_ignored: number;
}

/** Compute Jaccard similarity using character bigrams (fast, language-agnostic). */
function jaccardSimilarity(a: string, b: string): number {
	const setA = new Set<string>();
	const setB = new Set<string>();
	const aNorm = a.toLowerCase().trim();
	const bNorm = b.toLowerCase().trim();
	if (aNorm === bNorm) return 1;
	const minLen = Math.min(aNorm.length, bNorm.length);
	if (minLen <= 3) return aNorm === bNorm ? 1 : 0;
	for (let i = 0; i < aNorm.length - 1; i++) setA.add(aNorm.slice(i, i + 2));
	for (let i = 0; i < bNorm.length - 1; i++) setB.add(bNorm.slice(i, i + 2));
	let intersection = 0;
	for (const g of setA) if (setB.has(g)) intersection++;
	const union = setA.size + setB.size - intersection;
	return union === 0 ? 0 : intersection / union;
}
function rowToLearning(row: RawLearningRow): Learning {
	return {
		id: row.id,
		cwd: row.cwd,
		kind: row.kind as LearningKind,
		content: row.content,
		source: row.source as LearningSource,
		confidence: row.confidence,
		lifecycle: row.lifecycle as LearningLifecycle,
		scope: row.scope as LearningScope,
		sessionId: row.session_id,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		timesInjected: row.times_injected,
		timesHelped: row.times_helped,
		timesIgnored: row.times_ignored,
	};
}

export class SqliteLearningStore {
	#db: Database;
	#insertStmt: Statement;
	#updateLifecycleStmt: Statement;
	#mergeStmt: Statement;

	constructor(db: Database) {
		this.#db = db;
		this.#insertStmt = db.prepare(`
			INSERT INTO learnings (
				id, cwd, kind, content, source, confidence, lifecycle, session_id,
				created_at, updated_at, times_injected, times_helped, times_ignored, scope
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				confidence = MAX(learnings.confidence, excluded.confidence),
				updated_at = excluded.updated_at,
				lifecycle = CASE
					WHEN learnings.lifecycle = 'archived' THEN learnings.lifecycle
					WHEN learnings.source = 'manual_pin' THEN 'active'
					ELSE learnings.lifecycle
				END
		`);
		this.#updateLifecycleStmt = db.prepare("UPDATE learnings SET lifecycle = ?, updated_at = ? WHERE id = ?");
		this.#mergeStmt = db.prepare(`
			UPDATE learnings SET
				confidence = MAX(confidence, ?),
				lifecycle = CASE
					WHEN lifecycle = 'archived' THEN 'archived'
					WHEN ? = 'active' THEN 'active'
					ELSE lifecycle
				END,
				scope = CASE
					WHEN scope = 'global' OR ? = 'global' THEN 'global'
					ELSE scope
				END,
				times_injected = times_injected + ?,
				times_helped = times_helped + ?,
				times_ignored = times_ignored + ?,
				updated_at = ?
			WHERE id = ?
		`);
	}

	async insert(learning: Learning): Promise<void> {
		if (!validateLearningContent(learning.content)) return;

		const duplicate = await this.#findDuplicate(learning);
		if (duplicate) {
			this.#mergeStmt.run(
				learning.confidence,
				learning.lifecycle,
				learning.scope,
				learning.timesInjected,
				learning.timesHelped,
				learning.timesIgnored,
				Date.now(),
				duplicate.id,
			);
			return;
		}

		this.#insertStmt.run(
			learning.id,
			learning.cwd,
			learning.kind,
			learning.content,
			learning.source,
			learning.confidence,
			learning.lifecycle,
			learning.sessionId,
			learning.createdAt,
			learning.updatedAt,
			learning.timesInjected,
			learning.timesHelped,
			learning.timesIgnored,
			learning.scope,
		);
	}

	async get(id: string): Promise<Learning | undefined> {
		const row = this.#db.prepare("SELECT * FROM learnings WHERE id = ?").get(id) as RawLearningRow | null;
		return row ? rowToLearning(row) : undefined;
	}
	async #findDuplicate(learning: Learning): Promise<Learning | undefined> {
		const rows = this.#db
			.prepare("SELECT * FROM learnings WHERE kind = ? AND cwd = ?")
			.all(learning.kind, learning.cwd) as RawLearningRow[];
		for (const row of rows) {
			const sim = jaccardSimilarity(learning.content, row.content);
			if (sim >= 0.75) return rowToLearning(row);
		}
		return undefined;
	}

	async listAll(): Promise<Learning[]> {
		const rows = this.#db.prepare("SELECT * FROM learnings ORDER BY updated_at DESC").all() as RawLearningRow[];
		return rows.map(rowToLearning);
	}

	async listForInjection(cwd: string, limit = 8): Promise<Learning[]> {
		const all = await this.listAll();
		return all
			.filter(l => l.cwd === cwd && isLearningEligibleForInjection(l))
			.sort((a, b) => {
				if (a.source === "manual_pin" && b.source !== "manual_pin") return -1;
				if (b.source === "manual_pin" && a.source !== "manual_pin") return 1;
				return b.confidence - a.confidence || b.updatedAt - a.updatedAt;
			})
			.slice(0, limit);
	}

	async recordInjection(id: string): Promise<void> {
		this.#db
			.prepare("UPDATE learnings SET times_injected = times_injected + 1, updated_at = ? WHERE id = ?")
			.run(Date.now(), id);
	}

	async recordOutcome(id: string, helped: boolean): Promise<void> {
		if (helped) {
			this.#db
				.prepare("UPDATE learnings SET times_helped = times_helped + 1, updated_at = ? WHERE id = ?")
				.run(Date.now(), id);
		} else {
			this.#db
				.prepare("UPDATE learnings SET times_ignored = times_ignored + 1, updated_at = ? WHERE id = ?")
				.run(Date.now(), id);
		}
	}

	async pin(id: string): Promise<boolean> {
		const row = await this.get(id);
		if (!row) return false;
		this.#db
			.prepare(
				"UPDATE learnings SET source = 'manual_pin', lifecycle = 'active', confidence = MAX(confidence, 5), updated_at = ? WHERE id = ?",
			)
			.run(Date.now(), id);
		return true;
	}

	async archive(id: string): Promise<boolean> {
		const row = await this.get(id);
		if (!row) return false;
		this.#updateLifecycleStmt.run("archived", Date.now(), id);
		return true;
	}

	async delete(id: string): Promise<boolean> {
		const result = this.#db.prepare("DELETE FROM learnings WHERE id = ?").run(id);
		return result.changes > 0;
	}

	async refreshLifecycles(): Promise<{ reclassified: number; promoted: number }> {
		let reclassified = 0;
		let promoted = 0;
		const all = await this.listAll();
		const now = Date.now();
		for (const l of all) {
			const next = classifyLearningLifecycle(l);
			if (next !== l.lifecycle) {
				this.#updateLifecycleStmt.run(next, now, l.id);
				reclassified++;
				if (next === "active" && l.lifecycle !== "active") promoted++;
			}
		}
		return { reclassified, promoted };
	}
}
