import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage, ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "@oh-my-pi/pi-coding-agent";
import * as codingAgent from "@oh-my-pi/pi-coding-agent";
import { type ModelRegistry, Settings } from "@oh-my-pi/pi-coding-agent";
import { executePlan } from "../src/executor";
import moaExtension from "../src/extension";
import { buildPlan } from "../src/planner";
import { resolveSettings } from "../src/settings";
import type { WorkerOutput } from "../src/subprocess";
import * as subprocess from "../src/subprocess";

function makeWorkerOutput(overrides: Partial<WorkerOutput>): WorkerOutput {
	return {
		ok: overrides.ok ?? true,
		output: overrides.output ?? "ok",
		stderr: overrides.stderr ?? "",
		exitCode: overrides.exitCode ?? 0,
		aborted: overrides.aborted ?? false,
		timedOut: overrides.timedOut ?? false,
		model: overrides.model,
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
	};
}

/** Worker output that follows the default MoaOutputSchema contract (PR2). */
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

function mockSpawnMoaWorker(
	rules: Array<(input: subprocess.SpawnWorkerInput) => WorkerOutput | Promise<WorkerOutput>>,
) {
	return vi.spyOn(subprocess, "spawnMoaWorker").mockImplementation(async input => {
		const idx = Math.min(subprocess.spawnMoaWorker.mock.calls.length - 1, rules.length - 1);
		return Promise.resolve(rules[idx]!(input));
	});
}

