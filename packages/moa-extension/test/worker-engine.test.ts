import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage, ModelRegistry, Settings } from "@oh-my-pi/pi-coding-agent";
import * as codingAgent from "@oh-my-pi/pi-coding-agent";
import { executePlan } from "../src/executor";
import { resolveSettings } from "../src/settings";
import { type WorkerOutput } from "../src/subprocess";
import type { MoaWorkerEngine } from "../src/worker-engine";
import * as workerEngine from "../src/worker-engine";
import { buildPlan } from "../src/planner";

// ============================================================================
// Worker engine factory — dispatch test
// ============================================================================

describe("createWorkerEngine — dispatch", () => {
	const dummyShared = {
		cwd: "/tmp",
		authStorage: {} as AuthStorage,
		modelRegistry: {} as ModelRegistry,
		settings: {} as Settings,
	};

	it("returns SubprocessWorkerEngine for mode=subprocess", () => {
		const engine = workerEngine.createWorkerEngine("subprocess", dummyShared);
		expect(engine.constructor.name).toBe("SubprocessWorkerEngine");
	});

	it("returns InProcessWorkerEngine for mode=in-process", () => {
		const engine = workerEngine.createWorkerEngine("in-process", dummyShared);
		expect(engine.constructor.name).toBe("InProcessWorkerEngine");
	});
});

// ============================================================================
// In-process worker engine — isolated unit tests
// ============================================================================

function makeStubWorkerOutput(overrides: Partial<WorkerOutput> = {}): WorkerOutput {
	return {
		ok: overrides.ok ?? true,
		output: overrides.output ?? "ok",
		stderr: overrides.stderr ?? "",
		exitCode: overrides.exitCode ?? 0,
		aborted: overrides.aborted ?? false,
		timedOut: overrides.timedOut ?? false,
		model: overrides.model,
		stopReason: overrides.stopReason ?? "stop",
		usage: overrides.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
		durationMs: overrides.durationMs ?? 1,
	};
}

/**
 * Worker output that follows the default MoaOutputSchema contract (PR2).
 */
function conformingOutput(label: string): string {
	return [
		`## plan`,
		`${label} produced a plan with enough detail to pass the quality heuristic.`,
		``,
		`## open_questions`,
		``,
		`## assumptions`,
		`- ${label} assumed a sensible default.`,
	].join("\n");
}

