import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage, ModelRegistry } from "@oh-my-pi/pi-coding-agent";
import { Settings } from "@oh-my-pi/pi-coding-agent";
import { buildPlan } from "../src/planner";
import * as judgeModule from "../src/quality/judge";
import { resolveSettings } from "../src/settings";
import {
	buildDegradedSynthesis,
	mapWorkerOutput,
	resolvePlanWorkerMaxToolRounds,
	restrictPlanWorkerTools,
	runAskStage,
	runDiscoveryStage,
	runInputCollectStage,
	runResearchStage,
	runRewriteStage,
	runSynthesisStage,
	runWorkersStage,
} from "../src/stages";
import type { WorkerOutput } from "../src/subprocess";
import * as subprocess from "../src/subprocess";
import { emptyTco } from "../src/tco";
import { DEFAULT_OUTPUT_SCHEMA, type MoaWorkerResult } from "../src/types";

function makeWorkerOutput(overrides: Partial<WorkerOutput> = {}): WorkerOutput {
	return {
		ok: overrides.ok ?? true,
		output: overrides.output ?? `{"task_understanding":"t","known_inputs":[],"missing_inputs":[],"assumptions":[]}`,
		stderr: overrides.stderr ?? "",
		exitCode: overrides.exitCode ?? 0,
		aborted: overrides.aborted ?? false,
		timedOut: overrides.timedOut ?? false,
		idleTimedOut: overrides.idleTimedOut,
		toolBudgetExceeded: overrides.toolBudgetExceeded,
		toolTraceText: overrides.toolTraceText,
		stopReason: overrides.stopReason ?? "stop",
		usage: overrides.usage ?? {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			turns: 1,
		},
		durationMs: overrides.durationMs ?? 1,
		model: overrides.model,
	};
}

function conformingOutput(label: string): string {
	const planBody =
		`${label} produced a plan with enough detail to pass the quality heuristic. ` +
		"We considered the tradeoffs, chose one path, and wrote the assumptions explicitly. " +
		"Additional context ensures plan substance exceeds the 200-character threshold for v2 role weights.";
	return [
		`## plan`,
		planBody,
		``,
		`## open_questions`,
		``,
		`## assumptions`,
		`- ${label} assumed a sensible default for an unspecified parameter.`,
	].join("\n");
}

const LOW_QUALITY_OUTPUT = `## plan
Short plan with 请确认 here.

## open_questions
- q1
- q2
- q3
- q4
- q5
- q6`;

function baseOptions(moaSettings = resolveSettings({ workerExecutionMode: "subprocess" })) {
	return {
		cwd: "/tmp/moa-stage-test",
		authStorage: {} as AuthStorage,
		modelRegistry: { refresh: async () => {}, getAvailable: () => [] } as unknown as ModelRegistry,
		settings: Settings.isolated({}, { cwd: "/tmp/moa-stage-test" }),
		moaSettings,
		hasUI: false as boolean | undefined,
		ui: undefined as undefined,
	};
}

describe("mapWorkerOutput (worker audit diagnostics)", () => {
	it("forwards usage, duration, stopReason, timeout flags, and truncated toolTrace", () => {
		const longTrace = `[read]\n${"x".repeat(40_000)}`;
		const mapped = mapWorkerOutput(
			makeWorkerOutput({
				ok: false,
				output: "",
				stderr: "Request was aborted",
				timedOut: true,
				idleTimedOut: false,
				toolBudgetExceeded: false,
				aborted: true,
				stopReason: "aborted",
				toolTraceText: longTrace,
				usage: { input: 100, output: 0, cacheRead: 10, cacheWrite: 0, cost: 0.01, turns: 2 },
				durationMs: 480_123,
			}),
			"grounded",
			"Evaluate constraints",
			"narwal-plan/deepseek-v4-pro-202606",
		);
		expect(mapped.durationMs).toBe(480_123);
		expect(mapped.stopReason).toBe("aborted");
		expect(mapped.timedOut).toBe(true);
		expect(mapped.idleTimedOut).toBe(false);
		expect(mapped.toolBudgetExceeded).toBe(false);
		expect(mapped.aborted).toBe(true);
		expect(mapped.usage).toEqual({
			input: 100,
			output: 0,
			cacheRead: 10,
			cacheWrite: 0,
			cost: 0.01,
			turns: 2,
		});
		expect(mapped.toolTraceText).toBeDefined();
		expect(mapped.toolTraceText!.length).toBeLessThan(longTrace.length);
		expect(mapped.toolTraceText).toContain("[truncated");
		expect(mapped.stderr).toMatch(/timed out after 480s/);
	});

	it("keeps streamPreview when provided for empty timed-out workers", () => {
		const mapped = mapWorkerOutput(
			makeWorkerOutput({
				ok: false,
				output: "",
				timedOut: true,
				durationMs: 1000,
				stopReason: "aborted",
			}),
			"grounded",
			"role",
			"m",
			undefined,
			{ streamPreview: "partial thinking about workbuddy…" },
		);
		expect(mapped.streamPreview).toContain("workbuddy");
	});
});

