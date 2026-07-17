import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage, ModelRegistry } from "@oh-my-pi/pi-coding-agent";
import { Settings } from "@oh-my-pi/pi-coding-agent";
import { buildPlan } from "../src/planner";
import * as judgeModule from "../src/quality/judge";
import { resolveSettings } from "../src/settings";
import {
	runAskStage,
	runDiscoveryStage,
	runInputCollectStage,
	runRewriteStage,
	runSynthesisStage,
	runWorkersStage,
} from "../src/stages";
import type { WorkerOutput } from "../src/subprocess";
import * as subprocess from "../src/subprocess";
import { emptyTco } from "../src/tco";
import { DEFAULT_OUTPUT_SCHEMA } from "../src/types";

function makeWorkerOutput(overrides: Partial<WorkerOutput> = {}): WorkerOutput {
	return {
		ok: overrides.ok ?? true,
		output: overrides.output ?? `{"task_understanding":"t","known_inputs":[],"missing_inputs":[],"assumptions":[]}`,
		stderr: overrides.stderr ?? "",
		exitCode: overrides.exitCode ?? 0,
		aborted: overrides.aborted ?? false,
		timedOut: overrides.timedOut ?? false,
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

describe("runAskStage", () => {
	afterEach(() => vi.restoreAllMocks());

	it("fills assumptions when hasUI=false", async () => {
		const moaSettings = resolveSettings({ askEnabled: true, workerExecutionMode: "subprocess" });
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