describe("executePlan — in-process mode dispatch", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("uses InProcessWorkerEngine when workerExecutionMode=in-process", async () => {
		const createEngineSpy = vi.spyOn(workerEngine, "createWorkerEngine");
		// We need to spy on the actual InProcessWorkerEngine execute method.
		// The createWorkerEngine factory returns the real adapter; we mock
		// execute to return a fake result without hitting createAgentSession.
		const fakeEngine: MoaWorkerEngine = {
			execute: vi.fn().mockResolvedValue(makeStubWorkerOutput({ output: conformingOutput("w1") })),
		};
		createEngineSpy.mockReturnValue(fakeEngine);

		const plan = buildPlan("In-process dispatch test", resolveSettings());
		const moaSettings = resolveSettings({
			workerExecutionMode: "in-process",
			discoveryEnabled: false,
			rewriteEnabled: false,
		});
		const authStorage = {} as AuthStorage;
		const modelRegistry = { refresh: async () => {} } as unknown as ModelRegistry;
		const settings = codingAgent.Settings.isolated({}, { cwd: "/tmp/moa" });

		const result = await executePlan(plan, {
			cwd: "/tmp/moa",
			authStorage,
			modelRegistry,
			settings,
			moaSettings,
		});

		// Verify the factory was called with the right mode.
		expect(createEngineSpy).toHaveBeenCalledWith("in-process", expect.any(Object));
		// Verify the engine's execute was called (once per worker + synthesis).
		expect(fakeEngine.execute).toHaveBeenCalledTimes(4);
		// Verify result structure is the same as subprocess.
		expect(result.workers).toHaveLength(3);
		expect(result.synthesis).toBeDefined();
	});

	it("workerExecutionMode=subprocess still goes through SubprocessWorkerEngine", async () => {
		const createEngineSpy = vi.spyOn(workerEngine, "createWorkerEngine");
		const fakeEngine: MoaWorkerEngine = {
			execute: vi.fn().mockResolvedValue(makeStubWorkerOutput({ output: conformingOutput("w1") })),
		};
		createEngineSpy.mockReturnValue(fakeEngine);

		const plan = buildPlan("Subprocess dispatch test", resolveSettings());
		const moaSettings = resolveSettings({
			workerExecutionMode: "subprocess",
			discoveryEnabled: false,
			rewriteEnabled: false,
		});
		const result = await executePlan(plan, {
			cwd: "/tmp/moa",
			authStorage: {} as AuthStorage,
			modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
			settings: codingAgent.Settings.isolated({}, { cwd: "/tmp/moa" }),
			moaSettings,
		});

		expect(createEngineSpy).toHaveBeenCalledWith("subprocess", expect.any(Object));
		expect(fakeEngine.execute).toHaveBeenCalledTimes(4);
		expect(result.workers).toHaveLength(3);
	});

	it("in-process with discovery: discovery engine.execute has tools=none", async () => {
		const createEngineSpy = vi.spyOn(workerEngine, "createWorkerEngine");
		let callCount = 0;
		const fakeEngine: MoaWorkerEngine = {
			execute: vi.fn(() => {
				callCount++;
				return Promise.resolve(makeStubWorkerOutput({ output: conformingOutput("ok"), model: "test/model" }));
			}),
		};
		createEngineSpy.mockReturnValue(fakeEngine);

		const plan = buildPlan("Discovery tools=none test", resolveSettings());
		const moaSettings = resolveSettings({
			workerExecutionMode: "in-process",
			// Enable discovery + rewrite so we can verify their tool constraints.
			discoveryEnabled: true,
			rewriteEnabled: true,
		});
		await executePlan(plan, {
			cwd: "/tmp/moa",
			authStorage: {} as AuthStorage,
			modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
			settings: codingAgent.Settings.isolated({}, { cwd: "/tmp/moa" }),
			moaSettings,
		});

		// 1 discovery + 1 rewrite + 3 workers + 1 synthesis = 6 total.
		const calls = (fakeEngine.execute as ReturnType<typeof vi.fn>).mock.calls;
		// First call is discovery (tools=none).
		const discoveryInput = calls[0]?.[0] as { tools: string } | undefined;
		expect(discoveryInput?.tools).toBe("none");
		// Second call is rewrite (tools=none).
		const rewriteInput = calls[1]?.[0] as { tools: string } | undefined;
		expect(rewriteInput?.tools).toBe("none");
		// Last call is synthesis (tools=none).
		const synthesisInput = calls[calls.length - 1]?.[0] as { tools: string } | undefined;
		expect(synthesisInput?.tools).toBe("none");
	});
});

describe("in-process worker engine — failure semantics", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("engine.execute throw maps to MoaWorkerResult with ok=false exitCode=null", async () => {
		const createEngineSpy = vi.spyOn(workerEngine, "createWorkerEngine");
		const fakeEngine: MoaWorkerEngine = {
			execute: vi.fn().mockRejectedValue(new Error("worker crashed")),
		};
		createEngineSpy.mockReturnValue(fakeEngine);

		const plan = buildPlan("Crash test", resolveSettings());
		const moaSettings = resolveSettings({
			workerExecutionMode: "in-process",
			discoveryEnabled: false,
			rewriteEnabled: false,
		});
		const result = await executePlan(plan, {
			cwd: "/tmp/moa",
			authStorage: {} as AuthStorage,
			modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
			settings: codingAgent.Settings.isolated({}, { cwd: "/tmp/moa" }),
			moaSettings,
		});

		// All 3 workers crashed — synthesis should still run (with no survivors).
		expect(result.workers.every(w => w.ok === false)).toBe(true);
		expect(result.workers.every(w => w.exitCode === null)).toBe(true);
		expect(result.workers.some(w => w.stderr.includes("worker crashed"))).toBe(true);
		expect(result.synthesis).toBeDefined();
	});

	it("some workers throw, synthesis still runs with healthy ones", async () => {
		const createEngineSpy = vi.spyOn(workerEngine, "createWorkerEngine");
		const mockCalls: string[] = [];
		const fakeEngine: MoaWorkerEngine = {
			execute: vi.fn((input: Parameters<MoaWorkerEngine["execute"]>[0]) => {
				mockCalls.push(input.model ?? "unknown");
				// Worker 2 (grounded) throws.
				if (mockCalls.length === 2) return Promise.reject(new Error("grounded failed"));
				return Promise.resolve(
					makeStubWorkerOutput({ output: conformingOutput(input.model ?? "w"), model: input.model }),
				);
			}),
		};
		createEngineSpy.mockReturnValue(fakeEngine);

		const plan = buildPlan(
			"Partial crash test",
			resolveSettings({
				workers: [
					{ name: "divergent", role: "Diverge", model: "provider/a" },
					{ name: "grounded", role: "Ground", model: "provider/b" },
					{ name: "critical", role: "Critic", model: "provider/c" },
				],
				synthesisModel: "provider/synth",
			}),
		);
		const moaSettings = resolveSettings({
			workerExecutionMode: "in-process",
			discoveryEnabled: false,
			rewriteEnabled: false,
			workers: [
				{ name: "divergent", role: "Diverge", model: "provider/a" },
				{ name: "grounded", role: "Ground", model: "provider/b" },
				{ name: "critical", role: "Critic", model: "provider/c" },
			],
		});
		const result = await executePlan(plan, {
			cwd: "/tmp/moa",
			authStorage: {} as AuthStorage,
			modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
			settings: codingAgent.Settings.isolated({}, { cwd: "/tmp/moa" }),
			moaSettings,
		});

		// Worker 2 (index 1) should be the crash.
		expect(result.workers[1]).toMatchObject({ ok: false, stderr: "grounded failed", exitCode: null });
		// Workers 1 and 3 should be ok.
		expect(result.workers[0]?.ok).toBe(true);
		expect(result.workers[2]?.ok).toBe(true);
		// Synthesis should still run.
		expect(result.synthesis).toBeDefined();
	});
});

