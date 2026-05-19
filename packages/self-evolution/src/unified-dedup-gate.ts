/**
 * Unified Dedup Gate (Phase 3 — §6.8).
 *
 * Single entry point for extracted items (skills, raw_memory)
 * before they enter the Cognitive Pipeline. Ensures no semantic overlap
 * across sources.
 */
import { logger } from "@oh-my-pi/pi-utils";
export interface DedupEntry {
	/** Unique identifier */
	id: string;
	/** Source type */
	source: "skill" | "raw_memory";
	/** Semantic content for comparison */
	content: string;
	/** Confidence/provenance metadata */
	confidence: number;
	provenance: "user_stated" | "implied" | "inferred" | "fallback";
	/** Original object */
	original: unknown;
}

export interface DedupResult {
	/** Non-overlapping items */
	kept: DedupEntry[];
	/** Items removed as duplicates */
	duplicates: Array<{ kept: DedupEntry; removed: DedupEntry; similarity: number }>;
	/** Items with provenance conflicts */
	conflicts: Array<{ winner: DedupEntry; loser: DedupEntry; reason: string }>;
}

/**
 * Compute a simple Jaccard similarity between two texts based on word overlap.
 */
function jaccardSimilarity(a: string, b: string): number {
	const normalize = (s: string) =>
		s
			.toLowerCase()
			.replace(/[^\w\s]/g, " ")
			.split(/\s+/)
			.filter(w => w.length > 2);

	const wordsA = new Set(normalize(a));
	const wordsB = new Set(normalize(b));

	if (wordsA.size === 0 && wordsB.size === 0) return 0;

	const intersection = new Set([...wordsA].filter(w => wordsB.has(w)));
	const union = new Set([...wordsA, ...wordsB]);

	return intersection.size / Math.max(union.size, 1);
}

const PROVENANCE_RANK: Record<DedupEntry["provenance"], number> = {
	user_stated: 4,
	implied: 3,
	inferred: 2,
	fallback: 1,
};

const SIMILARITY_THRESHOLD = 0.85;

/**
 * Deduplicate a mixed list of conventions, skills, and raw_memory entries.
 *
 * - Jaccard similarity ≥ 0.85 ⇒ duplicate → keep higher provenance
 * - Same provenance ⇒ keep higher confidence
 * - Different sources with overlap ⇒ conflict → provenance wins
 */
export function deduplicateEntries(entries: DedupEntry[]): DedupResult {
	const result: DedupResult = { kept: [], duplicates: [], conflicts: [] };
	if (entries.length === 0) return result;

	// Sort by provenance rank desc, then confidence desc
	const ranked = [...entries].sort((a, b) => {
		const rankDiff = PROVENANCE_RANK[b.provenance] - PROVENANCE_RANK[a.provenance];
		if (rankDiff !== 0) return rankDiff;
		return b.confidence - a.confidence;
	});

	const _kept = new Set<number>();
	const removed = new Set<number>();

	for (let i = 0; i < ranked.length; i++) {
		if (removed.has(i)) continue;

		for (let j = i + 1; j < ranked.length; j++) {
			if (removed.has(j)) continue;

			const sim = jaccardSimilarity(ranked[i]!.content, ranked[j]!.content);

			if (sim >= SIMILARITY_THRESHOLD) {
				// Items are semantically similar — decide which to keep
				const rankI = PROVENANCE_RANK[ranked[i]!.provenance];
				const rankJ = PROVENANCE_RANK[ranked[j]!.provenance];

				if (rankI > rankJ) {
					// i wins, j is duplicate
					removed.add(j);
					result.duplicates.push({ kept: ranked[i]!, removed: ranked[j]!, similarity: sim });
				} else if (rankJ > rankI) {
					// j wins, i is duplicate
					removed.add(i);
					result.duplicates.push({ kept: ranked[j]!, removed: ranked[i]!, similarity: sim });
				} else {
					// Same provenance — higher confidence wins
					if (ranked[i]!.confidence >= ranked[j]!.confidence) {
						removed.add(j);
						result.duplicates.push({ kept: ranked[i]!, removed: ranked[j]!, similarity: sim });
					} else {
						removed.add(i);
						result.duplicates.push({ kept: ranked[j]!, removed: ranked[i]!, similarity: sim });
					}
				}
			} else if (sim >= 0.5 && ranked[i]!.source !== ranked[j]!.source) {
				// Cross-source overlap — flag as potential conflict
				const rankI = PROVENANCE_RANK[ranked[i]!.provenance];
				const rankJ = PROVENANCE_RANK[ranked[j]!.provenance];

				const winner = rankI >= rankJ ? ranked[i]! : ranked[j]!;
				const loser = rankI >= rankJ ? ranked[j]! : ranked[i]!;

				result.conflicts.push({
					winner,
					loser,
					reason: `Cross-source overlap (${ranked[i]!.source} vs ${ranked[j]!.source}, similarity: ${sim.toFixed(2)})`,
				});
			}
		}
	}

	for (let i = 0; i < ranked.length; i++) {
		if (!removed.has(i)) {
			result.kept.push(ranked[i]!);
		}
	}

	logger.debug("UnifiedDedupGate complete", {
		total: entries.length,
		kept: result.kept.length,
		duplicates: result.duplicates.length,
		conflicts: result.conflicts.length,
	});

	return result;
}

