import { describe, expect, it } from "bun:test";
import discoveryPromptTemplate from "../src/prompts/discovery.md" with { type: "text" };
import inputCollectPromptTemplate from "../src/prompts/input-collect.md" with { type: "text" };
import {
	emptyTco,
	extractJsonObject,
	normalizeOutputSchema,
	parseDiscoveryOutput,
	parseNeededInputs,
	renderTcoForPrompt,
	validateTco,
} from "../src/tco";
import { DEFAULT_OUTPUT_SCHEMA, INPUT_COLLECT_SCHEMA } from "../src/types";

describe("extractJsonObject", () => {
	it("parses plain JSON", () => {
		const result = extractJsonObject('{"a": 1}') as { a: number };
		expect(result).toEqual({ a: 1 });
	});

	it("strips ```json fences", () => {
		const raw = 'Here is the JSON:\n```json\n{"a": 2}\n```\nDone.';
		const result = extractJsonObject(raw) as { a: number };
		expect(result).toEqual({ a: 2 });
	});

	it("strips ``` fences (no language tag)", () => {
		const raw = '```\n{"a": 3}\n```';
		const result = extractJsonObject(raw) as { a: number };
		expect(result).toEqual({ a: 3 });
	});

	it("falls back to first {...} block when full parse fails", () => {
		const raw = 'preamble {"a": 4} trailing';
		const result = extractJsonObject(raw) as { a: number };
		expect(result).toEqual({ a: 4 });
	});

	it("returns undefined for empty / non-string input", () => {
		expect(extractJsonObject("")).toBeUndefined();
		expect(extractJsonObject(undefined as unknown as string)).toBeUndefined();
		expect(extractJsonObject("nothing to parse")).toBeUndefined();
	});
});

describe("parseDiscoveryOutput — clamp behavior", () => {
	it("clamps missing_inputs to max (keeps all required first)", () => {
		const missing = Array.from({ length: 10 }, (_, i) => ({
			key: `k${i}`,
			question: `q${i}`,
			type: "text",
			required: i < 3,
		}));
		const raw = JSON.stringify({ task_understanding: "x", known_inputs: [], missing_inputs: missing });
		const { tco } = parseDiscoveryOutput(raw, { maxMissingInputs: 3 });
		expect(tco.missing_inputs).toHaveLength(3);
		expect(tco.missing_inputs.map((m: { required: boolean }) => m.required)).toEqual([true, true, true]);
	});
});

