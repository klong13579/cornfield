import { describe, expect, it } from "bun:test";
import { shouldJudge } from "../src/quality/judge";

describe("shouldJudge", () => {
	const cases = [
		{ enabled: false, hardFail: false, heuristic: 35, minScore: 40, margin: 10, expect: false },
		{ enabled: true, hardFail: true, heuristic: 20, minScore: 40, margin: 10, expect: false },
		{ enabled: true, hardFail: false, heuristic: 35, minScore: 40, margin: 10, expect: true },
		{ enabled: true, hardFail: false, heuristic: 45, minScore: 40, margin: 10, expect: true },
		{ enabled: true, hardFail: false, heuristic: 70, minScore: 40, margin: 10, expect: false },
	] as const;

	for (const c of cases) {
		it(`enabled=${c.enabled} hardFail=${c.hardFail} score=${c.heuristic} → ${c.expect}`, () => {
			expect(
				shouldJudge({
					enabled: c.enabled,
					contractHardFail: c.hardFail,
					heuristicScore: c.heuristic,
					minScore: c.minScore,
					grayMargin: c.margin,
				}),
			).toBe(c.expect);
		});
	}
});