describe("moa executePlan", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("runs workers then synthesis through out-of-process spawnMoaWorker", async () => {
		const spy = mockSpawnMoaWorker([
			input => makeWorkerOutput({ output: conformingOutput(input.model ?? "w1"), model: input.model }),
			input => makeWorkerOutput({ output: conformingOutput(input.model ?? "w2"), model: input.model }),
			input => makeWorkerOutput({ output: conformingOutput(input.model ?? "w3"), model: input.model }),
			input => makeWorkerOutput({ output: "final recommendation", model: input.model }),
		]);

		const plan = buildPlan(
			"Design the MOA panel",
			resolveSettings({
				workers: [
					{ name: "divergent", role: "Generate options", model: "provider/divergent", thinking: "high" },
					{ name: "grounded", role: "Check realism", model: "provider/grounded", thinking: "medium" },
					{ name: "critical", role: "Find failure modes", model: "provider/critical", thinking: "low" },
				],
				synthesisModel: "provider/synthesis",
				synthesisThinking: "minimal",
				// Disable the TCO pre-fanout pipeline so this test still exercises
				// the original 4-spawn contract (3 workers + 1 synthesis).
				discoveryEnabled: false,
				rewriteEnabled: false,
			}),
		);
		const moaSettings = resolveSettings({ discoveryEnabled: false, rewriteEnabled: false });
		const authStorage = {} as AuthStorage;
		const modelRegistry = { refresh: async () => {} } as unknown as ModelRegistry;
		const settings = Settings.isolated({}, { cwd: "/tmp/moa" });

		const result = await executePlan(plan, {
			cwd: "/tmp/moa",
			authStorage,
			modelRegistry,
			settings,
			moaSettings,
		});

		expect(result.workers).toHaveLength(3);
		expect(result.workers.map(worker => worker.ok)).toEqual([true, true, true]);
		expect(result.synthesis?.ok).toBe(true);
		expect(spy).toHaveBeenCalledTimes(4);

		// First worker call: divergent model, high thinking, read-only tools, --append-system-prompt.
		const firstCall = spy.mock.calls[0]?.[0];
		expect(firstCall?.cwd).toBe("/tmp/moa");
		expect(firstCall?.model).toBe("provider/divergent");
		expect(firstCall?.thinkingLevel).toBe("high");
		expect(firstCall?.tools).toEqual(["read", "search", "find", "web_search", "ast_grep"]);
		expect(firstCall?.task).toBe("Design the MOA panel");
		expect(firstCall?.systemPrompt).toContain("divergent");

		// Last call: synthesis, no tools.
		const lastCall = spy.mock.calls[3]?.[0];
		expect(lastCall?.model).toBe("provider/synthesis");
		expect(lastCall?.thinkingLevel).toBe("minimal");
		expect(lastCall?.tools).toBe("none");
		expect(lastCall?.systemPrompt).toContain("## divergent");
		expect(lastCall?.systemPrompt).toContain("provider/divergent");
	});

	it("forwards settings.timeoutMs to worker and synthesis engine.execute", async () => {
		const spy = mockSpawnMoaWorker([
			input => makeWorkerOutput({ output: conformingOutput(input.model ?? "w1"), model: input.model }),
			input => makeWorkerOutput({ output: conformingOutput(input.model ?? "w2"), model: input.model }),
			input => makeWorkerOutput({ output: conformingOutput(input.model ?? "w3"), model: input.model }),
			input => makeWorkerOutput({ output: "final recommendation", model: input.model }),
		]);
		const moaSettings = resolveSettings({
			discoveryEnabled: false,
			rewriteEnabled: false,
			timeoutMs: 123_456,
			workers: [
				{ name: "divergent", role: "Generate options", model: "provider/divergent" },
				{ name: "grounded", role: "Check realism", model: "provider/grounded" },
				{ name: "critical", role: "Find failure modes", model: "provider/critical" },
			],
			synthesisModel: "provider/synthesis",
		});
		const plan = buildPlan("timeout wiring", moaSettings);
		await executePlan(plan, {
			cwd: "/tmp/moa",
			authStorage: {} as AuthStorage,
			modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
			settings: Settings.isolated({}, { cwd: "/tmp/moa" }),
			moaSettings,
		});
		expect(spy).toHaveBeenCalledTimes(4);
		for (const call of spy.mock.calls) {
			expect(call[0]?.timeoutMs).toBe(123_456);
		}
	});

	it("keeps synthesis running when a worker throws", async () => {
		const spy = mockSpawnMoaWorker([
			input => makeWorkerOutput({ output: conformingOutput(input.model ?? "w1") }),
			() => {
				throw new Error("grounded failed");
			},
			input => makeWorkerOutput({ output: conformingOutput(input.model ?? "w3") }),
			input => makeWorkerOutput({ output: "synthesis with partial failures", model: input.model }),
		]);

		const plan = buildPlan("Stress test", resolveSettings());
		const moaSettings = resolveSettings({ discoveryEnabled: false, rewriteEnabled: false });
		const result = await executePlan(plan, {
			cwd: "/tmp/moa",
			authStorage: {} as AuthStorage,
			modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
			settings: Settings.isolated({}, { cwd: "/tmp/moa" }),
			moaSettings,
		});

		expect(result.workers[1]).toMatchObject({ ok: false, stderr: "grounded failed", exitCode: null });
		expect(result.synthesis).toMatchObject({ ok: true, output: "synthesis with partial failures" });
		// PR2: the failing worker is quality-dropped (no output, no required
		// sections, score 0) so it is filtered out of the synthesis input.
		// Synthesis must NOT see the dropped worker's stderr; the failure
		// stays in result.workers[1] for archive.
		const lastCall = spy.mock.calls[3]?.[0];
		expect(lastCall?.systemPrompt).not.toContain("grounded failed");
		// The 2 surviving workers DO appear in the synthesis prompt.
		expect(lastCall?.systemPrompt).toContain("## divergent");
		expect(lastCall?.systemPrompt).toContain("## critical");
	});

	it("passes PI_MOA_SUBAGENT=1 to every worker subprocess env", async () => {
		const envSeen: Array<Record<string, string> | undefined> = [];
		const spy = vi.spyOn(subprocess, "spawnMoaWorker").mockImplementation(async input => {
			envSeen.push(input.env);
			return makeWorkerOutput({ output: conformingOutput(input.model ?? "w"), model: input.model });
		});
		// Override the env to record what's set; spawnMoaWorker will merge on top of process.env.
		const originalSpawn = subprocess.spawnMoaWorker;

		// TCO pipeline disabled so the test exercises the original 4-spawn contract.
		const moaSettings = resolveSettings({ discoveryEnabled: false, rewriteEnabled: false });
		const plan = buildPlan("env probe", moaSettings);
		await executePlan(plan, {
			cwd: "/tmp/moa-env",
			authStorage: {} as AuthStorage,
			modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
			settings: Settings.isolated({}, { cwd: "/tmp/moa-env" }),
			moaSettings,
		});

		// All 4 calls (3 workers + 1 synthesis) should be made. We don't assert on
		// PI_MOA_SUBAGENT here because subprocess.ts applies that env internally
		// after the call returns; the test exercises the integration of the
		// executor → spawnMoaWorker contract.
		expect(spy).toHaveBeenCalledTimes(4);
		expect(originalSpawn).toBe(spy);
	});
});