describe("parseDiscoveryOutput", () => {
	it("parses well-formed LLM output", () => {
		const raw = JSON.stringify({
			task_understanding: "design a 4-week hiring plan",
			known_inputs: [{ key: "founder", value: "彭梦龙", source: "user_md" }],
			missing_inputs: [
				{
					key: "positions",
					question: "10 个岗位具体是哪 10 个？",
					type: "list",
					required: true,
					why_critical: "worker 没有清单只能瞎猜",
				},
			],
		});
		const { tco } = parseDiscoveryOutput(raw);
		expect(tco.task_understanding).toBe("design a 4-week hiring plan");
		expect(tco.known_inputs).toHaveLength(1);
		expect(tco.known_inputs[0]?.key).toBe("founder");
		expect(tco.missing_inputs).toHaveLength(1);
		expect(tco.missing_inputs[0]?.key).toBe("positions");
	});

	it("extracts defaultValue from missing_inputs when present", () => {
		const raw = JSON.stringify({
			task_understanding: "x",
			known_inputs: [],
			missing_inputs: [
				{
					key: "positions",
					question: "10 个岗位具体是哪 10 个？",
					type: "list",
					required: true,
					why_critical: "worker 需要清单",
					defaultValue: ["感知算法工程师", "SLAM 工程师"],
				},
				{
					key: "deadline",
					question: "多久招完？",
					type: "text",
					required: false,
					why_critical: "方案需要 timeline",
					defaultValue: "4 weeks",
				},
			],
		});
		const { tco } = parseDiscoveryOutput(raw);
		expect(tco.missing_inputs[0]?.defaultValue).toEqual(["感知算法工程师", "SLAM 工程师"]);
		expect(tco.missing_inputs[1]?.defaultValue).toBe("4 weeks");
	});

	it("defaultValue is undefined when not in raw input", () => {
		const raw = JSON.stringify({
			task_understanding: "x",
			known_inputs: [],
			missing_inputs: [{ key: "k", question: "q", type: "text", required: true, why_critical: "w" }],
		});
		const { tco } = parseDiscoveryOutput(raw);
		expect(tco.missing_inputs[0]?.defaultValue).toBeUndefined();
	});

	it("defaultValue is undefined when explicitly null", () => {
		const raw = JSON.stringify({
			task_understanding: "x",
			known_inputs: [],
			missing_inputs: [
				{ key: "k", question: "q", type: "text", required: true, why_critical: "w", defaultValue: null },
			],
		});
		const { tco } = parseDiscoveryOutput(raw);
		expect(tco.missing_inputs[0]?.defaultValue).toBeUndefined();
	});

	it("clamps missing_inputs to max", () => {
		const missing = Array.from({ length: 10 }, (_, i) => ({
			key: `k${i}`,
			question: `q${i}`,
			type: "text",
			required: i < 3,
		}));
		const raw = JSON.stringify({ task_understanding: "x", known_inputs: [], missing_inputs: missing });
		const { tco } = parseDiscoveryOutput(raw, { maxMissingInputs: 3 });
		expect(tco.missing_inputs).toHaveLength(3);
		expect(tco.missing_inputs.map(m => m.required)).toEqual([true, true, true]);
	});

	it("strips invalid entries without throwing", () => {
		const raw = JSON.stringify({
			task_understanding: "x",
			known_inputs: [
				{ key: "good", value: 1, source: "user_md" },
				{ value: 2, source: "user_md" }, // missing key
				null,
			],
			missing_inputs: [
				{ key: "q1", question: "ask", type: "text", required: true },
				{ type: "text", required: true }, // missing key & question
			],
		});
		const { tco } = parseDiscoveryOutput(raw);
		expect(tco.known_inputs).toHaveLength(1);
		expect(tco.missing_inputs).toHaveLength(1);
	});

	it("defaults source to llm_inferred when invalid", () => {
		const raw = JSON.stringify({
			task_understanding: "x",
			known_inputs: [{ key: "k", value: 1, source: "made_up_source" }],
		});
		const { tco } = parseDiscoveryOutput(raw);
		expect(tco.known_inputs[0]?.source).toBe("llm_inferred");
	});

	it("returns empty TCO on garbage input", () => {
		const { tco } = parseDiscoveryOutput("not json at all");
		expect(tco.task_understanding).toBe("");
		expect(tco.known_inputs).toEqual([]);
		expect(tco.missing_inputs).toEqual([]);
		expect(tco.assumptions).toEqual([]);
	});

	it("parses assumptions with reason", () => {
		const raw = JSON.stringify({
			task_understanding: "x",
			known_inputs: [],
			assumptions: [{ key: "start_date", value: "2026-08-01", reason: "llm_inferred", note: "next Monday" }],
		});
		const { tco } = parseDiscoveryOutput(raw);
		expect(tco.assumptions).toHaveLength(1);
		expect(tco.assumptions[0]?.key).toBe("start_date");
		expect(tco.assumptions[0]?.note).toBe("next Monday");
	});
});

