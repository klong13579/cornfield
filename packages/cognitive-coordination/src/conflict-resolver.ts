/**
 * Conflict Resolver
 *
 * Phase 4: Detects and resolves conflicts among skill/content items.
 * Supports three conflict types: contradiction, redundancy, and overlap.
 */

export type ConflictType = "contradiction" | "overlap" | "redundancy";
export type ProvenanceLevel = "user_stated" | "implied" | "inferred" | "fallback";

export interface ConflictItem {
	id: string;
	content: string;
	provenance: ProvenanceLevel;
}

export interface ConflictReport {
	itemA: { id: string; content: string; provenance: ProvenanceLevel };
	itemB: { id: string; content: string; provenance: ProvenanceLevel };
	conflictType: ConflictType;
	winner: { id: string; content: string };
	loser: { id: string; content: string };
	reason: string;
}

const PROVENANCE_PRIORITY: ReadonlyMap<ProvenanceLevel, number> = new Map([
	["user_stated", 4],
	["implied", 3],
	["inferred", 2],
	["fallback", 1],
]);

const NEGATION_WORDS =
	/\b(?:don't|doesn't|didn't|won't|wouldn't|shouldn't|couldn't|never|avoid|must\s+not)\b|\b(no|not)\s+/gi;

/** Common English stop words filtered out during overlap computation. */
const STOP_WORDS = new Set([
	"a",
	"an",
	"the",
	"is",
	"are",
	"was",
	"were",
	"be",
	"been",
	"being",
	"have",
	"has",
	"had",
	"do",
	"does",
	"did",
	"will",
	"would",
	"could",
	"should",
	"may",
	"might",
	"shall",
	"can",
	"need",
	"dare",
	"ought",
	"used",
	"to",
	"of",
	"in",
	"for",
	"on",
	"with",
	"at",
	"by",
	"from",
	"as",
	"into",
	"through",
	"during",
	"before",
	"after",
	"above",
	"below",
	"between",
	"out",
	"off",
	"over",
	"under",
	"again",
	"further",
	"then",
	"once",
	"here",
	"there",
	"when",
	"where",
	"why",
	"how",
	"all",
	"each",
	"every",
	"both",
	"few",
	"more",
	"most",
	"other",
	"some",
	"such",
	"no",
	"nor",
	"not",
	"only",
	"own",
	"same",
	"so",
	"than",
	"too",
	"very",
	"just",
	"because",
	"but",
	"and",
	"or",
	"if",
	"while",
	"about",
	"up",
	"down",
	"since",
	"until",
	"also",
	"its",
	"it",
	"you",
	"your",
	"he",
	"she",
	"they",
	"we",
	"them",
	"this",
	"that",
]);

/**
 * Normalize content for comparison: lowercase, strip punctuation, collapse whitespace, remove stop words.
 */
function normalizeContent(content: string): string {
	const lower = content
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s]/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!lower) return "";
	return lower
		.split(" ")
		.filter(w => w.length > 0 && !STOP_WORDS.has(w))
		.join(" ");
}

/**
 * Split normalized content into word tokens. Returns sorted array for consistent comparison.
 */
function tokenize(normalized: string): string[] {
	if (!normalized) return [];
	return normalized.split(" ").sort();
}

/**
 * Word overlap ratio: fraction of tokens from the shorter set found in the longer set.
 * More robust than Jaccard when comparing sentences of different lengths discussing the same topic.
 */
function wordOverlap(wordsA: readonly string[], wordsB: readonly string[]): number {
	const setA = new Set(wordsA);
	const setB = new Set(wordsB);

	if (setA.size === 0 && setB.size === 0) return 0;

	let intersection = 0;
	for (const w of setA) {
		if (setB.has(w)) intersection++;
	}

	const minSize = Math.min(setA.size, setB.size);
	return minSize > 0 ? intersection / minSize : 0;
}

/**
 * Check if content contains negation indicators.
 */
function hasNegation(content: string): boolean {
	return NEGATION_WORDS.test(content);
}

/**
 * Arbitrate between two items based on provenance priority, then content length.
 * Returns [winnerId, loserId].
 */
function arbitrate(a: ConflictItem, b: ConflictItem): [string, string] {
	const priorityA = PROVENANCE_PRIORITY.get(a.provenance) ?? 0;
	const priorityB = PROVENANCE_PRIORITY.get(b.provenance) ?? 0;

	if (priorityA !== priorityB) {
		return priorityA > priorityB ? [a.id, b.id] : [b.id, a.id];
	}

	// Same level: longer content wins (more detail)
	if (a.content.length !== b.content.length) {
		return a.content.length >= b.content.length ? [a.id, b.id] : [b.id, a.id];
	}

	// Tie: stable sort by id
	return a.id <= b.id ? [a.id, b.id] : [b.id, a.id];
}

