import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage, ModelRegistry } from "@oh-my-pi/pi-coding-agent";
import { Settings } from "@oh-my-pi/pi-coding-agent";
import { executePlan } from "../src/executor";
import { buildPlan } from "../src/planner";
import { DEFAULT_SYNTHESIS_MODEL, DEFAULT_WORKER_MODELS, DEFAULT_WORKER_SLOTS, resolveSettings } from "../src/settings";
import type { SpawnWorkerInput, WorkerOutput } from "../src/subprocess";

function makeWorkerOutput(output = "ok"): WorkerOutput {
	return {
		ok: true,
		output,
		stderr: "",
		exitCode: 0,
		aborted: false,
		timedOut: false,
		model: undefined,
		stopReason: "stop",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
		durationMs: 1,
	};
}

/** Output that passes the default quality heuristic (so synthesis still runs). */
function conformingWorkerOutput(label: string): string {
	return [
		`## plan`,
		`${label} produced a plan with enough detail to pass the quality heuristic. We considered the tradeoffs, chose one path, and wrote the assumptions explicitly.`,
		``,
		`## open_questions`,
		``,
		`## assumptions`,
		`- assumed default`,
	].join("\n");
}

function mockRegistryWithModel(provider: string, id: string): ModelRegistry {
	return {
		getAvailable: () =>
			[
				{
					provider,
					id,
					name: id,
					baseUrl: "",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 0,
					maxTokens: 0,
					api: "anthropic-messages",
				},
			] as never,
	} as unknown as ModelRegistry;
}

function emptyRegistry(): ModelRegistry {
	return { getAvailable: () => [] as never } as unknown as ModelRegistry;
}

async function captureSpawnInputs(): Promise<{ seen: SpawnWorkerInput[]; restore: () => void }> {
	const seen: SpawnWorkerInput[] = [];
	const realSpy = vi.spyOn(await import("../src/subprocess"), "spawnMoaWorker");
	realSpy.mockImplementation(async (input: SpawnWorkerInput) => {
		seen.push(input);
		// Discovery / rewrite use tools=none; return empty JSON so parse falls back.
		// Workers must emit schema-conforming text or fail-loud skips synthesis.
		if (input.tools === "none") {
			return makeWorkerOutput("{}");
		}
		return makeWorkerOutput(conformingWorkerOutput(input.model ?? "w"));
	});
	return { seen, restore: () => realSpy.mockRestore() };
}

describe("heterogeneous default MOA models", () => {
	it("DEFAULT_WORKER_SLOTS uses 3 distinct model strings from different families", () => {
		const models = DEFAULT_WORKER_SLOTS.map(s => s.model);
		expect(models).toHaveLength(3);
		expect(new Set(models).size).toBe(3);
		// Distinct providers (diversity matters more than strength per Together MoA paper)
		const providers = new Set(models.map(m => m?.split("/")[0]));
		expect(providers.size).toBeGreaterThanOrEqual(2);
	});

	it("DEFAULT_SETTINGS.synthesisModel differs from every default worker model", () => {
		const workerModels = DEFAULT_WORKER_SLOTS.map(s => s.model);
		expect(workerModels).not.toContain(DEFAULT_SYNTHESIS_MODEL);
	});

	it("exports named model constants matching the 3 worker slots", () => {
		expect(DEFAULT_WORKER_MODELS.divergent).toBe(DEFAULT_WORKER_SLOTS[0]?.model);
		expect(DEFAULT_WORKER_MODELS.grounded).toBe(DEFAULT_WORKER_SLOTS[1]?.model);
		expect(DEFAULT_WORKER_MODELS.critical).toBe(DEFAULT_WORKER_SLOTS[2]?.model);
	});
});

describe("normalizeWorkerSlots preserves default model/thinking", () => {
	it("user override of name/role keeps default model", () => {
		const out = resolveSettings({
			workerCount: 1,
			workers: [{ name: "alpha", role: "custom" }],
		});
		expect(out.workers[0]?.name).toBe("alpha");
		expect(out.workers[0]?.role).toBe("custom");
		expect(out.workers[0]?.model).toBe(DEFAULT_WORKER_MODELS.divergent);
	});

	it("user override of model wins over default", () => {
		const out = resolveSettings({
			workerCount: 1,
			workers: [{ name: "alpha", role: "custom", model: "alibaba-coding-plan/glm-5" }],
		});
		expect(out.workers[0]?.model).toBe("alibaba-coding-plan/glm-5");
	});

	it("DEFAULT_SETTINGS carries synthesisModel", () => {
		const out = resolveSettings();
		expect(out.synthesisModel).toBe(DEFAULT_SYNTHESIS_MODEL);
	});
});