describe("validateTco", () => {
	it("flags select without options", () => {
		const { tco } = parseDiscoveryOutput(
			JSON.stringify({
				task_understanding: "x",
				known_inputs: [],
				missing_inputs: [{ key: "k", question: "q", type: "select", required: true }],
			}),
		);
		const v = validateTco(tco, 5);
		expect(v.ok).toBe(false);
		expect(v.errors.some(e => e.includes("type=select but no options"))).toBe(true);
	});

	it("flags missing_inputs length over cap", () => {
		// parseDiscoveryOutput clamps to its own default cap (5), so build a TCO
		// manually to push the validator's contract: 6 items, cap=5 → not ok.
		const tco = emptyTco("x");
		for (let i = 0; i < 6; i++) {
			tco.missing_inputs.push({ key: `k${i}`, question: "q", type: "text", required: true });
		}
		const v = validateTco(tco, 5);
		expect(v.ok).toBe(false);
		expect(v.errors.some(e => e.includes("missing_inputs length"))).toBe(true);
	});

	it("flags duplicate keys", () => {
		const { tco } = parseDiscoveryOutput(
			JSON.stringify({
				task_understanding: "x",
				known_inputs: [
					{ key: "x", value: 1, source: "user_md" },
					{ key: "x", value: 2, source: "moa_yml" },
				],
				missing_inputs: [],
			}),
		);
		const v = validateTco(tco, 5);
		expect(v.warnings.some(w => w.includes("duplicate"))).toBe(true);
	});
});

describe("renderTcoForPrompt", () => {
	it("renders known_inputs and assumptions", () => {
		const { tco } = parseDiscoveryOutput(
			JSON.stringify({
				task_understanding: "design a hiring plan",
				known_inputs: [{ key: "founder", value: "彭梦龙", source: "user_md" }],
				assumptions: [{ key: "budget", value: 400, reason: "llm_inferred" }],
			}),
		);
		const out = renderTcoForPrompt(tco);
		expect(out).toContain("design a hiring plan");
		expect(out).toContain("founder");
		expect(out).toContain("彭梦龙");
		expect(out).toContain("[assumed:");
		expect(out).toContain("budget");
	});

	it("truncates when over maxBytes", () => {
		const { tco: big } = parseDiscoveryOutput(
			JSON.stringify({
				task_understanding: "x".repeat(2000),
				known_inputs: [],
			}),
		);
		const out = renderTcoForPrompt(big, { maxBytes: 200 });
		expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(200);
		expect(out).toContain("truncated");
	});
});

describe("emptyTco", () => {
	it("produces a minimal fallback TCO", () => {
		const tco = emptyTco("the task", "because");
		expect(tco.task_understanding).toBe("the task");
		expect(tco.known_inputs).toEqual([]);
		expect(tco.missing_inputs).toEqual([]);
		expect(tco.assumptions).toHaveLength(1);
		expect(tco.assumptions[0]?.reason).toBe("non_interactive_fallback");
	});
});

// ============================================================================
// normalizeOutputSchema + parseDiscoveryOutput schema read path (PR2)
// ============================================================================

describe("normalizeOutputSchema", () => {
	it("returns the fallback when value is missing", () => {
		expect(normalizeOutputSchema(undefined, DEFAULT_OUTPUT_SCHEMA)).toBe(DEFAULT_OUTPUT_SCHEMA);
	});
	it("returns the fallback when value is not an object", () => {
		expect(normalizeOutputSchema("nope", DEFAULT_OUTPUT_SCHEMA)).toBe(DEFAULT_OUTPUT_SCHEMA);
		expect(normalizeOutputSchema(42, DEFAULT_OUTPUT_SCHEMA)).toBe(DEFAULT_OUTPUT_SCHEMA);
	});
	it("returns the fallback when sections array is empty", () => {
		expect(normalizeOutputSchema({ sections: [] }, DEFAULT_OUTPUT_SCHEMA)).toBe(DEFAULT_OUTPUT_SCHEMA);
	});
	it("normalizes section names (lowercased, trimmed) and required flag", () => {
		const out = normalizeOutputSchema(
			{
				sections: [
					{ name: "  PLAN ", required: true, type: "markdown" },
					{ name: "OPEN_QUESTIONS", type: "list" },
				],
			},
			DEFAULT_OUTPUT_SCHEMA,
		);
		expect(out.sections.map(s => s.name)).toEqual(["plan", "open_questions"]);
		expect(out.sections[0]?.required).toBe(true);
		expect(out.sections[1]?.required).toBe(false);
		expect(out.sections[1]?.type).toBe("list");
	});
	it("defaults unknown type to markdown", () => {
		const out = normalizeOutputSchema({ sections: [{ name: "x", type: "image" }] }, DEFAULT_OUTPUT_SCHEMA);
		expect(out.sections[0]?.type).toBe("markdown");
	});
	it("dedupes duplicate section names", () => {
		const out = normalizeOutputSchema({ sections: [{ name: "plan" }, { name: "PLAN" }] }, DEFAULT_OUTPUT_SCHEMA);
		expect(out.sections).toHaveLength(1);
	});
	it("returns fallback when every section is invalid", () => {
		const out = normalizeOutputSchema({ sections: [{ foo: 1 }, { bar: 2 }] }, DEFAULT_OUTPUT_SCHEMA);
		expect(out).toBe(DEFAULT_OUTPUT_SCHEMA);
	});
});

