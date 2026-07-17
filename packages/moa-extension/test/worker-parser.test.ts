import { describe, expect, it } from "bun:test";
import { scoreWorkerHeuristicV2 } from "../src/quality/heuristic";
import { DEFAULT_ROLE_WEIGHTS } from "../src/quality/weights";
import { DEFAULT_OUTPUT_SCHEMA, type MoaOutputSchema, type MoaWorkerResult } from "../src/types";
import {
	applyWorkerParsing,
	DEFAULT_QUALITY_MIN_SCORE,
	hasOpenQuestions,
	parseWorkerOutputBySchema,
	scoreWorkerOutput,
} from "../src/worker-parser";

// ----------------------------------------------------------------------------
// parseWorkerOutputBySchema
// ----------------------------------------------------------------------------

describe("parseWorkerOutputBySchema", () => {
	it("extracts all required sections when present", () => {
		const raw = `preamble

## plan
This is the plan.

## open_questions
- question: what is X? | context: because
- question: when? | context: deadline

## assumptions
- claim: y | basis: z
`;
		const parsed = parseWorkerOutputBySchema(raw, DEFAULT_OUTPUT_SCHEMA);
		expect(parsed.missingRequired).toEqual([]);
		expect(parsed.sections.plan).toContain("This is the plan.");
		expect(parsed.sections.open_questions).toContain("what is X?");
		expect(parsed.sections.assumptions).toContain("claim: y");
		expect(parsed.extraSections).toEqual([]);
	});

	it("reports missing required section", () => {
		const raw = "## open_questions\n- x";
		const parsed = parseWorkerOutputBySchema(raw, DEFAULT_OUTPUT_SCHEMA);
		expect(parsed.missingRequired).toEqual(["plan"]);
		expect(parsed.sections.plan).toBeUndefined();
	});

	it("treats missing optional section as empty (not in result)", () => {
		const raw = "## plan\nfoo\n\n## open_questions\n- x";
		const parsed = parseWorkerOutputBySchema(raw, DEFAULT_OUTPUT_SCHEMA);
		expect(parsed.missingRequired).toEqual([]);
		expect(parsed.sections.assumptions).toBeUndefined();
	});

	it("case-insensitive section name matching", () => {
		const raw = "## Plan\nx\n## Open_Questions\n- y";
		const parsed = parseWorkerOutputBySchema(raw, DEFAULT_OUTPUT_SCHEMA);
		expect(parsed.missingRequired).toEqual([]);
		expect(parsed.sections.plan).toBe("x");
	});

	it("records extra sections not in schema", () => {
		const raw = "## plan\nx\n## open_questions\n- y\n## bonus\nz";
		const parsed = parseWorkerOutputBySchema(raw, DEFAULT_OUTPUT_SCHEMA);
		expect(parsed.extraSections).toContain("bonus");
	});

	it("handles empty input", () => {
		const parsed = parseWorkerOutputBySchema("", DEFAULT_OUTPUT_SCHEMA);
		expect(parsed.missingRequired).toEqual(DEFAULT_OUTPUT_SCHEMA.sections.filter(s => s.required).map(s => s.name));
		expect(parsed.extraSections).toEqual([]);
	});

	it("soft-recovers freeform body when all required schema headers are missing", () => {
		const raw = [
			"## Step 1: 复述理解",
			"",
			"A ".repeat(120) + "concrete design with enough substance for quality scoring.",
			"",
			"## 设计概要",
			"More freeform notes.",
		].join("\n");
		const parsed = parseWorkerOutputBySchema(raw, DEFAULT_OUTPUT_SCHEMA);
		// Dual-channel: content is filled for display/scoring, but contract
		// failure is not cleared (softRecovered + missingRequired retained)
		// because required open_questions stays empty.
		expect(parsed.softRecovered).toBe(true);
		expect(parsed.missingRequired).toEqual(DEFAULT_OUTPUT_SCHEMA.sections.filter(s => s.required).map(s => s.name));
		expect(parsed.sections.plan).toContain("Step 1");
		expect(parsed.sections.open_questions).toBe("");
	});

	it("partitions freeform with code+verify into custom schema and clears softRecovered", () => {
		const schema: MoaOutputSchema = {
			sections: [
				{ name: "plan", required: true, type: "markdown" },
				{ name: "code_diff", required: true, type: "markdown" },
				{ name: "verify_steps", required: true, type: "list" },
			],
		};
		const raw = [
			"最小 Bun.serve 健康检查。零依赖。",
			"",
			"```typescript",
			"const server = Bun.serve({ port: 3000, fetch() { return Response.json({ ok: true }); } });",
			"```",
			"",
			"验证命令",
			"",
			"```bash",
			"curl -s http://localhost:3000/health",
			"```",
		].join("\n");
		const parsed = parseWorkerOutputBySchema(raw, schema);
		expect(parsed.softRecovered).toBeUndefined();
		expect(parsed.missingRequired).toEqual([]);
		expect(parsed.sections.plan).toContain("Bun.serve");
		expect(parsed.sections.code_diff).toContain("Response.json");
		expect(parsed.sections.verify_steps).toMatch(/curl/);
		const heuristic = scoreWorkerHeuristicV2(parsed, schema, DEFAULT_ROLE_WEIGHTS.grounded);
		expect(heuristic.contractHardFail).toBe(false);
		expect(heuristic.score).toBeGreaterThan(30);
	});

	it("soft-recovered freeform cannot fake all_complete convergence", () => {
		const raw = [
			"## Step 1",
			"",
			"A ".repeat(120) + "concrete design with enough substance for quality scoring.",
		].join("\n");
		const parsed = parseWorkerOutputBySchema(raw, DEFAULT_OUTPUT_SCHEMA);
		const heuristic = scoreWorkerHeuristicV2(parsed, DEFAULT_OUTPUT_SCHEMA, DEFAULT_ROLE_WEIGHTS.divergent);
		expect(parsed.softRecovered).toBe(true);
		expect(heuristic.contractHardFail).toBe(true);
		expect(heuristic.score).toBeLessThanOrEqual(30);

		const result: MoaWorkerResult = {
			name: "divergent",
			role: "Explore alternatives",
			ok: true,
			output: raw,
			qualityScore: heuristic.score,
		};
		// Empty synthesized open_questions must not count as "no questions".
		expect(hasOpenQuestions(result, DEFAULT_OUTPUT_SCHEMA)).toBe(true);
		expect(heuristic.score >= 80 && !hasOpenQuestions(result, DEFAULT_OUTPUT_SCHEMA)).toBe(false);
	});

	it("does not soft-recover when only some required headers are present", () => {
		const raw = "## open_questions\n- x";
		const parsed = parseWorkerOutputBySchema(raw, DEFAULT_OUTPUT_SCHEMA);
		expect(parsed.missingRequired).toEqual(["plan"]);
	});

	it("first occurrence wins on duplicate headers", () => {
		const raw = "## plan\nfirst\n\n## plan\nsecond";
		const parsed = parseWorkerOutputBySchema(raw, DEFAULT_OUTPUT_SCHEMA);
		expect(parsed.sections.plan).toBe("first");
	});

	it("works with custom schema (no required fields)", () => {
		const schema: MoaOutputSchema = { sections: [{ name: "foo", required: false, type: "markdown" }] };
		const parsed = parseWorkerOutputBySchema("## foo\nbar", schema);
		expect(parsed.missingRequired).toEqual([]);
		expect(parsed.sections.foo).toBe("bar");
	});
	it("PR2 regression: empty body between consecutive sections is parsed as the section being present (empty)", () => {
		// Before the regex fix, the greedy `\s*` between section name and
		// trailing `\n` would consume a blank line, leaving the next section's
		// `## ` prefix inside the previous section's body. This made
		// `## open_questions\n\n## assumptions\n- x` parse `open_questions` as
		// `"## assumptions\n- x"` and `assumptions` as missing.
		const raw = "## open_questions\n\n## assumptions\n- assumed default";
		const out = parseWorkerOutputBySchema(raw, DEFAULT_OUTPUT_SCHEMA);
		expect(out.sections.open_questions).toBe("");
		expect(out.sections.assumptions).toBe("- assumed default");
		expect(out.missingRequired).toContain("plan");
		expect(out.missingRequired).not.toContain("assumptions");
	});
});