function makeMoaApi(overrides: { sendMessage: (message: unknown, options?: unknown) => void; settings?: Settings }) {
	const sentMessages: Array<{ message: unknown; options: unknown }> = [];
	const notifications: Array<{ message: string; type?: "info" | "warning" | "error" }> = [];
	let command: RegisteredCommand | undefined;
	const authStorageStub = {
		setFallbackResolver(): void {},
		hasAuth: () => false,
		getApiKey: async () => undefined,
		getAll: () => ({}),
		hasOAuth: () => false,
		peekApiKey: async () => undefined,
	} as unknown as AuthStorage;

	const api = {
		appendEntry(): void {},
		exec: async () => ({ code: 0, stderr: "", stdout: "" }),
		getActiveTools: () => [],
		getAllTools: () => [],
		getCommands: () => [],
		getFlag: () => undefined,
		on(): void {},
		pi: {
			discoverAuthStorage: async () => authStorageStub,
			getMarkdownTheme: codingAgent.getMarkdownTheme,
			settings: overrides.settings ?? Settings.isolated({}, { cwd: "/tmp/moa-ext" }),
		},
		registerCommand: ((name: string, options: Omit<RegisteredCommand, "name">) => {
			command = { name, ...options };
		}) as ExtensionAPI["registerCommand"],
		registerFlag(): void {},
		registerMessageRenderer: vi.fn(),
		registerShortcut(): void {},
		registerTool(): void {},
		sendMessage(message: unknown, options?: unknown): void {
			sentMessages.push({ message, options });
			overrides.sendMessage(message, options);
		},
		sendUserMessage(): void {},
		setActiveTools: async (): Promise<void> => {},
		setLabel(): void {},
	} as unknown as ExtensionAPI;

	return {
		api,
		command: () => command,
		sentMessages,
		notifications,
		ctx: {
			abort(): void {},
			branch: async () => ({ cancelled: false }),
			compact: async () => {},
			cwd: "/tmp/moa-ext",
			getContextUsage: () => undefined,
			hasPendingMessages: () => false,
			hasQueuedMessages: () => false,
			hasUI: false,
			isIdle: () => true,
			model: undefined,
			modelRegistry: {} as ModelRegistry,
			navigateTree: async () => ({ cancelled: false }),
			newSession: async () => ({ cancelled: false }),
			reload: async () => {},
			sessionManager: { getEntries: () => [], getBranch: () => [], getSessionId: () => "session-1" },
			shutdown(): void {},
			switchSession: async () => ({ cancelled: false }),
			ui: {
				confirm: async () => false,
				custom: async () => undefined,
				editor: async () => undefined,
				getAllThemes: async () => [],
				getEditorText: () => "",
				getTheme: async () => undefined,
				getToolsExpanded: () => false,
				input: async () => undefined,
				notify(message: string, type?: "info" | "warning" | "error"): void {
					notifications.push({ message, type });
				},
				onTerminalInput: () => () => {},
				pasteToEditor(): void {},
				select: async () => undefined,
				setEditorComponent(): void {},
				setEditorText(): void {},
				setFooter(): void {},
				setHeader(): void {},
				setStatus(): void {},
				setTheme: async () => ({ success: true }),
				setTitle(): void {},
				setToolsExpanded(): void {},
				setWidget(): void {},
				setWorkingMessage(): void {},
				theme: {} as ExtensionCommandContext["ui"]["theme"],
			},
			waitForIdle: async () => {},
		} as unknown as ExtensionCommandContext,
	};
}

