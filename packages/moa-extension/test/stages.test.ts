import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage, ModelRegistry } from "@oh-my-pi/pi-coding-agent";
import { Settings } from "@oh-my-pi/pi-coding-agent";
import { buildPlan } from "../src/planner";
import { resolveSettings } from "../src/settings";
import {
	runAskStage,
	runDiscoveryStage,
	runRewriteStage,
	runSynthesisStage,
	runWorkersStage,
} from "../src/stages";
import * as subprocess from "../src/subprocess";
import type { WorkerOutput } from "../src/subprocess";
import { emptyTco } from "../src/tco";
import { DEFAULT_OUTPUT_SCHEMA } from "../src/types";

function makeWorkerOutput(overrides: Partial<WorkerOutput> = {}): WorkerOutput {
	return {
		ok: overrides.ok ?? true,
		output:
			overrides.output ??
			`{"task_understanding":"t","known_inputs":[],"missing_inputs":[],"assumptions":[]}`,
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
	return [
		`## plan`,
		`${label} produced a plan with enough detail to pass the quality heuristic. We considered the tradeoffs, chose one path, and wrote the assumptions explicitly.`,
		``,
		`## open_questions`,
		``,
		`## assumptions`,
		`- ${label} assumed a sensible default for an unspecified parameter.`,
	].join("\n");
}

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

	it("runSynthesisStage spawns once for surviving workers", async () => {
		const spy = vi.spyOn(subprocess, "spawnMoaWorker").mockResolvedValue(
			makeWorkerOutput({ output: "merged recommendation" }),
		);
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
		);
		expect(spy).toHaveBeenCalledTimes(1);
		expect(result.synthesis.ok).toBe(true);
		expect(result.synthesis.output).toContain("merged");
	});
});