describe("runDiscoveryStage", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns tco + outputSchema when discoveryEnabled", async () => {
		vi.spyOn(subprocess, "spawnMoaWorker").mockResolvedValue(
			makeWorkerOutput({
				output: JSON.stringify({
					task_understanding: "hire plan",
					known_inputs: [{ key: "weeks", value: 4, source: "user" }],
					missing_inputs: [],
					assumptions: [],
				}),
			}),
		);
		const moaSettings = resolveSettings({
			discoveryEnabled: true,
			rewriteEnabled: false,
			workerExecutionMode: "subprocess",
		});
		const result = await runDiscoveryStage(
			{ task: "4 week hiring", settings: moaSettings },
			baseOptions(moaSettings),
		);
		expect(result.tco.task_understanding).toContain("hire");
		expect(result.outputSchema).toBeDefined();
		expect(result.durationMs).toBeGreaterThanOrEqual(0);
	});

	it("returns empty TCO + DEFAULT_OUTPUT_SCHEMA when discovery disabled", async () => {
		const spy = vi.spyOn(subprocess, "spawnMoaWorker");
		const moaSettings = resolveSettings({
			discoveryEnabled: false,
			rewriteEnabled: false,
			workerExecutionMode: "subprocess",
		});
		const result = await runDiscoveryStage(
			{ task: "skip discovery", settings: moaSettings },
			baseOptions(moaSettings),
		);
		expect(spy).not.toHaveBeenCalled();
		expect(result.tco.task_understanding).toBeTruthy();
		expect(result.outputSchema).toEqual(DEFAULT_OUTPUT_SCHEMA);
		expect(result.result).toBeUndefined();
	});
});

describe("runInputCollectStage (once-right P2)", () => {
	afterEach(() => vi.restoreAllMocks());

	it("collects needed_inputs from each worker, tagged source=worker + role", async () => {
		vi.spyOn(subprocess, "spawnMoaWorker").mockResolvedValue(
			makeWorkerOutput({
				output:
					"## needed_inputs\n- key: target_env; question: 部署到哪个环境？; type: select; required: true; why: 影响回滚脚本",
			}),
		);
		const moaSettings = resolveSettings({ inputCollectEnabled: true, workerExecutionMode: "subprocess" });
		const plan = buildPlan("回滚演练", moaSettings);
		const result = await runInputCollectStage(
			plan,
			emptyTco("回滚演练", "test"),
			{ task: plan.task, settings: moaSettings },
			baseOptions(moaSettings),
		);
		expect(result.results).toHaveLength(3);
		expect(result.missing.length).toBeGreaterThanOrEqual(1);
		for (const m of result.missing) {
			expect(m.source).toBe("worker");
			expect(m.roles && m.roles.length).toBeGreaterThan(0);
		}
		expect(result.durationMs).toBeGreaterThanOrEqual(0);
	});

	it("returns empty and spawns nothing when inputCollectEnabled=false", async () => {
		const spy = vi.spyOn(subprocess, "spawnMoaWorker");
		const moaSettings = resolveSettings({ inputCollectEnabled: false, workerExecutionMode: "subprocess" });
		const plan = buildPlan("任务", moaSettings);
		const result = await runInputCollectStage(
			plan,
			emptyTco("任务", "test"),
			{ task: plan.task, settings: moaSettings },
			baseOptions(moaSettings),
		);
		expect(result.missing).toEqual([]);
		expect(result.results).toEqual([]);
		expect(spy).not.toHaveBeenCalled();
	});
});

