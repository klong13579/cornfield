import { describe, expect, test } from "bun:test";
import { ALIBABA_CODING_PLAN_SELECTOR_MODEL_IDS } from "../src/provider-models/alibaba-coding-plan-curated";

describe("Alibaba Coding Plan curated selector ids", () => {
	test("curated set size matches supported rollout", () => {
		expect(ALIBABA_CODING_PLAN_SELECTOR_MODEL_IDS.size).toBe(6);
	});
});
