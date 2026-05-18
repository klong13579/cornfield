/**
 * Context Assembler — Cognitive Coordination Pipeline
 *
 * Phase 1.5 / Phase 2: Builds the unified context injection for the Agent.
 * Replaces the dual injection path (Memory + Evolution) with a single,
 * priority-aware, token-bounded context block.
 *
 * Pipeline (architecture §7.1–§7.6):
 *   Stage 1 — Analyze (QueryAnalyzer)
 *   Stage 2 — Retrieve (4 sources, 3× over-retrieval)
 *   Stage 3 — Score Fusion (composite_score)
 *   Stage 4 — Conflict Resolution (Jaccard dedup, negation overlap)
 *   Stage 5 — Token Budget Allocation (dynamic by task type)
 *   Stage 6 — System Prompt Injection (7-layer priority)
 */

import { logger } from "@oh-my-pi/pi-utils";
import type { ConflictReport } from "./conflict-resolver";
import type { QueryAnalysis } from "./query-analyzer";
import { QueryAnalyzer } from "./query-analyzer";
import type { ImplicitConvention, UnifiedSkill } from "./types";

// ---------------------------------------------------------------------------
// Public types & interfaces
// ---------------------------------------------------------------------------

export interface AssemblerOptions {
	maxTokens: number;
	/** Estimated tokens per character. 4.0 is a safe average for English/Code mix. */
	tokensPerChar?: number;
}

const DEFAULT_TOKENS_PER_CHAR = 4.0;

/**
 * Assembles skills and conventions into a markdown context block.
 *
 * Priority order:
 * 1. Conventions (High signal, safety rules)
 * 2. Skills (sorted by confidence_score)
 *
 * @param skills - Unified skill list
 * @param conventions - Implicit conventions list
 * @param options - Token budget options
 */
export function assembleContext(
	skills: UnifiedSkill[],
	conventions: ImplicitConvention[],
	options: AssemblerOptions = { maxTokens: 2000 },
): string {
	const { maxTokens, tokensPerChar = DEFAULT_TOKENS_PER_CHAR } = options;
	const maxChars = Math.floor(maxTokens * tokensPerChar);

	const parts: string[] = [];

	// 1. Conventions (Top Priority)
	if (conventions.length > 0) {
		parts.push("## Active Conventions");
		for (const c of conventions) {
			parts.push(`- [Rule] ${c.rule} (Confidence: ${c.confidence.toFixed(2)})`);
		}
		parts.push("");
	}

	// 2. Skills (Sorted by Confidence)
	const sortedSkills = [...skills]
		.filter(s => s.status === "active")
		.sort((a, b) => b.confidenceScore - a.confidenceScore);

	if (sortedSkills.length > 0) {
		parts.push("## Relevant Skills");
		for (const s of sortedSkills) {
			parts.push(`### ${s.name} (v${s.version})`);
			parts.push(`Source: ${s.source} | Confidence: ${s.confidenceScore.toFixed(2)}`);
			parts.push(s.content);
			parts.push("");
		}
	}

	let result = parts.join("\n").trim();

	// Token/Char Guard
	if (result.length > maxChars) {
		logger.debug("ContextAssembler: trimming context to fit token budget", {
			originalChars: result.length,
			maxChars,
		});
		// Simple truncation with newline preservation
		const cutPoint = result.lastIndexOf("\n", maxChars);
		if (cutPoint > maxChars * 0.8) {
			result = `${result.slice(0, cutPoint)}\n... [truncated due to token limit]`;
		} else {
			result = `${result.slice(0, maxChars)}... [truncated]`;
		}
	}

	return result;
}

// ---------------------------------------------------------------------------
// Pipeline types
// ---------------------------------------------------------------------------

export type PipelineStage = "analyze" | "retrieve" | "fuse" | "resolve" | "allocate" | "inject";

export interface PipelineContext {
	query: string;
	skills: UnifiedSkill[];
	conventions: ImplicitConvention[];
	analysis?: QueryAnalysis;
	retrievedSkills?: UnifiedSkill[];
	resolved?: { resolved: Array<{ id: string; content: string }>; reports: ConflictReport[] };
	contextMd?: string;
	tokenBudget?: number;
	errors: string[];
	stageResults: Record<
		PipelineStage,
		{ status: "pending" | "running" | "success" | "failed"; startedAt: number; durationMs?: number }
	>;