describe("runResearchStage (Phase 7)", () => {
	afterEach(() => vi.restoreAllMocks());

	it("returns a parsed research_pack for a required-mode task", async () => {
		vi.spyOn(subprocess, "spawnMoaWorker").mockResolvedValue(
			makeWorkerOutput({
				output: JSON.stringify({
					queries: ["cursor compaction strategy"],
					sources: [{ claim: "Cursor summarizes", url: "https://docs.cursor.com/x", relevance: "compaction" }],
					repo_facts: [],
					gaps: ["Continue TTL unknown"],
				}),
			}),
		);
		const moaSettings = resolveSettings({ researchMode: "required", workerExecutionMode: "subprocess" });
		const tco = emptyTco("对比业界压缩策略", "test");
		const result = await runResearchStage(
			tco,
			{ task: tco.task_understanding, settings: moaSettings },
			baseOptions(moaSettings),
		);
		expect(result.pack).not.toBeNull();
		expect(result.packSource).toBe("json");
		expect(result.pack?.mode).toBe("required");
		expect(result.pack?.sources[0]?.url).toBe("https://docs.cursor.com/x");
		expect(result.results.length).toBeGreaterThanOrEqual(1);
		expect(result.durationMs).toBeGreaterThanOrEqual(0);
	});

	it("no-ops (no spawn, null pack) when researchMode=none", async () => {
		const spy = vi.spyOn(subprocess, "spawnMoaWorker");
		const moaSettings = resolveSettings({ researchMode: "none", workerExecutionMode: "subprocess" });
		const tco = emptyTco("修个 typo", "test");
		const result = await runResearchStage(
			tco,
			{ task: tco.task_understanding, settings: moaSettings },
			baseOptions(moaSettings),
		);
		expect(spy).not.toHaveBeenCalled();
		expect(result.pack).toBeNull();
		expect(result.packSource).toBeNull();
	});

	it("salvages a pack when research aborts empty after tool budget", async () => {
		vi.spyOn(subprocess, "spawnMoaWorker").mockResolvedValue(
			makeWorkerOutput({
				ok: false,
				output: "",
				stderr: "Request was aborted\n(research tool budget exceeded after 12 tool calls)",
				toolBudgetExceeded: true,
				timedOut: true,
			}),
		);
		const moaSettings = resolveSettings({ researchMode: "required", workerExecutionMode: "subprocess" });
		const tco = emptyTco("对比业界压缩策略", "test");
		const result = await runResearchStage(
			tco,
			{ task: tco.task_understanding, settings: moaSettings },
			baseOptions(moaSettings),
		);
		expect(result.pack).not.toBeNull();
		expect(result.packSource).toBe("salvage");
		expect(result.pack?.parse_source).toBe("salvage");
		expect(result.pack?.gaps.join(" ")).toMatch(/budget|interrupted|web_search/i);
	});

	it("finalizes tool_trace pack when tool traces have URLs but model output is empty", async () => {
		vi.spyOn(subprocess, "spawnMoaWorker").mockResolvedValue(
			makeWorkerOutput({
				ok: false,
				output: "",
				stderr: "research web_search budget exceeded after 3 searches",
				toolBudgetExceeded: true,
				toolTraceText:
					"[web_search]\n- https://github.com/openclaw/openclaw\n- https://docs.openclaw.ai/intro\n- https://workbuddy.dev/",
			}),
		);
		const moaSettings = resolveSettings({ researchMode: "required", workerExecutionMode: "subprocess" });
		const result = await runResearchStage(
			emptyTco("对比一下 workbuddy 和 openclaw", "test"),
			{ task: "对比一下 workbuddy 和 openclaw", settings: moaSettings },
			baseOptions(moaSettings),
			{ polishClaims: false },
		);
		expect(result.packSource).toBe("tool_trace");
		expect(result.pack?.parse_source).toBe("tool_trace");
		expect(result.pack!.sources.length).toBeGreaterThanOrEqual(3);
		expect(result.pack!.sources.length).toBeLessThanOrEqual(8);
	});

	it("applies claim polish (C) after tool_trace salvage", async () => {
		vi.spyOn(subprocess, "spawnMoaWorker").mockResolvedValue(
			makeWorkerOutput({
				ok: false,
				output: "",
				stderr: "research web_search budget exceeded after 3 searches",
				toolBudgetExceeded: true,
				toolTraceText: `[web_search]
[1] OpenClaw intro
    https://docs.openclaw.ai/intro
    OpenClaw is an open agent runtime for local workflows.
`,
			}),
		);
		const moaSettings = resolveSettings({ researchMode: "required", workerExecutionMode: "subprocess" });
		const result = await runResearchStage(
			emptyTco("对比一下 workbuddy 和 openclaw", "test"),
			{ task: "对比一下 workbuddy 和 openclaw", settings: moaSettings },
			baseOptions(moaSettings),
			{
				polishClaims: async ({ pack }) => ({
					...pack,
					sources: pack.sources.map(s =>
						s.url.includes("docs.openclaw.ai")
							? {
									...s,
									claim: "OpenClaw is an open agent runtime for local workflows",
									relevance: "Defines OpenClaw product positioning",
								}
							: s,
					),
				}),
			},
		);
		expect(result.packSource).toBe("tool_trace");
		const openclaw = result.pack?.sources.find(s => s.url.includes("docs.openclaw.ai"));
		expect(openclaw?.claim).toBe("OpenClaw is an open agent runtime for local workflows");
		expect(openclaw?.relevance).toBe("Defines OpenClaw product positioning");
	});

	it("uses researchModel when set, otherwise synthesisModel", async () => {
		const spy = vi.spyOn(subprocess, "spawnMoaWorker").mockResolvedValue(
			makeWorkerOutput({
				output: JSON.stringify({
					queries: ["q"],
					sources: [],
					repo_facts: [],
					gaps: [],
				}),
			}),
		);
		const withResearch = resolveSettings({
			researchMode: "required",
			workerExecutionMode: "subprocess",
			synthesisModel: "provider/heavy-synth",
			researchModel: "provider/light-research",
		});
		await runResearchStage(
			emptyTco("对比业界压缩策略", "test"),
			{ task: "对比业界压缩策略", settings: withResearch },
			baseOptions(withResearch),
		);
		expect(spy.mock.calls[0]?.[0]?.model).toBe("provider/light-research");

		spy.mockClear();
		const withoutResearch = resolveSettings({
			researchMode: "required",
			workerExecutionMode: "subprocess",
			synthesisModel: "provider/heavy-synth",
		});
		await runResearchStage(
			emptyTco("对比业界压缩策略", "test"),
			{ task: "对比业界压缩策略", settings: withoutResearch },
			baseOptions(withoutResearch),
		);
		expect(spy.mock.calls[0]?.[0]?.model).toBe("provider/heavy-synth");
	});
});

