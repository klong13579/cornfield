import { describe, expect, it } from "bun:test";
import { scoreWorkerHeuristicV2 } from "../src/quality/heuristic";
import { DEFAULT_ROLE_WEIGHTS } from "../src/quality/weights";
import { DEFAULT_OUTPUT_SCHEMA, type MoaOutputSchema } from "../src/types";
import { parseWorkerOutputBySchema } from "../src/worker-parser";

function parsedWith(plan: string, oq: string, assumptions?: string) {
	return parseWorkerOutputBySchema(
		[`## plan`, plan, `## open_questions`, oq, assumptions ? `## assumptions\n${assumptions}` : ""].join("\n"),
		DEFAULT_OUTPUT_SCHEMA,
	);
}

describe("scoreWorkerHeuristicV2", () => {
	it("plan-heavy fixture: divergent score >= critical score", () => {
		const parsed = parsedWith(
			"x".repeat(250),
			"- question: a | context: b | suggested_default: c | type: freeform",
			"- claim: y | basis: z",
		);

		const divergent = scoreWorkerHeuristicV2(parsed, DEFAULT_OUTPUT_SCHEMA, DEFAULT_ROLE_WEIGHTS.divergent);
		const critical = scoreWorkerHeuristicV2(parsed, DEFAULT_OUTPUT_SCHEMA, DEFAULT_ROLE_WEIGHTS.critical);

		expect(divergent.score).toBeGreaterThanOrEqual(critical.score);
		expect(divergent.contractHardFail).toBe(false);
		expect(critical.contractHardFail).toBe(false);
	});

	it("assumption-heavy short plan: critical score > divergent score", () => {
		const parsed = parsedWith(
			"Short plan with explicit assumptions focus.",
			"- question: x | context: y",
			"- claim: default auth | basis: prior art\n- claim: sqlite storage | basis: existing stack",
		);

		const divergent = scoreWorkerHeuristicV2(parsed, DEFAULT_OUTPUT_SCHEMA, DEFAULT_ROLE_WEIGHTS.divergent);
		const critical = scoreWorkerHeuristicV2(parsed, DEFAULT_OUTPUT_SCHEMA, DEFAULT_ROLE_WEIGHTS.critical);

		expect(critical.score).toBeGreaterThan(divergent.score);
		expect(divergent.breakdown.hits.planSubstance).toBe(0);
		expect(critical.breakdown.hits.assumptions).toBe(1);
	});

	it("missing required section → score <= 30 and contractHardFail", () => {
		const parsed = parseWorkerOutputBySchema(`## open_questions\n- x`, DEFAULT_OUTPUT_SCHEMA);

		const result = scoreWorkerHeuristicV2(parsed, DEFAULT_OUTPUT_SCHEMA, DEFAULT_ROLE_WEIGHTS.divergent);

		expect(result.score).toBeLessThanOrEqual(30);
		expect(result.contractHardFail).toBe(true);
		expect(result.breakdown.hits.required).toBeLessThan(1);
	});

	it("soft-recovered freeform → contractHardFail and score <= 30", () => {
		const parsed = parseWorkerOutputBySchema(
			`## Step 1\n\n${"A ".repeat(120)}concrete design with enough substance.`,
			DEFAULT_OUTPUT_SCHEMA,
		);
		expect(parsed.softRecovered).toBe(true);

		const result = scoreWorkerHeuristicV2(parsed, DEFAULT_OUTPUT_SCHEMA, DEFAULT_ROLE_WEIGHTS.divergent);
		expect(result.contractHardFail).toBe(true);
		expect(result.score).toBeLessThanOrEqual(30);
	});
});

describe("scoreWorkerHeuristicV2 — schema-aware (once-right P3)", () => {
	const customSchema: MoaOutputSchema = {
		sections: [
			{ name: "code_diff", required: true, type: "markdown" },
			{ name: "open_risks", required: true, type: "list" },
			{ name: "assumptions", required: false, type: "list" },
		],
	};

	it("planSubstance uses primary required markdown section (not hardcoded `plan`)", () => {
		const longDiff = "d".repeat(250);
		const parsed = parseWorkerOutputBySchema(
			[`## code_diff`, longDiff, `## open_risks`, `- risk: none`, `## assumptions`, `- claim: ok`].join("\n"),
			customSchema,
		);
		const result = scoreWorkerHeuristicV2(parsed, customSchema, DEFAULT_ROLE_WEIGHTS.divergent);
		expect(result.breakdown.hits.planSubstance).toBe(1);
		expect(result.contractHardFail).toBe(false);
		expect(result.score).toBeGreaterThan(40);
	});

	it("short primary markdown does not get planSubstance credit", () => {
		const parsed = parseWorkerOutputBySchema(
			[`## code_diff`, "tiny", `## open_risks`, `- risk: x`, `## assumptions`, `- claim: y`].join("\n"),
			customSchema,
		);
		const result = scoreWorkerHeuristicV2(parsed, customSchema, DEFAULT_ROLE_WEIGHTS.divergent);
		expect(result.breakdown.hits.planSubstance).toBe(0);
	});

	it("openQuestions uses required list / question-named section (not hardcoded `open_questions`)", () => {
		const longDiff = "d".repeat(250);
		const few = parseWorkerOutputBySchema(
			[`## code_diff`, longDiff, `## open_risks`, `- a\n- b`, `## assumptions`, `- claim: ok`].join("\n"),
			customSchema,
		);
		const many = parseWorkerOutputBySchema(
			[
				`## code_diff`,
				longDiff,
				`## open_risks`,
				`- 1\n- 2\n- 3\n- 4\n- 5\n- 6`,
				`## assumptions`,
				`- claim: ok`,
			].join("\n"),
			customSchema,
		);
		expect(
			scoreWorkerHeuristicV2(few, customSchema, DEFAULT_ROLE_WEIGHTS.divergent).breakdown.hits.openQuestions,
		).toBe(1);
		expect(
			scoreWorkerHeuristicV2(many, customSchema, DEFAULT_ROLE_WEIGHTS.divergent).breakdown.hits.openQuestions,
		).toBe(0);
	});

	it("default schema still scores via plan / open_questions (regression)", () => {
		const parsed = parsedWith("x".repeat(250), "- question: a | context: b", "- claim: y | basis: z");
		const result = scoreWorkerHeuristicV2(parsed, DEFAULT_OUTPUT_SCHEMA, DEFAULT_ROLE_WEIGHTS.divergent);
		expect(result.breakdown.hits.planSubstance).toBe(1);
		expect(result.breakdown.hits.openQuestions).toBe(1);
		expect(result.contractHardFail).toBe(false);
	});

	it("list-only schema: primary list is not also scored as openQuestions", () => {
		const listOnly: MoaOutputSchema = {
			sections: [{ name: "findings", required: true, type: "list" }],
		};
		const many = ["- a", "- b", "- c", "- d", "- e", "- f"].join("\n");
		const parsed = parseWorkerOutputBySchema(`## findings\n${many}`, listOnly);
		const result = scoreWorkerHeuristicV2(parsed, listOnly, DEFAULT_ROLE_WEIGHTS.divergent);
		// findings is primary (substance by length of raw text via bullets is short
		// individually but joined body may still be <200) — openQuestions must not
		// penalize the same section for having ≥5 bullets.
		expect(result.breakdown.hits.openQuestions).toBe(1);
	});
});