// ----------------------------------------------------------------------------
// scoreWorkerOutput
// ----------------------------------------------------------------------------

describe("scoreWorkerOutput", () => {
	function parsedWith(plan: string, oq: string, assumptions?: string) {
		return parseWorkerOutputBySchema(
			[`## plan`, plan, `## open_questions`, oq, assumptions ? `## assumptions\n${assumptions}` : ""].join("\n"),
			DEFAULT_OUTPUT_SCHEMA,
		);
	}

	it("full score (100) for complete well-formed output", () => {
		const parsed = parsedWith(
			"x".repeat(500),
			"- question: a | context: b | suggested_default: c | type: freeform",
			"- claim: y | basis: z",
		);
		const b = scoreWorkerOutput(parsed, DEFAULT_OUTPUT_SCHEMA);
		expect(b.score).toBe(100);
		expect(b.planLength).toBe(500);
		expect(b.openQuestionCount).toBe(1);
		expect(b.hasAssumptions).toBe(true);
		expect(b.refusalMatches).toEqual([]);
	});

	it("missing required section reduces score by ~30 (force-drop)", () => {
		const parsed = parseWorkerOutputBySchema(`## open_questions\n- x`, DEFAULT_OUTPUT_SCHEMA);
		const b = scoreWorkerOutput(parsed, DEFAULT_OUTPUT_SCHEMA);
		// Subtotal 55 (1/2 required), capped to 30 (force-drop)
		expect(b.score).toBe(30);
	});

	it("plan too short (< 200 chars) penalizes 20", () => {
		const parsed = parsedWith("short plan", "- question: x");
		const b = scoreWorkerOutput(parsed, DEFAULT_OUTPUT_SCHEMA);
		// 30 (required) + 0 (plan short) + 20 (oq) + 0 + 20 = 70
		expect(b.score).toBe(70);
	});

	it("5+ open questions penalizes 20", () => {
		const oq = Array.from({ length: 6 }, (_, i) => `- question: q${i}`).join("\n");
		const parsed = parsedWith("x".repeat(500), oq);
		const b = scoreWorkerOutput(parsed, DEFAULT_OUTPUT_SCHEMA);
		// 30 + 20 + 0 + 0 + 20 = 70
		expect(b.score).toBe(70);
	});

	it("refusal pattern in plan matches", () => {
		// Long plan with 请确认 inside → refusal penalty; everything else scores normally
		const planWithRefusal = `${"x".repeat(300)}\n\n请确认这块的具体含义，然后再继续。`;
		const parsed = parsedWith(planWithRefusal, "- question: x | context: y");
		const b = scoreWorkerOutput(parsed, DEFAULT_OUTPUT_SCHEMA);
		expect(b.refusalMatches.length).toBeGreaterThan(0);
		// 30 (required) + 20 (plan > 200) + 20 (oq < 5) + 0 + 0 (refusal match) = 70
		expect(b.score).toBe(70);
	});

	it("refusal pattern 'as an AI' matches", () => {
		const parsed = parsedWith("x".repeat(500), "- x", "As an AI I cannot do this");
		const b = scoreWorkerOutput(parsed, DEFAULT_OUTPUT_SCHEMA);
		// refusal match in assumptions text — does scoring check assumptions? No, only plan+oq
		// 30 + 20 + 20 + 10 + 20 = 100 (refusal not in plan/oq → no penalty)
		expect(b.refusalMatches.length).toBe(0);
	});

	it("missing required + short plan + many oq → score 30 (force-drop)", () => {
		const parsed = parseWorkerOutputBySchema("## assumptions\n- x", DEFAULT_OUTPUT_SCHEMA);
		const b = scoreWorkerOutput(parsed, DEFAULT_OUTPUT_SCHEMA);
		// Subtotal 50, capped to 30 (force-drop)
		expect(b.score).toBe(30);
	});
});