describe("buildDegradedSynthesis (Phase 7 — never empty)", () => {
	it("produces non-empty content from research_pack + assumptions + partial workers", () => {
		const tco = emptyTco("对比业界压缩策略", "test");
		tco.research_pack = {
			mode: "required",
			gathered_at: "2026-07-17T00:00:00.000Z",
			queries: ["q"],
			sources: [{ claim: "Cursor summarizes middle", url: "https://docs.cursor.com/x", relevance: "compaction" }],
			repo_facts: ["omp uses RotatingFileTransport"],
			gaps: ["Continue TTL unknown"],
		};
		tco.assumptions.push({ key: "budget", value: 3, reason: "user_skipped" });
		const workers: MoaWorkerResult[] = [
			{
				name: "divergent",
				role: "r",
				ok: false,
				output: "## plan\n部分方案草稿…",
				stderr: "timed out after 300s",
				exitCode: null,
			},
		];
		const synth = buildDegradedSynthesis(tco, workers);
		expect(synth.name).toBe("synthesis");
		expect(synth.ok).toBe(false);
		// crucially non-empty and actionable
		expect(synth.output.length).toBeGreaterThan(0);
		expect(synth.output).toContain("https://docs.cursor.com/x");
		expect(synth.output).toContain("RotatingFileTransport");
		expect(synth.output).toContain("Continue TTL unknown");
		expect(synth.output).toContain("部分方案草稿");
		expect(synth.output).toMatch(/缩小范围|narrow|重跑|rerun/i);
	});

	it("still yields content when there is no research_pack but partial worker output exists", () => {
		const tco = emptyTco("t", "test");
		const workers: MoaWorkerResult[] = [
			{ name: "grounded", role: "r", ok: false, output: "## plan\n仅有的半成品", stderr: "", exitCode: null },
		];
		const synth = buildDegradedSynthesis(tco, workers);
		expect(synth.output).toContain("仅有的半成品");
	});
});