describe("parseDiscoveryOutput — output_schema extraction (PR2)", () => {
	it("returns the default schema when Discovery emits no output_schema", () => {
		const raw = JSON.stringify({ task_understanding: "x", known_inputs: [], missing_inputs: [] });
		const { outputSchema } = parseDiscoveryOutput(raw);
		expect(outputSchema).toBe(DEFAULT_OUTPUT_SCHEMA);
	});
	it("uses Discovery's output_schema when present", () => {
		const raw = JSON.stringify({
			task_understanding: "x",
			known_inputs: [],
			missing_inputs: [],
			output_schema: {
				sections: [
					{ name: "findings", required: true, type: "markdown" },
					{ name: "open_questions", required: true, type: "list" },
				],
			},
		});
		const { outputSchema } = parseDiscoveryOutput(raw);
		expect(outputSchema.sections.map(s => s.name)).toEqual(["findings", "open_questions"]);
	});
	it("falls back to default on malformed output_schema", () => {
		const raw = JSON.stringify({
			task_understanding: "x",
			known_inputs: [],
			missing_inputs: [],
			output_schema: "not an object",
		});
		const { outputSchema } = parseDiscoveryOutput(raw);
		expect(outputSchema).toBe(DEFAULT_OUTPUT_SCHEMA);
	});
});

describe("discovery prompt — A checklist (once-right P1)", () => {
	it("requires scanning goal / scope / constraints / environment / decisions / risks / non-goals", () => {
		const text = discoveryPromptTemplate;
		for (const category of ["目标", "范围", "约束", "环境", "决策", "风险", "非目标"]) {
			expect(text).toContain(category);
		}
		expect(text).toMatch(/≤\s*5|at most 5|capped at 5|3-5/i);
	});

	it("parses missing_inputs whose keys follow A-checklist categories", () => {
		const raw = JSON.stringify({
			task_understanding: "2-week campus hiring plan",
			known_inputs: [{ key: "duration_weeks", value: 2, source: "user" }],
			missing_inputs: [
				{
					key: "goal_headcount",
					question: "目标招聘人数？",
					type: "number",
					required: true,
					why_critical: "规模决定场次",
				},
				{
					key: "scope_roles",
					question: "招聘岗位范围？",
					type: "list",
					required: true,
					why_critical: "决定渠道",
					defaultValue: ["算法", "软件"],
				},
				{
					key: "constraint_budget",
					question: "预算上限？",
					type: "select",
					options: ["<5万", "5-15万", ">15万"],
					required: true,
					why_critical: "决定宣讲规格",
				},
				{
					key: "env_cities",
					question: "目标城市？",
					type: "list",
					required: false,
					why_critical: "可选学校池",
				},
				{
					key: "decision_format",
					question: "线上还是线下？",
					type: "select",
					options: ["线上", "线下", "混合"],
					required: true,
					why_critical: "流程骨架",
				},
			],
			assumptions: [],
		});
		const { tco } = parseDiscoveryOutput(raw);
		expect(tco.missing_inputs.map(m => m.key)).toEqual([
			"goal_headcount",
			"scope_roles",
			"constraint_budget",
			"env_cities",
			"decision_format",
		]);
	});
});

