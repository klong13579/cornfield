import { describe, expect, it } from "bun:test";
import { buildPlan } from "../src/planner";
import { DEFAULT_WORKER_SLOTS, resolveSettings } from "../src/settings";
import { DEFAULT_OUTPUT_SCHEMA, type MoaOutputSchema, type MoaSettings } from "../src/types";

const SETTINGS: MoaSettings = resolveSettings({});

describe("buildPlan", () => {
	it("uses DEFAULT_OUTPUT_SCHEMA when none provided", () => {
		const plan = buildPlan("design panel", SETTINGS);
		for (const w of plan.workers) {
			expect(w.prompt).toContain("## plan");
			expect(w.prompt).toContain("## open_questions");
			expect(w.prompt).toContain("## assumptions");
			expect(w.prompt).toContain("type: markdown");
			expect(w.prompt).toContain("type: list");
		}
	});

	it("renders the output schema section in each worker prompt", () => {
		const plan = buildPlan("x", SETTINGS);
		for (const w of plan.workers) {
			expect(w.prompt).toContain("Required output schema");
		}
	});

	it("renders hard rules at the top (before TCO / task)", () => {
		const plan = buildPlan("x", SETTINGS);
		const hardRulesIdx = plan.workers[0]!.prompt.indexOf("Hard rules");
		const taskIdx = plan.workers[0]!.prompt.indexOf("## Task");
		expect(hardRulesIdx).toBeGreaterThanOrEqual(0);
		expect(hardRulesIdx).toBeLessThan(taskIdx);
	});

	it("accepts a custom output schema (PR2 path)", () => {
		const customSchema: MoaOutputSchema = {
			sections: [
				{ name: "code_diff", required: true, type: "markdown" },
				{ name: "test_plan", required: true, type: "markdown" },
				{ name: "risks", required: false, type: "list", item: { risk: "string", severity: "low|med|high" } },
			],
		};
		const plan = buildPlan("implement feature", SETTINGS, customSchema);
		for (const w of plan.workers) {
			expect(w.prompt).toContain("`## code_diff`");
			expect(w.prompt).toContain("`## test_plan`");
			expect(w.prompt).toContain("`## risks`");
			expect(w.prompt).toContain("severity: low|med|high");
			// Default schema sections should NOT appear when overridden
			expect(w.prompt).not.toContain("`## open_questions`");
		}
	});

	it("marks required vs optional in rendered schema", () => {
		const plan = buildPlan("x", SETTINGS);
		const prompt = plan.workers[0]!.prompt;
		expect(prompt).toContain("(required)");
		expect(prompt).toContain("(optional)");
	});

	it("still includes role-specific worker_prompt line", () => {
		const plan = buildPlan("x", SETTINGS);
		for (const w of plan.workers) {
			expect(w.prompt).toContain(`Approach the task from the ${w.name} angle.`);
		}
	});

	it("exposes DEFAULT_OUTPUT_SCHEMA as a stable contract", () => {
		// Lock the default schema shape so downstream tests / docs can rely on it
		expect(DEFAULT_OUTPUT_SCHEMA.sections.map(s => s.name)).toEqual(["plan", "open_questions", "assumptions"]);
		expect(DEFAULT_OUTPUT_SCHEMA.sections[0]!.required).toBe(true);
		expect(DEFAULT_OUTPUT_SCHEMA.sections[1]!.required).toBe(true);
		expect(DEFAULT_OUTPUT_SCHEMA.sections[2]!.required).toBe(false);
	});
});

// Sanity: planner uses the worker slots from settings
describe("buildPlan integration", () => {
	it("emits exactly settings.workerCount workers", () => {
		const plan = buildPlan("x", resolveSettings({ workerCount: 2 }));
		expect(plan.workers).toHaveLength(2);
		expect(plan.workers.map(w => w.name)).toEqual(DEFAULT_WORKER_SLOTS.slice(0, 2).map(s => s.name));
	});
});