describe("restrictPlanWorkerTools (Phase 7)", () => {
	it("removes web_search when research already ran (non-none mode)", () => {
		const out = restrictPlanWorkerTools(["read", "search", "web_search", "ast_grep"], "required");
		expect(out).not.toContain("web_search");
		expect(out).toEqual(["read", "search", "ast_grep"]);
	});
	it("leaves tools untouched for none mode", () => {
		const out = restrictPlanWorkerTools(["read", "web_search"], "none");
		expect(out).toEqual(["read", "web_search"]);
	});
	it("expands 'all' to the read-only set without web_search in research modes", () => {
		const out = restrictPlanWorkerTools("all", "required");
		expect(out).not.toBe("all");
		expect(Array.isArray(out) && !out.includes("web_search")).toBe(true);
		expect(Array.isArray(out) && out.includes("read")).toBe(true);
	});
	it("passes 'all' through unchanged for none mode", () => {
		expect(restrictPlanWorkerTools("all", "none")).toBe("all");
	});

	it("intersects explicit lists so write/edit/bash cannot sneak in after research (P2)", () => {
		const out = restrictPlanWorkerTools(["read", "write", "edit", "bash", "search", "web_search"], "required");
		expect(out).toEqual(["read", "search"]);
		expect(out).not.toContain("write");
		expect(out).not.toContain("edit");
		expect(out).not.toContain("bash");
	});
});

describe("resolvePlanWorkerMaxToolRounds (P2)", () => {
	it("caps compare research workers tighter than design", () => {
		expect(resolvePlanWorkerMaxToolRounds("compare", "required")).toBe(8);
		expect(resolvePlanWorkerMaxToolRounds("design", "encouraged")).toBe(12);
		expect(resolvePlanWorkerMaxToolRounds("local-impl", "none")).toBe(12);
		expect(resolvePlanWorkerMaxToolRounds("design", "none")).toBe(0);
	});
});

describe("runAskStage", () => {
	afterEach(() => vi.restoreAllMocks());

	it("fills assumptions when hasUI=false", async () => {
		const moaSettings = resolveSettings({ askEnabled: true, askStrategy: "form", workerExecutionMode: "subprocess" });
		const tco = emptyTco("ask me", "test");
		tco.missing_inputs.push({
			key: "budget",
			question: "预算多少？",
			type: "text",
			required: true,
			why_critical: "needed",
		});
		const result = await runAskStage(tco, { task: "ask me", settings: moaSettings }, baseOptions(moaSettings));
		expect(result.askSummary.assumed).toBe(1);
		expect(result.askSummary.answered).toBe(0);
		expect(tco.assumptions.some(a => a.key === "budget")).toBe(true);
	});

	it("filters definition-style missing before form ask", async () => {
		const moaSettings = resolveSettings({ askEnabled: true, askStrategy: "form", workerExecutionMode: "subprocess" });
		const tco = emptyTco("compare tools", "test");
		tco.missing_inputs.push(
			{
				key: "what_is_x",
				question: "workbuddy 在本项目具体指什么？",
				type: "text",
				required: true,
				why_critical: "def",
			},
			{
				key: "dims",
				question: "对比维度？",
				type: "text",
				required: true,
				why_critical: "decision",
			},
		);
		await runAskStage(tco, { task: "compare tools", settings: moaSettings }, baseOptions(moaSettings));
		expect(tco.missing_inputs.map(m => m.key)).toEqual(["dims"]);
		expect(tco.assumptions.some(a => a.key === "dims")).toBe(true);
		expect(tco.assumptions.some(a => a.key === "what_is_x")).toBe(false);
	});
});

