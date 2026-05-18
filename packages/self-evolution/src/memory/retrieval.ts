/**
 * Composite scoring retrieval for vector embeddings.
 *
 * Scoring formula: 0.5 * similarity + 0.3 * recency + 0.2 * importance
 */
import type { Database } from "bun:sqlite";
import { logger } from "@oh-my-pi/pi-utils";
import { searchVectorEmbeddings, type VectorEmbedding } from "./storage";

export interface CompositeSearchParams {
	namespace: string;
	queryEmbedding: number[];
	topK: number;
	minSimilarity?: number;
	/** Max age in days for recency scoring (default: 30) */
	recencyWindowDays?: number;
}

export interface CompositeSearchResult {
	embedding: VectorEmbedding;
	/** Cosine similarity 0-1 */
	similarity: number;
	/** Recency score 0-1 */
	recency: number;
	/** Normalized importance 0-1 */
	importance: number;
	/** Composite score 0-100 */
	compositeScore: number;
}

/**
 * Search embeddings with composite scoring:
 *   composite = 0.5 * similarity + 0.3 * recency + 0.2 * importance
 *
 * Recency decays linearly over recencyWindowDays (default 30).
 * Importance is used as-is (assumed 0-1 range).
 */
export function searchWithCompositeScore(db: Database, params: CompositeSearchParams): CompositeSearchResult[] {
	const { namespace, queryEmbedding, topK, minSimilarity = 0, recencyWindowDays = 30 } = params;

	const now = Date.now();
	const recencyMs = recencyWindowDays * 24 * 60 * 60 * 1000;

	// Stage 1: Get candidates via vector similarity (with a generous over-retrieval factor)
	const candidates = searchVectorEmbeddings(db, {
		namespace,
		queryEmbedding,
		topK: topK * 3, // 3x over-retrieval for re-ranking
		minSimilarity,
	});

	if (candidates.length === 0) return [];

	// Stage 2: Compute composite scores
	const scored: CompositeSearchResult[] = candidates.map(c => {
		const daysAgo = (now - c.embedding.lastAccessedAt) / recencyMs;
		const recency = Math.max(0, 1 - daysAgo);

		return {
			embedding: c.embedding,
			similarity: c.similarity,
			recency,
			importance: c.embedding.importance,
			compositeScore: Math.round((c.similarity * 0.5 + recency * 0.3 + c.embedding.importance * 0.2) * 100),
		};
	});

	// Stage 3: Sort by composite score and return topK
	scored.sort((a, b) => b.compositeScore - a.compositeScore);
	const results = scored.slice(0, topK);

	logger.debug("Composite vector search complete", {
		namespace,
		candidates: candidates.length,
		returned: results.length,
		topScore: results[0]?.compositeScore,
	});

	return results;
}

/**
 * Update last_accessed_at for a set of embedding IDs.
 * Call this after retrieving results to keep recency scoring accurate.
 */
export function touchEmbeddings(db: Database, ids: string[]): void {
	if (ids.length === 0) return;
	const now = Date.now();
	const stmt = db.prepare("UPDATE vector_embeddings SET last_accessed_at = ? WHERE id = ?");
	for (const id of ids) {
		stmt.run(now, id);
	}
	stmt.finalize();
}

/**
 * Batch insert embeddings with auto-generated IDs.
 */
export function batchInsertEmbeddings(
	db: Database,
	namespace: string,
	items: Array<{ content: string; embedding: number[]; metadata?: Record<string, unknown>; importance?: number }>,
): void {
	const now = Date.now();
	const { insertVectorEmbedding } = require("./storage");
	for (const item of items) {
		insertVectorEmbedding(db, {
			id: `${namespace}-${crypto.randomUUID()}`,
			namespace,
			content: item.content,
			embedding: item.embedding,
			metadata: item.metadata,
			importance: item.importance ?? 0.5,
			createdAt: now,
			lastAccessedAt: now,
		});
	}
}
