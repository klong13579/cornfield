import { describe, expect, it } from "bun:test";
import { buildPlan, buildWorkerTaskMessage } from "../src/planner";
import rewritePromptTemplate from "../src/prompts/rewrite.md" with { type: "text" };
import workerPromptTemplate from "../src/prompts/worker.md" with { type: "text" };
import { resolveSettings } from "../src/settings";
import { DEFAULT_OUTPUT_SCHEMA, type MoaOutputSchema, type MoaSettings } from "../src/types";

const SETTINGS: MoaSettings = resolveSettings({});

describe("buildPlan", () => {
	it("injects research guidance into worker prompts when provided", () => {
		const plan = buildPlan("architecture tradeoffs", SETTINGS, DEFAULT_OUTPUT_SCHEMA, "## Research guidance\n- use web_search");
		for (const w of plan.workers) {
			expect(w.prompt).toContain("Research guidance");
			expect(w.prompt).toContain("web_search");
		}
	});

	it("omits research guidance block when empty", () => {
		const plan = buildPlan("fix typo", SETTINGS);
		expect(plan.workers[0]!.prompt).not.toContain("## Research guidance");
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
			// Default schema section names must not be hardcoded into the
			// Required output schema block when a custom schema is used.
			expect(w.prompt).not.toMatch(/Required output schema[\s\S]*`## open_questions`/);
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

describe("plan-round prompt contract (once-right P3)", () => {
	it("worker prompt: unique Ask already done; residual uncertainty → assumptions, not another user round", () => {
		const text = workerPromptTemplate;
		expect(text).toMatch(/unique Ask|single Ask|唯一.*Ask|Ask (?:is |has )?already|already (?:been )?asked/i);
		expect(text).toMatch(/assumptions/i);
		expect(text).toMatch(
			/do not (?:expect|trigger|wait for)|not (?:another|a second)|no (?:further|second) (?:Ask|round)|禁止.*(?:再问|二次)/i,
		);
	});

	it("rewrite prompt embeds the same once-right Ask-complete contract for generated worker prompts", () => {
		const text = rewritePromptTemplate;
		expect(text).toMatch(/unique Ask|single Ask|唯一.*Ask|Ask (?:is |has )?already|already (?:been )?asked/i);
		expect(text).toMatch(/assumptions/i);
		expect(text).toMatch(
			/do not (?:expect|trigger|wait for)|not (?:another|a second)|no (?:further|second) (?:Ask|round)|禁止.*(?:再问|二次)/i,
		);
	});

	it("rewrite + worker templates carry research_guidance injection points", () => {
		expect(rewritePromptTemplate).toContain("research_guidance");
		expect(workerPromptTemplate).toContain("research_guidance");
	});

	it("built worker prompts carry the once-right Ask-complete contract", () => {
		const plan = buildPlan("design a rollback drill", SETTINGS);
		for (const w of plan.workers) {
			expect(w.prompt).toMatch(/unique Ask|single Ask|Ask (?:is |has )?already|already (?:been )?asked/i);
			expect(w.prompt).toMatch(/assumptions/i);
		}
	});
});

describe("buildWorkerTaskMessage (schema-forcing user message)", () => {
	it("embeds the task and forces the first schema header as the first line", () => {
		const msg = buildWorkerTaskMessage("design a health endpoint", DEFAULT_OUTPUT_SCHEMA);
		expect(msg).toContain("## Task");
		expect(msg).toContain("design a health endpoint");
		expect(msg).toMatch(/FIRST line MUST be exactly `## plan`/);
		expect(msg).toContain("## open_questions");
		expect(msg).toContain("## assumptions");
	});

	it("uses Discovery-driven section names when schema is custom", () => {
		const schema: MoaOutputSchema = {
			sections: [
				{ name: "plan", required: true, type: "markdown" },
				{ name: "code_diff", required: true, type: "markdown" },
				{ name: "verify_steps", required: true, type: "list" },
			],
		};
		const msg = buildWorkerTaskMessage("health check", schema);
		expect(msg).toMatch(/FIRST line MUST be exactly `## plan`/);
		expect(msg).toContain("## code_diff");
		expect(msg).toContain("## verify_steps");
	});
});

// Sanity: planner uses the worker slots from settings
describe("buildPlan integration", () => {
	it("emits exactly settings.workerCount workers", () => {
		const plan = buildPlan("x", resolveSettings({ workerCount: 2 }));
		expect(plan.workers).toHaveLength(2);
		expect(plan.workers.map(w => w.name)).toEqual(["divergent", "grounded"]);
	});
});