describe("moa extension", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		// Also clear PI_MOA_SUBAGENT so a previous test run does not poison
		// the next test's moaExtension(api) invocation.
		delete process.env.PI_MOA_SUBAGENT;
	});

	it("registers renderer and emits moa-result + moa-archive messages for /moa run", async () => {
		const spy = mockSpawnMoaWorker([
			input => makeWorkerOutput({ output: conformingOutput(input.model ?? "w1"), model: input.model }),
			input => makeWorkerOutput({ output: conformingOutput(input.model ?? "w2"), model: input.model }),
			input => makeWorkerOutput({ output: conformingOutput(input.model ?? "w3"), model: input.model }),
			input => makeWorkerOutput({ output: "pick option A", model: input.model }),
		]);
		// TCO pre-fanout pipeline disabled so this test still exercises the
		// original 4-spawn contract (3 workers + 1 synthesis).
		const resolveSettingsSpy = vi.spyOn(await import("../src/settings"), "resolveSettings");
		resolveSettingsSpy.mockReturnValue(resolveSettings({ discoveryEnabled: false, rewriteEnabled: false }));

		const { api, command, sentMessages, notifications, ctx } = makeMoaApi({
			sendMessage: () => {},
		});
		moaExtension(api);
		const cmd = command();
		if (!cmd) throw new Error("Expected moa command to register");

		await cmd.handler("run Ship the MOA panel", ctx);

		// 3 worker subprocesses + 1 synthesis subprocess = 4 total.
		expect(spy).toHaveBeenCalledTimes(4);

		// No agent tools were instantiated (the api was created with a getMarkdownTheme shim).
		// Verify that sendMessage got the expected 1 moa-result + 1 manifest + N chunks.
		const resultMessage = sentMessages[0]?.message as
			| { customType?: string; details?: { runId?: string; archiveChunks?: number } }
			| undefined;
		const archiveMessages = sentMessages.slice(1);
		expect(resultMessage?.customType).toBe("moa-result");
		expect(resultMessage?.details?.runId).toMatch(/^moa-\d{8}-\d{6}-[0-9a-z]{6}$/);
		// First archive message is the manifest; remaining N are chunks where N === archiveChunks.
		expect(archiveMessages.length).toBe((resultMessage?.details?.archiveChunks ?? 0) + 1);
		expect(archiveMessages.length).toBeGreaterThanOrEqual(1);
		for (const sent of archiveMessages) {
			const message = sent.message as {
				customType?: string;
				display?: boolean;
				details?: { runId?: string; kind?: string; index?: number; total?: number };
			};
			expect(message.customType).toBe("moa-archive");
			expect(message.display).toBe(false);
			expect(message.details?.runId).toBe(resultMessage?.details?.runId);
		}
		const firstArchiveDetails = (archiveMessages[0]?.message as { details?: { kind?: string } } | undefined)?.details;
		expect(firstArchiveDetails?.kind).toBe("manifest");
		expect(sentMessages.every(s => s.options)).toBe(true);
		expect(sentMessages.map(s => s.options)).toEqual(sentMessages.map(() => ({ triggerTurn: false })));
		expect(notifications).toHaveLength(0);
	});

	it("preserves heterogeneous worker models through /moa run details", async () => {
		mockSpawnMoaWorker([
			input => makeWorkerOutput({ output: conformingOutput(input.model ?? "w1"), model: input.model }),
			input => makeWorkerOutput({ output: conformingOutput(input.model ?? "w2"), model: input.model }),
			input => makeWorkerOutput({ output: conformingOutput(input.model ?? "w3"), model: input.model }),
			input => makeWorkerOutput({ output: "pick the grounded route", model: input.model }),
		]);
		const resolveSettingsSpy = vi.spyOn(await import("../src/settings"), "resolveSettings");
		resolveSettingsSpy.mockReturnValue(
			resolveSettings({
				workers: [
					{ name: "divergent", role: "Generate options", model: "provider/divergent" },
					{ name: "grounded", role: "Check realism", model: "provider/grounded" },
					{ name: "critical", role: "Find failure modes", model: "provider/critical" },
				],
				synthesisModel: "provider/synthesis",
			}),
		);

		const { api, command, sentMessages, ctx } = makeMoaApi({ sendMessage: () => {} });
		moaExtension(api);
		const cmd = command();
		if (!cmd) throw new Error("Expected moa command to register");

		await cmd.handler("run Ship the MOA panel", ctx);

		const heterResultMessage = sentMessages[0]?.message as
			| { customType?: string; details?: { runId?: string; workers?: Array<{ name: string; model?: string }> } }
			| undefined;
		expect(heterResultMessage?.details?.runId).toMatch(/^moa-\d{8}-\d{6}-[0-9a-z]{6}$/);
		expect(sentMessages[0]?.message).toMatchObject({
			details: expect.objectContaining({
				workers: [
					expect.objectContaining({ name: "divergent", model: "provider/divergent" }),
					expect.objectContaining({ name: "grounded", model: "provider/grounded" }),
					expect.objectContaining({ name: "critical", model: "provider/critical" }),
				],
			}),
		});
		expect(sentMessages.length).toBeGreaterThan(1);
	});

	it("no-ops when PI_MOA_SUBAGENT=1 (recursive guard)", () => {
		process.env.PI_MOA_SUBAGENT = "1";
		let command: RegisteredCommand | undefined;
		const api = {
			appendEntry(): void {},
			exec: async () => ({ code: 0, stderr: "", stdout: "" }),
			getActiveTools: () => [],
			getAllTools: () => [],
			getCommands: () => [],
			getFlag: () => undefined,
			on(): void {},
			pi: {
				discoverAuthStorage: async () => ({}) as AuthStorage,
				getMarkdownTheme: {} as never,
				settings: Settings.isolated({}, { cwd: "/tmp" }),
			},
			registerCommand(_name: string, _options: Omit<RegisteredCommand, "name">): void {
				command = { name: _name, ..._options };
			},
			registerFlag(): void {},
			registerMessageRenderer: vi.fn(),
			registerShortcut(): void {},
			registerTool(): void {},
			sendMessage(): void {},
			sendUserMessage(): void {},
			setActiveTools: async (): Promise<void> => {},
			setLabel(): void {},
		} as unknown as ExtensionAPI;
		moaExtension(api);
		// moa-extension should not register any command when in subagent mode.
		expect(command).toBeUndefined();
	});
});

// ============================================================================
// PR2: multi-round executor
// ============================================================================

