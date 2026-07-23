import { describe, expect, it } from "bun:test";
import { shouldSkipInputCollect } from "../src/skip-input-collect";
import { emptyTco } from "../src/tco";

describe("shouldSkipInputCollect", () => {
	it("skips for compare intent", () => {
		const tco = emptyTco("对比 workbuddy 和 openclaw", "t");
		tco.task_intent = "compare";
		expect(shouldSkipInputCollect(tco)).toBe(true);
	});

	it("does not skip for design / local-impl", () => {
		const design = emptyTco("设计招聘计划", "t");
		design.task_intent = "design";
		expect(shouldSkipInputCollect(design)).toBe(false);
		const local = emptyTco("修 typo", "t");
		local.task_intent = "local-impl";
		expect(shouldSkipInputCollect(local)).toBe(false);
	});

	it("infers compare from task text when intent missing", () => {
		const tco = emptyTco("hermes agent 和 workbuddy 的区别是什么？", "t");
		expect(shouldSkipInputCollect(tco)).toBe(true);
	});
});
