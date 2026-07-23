import type { MoaOutputSchema, MoaOutputSchemaSection, MoaResearchModeSetting, ResearchMode } from "./types";

export type { MoaResearchModeSetting, ResearchMode };

const SOURCES_SECTION: MoaOutputSchemaSection = {
	name: "sources",
	required: false,
	type: "list",
	item: { claim: "string", url: "string", relevance: "string" },
};

/** Explicit external-research cues → required. */
const REQUIRED_CUES =
	/(?:业界|竞品|论文|开源方案|参考方案|区别|对比|相比较|竞品对比|比起|versus|\bvs\.?\b|industry\s+(?:practice|best)|best\s+practices|survey\s+(?:the|of)|compare\s+(?:papers|approaches)|research\s+(?:papers|literature)|look\s+up\s+(?:how|what)|调研)/i;

/** Open architecture / tradeoff cues → encouraged (unless required wins). */
const ENCOURAGED_CUES =
	/(?:设计方案|架构|治理|策略|取舍|可选|architecture|design\s+(?:an?\s+)?(?:architecture|system)|tradeoff|strategy|governance)/i;

/** Narrow implementation cues → force none even if encouraged cues match weakly. */
const NARROW_CUES =
	/(?:仅含|返回\s*JSON|fix\s+the\s+typo|health\s+check|GET\s+\/health|examples\/[\w./-]+\.ts|具体实现|写一个最小)/i;

/**
 * Infer research intensity from the user task. Prefer `required` over
 * `encouraged` when both match; narrow implementation tasks stay `none`.
 */
export function inferResearchMode(task: string): ResearchMode {
	const text = task.trim();
	if (!text) return "none";
	if (NARROW_CUES.test(text) && !REQUIRED_CUES.test(text)) return "none";
	if (REQUIRED_CUES.test(text)) return "required";
	if (ENCOURAGED_CUES.test(text)) return "encouraged";
	return "none";
}

/** Resolve settings knob + task into an effective mode. */
export function resolveResearchMode(task: string, setting: MoaResearchModeSetting = "auto"): ResearchMode {
	if (setting === "auto") return inferResearchMode(task);
	return setting;
}

/**
 * Prompt block injected into plan-worker / rewrite templates. Empty for `none`.
 *
 * Phase 7: a dedicated Research stage runs BEFORE the plan workers and gathers
 * all external evidence into a `research_pack` (rendered in the injected task
 * context under `### Research evidence`). Plan workers therefore do NOT call
 * `web_search` themselves — that tool is stripped from their tool set. This
 * guidance tells them to build on the provided evidence and cite from it.
 */
export function renderResearchGuidance(mode: ResearchMode): string {
	if (mode === "none") return "";
	const strictness = mode === "required" ? "## Research guidance (REQUIRED)" : "## Research guidance (encouraged)";
	return [
		strictness,
		"- A separate research stage already gathered evidence for you — see the",
		"  `### Research evidence` block in the task context above. Build on it.",
		"- Do NOT call `web_search` yourself (it has been disabled for this role);",
		"  the evidence has already been collected.",
		"- You may `read`/`search`/`find` **local repo paths only**. Do NOT `read`",
		"  remote http(s) URLs — remote URL reads are blocked for this role.",
		"- Prefer the provided research evidence over deep local exploration.",
		"  Compare/design tasks: a short local check is fine; do not wander the repo.",
		"- Emit a `## sources` section citing the evidence you actually relied on,",
		"  shaped `claim: … | url: https://… | relevance: …`. Only reuse URLs from",
		"  the provided research evidence — do NOT invent URLs from memory.",
		"- If the provided evidence is insufficient for a claim, record the gap in",
		"  `## assumptions` (do not fabricate a source). Mark unbacked claims",
		"  `[unverified]`.",
	].join("\n");
}

/**
 * Ensure the worker schema lists `## sources` when research is on.
 * Encouraged → optional; required → required. Existing section is upgraded
 * in place (no duplicate).
 */
export function enrichSchemaWithSources(schema: MoaOutputSchema, mode: ResearchMode): MoaOutputSchema {
	if (mode === "none") return schema;
	const required = mode === "required";
	const existing = schema.sections.find(s => s.name === "sources");
	if (existing) {
		return {
			sections: schema.sections.map(s =>
				s.name === "sources"
					? {
							...s,
							required,
							type: s.type === "list" ? s.type : "list",
							item: s.item ?? SOURCES_SECTION.item,
						}
					: s,
			),
		};
	}
	return {
		sections: [...schema.sections, { ...SOURCES_SECTION, required }],
	};
}

/** True when `## sources` has at least one http(s) URL. */
export function hasToolBackedSources(sourcesText: string | undefined): boolean {
	if (!sourcesText?.trim()) return false;
	return /https?:\/\/\S+/i.test(sourcesText);
}

/**
 * Soft quality adjustment for research mode. Does not trigger contract
 * hard-fail (that stays schema-driven). Required + no URL → cap 60;
 * encouraged + no URL → −10.
 */
export function applyResearchSourcesPenalty(
	score: number,
	sourcesText: string | undefined,
	mode: ResearchMode,
): number {
	if (mode === "none") return score;
	if (hasToolBackedSources(sourcesText)) return score;
	if (mode === "required") return Math.min(score, 60);
	return Math.max(0, score - 10);
}

/** Research runs often call web_search; raise the floor to 10 minutes. */
export const RESEARCH_WORKER_TIMEOUT_FLOOR_MS = 600_000;

/**
 * Effective per-worker timeout. Research modes never go below 10 minutes
 * unless the user already configured a higher `timeoutMs`.
 */
export function resolveWorkerTimeoutMs(configuredTimeoutMs: number, mode: ResearchMode): number {
	const base = Math.max(0, Math.floor(configuredTimeoutMs));
	if (mode === "none") return base;
	return Math.max(base, RESEARCH_WORKER_TIMEOUT_FLOOR_MS);
}