describe("runRewriteStage", () => {
	afterEach(() => vi.restoreAllMocks());

	it("updates worker prompts from ## name sections", async () => {
		vi.spyOn(subprocess, "spawnMoaWorker").mockResolvedValue(
			makeWorkerOutput({
				output: [
					"## divergent",
					"divergent prompt body with enough text",
					"",
					"## grounded",
					"grounded prompt body with enough text",
					"",
					"## critical",
					"critical prompt body with enough text",
				].join("\n"),
			}),
		);
		const moaSettings = resolveSettings({
			discoveryEnabled: false,
			rewriteEnabled: true,
			workerExecutionMode: "subprocess",
		});
		const plan = buildPlan("rewrite task", moaSettings);
		const tco = emptyTco("rewrite task", "test");
		const result = await runRewriteStage(
			tco,
			plan,
			{ task: plan.task, settings: moaSettings },
			baseOptions(moaSettings),
			DEFAULT_OUTPUT_SCHEMA,
		);
		expect(result.workers.find(w => w.name === "divergent")?.prompt).toContain("divergent prompt");
		expect(result.workers.find(w => w.name === "grounded")?.prompt).toContain("grounded prompt");
		expect(result.workers.find(w => w.name === "critical")?.prompt).toContain("critical prompt");
		expect(result.fallbackUsed).toBe(false);
	});

	it("marks fallbackUsed when output is ok but sections do not match worker names", async () => {
		vi.spyOn(subprocess, "spawnMoaWorker").mockResolvedValue(
			makeWorkerOutput({
				output: "## not_a_worker\nsome freeform rewrite that cannot be applied",
			}),
		);
		const moaSettings = resolveSettings({
			discoveryEnabled: false,
			rewriteEnabled: true,
			workerExecutionMode: "subprocess",
		});
		const plan = buildPlan("rewrite fallback", moaSettings);
		const original = plan.workers.map(w => w.prompt);
		const result = await runRewriteStage(
			emptyTco(plan.task, "test"),
			plan,
			{ task: plan.task, settings: moaSettings },
			baseOptions(moaSettings),
			DEFAULT_OUTPUT_SCHEMA,
		);
		expect(result.fallbackUsed).toBe(true);
		expect(result.result?.ok).toBe(true);
		expect(result.result?.stderr).toMatch(/fallback|unparsed|original/i);
		expect(result.workers.map(w => w.prompt)).toEqual(original);
	});
});