describe("resolveModel fallback in workers/synthesis", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("uses default slot model (NOT registry) when worker.model is unset", async () => {
		const { seen, restore } = await captureSpawnInputs();
		const registry = mockRegistryWithModel("narwal-plan", "deepseek-v4-flash-202605");
		const plan = buildPlan("task", resolveSettings({ workerCount: 1, workers: [{ name: "a", role: "r" }] }));
		await executePlan(plan, {
			cwd: "/tmp",
			authStorage: {} as AuthStorage,
			modelRegistry: registry,
			settings: Settings.isolated({}, { cwd: "/tmp" }),
		});
		restore();
		// TCO pipeline adds 2 spawns: discovery + rewrite (before the worker + synthesis)
		expect(seen.length).toBe(4);
		expect(seen[2]?.model).toBe(DEFAULT_WORKER_MODELS.divergent);
		expect(seen[3]?.model).toBe(DEFAULT_SYNTHESIS_MODEL);
	});

	it("falls back to modelRegistry.getAvailable()[0] when worker slot has no default model (workerCount > default slot count)", async () => {
		const { seen, restore } = await captureSpawnInputs();
		const registry = mockRegistryWithModel("narwal-plan", "deepseek-v4-flash-202605");
		// workerCount=5 → only first 3 have a default model; 4th and 5th must fall back to registry
		const plan = buildPlan("task", resolveSettings({ workerCount: 5 }));
		await executePlan(plan, {
			cwd: "/tmp",
			authStorage: {} as AuthStorage,
			modelRegistry: registry,
			settings: Settings.isolated({}, { cwd: "/tmp" }),
		});
		restore();
		// TCO pipeline: [discovery, rewrite, worker1..5, synthesis] = 8 spawns
		expect(seen[2]?.model).toBe(DEFAULT_WORKER_MODELS.divergent);
		expect(seen[3]?.model).toBe(DEFAULT_WORKER_MODELS.grounded);
		expect(seen[4]?.model).toBe(DEFAULT_WORKER_MODELS.critical);
		expect(seen[5]?.model).toBe("narwal-plan/deepseek-v4-flash-202605");
		expect(seen[6]?.model).toBe("narwal-plan/deepseek-v4-flash-202605");
		expect(seen[7]?.model).toBe(DEFAULT_SYNTHESIS_MODEL); // synthesis
	});

	it("passes through user-configured worker.model unchanged", async () => {
		const { seen, restore } = await captureSpawnInputs();
		const registry = mockRegistryWithModel("narwal-plan", "deepseek-v4-flash-202605");
		const plan = buildPlan(
			"task",
			resolveSettings({ workerCount: 1, workers: [{ name: "a", role: "r", model: "custom/special" }] }),
		);
		await executePlan(plan, {
			cwd: "/tmp",
			authStorage: {} as AuthStorage,
			modelRegistry: registry,
			settings: Settings.isolated({}, { cwd: "/tmp" }),
		});
		restore();
		// seen[2] is the worker (after discovery + rewrite at seen[0..1])
		expect(seen[2]?.model).toBe("custom/special");
	});

	it("default settings + empty registry: still passes default models to subprocess (registry is fallback, not source of truth)", async () => {
		const { seen, restore } = await captureSpawnInputs();
		const plan = buildPlan("task", resolveSettings());
		await executePlan(plan, {
			cwd: "/tmp",
			authStorage: {} as AuthStorage,
			modelRegistry: emptyRegistry(),
			settings: Settings.isolated({}, { cwd: "/tmp" }),
		});
		restore();
		// TCO pipeline: [discovery, rewrite, 3 workers, synthesis] = 6 spawns
		expect(seen.length).toBe(6);
		expect(seen[2]?.model).toBe(DEFAULT_WORKER_MODELS.divergent);
		expect(seen[3]?.model).toBe(DEFAULT_WORKER_MODELS.grounded);
		expect(seen[4]?.model).toBe(DEFAULT_WORKER_MODELS.critical);
		expect(seen[5]?.model).toBe(DEFAULT_SYNTHESIS_MODEL);
	});
});
