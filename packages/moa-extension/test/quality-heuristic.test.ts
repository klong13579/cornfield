import { describe, expect, it } from "bun:test";
import { scoreWorkerHeuristicV2 } from "../src/quality/heuristic";
import { DEFAULT_ROLE_WEIGHTS } from "../src/quality/weights";
import { DEFAULT_OUTPUT_SCHEMA } from "../src/types";
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
});