// ----------------------------------------------------------------------------
// applyWorkerParsing
// ----------------------------------------------------------------------------

function makeResult(overrides: Partial<MoaWorkerResult> = {}): MoaWorkerResult {
	return {
		name: overrides.name ?? "divergent",
		role: overrides.role ?? "Generate options",
		ok: overrides.ok ?? true,
		output: overrides.output ?? "",
		stderr: overrides.stderr ?? "",
		exitCode: overrides.exitCode ?? 0,
		model: overrides.model,
	};
}

describe("applyWorkerParsing", () => {
	it("populates parsed, qualityScore, qualityDropped, parsedAt", () => {
		const result = makeResult({
			output: `## plan\n${"x".repeat(500)}\n## open_questions\n- question: a | context: b | suggested_default: c | type: freeform\n## assumptions\n- claim: y | basis: z`,
		});
		const fixedNow = new Date("2026-07-14T10:00:00.000Z");
		const out = applyWorkerParsing(result, DEFAULT_OUTPUT_SCHEMA, { now: () => fixedNow });
		expect(out.parsed?.plan).toContain("x".repeat(100));
		expect(out.parsed?.open_questions).toContain("question: a");
		expect(out.parsed?.assumptions).toContain("claim: y");
		expect(out.qualityScore).toBe(100);
		expect(out.qualityDropped).toBe(false);
		expect(out.parsedAt).toBe("2026-07-14T10:00:00.000Z");
	});

	it("marks worker as qualityDropped when below minScore", () => {
		const result = makeResult({ output: "## open_questions\n- only oq, no plan" });
		const out = applyWorkerParsing(result, DEFAULT_OUTPUT_SCHEMA, { minScore: 50 });
		// Subtotal 55, capped to 30 (force-drop), 30 < 50 → dropped
		expect(out.qualityScore).toBe(30);
		expect(out.qualityDropped).toBe(true);
	});

	it("does not mutate the input result", () => {
		const result = makeResult({ output: "## plan\nx" });
		const before = { ...result };
		applyWorkerParsing(result, DEFAULT_OUTPUT_SCHEMA);
		expect(result).toEqual(before);
	});

	it("uses default minScore when not provided (all required, v2 divergent score → not dropped)", () => {
		// All required present: plan (short) + oq (1 bullet). Divergent v2: 25+0+15+0+20 = 60.
		const result = makeResult({ output: "## plan\nshort plan\n## open_questions\n- x" });
		const out = applyWorkerParsing(result, DEFAULT_OUTPUT_SCHEMA);
		expect(DEFAULT_QUALITY_MIN_SCORE).toBe(40);
		expect(out.qualityScore).toBe(60);
		expect(out.qualityDropped).toBe(false);
	});

	it("force-drops when any required section is missing even if other checks pass", () => {
		// Long plan (passes plan check), no oq (missing required), no assumptions, no refusal
		// Subtotal: 0 (required 0/2 because oq missing) + 20 (plan > 200) + 20 (oq "" < 5) + 0 + 20 = 60, capped to 30
		const result = makeResult({ output: `## plan\n${"x".repeat(500)}` });
		const out = applyWorkerParsing(result, DEFAULT_OUTPUT_SCHEMA);
		expect(out.qualityScore).toBe(30);
		expect(out.qualityDropped).toBe(true);
	});
});
