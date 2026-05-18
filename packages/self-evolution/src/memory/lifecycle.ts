/**
 * Memory lifecycle management: exponential decay, threshold pruning, and merging.
 *
 * Implements forgetting/elimination algorithms for vector embeddings.
 */
import type { Database } from "bun:sqlite";
import { logger } from "@oh-my-pi/pi-utils";

export interface LifecycleOptions {
	/** Half-life in days for exponential decay (default: 30) */
	decayHalfLifeDays: number;
	/** Minimum importance threshold below which entries are pruned (default: 0.1) */
	minImportanceThreshold: number;
	/** Maximum entries per namespace before forced pruning (default: 1000) */
	maxEntriesPerNamespace: number;
	/** Cosine similarity threshold for merging similar entries (default: 0.95) */
	mergeSimilarityThreshold: number;
}

export const DEFAULT_LIFECYCLE_OPTIONS: LifecycleOptions = {
	decayHalfLifeDays: 30,
	minImportanceThreshold: 0.1,
	maxEntriesPerNamespace: 1000,
	mergeSimilarityThreshold: 0.95,
};

export interface MemoryEntry {
	id: string;
	namespace: string;
	content: string;
	embedding: number[];
	importance: number;
	createdAt: number;
	lastAccessedAt: number;
	accessCount: number;
}

/**
 * Calculate the decayed importance score of an entry.
 *
 * Uses exponential decay based on days since last access:
 *   score = importance * (0.5 ^ (daysSinceAccess / halfLife))
 */
export function calculateDecayScore(entry: MemoryEntry, options: LifecycleOptions): number {
	const daysSinceAccess = (Date.now() - entry.lastAccessedAt) / (24 * 60 * 60 * 1000);
	const decayFactor = 0.5 ** (daysSinceAccess / options.decayHalfLifeDays);
	return entry.importance * decayFactor;
}

/**
 * Compute cosine similarity between two embeddings.
 */
function cosineSimilarity(a: number[], b: number[]): number {
	if (a.length !== b.length) return 0;
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}
	if (normA === 0 || normB === 0) return 0;
	return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Prune entries whose decayed score falls below the threshold.
 * Also enforces maxEntriesPerNamespace by removing lowest-scored entries.
 */
export function pruneExpired(db: Database, namespace: string, options: LifecycleOptions): number {
	const rows = db
		.prepare(
			"SELECT id, content, embedding_json, importance, created_at, last_accessed_at FROM vector_embeddings WHERE namespace = ?",
		)
		.all(namespace) as Array<{
		id: string;
		content: string;
		embedding_json: string;
		importance: number;
		created_at: number;
		last_accessed_at: number;
	}>;

	if (rows.length === 0) return 0;

	const entries: Array<{ id: string; score: number }> = rows.map(row => {
		const entry: MemoryEntry = {
			id: row.id,
			namespace,
			content: row.content,
			embedding: JSON.parse(row.embedding_json) as number[],
			importance: row.importance,
			createdAt: row.created_at,
			lastAccessedAt: row.last_accessed_at,
			accessCount: 0, // not tracked in DB yet
		};
		return { id: row.id, score: calculateDecayScore(entry, options) };
	});

	// Mark entries below threshold for deletion
	const toDelete = new Set<string>();
	for (const e of entries) {
		if (e.score < options.minImportanceThreshold) {
			toDelete.add(e.id);
		}
	}

	// If still over max, remove lowest scored until under limit
	if (rows.length - toDelete.size > options.maxEntriesPerNamespace) {
		const survivors = entries.filter(e => !toDelete.has(e.id));
		survivors.sort((a, b) => a.score - b.score);
		const excess = survivors.length - options.maxEntriesPerNamespace;
		for (let i = 0; i < excess; i++) {
			toDelete.add(survivors[i]!.id);
		}
	}

	if (toDelete.size > 0) {
		const stmt = db.prepare("DELETE FROM vector_embeddings WHERE id = ?");
		for (const id of toDelete) {
			stmt.run(id);
		}
		stmt.finalize();
	}

	logger.debug("Pruned expired embeddings", { namespace, pruned: toDelete.size, total: rows.length });
	return toDelete.size;
}