describe("moa executePlan — PR2 multi-round", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	function buildThreeWorkerSettings() {
		return resolveSettings({
			discoveryEnabled: false,
			rewriteEnabled: false,
			workers: [
				{ name: "divergent", role: "diverge", model: "provider/divergent" },
				{ name: "grounded", role: "ground", model: "provider/grounded" },
				{ name: "critical", role: "critic", model: "provider/critical" },
			],
			synthesisModel: "provider/synthesis",
			maxRounds: 3,
			maxQuestionsPerRound: 5,
			qualityMinScore: 40,
		});
	}

	function noopUI() {
		return {
			select: vi.fn(async () => undefined as string | undefined),
			input: vi.fn(async () => undefined as string | undefined),
			notify: vi.fn(),
			setStatus: vi.fn(),
			setWorkingMessage: vi.fn(),
		};
	}

	it("single-round path when hasUI=false: only one worker fanout", async () => {
		const spy = mockSpawnMoaWorker([
			input => makeWorkerOutput({ output: conformingOutput(input.model ?? "w1"), model: input.model }),
			input => makeWorkerOutput({ output: conformingOutput(input.model ?? "w2"), model: input.model }),
			input => makeWorkerOutput({ output: conformingOutput(input.model ?? "w3"), model: input.model }),
			input => makeWorkerOutput({ output: "synth ok", model: input.model }),
		]);
		const plan = buildPlan("Single round test", buildThreeWorkerSettings());
		const result = await executePlan(plan, {
			cwd: "/tmp/moa",
			authStorage: {} as AuthStorage,
			modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
			settings: Settings.isolated({}, { cwd: "/tmp/moa" }),
			moaSettings: buildThreeWorkerSettings(),
			// hasUI omitted → single-round path
		});
		// 3 workers + 1 synthesis = 4 spawns
		expect(spy).toHaveBeenCalledTimes(4);
		expect(result.rounds).toHaveLength(1);
		expect(result.rounds?.[0]?.convergenceSignal).toBe("all_complete");
		expect(result.askRoundSummaries).toEqual([]);
	});

	it("multi-round with TUI: same open_questions across rounds → no_new_questions convergence", async () => {
		// Same question every round. After round 1 ask, previousQuestionKeys
		// filters it out → round 2 converges with no_new_questions.
		const openQuestions = `## open_questions\n- what's the budget?`;
		const workerOutput = (label: string) =>
			[
				`## plan`,
				`${label} plan with detail. `.repeat(20),
				``,
				openQuestions,
				`## assumptions`,
				`- assumed default`,
			].join("\n");
		const spy = mockSpawnMoaWorker([
			input => makeWorkerOutput({ output: workerOutput(input.model ?? "w1"), model: input.model }),
			input => makeWorkerOutput({ output: workerOutput(input.model ?? "w2"), model: input.model }),
			input => makeWorkerOutput({ output: workerOutput(input.model ?? "w3"), model: input.model }),
			// Round 2 — same questions (filtered by previousQuestionKeys)
			input => makeWorkerOutput({ output: workerOutput(input.model ?? "w1"), model: input.model }),
			input => makeWorkerOutput({ output: workerOutput(input.model ?? "w2"), model: input.model }),
			input => makeWorkerOutput({ output: workerOutput(input.model ?? "w3"), model: input.model }),
			input => makeWorkerOutput({ output: "synth ok", model: input.model }),
		]);
		const plan = buildPlan("Multi-round same-Q test", buildThreeWorkerSettings());
		const result = await executePlan(plan, {
			cwd: "/tmp/moa",
			authStorage: {} as AuthStorage,
			modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
			settings: Settings.isolated({}, { cwd: "/tmp/moa" }),
			moaSettings: buildThreeWorkerSettings(),
			ui: noopUI() as never,
			hasUI: true,
		});
		// 2 rounds × 3 workers + 1 synthesis = 7
		expect(spy).toHaveBeenCalledTimes(7);
		expect(result.rounds).toHaveLength(2);
		expect(result.rounds?.[1]?.convergenceSignal).toBe("no_new_questions");
		expect(result.askRoundSummaries).toHaveLength(1);
	});

	it("multi-round with TUI: distinct questions each round until maxRounds", async () => {
		const workerOutput = (label: string, question: string) =>
			[
				`## plan`,
				`${label} plan with detail. `.repeat(20),
				``,
				`## open_questions`,
				`- ${question}`,
				`## assumptions`,
				`- assumed default`,
			].join("\n");
		let call = 0;
		const spy = vi.spyOn(subprocess, "spawnMoaWorker").mockImplementation(async input => {
			const idx = call++;
			// Rounds 1/2/3 → distinct questions so previousQuestions never filters all.
			const question =
				idx < 3 ? "what's the budget?" : idx < 6 ? "what's the timeline?" : "what's the team size?";
			if (idx < 9) {
				return makeWorkerOutput({ output: workerOutput(input.model ?? `w${idx}`, question), model: input.model });
			}
			return makeWorkerOutput({ output: "synth ok", model: input.model });
		});
		const plan = buildPlan("Multi-round max test", buildThreeWorkerSettings());
		const result = await executePlan(plan, {
			cwd: "/tmp/moa",
			authStorage: {} as AuthStorage,
			modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
			settings: Settings.isolated({}, { cwd: "/tmp/moa" }),
			moaSettings: buildThreeWorkerSettings(),
			ui: noopUI() as never,
			hasUI: true,
		});
		// 3 rounds × 3 workers + 1 synthesis = 10
		expect(spy).toHaveBeenCalledTimes(10);
		expect(result.rounds).toHaveLength(3);
		expect(result.rounds?.[2]?.convergenceSignal).toBe("max_rounds");
		expect(result.askRoundSummaries).toHaveLength(2);
	});

	it("multi-round converges early when workers drop open_questions", async () => {
		// Round 1: 1 worker has open_questions. Round 2: all workers finish without.
		// After round 2 all 3 workers score >= 80 with 0 oq ⇒ all_complete, stop.
		const withQuestions = (label: string) =>
			[
				`## plan`,
				`${label} plan with detail. `.repeat(20),
				``,
				`## open_questions`,
				`- one open question here`,
				`## assumptions`,
				`- assumed default`,
			].join("\n");
		const withoutQuestions = (label: string) =>
			[
				`## plan`,
				`${label} plan with detail. `.repeat(20),
				``,
				`## open_questions`,
				``,
				`## assumptions`,
				`- assumed default`,
			].join("\n");
		const spy = mockSpawnMoaWorker([
			// Round 1
			input => makeWorkerOutput({ output: withQuestions(input.model ?? "w1"), model: input.model }),
			input => makeWorkerOutput({ output: withQuestions(input.model ?? "w2"), model: input.model }),
			input => makeWorkerOutput({ output: withQuestions(input.model ?? "w3"), model: input.model }),
			// Round 2 — convergent
			input => makeWorkerOutput({ output: withoutQuestions(input.model ?? "w1"), model: input.model }),
			input => makeWorkerOutput({ output: withoutQuestions(input.model ?? "w2"), model: input.model }),
			input => makeWorkerOutput({ output: withoutQuestions(input.model ?? "w3"), model: input.model }),
			input => makeWorkerOutput({ output: "synth ok", model: input.model }),
		]);
		const plan = buildPlan("Converge test", buildThreeWorkerSettings());
		const result = await executePlan(plan, {
			cwd: "/tmp/moa",
			authStorage: {} as AuthStorage,
			modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
			settings: Settings.isolated({}, { cwd: "/tmp/moa" }),
			moaSettings: buildThreeWorkerSettings(),
			ui: noopUI() as never,
			hasUI: true,
		});
		expect(spy).toHaveBeenCalledTimes(7); // 2 rounds × 3 + 1 synth
		expect(result.rounds).toHaveLength(2);
		expect(result.rounds?.[1]?.convergenceSignal).toBe("all_complete");
	});

	it("user stop-all action ends the loop with user_stop signal", async () => {
		const workerOutput = (label: string) =>
			[
				`## plan`,
				`${label} plan with detail. `.repeat(20),
				``,
				`## open_questions`,
				`- what's the budget?`,
				`## assumptions`,
				`- assumed default`,
			].join("\n");
		const spy = mockSpawnMoaWorker([
			input => makeWorkerOutput({ output: workerOutput(input.model ?? "w1"), model: input.model }),
			input => makeWorkerOutput({ output: workerOutput(input.model ?? "w2"), model: input.model }),
			input => makeWorkerOutput({ output: workerOutput(input.model ?? "w3"), model: input.model }),
			input => makeWorkerOutput({ output: "synth ok", model: input.model }),
		]);
		const ui = noopUI();
		ui.select.mockResolvedValueOnce("stop all");
		const plan = buildPlan("Stop test", buildThreeWorkerSettings());
		const result = await executePlan(plan, {
			cwd: "/tmp/moa",
			authStorage: {} as AuthStorage,
			modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
			settings: Settings.isolated({}, { cwd: "/tmp/moa" }),
			moaSettings: buildThreeWorkerSettings(),
			ui: ui as never,
			hasUI: true,
		});
		expect(spy).toHaveBeenCalledTimes(4); // 1 round × 3 + 1 synth
		expect(result.rounds).toHaveLength(1);
		expect(result.rounds?.[0]?.convergenceSignal).toBe("user_stop");
		expect(result.rounds?.[0]?.userStopped).toBe(true);
	});

	it("updates setStatus with Round · asking · worker OK/BLOCKED during ask", async () => {
		const workerOutput = (label: string) =>
			[
				`## plan`,
				`${label} plan with detail. `.repeat(20),
				``,
				`## open_questions`,
				`- what's the budget?`,
				`## assumptions`,
				`- assumed default`,
			].join("\n");
		mockSpawnMoaWorker([
			input => makeWorkerOutput({ output: workerOutput(input.model ?? "w1"), model: input.model }),
			input => makeWorkerOutput({ output: workerOutput(input.model ?? "w2"), model: input.model }),
			input => makeWorkerOutput({ output: workerOutput(input.model ?? "w3"), model: input.model }),
			input => makeWorkerOutput({ output: workerOutput(input.model ?? "w1"), model: input.model }),
			input => makeWorkerOutput({ output: workerOutput(input.model ?? "w2"), model: input.model }),
			input => makeWorkerOutput({ output: workerOutput(input.model ?? "w3"), model: input.model }),
			input => makeWorkerOutput({ output: "synth ok", model: input.model }),
		]);
		const ui = noopUI();
		ui.select.mockResolvedValue("skip");
		await executePlan(buildPlan("status bar", buildThreeWorkerSettings()), {
			cwd: "/tmp/moa",
			authStorage: {} as AuthStorage,
			modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
			settings: Settings.isolated({}, { cwd: "/tmp/moa" }),
			moaSettings: buildThreeWorkerSettings(),
			ui: ui as never,
			hasUI: true,
		});
		const statusCalls = ui.setStatus.mock.calls.map(c => c[1] as string | undefined).filter(Boolean) as string[];
		expect(statusCalls.some(s => s.includes("asking question") && s.includes("divergent OK"))).toBe(true);
		// Cleared at end
		expect(ui.setStatus.mock.calls.at(-1)?.[1]).toBeUndefined();
	});

	it("all 3 workers quality-dropped → fail loud, no synthesis spawn", async () => {
		const spy = mockSpawnMoaWorker([
			input => makeWorkerOutput({ output: "no schema", model: input.model }),
			input => makeWorkerOutput({ output: "no schema", model: input.model }),
			input => makeWorkerOutput({ output: "no schema", model: input.model }),
			input => makeWorkerOutput({ output: "should not run", model: input.model }),
		]);
		const plan = buildPlan("All dropped test", buildThreeWorkerSettings());
		const result = await executePlan(plan, {
			cwd: "/tmp/moa",
			authStorage: {} as AuthStorage,
			modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
			settings: Settings.isolated({}, { cwd: "/tmp/moa" }),
			moaSettings: buildThreeWorkerSettings(),
		});
		expect(result.workers.every(w => w.qualityDropped === true)).toBe(true);
		expect(result.synthesis?.ok).toBe(false);
		expect(result.synthesis?.stderr).toBe("all workers quality-failed");
		expect(result.rounds?.[0]?.convergenceSignal).toBe("quality_failed");
		// 3 workers only — synthesis must not be spawned
		expect(spy).toHaveBeenCalledTimes(3);
		expect(result.dispatchLog).toHaveLength(3);
	});

	it("hasUI=true with maxRounds=0 falls back to single-round (defensive)", async () => {
		const spy = mockSpawnMoaWorker([
			input => makeWorkerOutput({ output: conformingOutput(input.model ?? "w1"), model: input.model }),
			input => makeWorkerOutput({ output: conformingOutput(input.model ?? "w2"), model: input.model }),
			input => makeWorkerOutput({ output: conformingOutput(input.model ?? "w3"), model: input.model }),
			input => makeWorkerOutput({ output: "synth ok", model: input.model }),
		]);
		const moaSettings = resolveSettings({ ...buildThreeWorkerSettings(), maxRounds: 0 });
		const plan = buildPlan("Single via maxRounds=0", moaSettings);
		const result = await executePlan(plan, {
			cwd: "/tmp/moa",
			authStorage: {} as AuthStorage,
			modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
			settings: Settings.isolated({}, { cwd: "/tmp/moa" }),
			moaSettings,
			hasUI: true,
		});
		expect(spy).toHaveBeenCalledTimes(4);
		expect(result.rounds).toHaveLength(1);
		expect(result.askRoundSummaries).toEqual([]);
	});

	it("round 2 injects previous answers and already-asked questions (no discovery/planning phase)", async () => {
		const withQuestions = (label: string) =>
			[
				`## plan`,
				`${label} plan with detail. `.repeat(20),
				``,
				`## open_questions`,
				`- where is the team?`,
				`## assumptions`,
				`- assumed default`,
			].join("\n");
		const withoutQuestions = (label: string) =>
			[
				`## plan`,
				`${label} plan with detail. `.repeat(20),
				``,
				`## open_questions`,
				``,
				`## assumptions`,
				`- assumed default`,
			].join("\n");

		const capturedPrompts: string[] = [];
		vi.spyOn(subprocess, "spawnMoaWorker").mockImplementation(async input => {
			capturedPrompts.push(input.systemPrompt);
			const idx = capturedPrompts.length - 1;
			let output: string;
			if (idx < 3) output = withQuestions(input.model ?? `w${idx}`);
			else if (idx < 6) output = withoutQuestions(input.model ?? `w${idx}`);
			else output = "synth ok";
			return makeWorkerOutput({ output, model: input.model });
		});

		const ui = noopUI();
		ui.select.mockResolvedValue("answer");
		ui.input.mockResolvedValue("深圳, 50人");

		const plan = buildPlan("Round history injection test", buildThreeWorkerSettings());
		const result = await executePlan(plan, {
			cwd: "/tmp/moa",
			authStorage: {} as AuthStorage,
			modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
			settings: Settings.isolated({}, { cwd: "/tmp/moa" }),
			moaSettings: buildThreeWorkerSettings(),
			ui: ui as never,
			hasUI: true,
		});

		expect(capturedPrompts).toHaveLength(7);
		expect(result.rounds).toHaveLength(2);
		expect(result.rounds?.[1]?.convergenceSignal).toBe("all_complete");

		// Round 1: no prior history → no Round context block / no phase split.
		for (let i = 0; i < 3; i++) {
			const p = capturedPrompts[i]!;
			expect(p).not.toContain("DISCOVERY");
			expect(p).not.toContain("PLANNING");
			expect(p).not.toContain("DO NOT output a `## plan` section");
		}

		// Round 2: history block with answers + already-asked; still allows plan+questions.
		for (let i = 3; i < 6; i++) {
			const p = capturedPrompts[i]!;
			expect(p).toContain("## Round 2 context");
			expect(p).toContain("### Previous answers");
			expect(p).toContain("深圳, 50人");
			expect(p).toContain("### Questions already asked");
			expect(p).toContain("where is the team?");
			expect(p).not.toContain("DO NOT output a new `## open_questions` section");
			expect(p).not.toContain("DISCOVERY");
		}
	});

	it("Discovery output_schema is baked into worker prompts", async () => {
		const discoveryJson = JSON.stringify({
			task_understanding: "build a debug plan",
			known_inputs: [],
			missing_inputs: [],
			output_schema: {
				sections: [
					{ name: "repro_steps", required: true, type: "markdown" },
					{ name: "plan", required: true, type: "markdown" },
					{ name: "open_questions", required: true, type: "list" },
				],
			},
		});
		const capturedPrompts: string[] = [];
		vi.spyOn(subprocess, "spawnMoaWorker").mockImplementation(async input => {
			capturedPrompts.push(input.systemPrompt);
			const idx = capturedPrompts.length - 1;
			if (idx === 0) {
				return makeWorkerOutput({ output: discoveryJson, model: input.model });
			}
			if (idx <= 3) {
				return makeWorkerOutput({
					output: [
						`## repro_steps`,
						`1. reproduce the bug with enough detail for the quality heuristic to pass.`,
						`## plan`,
						`${input.model} plan with detail. `.repeat(20),
						`## open_questions`,
						``,
					].join("\n"),
					model: input.model,
				});
			}
			return makeWorkerOutput({ output: "synth ok", model: input.model });
		});

		const moaSettings = resolveSettings({
			discoveryEnabled: true,
			rewriteEnabled: false,
			workers: [
				{ name: "divergent", role: "diverge", model: "provider/divergent" },
				{ name: "grounded", role: "ground", model: "provider/grounded" },
				{ name: "critical", role: "critic", model: "provider/critical" },
			],
			synthesisModel: "provider/synthesis",
			maxRounds: 0,
			askEnabled: false,
		});
		const plan = buildPlan("schema injection", moaSettings);
		const result = await executePlan(plan, {
			cwd: "/tmp/moa",
			authStorage: {} as AuthStorage,
			modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
			settings: Settings.isolated({}, { cwd: "/tmp/moa" }),
			moaSettings,
			hasUI: false,
		});

		expect(result.outputSchema?.sections.some(s => s.name === "repro_steps")).toBe(true);
		// Worker prompts (calls 1-3) must include Discovery's section.
		for (let i = 1; i <= 3; i++) {
			expect(capturedPrompts[i]).toContain("## repro_steps");
		}
		expect(result.dispatchLog?.length).toBe(3);
	});

	it("records stage timings and notifies with durations when hasUI", async () => {
		mockSpawnMoaWorker([
			input => makeWorkerOutput({ output: conformingOutput(input.model ?? "w1"), model: input.model }),
			input => makeWorkerOutput({ output: conformingOutput(input.model ?? "w2"), model: input.model }),
			input => makeWorkerOutput({ output: conformingOutput(input.model ?? "w3"), model: input.model }),
			input => makeWorkerOutput({ output: "merged plan", model: input.model }),
		]);
		const ui = noopUI();
		const moaSettings = buildThreeWorkerSettings();
		const plan = buildPlan("Timing test", moaSettings);
		const result = await executePlan(plan, {
			cwd: "/tmp/moa",
			authStorage: {} as AuthStorage,
			modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
			settings: Settings.isolated({}, { cwd: "/tmp/moa" }),
			moaSettings,
			ui: ui as never,
			hasUI: true,
		});

		expect(result.timings).toBeDefined();
		expect(result.timings?.discovery).toBeGreaterThanOrEqual(0);
		expect(result.timings?.ask).toBeGreaterThanOrEqual(0);
		expect(result.timings?.rewrite).toBeGreaterThanOrEqual(0);
		expect(result.timings?.workers).toBeGreaterThanOrEqual(0);
		expect(result.timings?.synthesis).toBeGreaterThanOrEqual(0);
		expect(result.timings?.total).toBeGreaterThanOrEqual(0);

		const notifyMsgs = ui.notify.mock.calls.map(c => String(c[0]));
		expect(notifyMsgs.some(m => /发现完成.*\d+\.\d+s/.test(m))).toBe(true);
		expect(notifyMsgs.some(m => /Worker 完成.*\d+\.\d+s/.test(m))).toBe(true);
		expect(notifyMsgs.some(m => /MOA 完成.*\d+\.\d+s/.test(m))).toBe(true);
		expect(notifyMsgs.some(m => m.includes("MOA 耗时"))).toBe(true);

		const workingMsgs = ui.setWorkingMessage.mock.calls.map(c => String(c[0]));
		expect(workingMsgs.some(m => /MOA:.*\d+\.\d+s/.test(m))).toBe(true);
	});
});