describe("runWorkersStage + runSynthesisStage", () => {
	afterEach(() => vi.restoreAllMocks());

	it("returns surviving workers and dispatchLog for conforming outputs", async () => {
		vi.spyOn(subprocess, "spawnMoaWorker").mockImplementation(async input =>
			makeWorkerOutput({
				output: conformingOutput(input.model ?? "w"),
				model: input.model,
			}),
		);
		const moaSettings = resolveSettings({
			discoveryEnabled: false,
			rewriteEnabled: false,
			workerExecutionMode: "subprocess",
		});
		const plan = buildPlan("workers task", moaSettings);
		const tco = emptyTco(plan.task, "test");
		const result = await runWorkersStage({
			plan,
			baseWorkers: plan.workers,
			tco,
			outputSchema: DEFAULT_OUTPUT_SCHEMA,
			tcoBlock: "",
			ctx: { task: plan.task, settings: moaSettings },
			options: baseOptions(moaSettings),
			effectiveMaxRounds: 0,
		});
		expect(result.surviving).toHaveLength(3);
		expect(result.dispatchLog).toHaveLength(3);
		expect(result.signal).not.toBe("quality_failed");
	});

	it("wires judgeFn into apply when quality.judge.enabled", async () => {
		const mockJudgeFn = vi.fn(async () => ({ score: 80 }));
		const createSpy = vi.spyOn(judgeModule, "createSpawnJudgeFn").mockReturnValue(mockJudgeFn);

		vi.spyOn(subprocess, "spawnMoaWorker").mockResolvedValue(
			makeWorkerOutput({ output: LOW_QUALITY_OUTPUT, ok: true }),
		);

		const moaSettings = resolveSettings({
			discoveryEnabled: false,
			rewriteEnabled: false,
			workerExecutionMode: "subprocess",
			qualityMinScore: 40,
			quality: { judge: { enabled: true } },
		});
		const plan = buildPlan("judge wiring task", moaSettings);
		const result = await runWorkersStage({
			plan,
			baseWorkers: plan.workers,
			tco: emptyTco(plan.task, "test"),
			outputSchema: DEFAULT_OUTPUT_SCHEMA,
			tcoBlock: "",
			ctx: { task: plan.task, settings: moaSettings },
			options: baseOptions(moaSettings),
			effectiveMaxRounds: 0,
		});

		expect(createSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				cwd: "/tmp/moa-stage-test",
				model: "narwal-plan/minimax-m3",
				timeoutMs: 60_000,
			}),
		);
		expect(mockJudgeFn).toHaveBeenCalledTimes(3);
		expect(result.surviving).toHaveLength(3);
		expect(result.workers.every(w => w.qualityMeta?.judged)).toBe(true);
		expect(result.workers.every(w => w.qualityMeta?.source === "judge")).toBe(true);
	});

	it("signals quality_failed when all workers drop", async () => {
		vi.spyOn(subprocess, "spawnMoaWorker").mockResolvedValue(
			makeWorkerOutput({ output: "not a valid plan section at all", ok: true }),
		);
		const moaSettings = resolveSettings({
			discoveryEnabled: false,
			rewriteEnabled: false,
			workerExecutionMode: "subprocess",
			qualityMinScore: 70,
		});
		const plan = buildPlan("drop task", moaSettings);
		const result = await runWorkersStage({
			plan,
			baseWorkers: plan.workers,
			tco: emptyTco(plan.task, "test"),
			outputSchema: DEFAULT_OUTPUT_SCHEMA,
			tcoBlock: "",
			ctx: { task: plan.task, settings: moaSettings },
			options: baseOptions(moaSettings),
			effectiveMaxRounds: 0,
		});
		expect(result.surviving).toHaveLength(0);
		expect(result.signal).toBe("quality_failed");
	});

	it("forwards onWorkerPartial chunks grouped by worker name (once-right P5)", async () => {
		const partials: Array<{ name: string; text: string }> = [];
		vi.spyOn(subprocess, "spawnMoaWorker").mockImplementation(async input => {
			const label = input.model ?? "w";
			input.onPartial?.({ text: `${label} draft` });
			input.onPartial?.({ text: `${label} draft complete` });
			return makeWorkerOutput({
				output: conformingOutput(label),
				model: input.model,
			});
		});
		const moaSettings = resolveSettings({
			discoveryEnabled: false,
			rewriteEnabled: false,
			workerExecutionMode: "subprocess",
		});
		const plan = buildPlan("stream partials task", moaSettings);
		await runWorkersStage({
			plan,
			baseWorkers: plan.workers,
			tco: emptyTco(plan.task, "test"),
			outputSchema: DEFAULT_OUTPUT_SCHEMA,
			tcoBlock: "",
			ctx: { task: plan.task, settings: moaSettings },
			options: baseOptions(moaSettings),
			effectiveMaxRounds: 0,
			hooks: {
				onWorkerPartial: chunk => partials.push(chunk),
			},
		});
		expect(partials.length).toBeGreaterThanOrEqual(6);
		const names = new Set(partials.map(p => p.name));
		expect(names.has("divergent")).toBe(true);
		expect(names.has("grounded")).toBe(true);
		expect(names.has("critical")).toBe(true);
		expect(partials.every(p => p.text.length > 0)).toBe(true);
	});

	it("runSynthesisStage spawns once for surviving workers", async () => {
		const spy = vi
			.spyOn(subprocess, "spawnMoaWorker")
			.mockResolvedValue(makeWorkerOutput({ output: "merged recommendation" }));
		const moaSettings = resolveSettings({
			discoveryEnabled: false,
			rewriteEnabled: false,
			workerExecutionMode: "subprocess",
		});
		const plan = buildPlan("synth task", moaSettings);
		const surviving = [
			{
				name: "divergent",
				role: "r",
				ok: true,
				output: conformingOutput("d"),
				stderr: "",
				exitCode: 0,
			},
			{
				name: "grounded",
				role: "r",
				ok: true,
				output: conformingOutput("g"),
				stderr: "",
				exitCode: 0,
			},
		];
		const result = await runSynthesisStage(
			plan,
			surviving,
			{ task: plan.task, settings: moaSettings },
			baseOptions(moaSettings),
			"",
			emptyTco(plan.task, "test"),
		);
		expect(spy).toHaveBeenCalledTimes(1);
		expect(result.synthesis.ok).toBe(true);
		expect(result.synthesis.output).toContain("merged");
	});

	it("synthesis prompt includes TCO assumptions when askEnabled and injects tco_block once", async () => {
		const spy = vi
			.spyOn(subprocess, "spawnMoaWorker")
			.mockResolvedValue(makeWorkerOutput({ output: "merged recommendation" }));
		const moaSettings = resolveSettings({
			discoveryEnabled: false,
			rewriteEnabled: false,
			workerExecutionMode: "subprocess",
			askEnabled: true,
		});
		const plan = buildPlan("synth assumptions task", moaSettings);
		const tco = emptyTco(plan.task, "test");
		tco.assumptions.push({
			key: "target_env",
			value: "staging",
			reason: "user_skipped",
			note: "user skipped required env",
		});
		const tcoBlock = "## Task Context (from discovery stage)\n\n### Task understanding\nsynth assumptions task";
		const surviving = [
			{
				name: "divergent",
				role: "r",
				ok: true,
				output: conformingOutput("d"),
				stderr: "",
				exitCode: 0,
			},
		];
		await runSynthesisStage(
			plan,
			surviving,
			{ task: plan.task, settings: moaSettings },
			baseOptions(moaSettings),
			tcoBlock,
			tco,
		);
		expect(spy).toHaveBeenCalledTimes(1);
		const systemPrompt = String(spy.mock.calls[0]?.[0]?.systemPrompt ?? "");
		expect(systemPrompt).toContain("Assumptions made during the run");
		expect(systemPrompt).toContain("target_env");
		expect(systemPrompt).toContain("staging");
		expect(systemPrompt).toContain("user_skipped");
		// tco_block appears in the template once — not also prepended again.
		expect(systemPrompt.split("Task Context (from discovery stage)").length - 1).toBe(1);
	});

	it("synthesis tolerates assumption values that JSON.stringify cannot serialize", async () => {
		const spy = vi
			.spyOn(subprocess, "spawnMoaWorker")
			.mockResolvedValue(makeWorkerOutput({ output: "merged recommendation" }));
		const moaSettings = resolveSettings({
			discoveryEnabled: false,
			rewriteEnabled: false,
			workerExecutionMode: "subprocess",
		});
		const plan = buildPlan("unserializable assumption task", moaSettings);
		const tco = emptyTco(plan.task, "test");
		tco.assumptions.push({
			key: "large_counter",
			value: 1n,
			reason: "llm_inferred",
		});

		await expect(
			runSynthesisStage(
				plan,
				[
					{
						name: "divergent",
						role: "r",
						ok: true,
						output: conformingOutput("d"),
						stderr: "",
						exitCode: 0,
					},
				],
				{ task: plan.task, settings: moaSettings },
				baseOptions(moaSettings),
				"",
				tco,
			),
		).resolves.toBeDefined();
		expect(spy).toHaveBeenCalledTimes(1);
		expect(String(spy.mock.calls[0]?.[0]?.systemPrompt ?? "")).toContain("<unserializable>");
	});
});