/**
 * Find and merge highly similar entries within a namespace.
 *
 * When two entries have cosine similarity >= threshold:
 * - Keep the one with higher importance
 * - Merge metadata JSON (if present)
 * - Update content to be the longer/more specific of the two
 */
export function mergeSimilar(db: Database, namespace: string, options: LifecycleOptions): number {
	const rows = db
		.prepare(
			"SELECT id, content, embedding_json, metadata_json, importance, created_at, last_accessed_at FROM vector_embeddings WHERE namespace = ?",
		)
		.all(namespace) as Array<{
		id: string;
		content: string;
		embedding_json: string;
		metadata_json: string | null;
		importance: number;
		created_at: number;
		last_accessed_at: number;
	}>;

	if (rows.length < 2) return 0;

	const entries = rows.map(row => ({
		id: row.id,
		content: row.content,
		embedding: JSON.parse(row.embedding_json) as number[],
		metadata: row.metadata_json ? (JSON.parse(row.metadata_json) as Record<string, unknown>) : undefined,
		importance: row.importance,
		createdAt: row.created_at,
		lastAccessedAt: row.last_accessed_at,
	}));

	const merged = new Set<string>();
	let mergeCount = 0;

	for (let i = 0; i < entries.length; i++) {
		if (merged.has(entries[i]!.id)) continue;

		for (let j = i + 1; j < entries.length; j++) {
			if (merged.has(entries[j]!.id)) continue;

			const sim = cosineSimilarity(entries[i]!.embedding, entries[j]!.embedding);
			if (sim >= options.mergeSimilarityThreshold) {
				const a = entries[i]!;
				const b = entries[j]!;

				// Keep the higher-importance one as the survivor
				const survivor = a.importance >= b.importance ? a : b;
				const victim = a.importance >= b.importance ? b : a;

				// Merge content (keep longer)
				const mergedContent = survivor.content.length >= victim.content.length ? survivor.content : victim.content;

				// Merge metadata
				const mergedMetadata = { ...victim.metadata, ...survivor.metadata };

				// Update survivor
				const updateStmt = db.prepare(`
					UPDATE vector_embeddings
					SET content = ?,
						metadata_json = ?,
						importance = MAX(importance, ?),
						last_accessed_at = ?
					WHERE id = ?
				`);
				updateStmt.run(mergedContent, JSON.stringify(mergedMetadata), victim.importance, Date.now(), survivor.id);
				updateStmt.finalize();

				// Delete victim
				const deleteStmt = db.prepare("DELETE FROM vector_embeddings WHERE id = ?");
				deleteStmt.run(victim.id);
				deleteStmt.finalize();

				merged.add(victim.id);
				mergeCount++;

				logger.debug("Merged similar embeddings", {
					survivor: survivor.id,
					victim: victim.id,
					similarity: sim,
				});
			}
		}
	}

	return mergeCount;
}

/**
 * Run full lifecycle maintenance: prune expired, then merge similar.
 */
export function runLifecycleMaintenance(
	db: Database,
	options: Partial<LifecycleOptions> = {},
): { pruned: number; merged: number } {
	const opts = { ...DEFAULT_LIFECYCLE_OPTIONS, ...options };

	// Get all namespaces
	const nsRows = db.prepare("SELECT DISTINCT namespace FROM vector_embeddings").all() as Array<{ namespace: string }>;

	let totalPruned = 0;
	let totalMerged = 0;

	for (const { namespace } of nsRows) {
		totalPruned += pruneExpired(db, namespace, opts);
		totalMerged += mergeSimilar(db, namespace, opts);
	}

	logger.debug("Lifecycle maintenance complete", {
		pruned: totalPruned,
		merged: totalMerged,
		namespaces: nsRows.length,
	});

	return { pruned: totalPruned, merged: totalMerged };
}