/**
 * Class responsible for detecting and resolving conflicts among content items.
 * Uses ES native # private fields.
 */
export class ConflictResolver {
	readonly #similarityThresholds: { contradiction: number; redundancy: number; overlap: number };

	constructor(options?: { contradictionThreshold?: number; redundancyThreshold?: number; overlapThreshold?: number }) {
		this.#similarityThresholds = {
			contradiction: options?.contradictionThreshold ?? 0.5,
			redundancy: options?.redundancyThreshold ?? 0.8,
			overlap: options?.overlapThreshold ?? 0.5,
		};
	}

	/**
	 * Detect all pairwise conflicts among a list of items.
	 *
	 * Conflict types:
	 * - "contradiction": items express opposing meanings (one has negation, other doesn't)
	 *   with >= 50% word overlap.
	 * - "redundancy": items are near-identical (>= 80% word overlap) with same polarity.
	 * - "overlap": items share significant content (>= 50% word overlap) but differ enough.
	 */
	detectConflicts(items: ConflictItem[]): ConflictReport[] {
		if (items.length < 2) return [];

		const reports: ConflictReport[] = [];

		for (let i = 0; i < items.length; i++) {
			for (let j = i + 1; j < items.length; j++) {
				const a = items[i];
				const b = items[j];

				const normalizedA = normalizeContent(a.content);
				const normalizedB = normalizeContent(b.content);

				const wordsA = tokenize(normalizedA);
				const wordsB = tokenize(normalizedB);

				const similarity = wordOverlap(wordsA, wordsB);
				if (similarity === 0) continue;

				const aNegates = hasNegation(a.content);
				const bNegates = hasNegation(b.content);

				let conflictType: ConflictType | null = null;
				let reason: string | null = null;

				// Priority 1: Contradiction (opposite polarity, sufficient overlap)
				if (
					(aNegates || bNegates) &&
					!(aNegates && bNegates) &&
					similarity >= this.#similarityThresholds.contradiction
				) {
					conflictType = "contradiction";
					const affirming = aNegates ? b : a;
					const negating = aNegates ? a : b;
					reason = `Contradictory stance: "${negating.id}" expresses negation while "${affirming.id}" affirms, ${Math.round(similarity * 100)}% word overlap`;
				}
				// Priority 2: Redundancy (high overlap, same polarity)
				else if (similarity >= this.#similarityThresholds.redundancy) {
					conflictType = "redundancy";
					reason = `Near-duplicate content: ${Math.round(similarity * 100)}% word overlap, same polarity`;
				}
				// Priority 3: Overlap (moderate overlap, different content)
				else if (similarity >= this.#similarityThresholds.overlap) {
					conflictType = "overlap";
					reason = `Significant content overlap: ${Math.round(similarity * 100)}% word overlap`;
				}

				if (conflictType && reason) {
					const [winnerId, loserId] = arbitrate(a, b);
					reports.push({
						itemA: { id: a.id, content: a.content, provenance: a.provenance },
						itemB: { id: b.id, content: b.content, provenance: b.provenance },
						conflictType,
						winner: { id: winnerId, content: winnerId === a.id ? a.content : b.content },
						loser: { id: loserId, content: loserId === a.id ? a.content : b.content },
						reason,
					});
				}
			}
		}

		// Sort by provenance severity: higher priority items' conflicts listed first
		reports.sort((a, b) => {
			const prioA = Math.max(
				PROVENANCE_PRIORITY.get(a.itemA.provenance) ?? 0,
				PROVENANCE_PRIORITY.get(a.itemB.provenance) ?? 0,
			);
			const prioB = Math.max(
				PROVENANCE_PRIORITY.get(b.itemA.provenance) ?? 0,
				PROVENANCE_PRIORITY.get(b.itemB.provenance) ?? 0,
			);
			return prioB - prioA;
		});

		return reports;
	}

	/**
	 * Resolve grouped items by detecting conflicts within each group and returning
	 * only the winners (non-superseded items) plus all conflict reports.
	 */
	resolve(groupedItems: Record<string, ConflictItem[]>): {
		resolved: Array<{ id: string; content: string }>;
		reports: ConflictReport[];
	} {
		const allReports: ConflictReport[] = [];
		const supersededIds = new Set<string>();

		for (const items of Object.values(groupedItems)) {
			const groupReports = this.detectConflicts(items);
			for (const report of groupReports) {
				allReports.push(report);
				supersededIds.add(report.loser.id);
			}
		}

		// Collect winners: items that were never marked as losers across all groups
		const resolved: Array<{ id: string; content: string }> = [];
		for (const items of Object.values(groupedItems)) {
			for (const item of items) {
				if (!supersededIds.has(item.id)) {
					resolved.push({ id: item.id, content: item.content });
				}
			}
		}

		return { resolved, reports: allReports };
	}
}
