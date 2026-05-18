/**
 * Vector-aware retrieval: blends vector similarity with the existing
 * keyword-based ContextAwareRetriever for enhanced semantic search.
 *
 * Architecture §7.3: composite_score = 0.50 × semantic + 0.30 × recency + 0.20 × importance.
 * With vector search, the semantic component uses cosine similarity of embeddings
 * instead of Jaccard word overlap.
 */
import type { Database } from "bun:sqlite";
import { logger } from "@oh-my-pi/pi-utils";
import type { EmbeddingGenerator } from "./embedding";
import { cosineSimilarity, VectorStore } from "./vector-store";

export interface VectorRetrievalResult {
	id: string;
	namespace: string;
	content: string;
	similarity: number;
	metadata?: Record<string, unknown>;
}

/**
 * Perform vector similarity search against the vec_embeddings table.
 * Falls back gracefully when no embedding generator or vector store is available.
 */
export async function vectorSearch(
	db: Database | undefined,
	generator: EmbeddingGenerator | undefined,
	query: string,
	options: { namespace?: string; minSimilarity?: number; limit?: number } = {},
): Promise<VectorRetrievalResult[]> {
	if (!db || !generator) {
		return [];
	}

	try {
		const store = new VectorStore(db);
		const { embedding } = await generator.embed(query);

		if (embedding.every(v => v === 0)) {
			logger.debug("Vector search: zero embedding, skipping");
			return [];
		}

		const results = store.search(embedding, {
			namespace: options.namespace,
			minSimilarity: options.minSimilarity ?? 0.3,
			limit: options.limit ?? 10,
		});

		return results.map(r => ({
			id: r.entry.id,
			namespace: r.entry.namespace,
			content: r.entry.content,
			similarity: r.similarity,
			metadata: r.entry.metadata,
		}));
	} catch (err) {
		logger.warn("Vector search failed", { error: String(err) });
		return [];
	}
}

/**
 * Compute vector-enhanced composite score between a query and retrieval candidates.
 * Uses embedding similarity when available, falls back to Jaccard overlap.
 *
 * @param queryEmbedding - Query vector (optional, falls back to keyword Jaccard)
 * @param candidateEmbedding - Candidate vector (optional)
 * @param queryKeywords - Query keywords for Jaccard fallback
 * @param candidateText - Candidate text for Jaccard fallback
 * @param lastUsedAt - Timestamp of last use for recency decay
 * @param confidenceScore - Confidence score for importance component (0-100)
 * @returns Composite score in [0, 1]
 */
export function vectorCompositeScore(
	queryEmbedding: Float32Array | undefined,
	candidateEmbedding: Float32Array | undefined,
	queryKeywords: string[],
	candidateText: string,
	lastUsedAt: number | undefined,
	confidenceScore: number,
	now: number = Date.now(),
): number {
	const SEMANTIC_WEIGHT = 0.5;
	const RECENCY_WEIGHT = 0.3;
	const IMPORTANCE_WEIGHT = 0.2;

	// Semantic similarity: vector cosine > Jaccard word overlap
	let semanticSim: number;
	if (queryEmbedding && candidateEmbedding) {
		try {
			semanticSim = cosineSimilarity(queryEmbedding, candidateEmbedding);
		} catch {
			semanticSim = jaccardSimilarity(queryKeywords, candidateText);
		}
	} else {
		semanticSim = jaccardSimilarity(queryKeywords, candidateText);
	}

	// Recency decay
	const daysSinceLastUse = lastUsedAt ? (now - lastUsedAt) / (1000 * 60 * 60 * 24) : 365;
	const recencyDecay = 0.5 ** (daysSinceLastUse / 30);

	// Importance
	const importanceScore = confidenceScore / 100;

	return SEMANTIC_WEIGHT * semanticSim + RECENCY_WEIGHT * recencyDecay + IMPORTANCE_WEIGHT * importanceScore;
}

/**
 * Jaccard word overlap similarity between query keywords and candidate text.
 * Returns value in [0, 1].
 */
function jaccardSimilarity(queryKeywords: string[], candidateText: string): number {
	if (queryKeywords.length === 0) return 0;
	const normalized = candidateText.toLowerCase();
	let matches = 0;
	for (const kw of queryKeywords) {
		if (normalized.includes(kw)) matches++;
	}
	return matches / queryKeywords.length;
}
