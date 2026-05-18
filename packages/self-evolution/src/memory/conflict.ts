/**
 * Conflict detection + supersede + provenance arbitration for memory rules.
 *
 * Detects contradictions between extracted conventions/rules and resolves them
 * using provenance priority: user_stated > implied > inferred > fallback.
 */
import { logger } from "@oh-my-pi/pi-utils";

export type ProvenanceLevel = "user_stated" | "implied" | "inferred" | "fallback";

const PROVENANCE_RANK: Record<ProvenanceLevel, number> = {
	user_stated: 4,
	implied: 3,
	inferred: 2,
	fallback: 1,
};

export interface MemoryRule {
	id: string;
	content: string;
	provenance: ProvenanceLevel;
	source: string;
	timestamp: number;
	/** Whether this rule has been superseded by a higher-priority rule */
	superseded?: boolean;
	supersededBy?: string;
}

export interface ConflictReport {
	ruleA: MemoryRule;
	ruleB: MemoryRule;
	conflictType: "contradiction" | "overlap" | "redundancy";
	severity: "high" | "medium" | "low";
	/** The winning rule after arbitration */
	winner: MemoryRule;
	/** The losing rule after arbitration */
	loser: MemoryRule;
	reason: string;
}

// Common negation keywords that flip rule polarity
const NEGATION_WORDS = new Set([
	"don't",
	"dont",
	"do not",
	"never",
	"avoid",
	"no ",
	"not ",
	"without",
	"shouldn't",
	"shouldnt",
	"must not",
	"mustn't",
	"mustnt",
]);

// Contrast conjunctions indicating conflict
const CONTRAST_WORDS = new Set(["but", "however", "instead", "rather", "prefer", "over"]);

function normalizeRule(content: string): string {
	return content
		.toLowerCase()
		.replace(/[^\w\s]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function hasNegation(content: string): boolean {
	const lower = content.toLowerCase();
	for (const neg of NEGATION_WORDS) {
		if (lower.includes(neg)) return true;
	}
	return false;
}

function extractKeyPhrases(content: string): string[] {
	const normalized = normalizeRule(content);
	// Remove common filler words
	const fillers = new Set([
		"the",
		"a",
		"an",
		"is",
		"are",
		"was",
		"were",
		"be",
		"been",
		"being",
		"to",
		"of",
		"and",
		"in",
		"on",
		"at",
		"for",
		"with",
		"by",
		"from",
		"please",
		"always",
		"never",
		"should",
		"must",
		"use",
		"using",
		"prefer",
	]);
	return normalized.split(" ").filter(w => w.length > 2 && !fillers.has(w));
}

function phraseOverlap(a: string[], b: string[]): number {
	const setA = new Set(a);
	let overlap = 0;
	for (const word of b) {
		if (setA.has(word)) overlap++;
	}
	return overlap / Math.max(setA.size, b.length);
}

/**
 * Detect conflicts between a set of memory rules.
 * Returns conflict reports for pairs that contradict or heavily overlap.
 */
export function detectConflicts(rules: MemoryRule[]): ConflictReport[] {
	const reports: ConflictReport[] = [];
	const processed = new Set<string>();

	for (let i = 0; i < rules.length; i++) {
		for (let j = i + 1; j < rules.length; j++) {
			const a = rules[i]!;
			const b = rules[j]!;
			if (a.superseded || b.superseded) continue;

			const pairKey = [a.id, b.id].sort().join("::");
			if (processed.has(pairKey)) continue;
			processed.add(pairKey);

			const report = evaluatePair(a, b);
			if (report) {
				reports.push(report);
			}
		}
	}

	logger.debug("Conflict detection complete", {
		rulesChecked: rules.length,
		conflictsFound: reports.length,
	});

	return reports;
}

function evaluatePair(a: MemoryRule, b: MemoryRule): ConflictReport | null {
	const phrasesA = extractKeyPhrases(a.content);
	const phrasesB = extractKeyPhrases(b.content);

	// Require meaningful overlap to be considered related
	const overlap = phraseOverlap(phrasesA, phrasesB);
	if (overlap < 0.3) return null;

	const negA = hasNegation(a.content);
	const negB = hasNegation(b.content);

	// Case 1: Direct contradiction — one affirms, one negates the same concept
	if (negA !== negB && overlap >= 0.5) {
		const { winner, loser, reason } = arbitrate(a, b, "contradiction");
		return {
			ruleA: a,
			ruleB: b,
			conflictType: "contradiction",
			severity: "high",
			winner,
			loser,
			reason,
		};
	}

	// Case 2: High overlap with same polarity — redundancy
	if (overlap >= 0.8 && negA === negB) {
		const { winner, loser, reason } = arbitrate(a, b, "redundancy");
		return {
			ruleA: a,
			ruleB: b,
			conflictType: "redundancy",
			severity: "low",
			winner,
			loser,
			reason,
		};
	}

	// Case 3: Moderate overlap with contrast keywords — potential overlap conflict
	const hasContrast = CONTRAST_WORDS.has(a.content.toLowerCase()) || CONTRAST_WORDS.has(b.content.toLowerCase());
	if (overlap >= 0.5 && hasContrast) {
		const { winner, loser, reason } = arbitrate(a, b, "overlap");
		return {
			ruleA: a,
			ruleB: b,
			conflictType: "overlap",
			severity: "medium",
			winner,
			loser,
			reason,
		};
	}

	return null;
}

function arbitrate(
	a: MemoryRule,
	b: MemoryRule,
	conflictType: string,
): { winner: MemoryRule; loser: MemoryRule; reason: string } {
	const rankA = PROVENANCE_RANK[a.provenance];
	const rankB = PROVENANCE_RANK[b.provenance];

	if (rankA > rankB) {
		return {
			winner: a,
			loser: b,
			reason: `${a.provenance} beats ${b.provenance} for ${conflictType}`,
		};
	}
	if (rankB > rankA) {
		return {
			winner: b,
			loser: a,
			reason: `${b.provenance} beats ${a.provenance} for ${conflictType}`,
		};
	}

	// Same provenance — newer wins
	if (a.timestamp >= b.timestamp) {
		return {
			winner: a,
			loser: b,
			reason: `Same provenance (${a.provenance}), newer timestamp wins`,
		};
	}
	return {
		winner: b,
		loser: a,
		reason: `Same provenance (${b.provenance}), newer timestamp wins`,
	};
}

/**
 * Apply supersede decisions to the rule set.
 * Marks losing rules as superseded and returns the cleaned list.
 */
export function applySupersede(rules: MemoryRule[], reports: ConflictReport[]): MemoryRule[] {
	const ruleMap = new Map<string, MemoryRule>(rules.map(r => [r.id, { ...r }]));

	for (const report of reports) {
		const loser = ruleMap.get(report.loser.id);
		if (loser) {
			loser.superseded = true;
			loser.supersededBy = report.winner.id;
		}
	}

	const result = Array.from(ruleMap.values());
	logger.debug("Supersede applied", {
		totalRules: result.length,
		superseded: result.filter(r => r.superseded).length,
	});

	return result;
}

/**
 * One-shot function: detect conflicts and apply supersede in one call.
 */
export function resolveConflicts(rules: MemoryRule[]): { rules: MemoryRule[]; reports: ConflictReport[] } {
	const reports = detectConflicts(rules);
	const resolved = applySupersede(rules, reports);
	return { rules: resolved, reports };
}