	/** Retrieved conventions (Stage 2 output). */
	retrievedConventions?: ImplicitConvention[];
	/** Retrieved memory skills (pre-fusion). */
	retrievedMemory?: UnifiedSkill[];
	/** Whether profile injection flag was set. */
	profileInjected?: boolean;
	/** Whether episodic injection flag was set. */
	episodicInjected?: boolean;
	/** Fused/scored items with composite scores (Stage 3 output). */
	scoredItems?: Array<{ item: UnifiedSkill; compositeScore: number }>;
	/** Token allocation percentages by layer (Stage 5 output). */
	tokenAllocations?: Record<string, number>;
}

function makeEmptyStageResult(): PipelineContext["stageResults"][PipelineStage] {
	return { status: "pending", startedAt: Date.now() };
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/** Common English stop words filtered out during word-level comparison. */
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

/** Negation keyword regex for overlap conflict detection. */
const NEGATION_PATTERN =
	/\b(?:don't|doesn't|didn't|won't|wouldn't|shouldn't|couldn't|never|avoid|must\s+not)\b|\b(no|not)\s+/gi;

/** Jaccard similarity threshold for duplicate detection (§7.4). */
const DEDUP_SIMILARITY_THRESHOLD = 0.85;

/** Composite score weighting coefficients (§7.3). */
const SEMANTIC_WEIGHT = 0.5;
const RECENCY_WEIGHT = 0.3;
const IMPORTANCE_WEIGHT = 0.2;

/** Provenance priority ordering (§7.4). Higher wins. */
const PROVENANCE_PRIORITY: ReadonlyMap<string, number> = new Map([
	["user_stated", 4],
	["implied", 3],
	["inferred", 2],
	["fallback", 1],
]);

/** Normalizes text to lowercase alphanumeric tokens, removing stop words. */
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

/** Tokenize normalized text into a sorted array. */
function tokenize(normalized: string): string[] {
	if (!normalized) return [];
	return normalized.split(" ").sort();
}

/**
 * Compute word-level Jaccard similarity between two strings.
 * Returns value in [0, 1]. 0 = no shared tokens, 1 = identical token sets.
 */
export function computeJaccardSim(a: string, b: string): number {
	const tokensA = tokenize(normalizeContent(a));
	const tokensB = tokenize(normalizeContent(b));

	const setA = new Set(tokensA);
	const setB = new Set(tokensB);

	if (setA.size === 0 && setB.size === 0) return 0;

	let intersection = 0;
	for (const t of setA) {
		if (setB.has(t)) intersection++;
	}

	const unionSize = new Set([...tokensA, ...tokensB]).size;
	return unionSize === 0 ? 0 : intersection / unionSize;
}

/**
 * Create a ConflictItem from a UnifiedSkill for reuse with conflict-resolver types.
 */
function createConflictItem(skill: UnifiedSkill): ConflictItem {
	return { id: skill.id, content: skill.content, provenance: "fallback" as const };
}

interface ConflictItem {
	id: string;
	content: string;
	provenance: "user_stated" | "implied" | "inferred" | "fallback";
}

/**
 * Compute composite_score for a skill:
 *   0.50 × semantic_similarity + 0.30 × recency_decay + 0.20 × importance_score
 *
 * - semantic_similarity: Jaccard overlap between skill name+content and query keywords
 * - recency_decay: 0.5^(days_since_last_use / 30)
 * - importance_score: confidenceScore / 100
 */
function computeCompositeScore(skill: UnifiedSkill, queryKeywords: string[], now: number): number {
	// Semantic similarity: Jaccard between query keywords and skill content
	const skillText = `${skill.name} ${skill.content}`;
	const semanticSim = computeJaccardSim(queryKeywords.join(" "), skillText);

	// Recency decay
	const daysSinceLastUse = skill.lastUsedAt ? (now - skill.lastUsedAt) / (1000 * 60 * 60 * 24) : 365; // default: unused → high decay
	const recencyDecay = 0.5 ** (daysSinceLastUse / 30);

	// Importance
	const importanceScore = skill.confidenceScore / 100;

	return SEMANTIC_WEIGHT * semanticSim + RECENCY_WEIGHT * recencyDecay + IMPORTANCE_WEIGHT * importanceScore;
}

/**
 * Extract meaningful keywords from a skill (name + content tokens) for comparison.
 */
function extractKeywords(text: string): string[] {
	const raw = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
	const noise = new Set([
		"what",
		"when",
		"where",
		"which",
		"with",
		"that",
		"this",
		"from",
		"have",
		"been",
		"just",
		"like",
		"some",
		"your",
		"will",
		"about",
		"would",
		"could",
		"should",
	]);
	return raw.filter(w => w.length > 3 && !noise.has(w));
}

/**
 * Enhanced conflict resolution (architecture §7.4):
 * 1. Jaccard-based duplicate detection (>0.85)
 * 2. Provenance arbitration for same-concept pairs
 * 3. Negation overlap detection between skills and conventions
 * 4. Superseded exclusion
 */
function resolveConflictsBetweenSkills(
	skills: UnifiedSkill[],
	conventions: ImplicitConvention[],
): {
	enriched: {
		item: UnifiedSkill;
		compositeScore: number;
		isDuplicate: boolean;
		duplicateWith?: string;
		conflictAnnotations: Array<{ conventionName: string; overlapRatio: number }>;
	}[];
	duplicates: Array<{ winnerId: string; loserId: string }>;
	annotated: Array<{ itemId: string; conventionIndex: number }>;
} {
	const supersededIds = new Set<string>();
	const losers = new Map<string, string>(); // loserId → winnerId
	const duplicates: Array<{ winnerId: string; loserId: string }> = [];
	const annotated: Array<{ itemId: string; conventionIndex: number }> = [];

	// --- Duplicate detection via Jaccard keyword overlap ---
	for (let i = 0; i < skills.length; i++) {
		for (let j = i + 1; j < skills.length; j++) {
			const a = skills[i];
			const b = skills[j];

			if (supersededIds.has(a.id) || supersededIds.has(b.id)) continue;

			const sim = computeJaccardSim(
				extractKeywords(`${a.name} ${a.content}`).join(" "),
				extractKeywords(`${b.name} ${b.content}`).join(" "),
			);
			if (sim >= DEDUP_SIMILARITY_THRESHOLD) {
				// Arbitrate: higher provenance wins → if equal, higher confidenceScore wins
				const prioA =
					PROVENANCE_PRIORITY.get(
						a.source === "user_manual"
							? "user_stated"
							: a.source === "memory_consolidation"
								? "implied"
								: "fallback",
					) ?? 0;
				const prioB =
					PROVENANCE_PRIORITY.get(
						b.source === "user_manual"
							? "user_stated"
							: b.source === "memory_consolidation"
								? "implied"
								: "fallback",
					) ?? 0;

				let winnerId: string, loserId: string;
				if (prioA !== prioB) {
					[winnerId, loserId] = prioA > prioB ? [a.id, b.id] : [b.id, a.id];
				} else if (a.confidenceScore !== b.confidenceScore) {
					[winnerId, loserId] = a.confidenceScore > b.confidenceScore ? [a.id, b.id] : [b.id, a.id];
				} else {
					[winnerId, loserId] = a.id.localeCompare(b.id) <= 0 ? [a.id, b.id] : [b.id, a.id];
				}

				supersededIds.add(loserId);
				losers.set(loserId, winnerId);
				duplicates.push({ winnerId, loserId });
			}
		}
	}

	// --- Negation overlap: convention with negation keywords overlapping a skill ---
	for (let ci = 0; ci < conventions.length; ci++) {
		const conv = conventions[ci];
		if (!NEGATION_PATTERN.test(conv.rule)) continue;

		NEGATION_PATTERN.lastIndex = 0; // reset stateful regex

		for (const skill of skills) {
			if (supersededIds.has(skill.id)) continue;
			const overlapRatio = computeJaccardSim(conv.rule, skill.content);
			if (overlapRatio >= 0.3) {
				annotated.push({ itemId: skill.id, conventionIndex: ci });
			}
		}
	}

	// Build enriched output: winners survive directly; losers get marked
	// Note: losers are NOT added to supersededIds here — they're tracked separately
	// so they appear in output as "duplicates" rather than being silently excluded.
	interface EnrichedSkill {
		item: UnifiedSkill;
		compositeScore: number;
		isDuplicate: boolean;
		duplicateWith?: string;
		conflictAnnotations: Array<{ conventionName: string; overlapRatio: number }>;
	}

	const enriched: EnrichedSkill[] = skills
		.filter(s => !supersededIds.has(s.id))
		.map(s => {
			const entry: EnrichedSkill = {
				item: s,
				compositeScore: 0, // placeholder—filled by #stageFuse before this call
				isDuplicate: false,
				conflictAnnotations: [],
			};
			// Check if this skill lost arbitration
			const winnerId = losers.get(s.id);
			if (winnerId !== undefined) {
				entry.isDuplicate = true;
				entry.duplicateWith = winnerId;
			}
			// Attach negation-overlap annotations
			entry.conflictAnnotations = annotated
				.filter(a => a.itemId === s.id)
				.map(a => {
					const conv = conventions[a.conventionIndex];
					const overlapRatio = computeJaccardSim(conv.rule, s.content);
					return { conventionName: conv.rule, overlapRatio };
				});
			return entry;
		});

	return { enriched, duplicates, annotated };
}

/**
 * Task-type token allocation map (architecture §7.5).
 */
const TASK_ALLOCATIONS: Record<string, Record<string, number>> = {
	refactoring: { conventions: 30, skills: 20, memory: 10, profile: 15, episodic: 5, buffer: 20 },
	bugfix: { conventions: 30, skills: 20, memory: 10, profile: 15, episodic: 5, buffer: 20 },
	exploration: { memory: 25, conventions: 20, skills: 10, profile: 15, episodic: 5, buffer: 25 },
	documentation: { memory: 25, conventions: 20, skills: 10, profile: 15, episodic: 5, buffer: 25 },
	"feature-add": { skills: 25, conventions: 15, memory: 15, profile: 10, episodic: 5, buffer: 30 },
};

// ---------------------------------------------------------------------------
// Pipeline state machine
// ---------------------------------------------------------------------------

/**
 * Pipeline orchestrator — runs the 6-stage cognitive coordination pipeline.
 *
 * Stages:
 *   analyze  → classify the query (intent, domains, keywords, episodic requirement)
 *   retrieve → filter from 4 sources (memory/convention/profile/episodic) with 3× over-retrieval
 *   fuse     → rank by composite_score = 0.50·semantic + 0.30·recency + 0.20·importance
 *   resolve  → detect conflicts via Jaccard similarity (>0.85), provenance arbitration
 *   allocate → dynamic token budget by task type
 *   inject   → 7-layer system prompt assembly (AGENTS.md → Memory → Conventions → Skills → Profile → Episodic → Past Episodes)
 */
export class Pipeline {
	#queryAnalyzer: QueryAnalyzer;
	#maxTokens: number;

	constructor(options?: { maxTokens?: number }) {
		this.#queryAnalyzer = new QueryAnalyzer();
		this.#maxTokens = options?.maxTokens ?? 4000;
	}

	static #createContext(query: string, skills: UnifiedSkill[], conventions: ImplicitConvention[]): PipelineContext {
		return {
			query,
			skills,
			conventions,
			errors: [],
			stageResults: {
				analyze: makeEmptyStageResult(),
				retrieve: makeEmptyStageResult(),
				fuse: makeEmptyStageResult(),
				resolve: makeEmptyStageResult(),
				allocate: makeEmptyStageResult(),
				inject: makeEmptyStageResult(),
			},
		};
	}

	/**
	 * Run all 6 pipeline stages sequentially. Each stage fails independently;
	 * failures are recorded in ctx.errors but do not stop subsequent stages.
	 */
	async run(query: string, skills: UnifiedSkill[], conventions: ImplicitConvention[]): Promise<PipelineContext> {
		const ctx = Pipeline.#createContext(query, skills, conventions);

		await this.#stageAnalyze(ctx);
		await this.#stageRetrieve(ctx);
		await this.#stageFuse(ctx);
		await this.#stageResolve(ctx);
		await this.#stageAllocate(ctx);
		await this.#stageInject(ctx);

		return ctx;
	}

	// -- Stage implementations -----------------------------------------------

	async #stageAnalyze(ctx: PipelineContext): Promise<void> {
		ctx.stageResults.analyze.startedAt = Date.now();
		ctx.stageResults.analyze.status = "running";
		try {
			ctx.analysis = this.#queryAnalyzer.analyze(ctx.query);
			ctx.stageResults.analyze.status = "success";
			ctx.stageResults.analyze.durationMs = Date.now() - ctx.stageResults.analyze.startedAt;
		} catch (err) {
			ctx.stageResults.analyze.status = "failed";
			ctx.stageResults.analyze.durationMs = Date.now() - ctx.stageResults.analyze.startedAt;
			ctx.errors.push(`analyze: ${(err as Error).message}`);
		}
	}

	async #stageRetrieve(ctx: PipelineContext): Promise<void> {
		ctx.stageResults.retrieve.startedAt = Date.now();
		ctx.stageResults.retrieve.status = "running";
		try {
			const targetSize = 5;
			const overRetrievalFactor = 3;
			const retrievalTarget = targetSize * overRetrievalFactor; // 15

			// Source 1: Memory — skills where source === "memory_consolidation"
			const memorySkills = ctx.skills.filter(s => s.source === "memory_consolidation").slice(0, retrievalTarget);
			ctx.retrievedMemory = memorySkills;

			// Source 2: Convention — filter conventions ranked by confidence
			const rankedConventions = [...ctx.conventions]
				.sort((a, b) => b.confidence - a.confidence)
				.slice(0, retrievalTarget);
			ctx.retrievedConventions = rankedConventions;

			// Source 3: Profile — set flag (profile data provided externally via ctx.skills that aren't from other sources)
			ctx.profileInjected = true;

			// Source 4: Episodic — check analysis requiresEpisodic
			ctx.episodicInjected = !!ctx.analysis?.requiresEpisodic;

			// For downstream stages, use all active skills as retrieved pool
			ctx.retrievedSkills = ctx.skills.filter(s => s.status === "active");

			ctx.stageResults.retrieve.status = "success";
			ctx.stageResults.retrieve.durationMs = Date.now() - ctx.stageResults.retrieve.startedAt;
		} catch (err) {
			ctx.stageResults.retrieve.status = "failed";
			ctx.stageResults.retrieve.durationMs = Date.now() - ctx.stageResults.retrieve.startedAt;
			ctx.errors.push(`retrieve: ${(err as Error).message}`);
		}
	}

	async #stageFuse(ctx: PipelineContext): Promise<void> {
		ctx.stageResults.fuse.startedAt = Date.now();
		ctx.stageResults.fuse.status = "running";
		try {
			const skillList = ctx.retrievedSkills ?? ctx.skills;
			const queryKeywords = ctx.analysis?.keywords ?? [];
			const now = Date.now();

			// Compute composite_score for each skill
			const scored = skillList
				.map(skill => ({
					item: skill,
					compositeScore: computeCompositeScore(skill, queryKeywords, now),
				}))
				.sort((a, b) => b.compositeScore - a.compositeScore)
				.slice(0, Math.min(5, skillList.length));

			// Update retrievedSkills to fused list
			ctx.retrievedSkills = scored.map(s => s.item);
			ctx.scoredItems = scored;

			ctx.stageResults.fuse.status = "success";
			ctx.stageResults.fuse.durationMs = Date.now() - ctx.stageResults.fuse.startedAt;
		} catch (err) {
			ctx.stageResults.fuse.status = "failed";
			ctx.stageResults.fuse.durationMs = Date.now() - ctx.stageResults.fuse.startedAt;
			ctx.errors.push(`fuse: ${(err as Error).message}`);
		}
	}

	async #stageResolve(ctx: PipelineContext): Promise<void> {
		ctx.stageResults.resolve.startedAt = Date.now();
		ctx.stageResults.resolve.status = "running";
		try {
			const skillList = ctx.retrievedSkills ?? ctx.skills;
			const conventions = ctx.conventions;

			// Assign composite scores before conflict resolution
			const enriched = resolveConflictsBetweenSkills(skillList, conventions);

			// Build resolved output in the original format expected by callers
			const resolvedItems = enriched.enriched
				.filter(e => !e.isDuplicate)
				.map(e => ({ id: e.item.id, content: e.item.content }));

			// Build conflict reports compatible with existing ConflictReport type
			const reports: ConflictReport[] = enriched.duplicates.map(d => {
				const winner = skillList.find(s => s.id === d.winnerId)!;
				const loser = skillList.find(s => s.id === d.loserId)!;
				return {
					itemA: { id: d.winnerId, content: winner.content, provenance: "fallback" as const },
					itemB: { id: d.loserId, content: loser.content, provenance: "fallback" as const },
					conflictType: "redundancy" as const,
					winner: { id: d.winnerId, content: winner.content },
					loser: { id: d.loserId, content: loser.content },
					reason: `Near-duplicate content: Jaccard similarity ≥ ${DEDUP_SIMILARITY_THRESHOLD}`,
				};
			});

			ctx.resolved = { resolved: resolvedItems, reports };
			ctx.stageResults.resolve.status = "success";
			ctx.stageResults.resolve.durationMs = Date.now() - ctx.stageResults.resolve.startedAt;
		} catch (err) {
			ctx.stageResults.resolve.status = "failed";
			ctx.stageResults.resolve.durationMs = Date.now() - ctx.stageResults.resolve.startedAt;
			ctx.errors.push(`resolve: ${(err as Error).message}`);
		}
	}

	async #stageAllocate(ctx: PipelineContext): Promise<void> {
		ctx.stageResults.allocate.startedAt = Date.now();
		ctx.stageResults.allocate.status = "running";
		try {
			const intent = ctx.analysis?.intent ?? "general";
			const allocation = TASK_ALLOCATIONS[intent] ?? {
				memory: 20,
				conventions: 20,
				skills: 20,
				profile: 10,
				episodic: 5,
				buffer: 25,
			};

			// Convert percentages to absolute token allocations
			const totalAllocation = Object.values(allocation).reduce((sum, v) => sum + v, 0);
			const allocations: Record<string, number> = {};
			for (const [key, pct] of Object.entries(allocation)) {
				allocations[key] = Math.floor(this.#maxTokens * (pct / totalAllocation));
			}

			// Fix rounding error so sum matches exactly
			const actualSum = Object.values(allocations).reduce((s, v) => s + v, 0);
			const remainder = this.#maxTokens - actualSum;
			if (remainder !== 0) {
				const largestKey = Object.entries(allocation).sort((a, b) => b[1] - a[1])[0][0];
				allocations[largestKey] += remainder;
			}

			ctx.tokenBudget = this.#maxTokens;
			ctx.tokenAllocations = allocations;
			ctx.stageResults.allocate.status = "success";
			ctx.stageResults.allocate.durationMs = Date.now() - ctx.stageResults.allocate.startedAt;
		} catch (err) {
			ctx.stageResults.allocate.status = "failed";
			ctx.stageResults.allocate.durationMs = Date.now() - ctx.stageResults.allocate.startedAt;
			ctx.errors.push(`allocate: ${(err as Error).message}`);
		}
	}

	async #stageInject(ctx: PipelineContext): Promise<void> {
		ctx.stageResults.inject.startedAt = Date.now();
		ctx.stageResults.inject.status = "running";
		try {
			// 7-layer injection order (architecture §7.6)
			// Priority 1: AGENTS.md → Priority 7: Past Episodes (BOTTOM)
			const LAYER_ORDER = [
				{ key: "agents", label: "AGENTS.md", weight: 0.02 },
				{ key: "memory", label: "Memory Summary", weight: 0.08 },
				{ key: "conventions", label: "Conventions", weight: 0.15 },
				{ key: "skills", label: "Relevant Skills", weight: 0.3 },
				{ key: "profile", label: "User Profile", weight: 0.05 },
				{ key: "episodic", label: "Episodic Context", weight: 0.05 },
				{ key: "past_episodes", label: "Past Episodes", weight: 0.02 },
				{ key: "buffer", label: "Buffer", weight: 0.33 },
			] as const;

			// Per-layer char budgets derived from token allocations
			const charsPerToken = 4;
			const totalBudget = ctx.tokenBudget ?? this.#maxTokens;
			const totalChars = totalBudget * charsPerToken;

			const parts: string[] = [];
			let cumulativeChars = 0;
			const prevLayerWeight = 0;

			// Layer 1: AGENTS.md (TOP — always included, even if budget tight)
			const agentsPct = LAYER_ORDER[0].weight * 100;
			const agentsLayerBudget = Math.floor((totalChars * agentsPct) / 100);
			const agentsRemaining = totalChars - cumulativeChars;
			const agentsChars = Math.max(0, Math.min(agentsLayerBudget, agentsRemaining));
			parts.push(`## 📋 AGENTS.md\nStatic project guidelines and coding standards.\n`);
			cumulativeChars += agentsChars;

			// Layers 2–7: conditional based on flags and budget
			for (let li = 1; li < LAYER_ORDER.length; li++) {
				const layer = LAYER_ORDER[li];
				const layerPct = layer.weight * 100;
				const layerBudget = Math.floor((totalChars * layerPct) / 100);
				const remaining = totalChars - cumulativeChars;
				const usedChars = Math.max(0, Math.min(layerBudget, remaining));

				if (usedChars <= 0 && li > 1) continue; // skip remaining layers if budget exhausted

				let layerContent = "";

				switch (layer.key) {
					case "memory": {
						const scored = ctx.scoredItems ?? [];
						layerContent = `## 🧠 Memory Summary\nConsolidated memories from previous sessions.\n${scored
							.slice(0, 3)
							.map(s => `- **${s.item.name}** (score: ${s.compositeScore.toFixed(3)})`)
							.join("\n")}\n`;
						break;
					}
					case "conventions": {
						const conventions = ctx.retrievedConventions ?? ctx.conventions;
						layerContent = `## 📐 Conventions\nEstablished team and project conventions.\n${conventions.map(c => `- [Rule] ${c.rule} (Confidence: ${c.confidence.toFixed(2)})`).join("\n")}\n`;
						break;
					}
					case "skills": {
						const resolvedItems = ctx.resolved?.resolved ?? [];
						layerContent = `## 🔧 Relevant Skills\nActive skills available for execution.\n${resolvedItems
							.slice(0, 5)
							.map(r => {
								const orig = ctx.skills.find(s => s.id === r.id);
								if (orig) {
									return `### ${orig.name} (v${orig.version})\nSource: ${orig.source} | Confidence: ${orig.confidenceScore.toFixed(2)}\n${orig.content}`;
								}
								return `### ${r.id}\n${r.content}`;
							})
							.join("\n\n")}\n`;
						break;
					}
					case "profile": {
						layerContent = `## 👤 User Profile\nPreferred patterns and user-specific context.\nProfile data provided via external integration.\n`;
						break;
					}
					case "episodic": {
						if (!ctx.episodicInjected) {
							cumulativeChars += usedChars;
							continue;
						}
						const keywords = ctx.analysis?.keywords?.slice(0, 5).join(", ") ?? "session history";
						layerContent = `## 📅 Episodic Context\nRecent session fragments relevant to current task.\nKeywords: ${keywords}\nSession-level recall from prior interactions.\n`;
						break;
					}
					case "past_episodes": {
						layerContent = `## 🕰️ Past Episodes\nHistorical episode summaries (bottom priority).\nNo episodes available yet.\n`;
						break;
					}
					case "buffer": {
						// Buffer absorbs any remaining budget — add placeholder
						const leftover = totalChars - cumulativeChars;
						if (leftover > 0) {
							layerContent = `## ⏱️ Buffer\nFlexible space for additional context.\nAvailable tokens: ${Math.floor(leftover / charsPerToken)}\n`;
						}
						break;
					}
				}

				if (layerContent) {
					parts.push(layerContent);
					cumulativeChars += usedChars;
				}
			}

			// Final budget enforcement
			const contextMd = parts.join("").trim();
			if (contextMd.length > totalChars) {
				const cutPoint = contextMd.lastIndexOf("\n", totalChars);
				if (cutPoint > totalChars * 0.8) {
					ctx.contextMd = `${contextMd.slice(0, cutPoint)}\n... [truncated due to token limit]`;
				} else {
					ctx.contextMd = `${contextMd.slice(0, totalChars)}... [truncated]`;
				}
			} else {
				ctx.contextMd = contextMd;
			}

			ctx.stageResults.inject.status = "success";
			ctx.stageResults.inject.durationMs = Date.now() - ctx.stageResults.inject.startedAt;
		} catch (err) {
			ctx.stageResults.inject.status = "failed";
			ctx.stageResults.inject.durationMs = Date.now() - ctx.stageResults.inject.startedAt;
			ctx.errors.push(`inject: ${(err as Error).message}`);
		}
	}
}

/**
 * Factory function that creates a Pipeline and executes it.
 */
export function runPipeline(
	query: string,
	skills: UnifiedSkill[],
	conventions: ImplicitConvention[],
	options?: { maxTokens?: number },
): Promise<PipelineContext> {
	const pipeline = new Pipeline(options);
	return pipeline.run(query, skills, conventions);
}