describe("in-process — executor contract equivalence (subprocess vs in-process)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("both modes produce the same MoaExecutionResult shape", async () => {
		// Run the plan through both subprocess and in-process engines.
		// We mock execute to return identical outputs regardless of mode.
		const executeStub = vi.fn().mockResolvedValue(
			makeStubWorkerOutput({ output: conformingOutput("worker") }),
		);

		const createEngineSpy = vi.spyOn(workerEngine, "createWorkerEngine");

		for (const mode of ["subprocess", "in-process"] as const) {
			const fakeEngine: MoaWorkerEngine = { execute: executeStub };
			createEngineSpy.mockReturnValue(fakeEngine);

			const plan = buildPlan("Contract test", resolveSettings());
			const moaSettings = resolveSettings({
				workerExecutionMode: mode,
				discoveryEnabled: false,
				rewriteEnabled: false,
			});
			const result = await executePlan(plan, {
				cwd: "/tmp/moa",
				authStorage: {} as AuthStorage,
				modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
				settings: codingAgent.Settings.isolated({}, { cwd: "/tmp/moa" }),
				moaSettings,
			});

			// Verify the MoaExecutionResult has the expected fields.
			expect(result.plan).toBeDefined();
			expect(result.workers).toHaveLength(3);
			expect(result.synthesis).toBeDefined();
			for (const w of result.workers) {
				expect(w).toHaveProperty("ok");
				expect(w).toHaveProperty("output");
				expect(w).toHaveProperty("stderr");
				expect(w).toHaveProperty("exitCode");
				expect(w).toHaveProperty("name");
				expect(w).toHaveProperty("role");
			}
			// Synthesis contract.
			expect(result.synthesis).toMatchObject({
				ok: true,
				name: "synthesis",
			});
		}
	});

	it("exitCode is 0 for in-process success, null for in-process failure", async () => {
		const createEngineSpy = vi.spyOn(workerEngine, "createWorkerEngine");

		// Success case.
		const successEngine: MoaWorkerEngine = {
			execute: vi.fn().mockResolvedValue(makeStubWorkerOutput({ exitCode: 0, output: conformingOutput("ok") })),
		};
		createEngineSpy.mockReturnValue(successEngine);

		const plan = buildPlan("Exit code test", resolveSettings());
		const moaSettings = resolveSettings({ workerExecutionMode: "in-process", discoveryEnabled: false, rewriteEnabled: false });
		const result = await executePlan(plan, {
			cwd: "/tmp/moa",
			authStorage: {} as AuthStorage,
			modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
			settings: codingAgent.Settings.isolated({}, { cwd: "/tmp/moa" }),
			moaSettings,
		});

		// All workers and synthesis should have exitCode=0 for in-process success.
		for (const w of result.workers) {
			expect(w.exitCode).toBe(0);
		}
		expect(result.synthesis?.exitCode).toBe(0);

		// Failure case: engine throws.
		const failEngine: MoaWorkerEngine = {
			execute: vi.fn().mockRejectedValue(new Error("fail")),
		};
		createEngineSpy.mockReturnValue(failEngine);

		const failResult = await executePlan(plan, {
			cwd: "/tmp/moa",
			authStorage: {} as AuthStorage,
			modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
			settings: codingAgent.Settings.isolated({}, { cwd: "/tmp/moa" }),
			moaSettings,
		});

		for (const w of failResult.workers) {
			expect(w.exitCode).toBeNull();
		}
	});
});
