/**
 * Vector Store: Pure-JS cosine-similarity vector search over SQLite-stored embeddings.
 *
 * Stores Float32Array embeddings as BLOBs in the vec_embeddings table.
 * Search computes cosine similarity in TypeScript — fast enough for
 * collections up to ~10K embeddings without native extensions.
 */
import type { Database, Statement } from "bun:sqlite";
import { logger } from "@oh-my-pi/pi-utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VectorEntry {
	id: string;
	namespace: string;
	content: string;
	embedding: Float32Array;
	metadata?: Record<string, unknown>;
	createdAt: number;
	updatedAt: number;
}

export interface VectorSearchResult {
	entry: VectorEntry;
	similarity: number;
}

export interface VectorSearchOptions {
	namespace?: string;
	minSimilarity?: number;
	limit?: number;
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

function serializeEmbedding(vec: Float32Array): Buffer {
	return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

function deserializeEmbedding(blob: Buffer): Float32Array {
	return new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));
}

// ---------------------------------------------------------------------------
// Cosine similarity
// ---------------------------------------------------------------------------

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
	if (a.length !== b.length) {
		throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
	}
	let dotProduct = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < a.length; i++) {
		dotProduct += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}
	const denom = Math.sqrt(normA) * Math.sqrt(normB);
	if (denom === 0) return 0;
	return dotProduct / denom;
}

// ---------------------------------------------------------------------------
// VectorStore
// ---------------------------------------------------------------------------

export class VectorStore {
	#db: Database;
	#insertStmt: Statement;
	#allStmt: Statement;
	#byNamespaceStmt: Statement;
	#deleteStmt: Statement;
	#countStmt: Statement;
	#countByNsStmt: Statement;

	constructor(db: Database) {
		this.#db = db;
		this.#insertStmt = db.prepare(`
			INSERT OR REPLACE INTO vec_embeddings (id, namespace, content, embedding, metadata_json, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)
		`);
		this.#allStmt = db.prepare(
			"SELECT id, namespace, content, embedding, metadata_json, created_at, updated_at FROM vec_embeddings",
		);
		this.#byNamespaceStmt = db.prepare(
			"SELECT id, namespace, content, embedding, metadata_json, created_at, updated_at FROM vec_embeddings WHERE namespace = ?",
		);
		this.#deleteStmt = db.prepare("DELETE FROM vec_embeddings WHERE id = ?");
		this.#countStmt = db.prepare("SELECT COUNT(*) as c FROM vec_embeddings");
		this.#countByNsStmt = db.prepare("SELECT COUNT(*) as c FROM vec_embeddings WHERE namespace = ?");
	}

	/**
	 * Store or update a vector embedding.
	 */
	upsert(entry: VectorEntry): void {
		const now = Date.now();
		this.#insertStmt.run(
			entry.id,
			entry.namespace,
			entry.content,
			serializeEmbedding(entry.embedding),
			entry.metadata ? JSON.stringify(entry.metadata) : null,
			entry.createdAt || now,
			now,
		);
	}

	/**
	 * Delete a vector entry by ID.
	 */
	delete(id: string): void {
		this.#deleteStmt.run(id);
	}

	/**
	 * Count entries, optionally filtered by namespace.
	 */
	count(namespace?: string): number {
		const row = (namespace ? this.#countByNsStmt.get(namespace) : this.#countStmt.get()) as { c: number } | undefined;
		return row?.c ?? 0;
	}

	/**
	 * Search for the most similar entries to the given query vector.
	 * Returns results sorted by cosine similarity descending.
	 */
	search(queryVec: Float32Array, options: VectorSearchOptions = {}): VectorSearchResult[] {
		const { namespace, minSimilarity = 0.3, limit = 10 } = options;

		const rows = namespace ? (this.#byNamespaceStmt.all(namespace) as any[]) : (this.#allStmt.all() as any[]);

		const results: VectorSearchResult[] = [];

		for (const row of rows) {
			const embedding = row.embedding ? deserializeEmbedding(row.embedding as Buffer) : undefined;
			if (!embedding) continue;

			const similarity = cosineSimilarity(queryVec, embedding);
			if (similarity < minSimilarity) continue;

			results.push({
				entry: {
					id: row.id,
					namespace: row.namespace,
					content: row.content,
					embedding,
					metadata: row.metadata_json ? JSON.parse(row.metadata_json) : undefined,
					createdAt: row.created_at,
					updatedAt: row.updated_at,
				},
				similarity,
			});
		}

		results.sort((a, b) => b.similarity - a.similarity);
		return results.slice(0, limit);
	}

	/**
	 * Load all entries for batch processing.
	 */
	allEntries(): VectorEntry[] {
		const rows = this.#allStmt.all() as any[];
		return rows.map(row => ({
			id: row.id,
			namespace: row.namespace,
			content: row.content,
			embedding: row.embedding ? deserializeEmbedding(row.embedding as Buffer) : new Float32Array(0),
			metadata: row.metadata_json ? JSON.parse(row.metadata_json) : undefined,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		}));
	}

	/**
	 * Delete entries by namespace.
	 */
	deleteByNamespace(namespace: string): void {
		const stmt = this.#db.prepare("DELETE FROM vec_embeddings WHERE namespace = ?");
		const result = stmt.run(namespace);
		logger.debug("VectorStore: deleted entries by namespace", {
			namespace,
			count: (result as { changes: number }).changes,
		});
	}

	/** Get count per namespace for stats. */
	namespaceStats(): Array<{ namespace: string; count: number }> {
		const rows = this.#db
			.prepare("SELECT namespace, COUNT(*) as c FROM vec_embeddings GROUP BY namespace ORDER BY c DESC")
			.all() as Array<{ namespace: string; c: number }>;
		return rows.map(r => ({ namespace: r.namespace, count: r.c }));
	}
}
