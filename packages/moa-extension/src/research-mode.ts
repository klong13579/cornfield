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
	/(?:业界|竞品|论文|开源方案|参考方案|industry\s+(?:practice|best)|best\s+practices|survey\s+(?:the|of)|compare\s+(?:papers|approaches)|research\s+(?:papers|literature)|look\s+up\s+(?:how|what)|调研)/i;

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
 * Prompt block injected into worker / rewrite templates. Empty for `none`.
 */
export function renderResearchGuidance(mode: ResearchMode): string {
	if (mode === "none") return "";
	if (mode === "required") {
		return [
			"## Research guidance (REQUIRED)",
			"- You MUST call `web_search` at least once before finishing.",
			"- Emit a `## sources` section with bullets shaped",
			"  `claim: … | url: https://… | relevance: …`.",
			"- Do NOT cite URLs from memory — only URLs returned by tools",
			"  (`web_search` / `read` of fetched pages). Mark unbacked claims",
			"  `[unverified]`.",
			"- Prefer tool-backed external evidence for architecture choices;",
			"  repo-local evidence still belongs in the plan body.",
		].join("\n");
	}
	return [
		"## Research guidance (encouraged)",
		"- For open / architecture claims, prefer calling `web_search`",
		"  (or reading fetched pages) before asserting industry practice.",
		"- When you use external evidence, cite it under `## sources` as",
		"  `claim: … | url: https://… | relevance: …`.",
		"- Do not invent URLs from memory. If you cannot verify, tag the",
		"  claim `[unverified]` and skip a fake source.",
		"- Role split: divergent → external architectures; grounded → repo",
		"  constraints first; critical → failure modes (cite when claiming",
		"  known industry pitfalls).",
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