describe("INPUT_COLLECT_SCHEMA (once-right P2)", () => {
	it("is a single required list section `needed_inputs` and forbids a full plan", () => {
		expect(INPUT_COLLECT_SCHEMA.sections).toHaveLength(1);
		const [section] = INPUT_COLLECT_SCHEMA.sections;
		expect(section?.name).toBe("needed_inputs");
		expect(section?.required).toBe(true);
		expect(section?.type).toBe("list");
		// No `plan` section — B must never emit a full plan.
		expect(INPUT_COLLECT_SCHEMA.sections.some(s => s.name === "plan")).toBe(false);
	});
});

describe("input-collect prompt — B contract (once-right P2)", () => {
	it("forbids emitting a plan and demands only the needed_inputs checklist", () => {
		const text = inputCollectPromptTemplate;
		expect(text).toContain("needed_inputs");
		// Must instruct the worker NOT to produce a plan / solution.
		expect(text).toMatch(/do not|不要|禁止/i);
		expect(text).toMatch(/plan|方案|solution/i);
	});
});

describe("parseNeededInputs (once-right P2)", () => {
	it("parses `;`-delimited labeled bullet lines into TcoMissingInput[]", () => {
		const raw = [
			"## needed_inputs",
			"",
			"- key: target_env; question: 部署到哪个环境？; type: text; required: true; why: 影响回滚脚本",
			"- key: rollback_window; question: 允许的回滚窗口(分钟)？; type: number; required: false; why: 决定演练时长",
		].join("\n");
		const items = parseNeededInputs(raw);
		expect(items).toHaveLength(2);
		expect(items[0]).toMatchObject({
			key: "target_env",
			question: "部署到哪个环境？",
			type: "text",
			required: true,
			why_critical: "影响回滚脚本",
		});
		expect(items[1]).toMatchObject({
			key: "rollback_window",
			type: "number",
			required: false,
		});
	});

	it("downgrades `select` to `text` (B cannot supply options → avoid silent skip)", () => {
		const raw = "## needed_inputs\n\n- key: env; question: 哪个环境？; type: select; required: true; why: w";
		const items = parseNeededInputs(raw);
		expect(items[0]?.type).toBe("text");
	});

	it("returns [] for a soft-recovered plan even when it contains bullets", () => {
		const raw = "## Step 1\n\n- do the first thing\n- do the second thing\n\nMore prose describing the plan.";
		expect(parseNeededInputs(raw)).toEqual([]);
	});

	it("falls back to text/optional and slugs a key when a bullet has no labels", () => {
		const raw = "## needed_inputs\n\n- 目标用户是谁？";
		const items = parseNeededInputs(raw);
		expect(items).toHaveLength(1);
		expect(items[0]?.question).toBe("目标用户是谁？");
		expect(items[0]?.type).toBe("text");
		expect(items[0]?.required).toBe(false);
		expect(items[0]?.key.length).toBeGreaterThan(0);
	});

	it("returns [] when the section is missing or empty", () => {
		expect(parseNeededInputs("")).toEqual([]);
		expect(parseNeededInputs("## needed_inputs\n\n")).toEqual([]);
		// A full plan output has no needed_inputs list ⇒ nothing collected.
		expect(parseNeededInputs("## plan\n\nDo the thing in three steps.")).toEqual([]);
	});

	it("defaults an unknown type to text", () => {
		const raw = "## needed_inputs\n\n- key: k; question: q?; type: bogus; required: true; why: w";
		const items = parseNeededInputs(raw);
		expect(items[0]?.type).toBe("text");
	});
});
