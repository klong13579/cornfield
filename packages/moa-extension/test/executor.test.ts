import { afterEach, describe, expect, it, vi } from "bun:test";
import type {
	AuthStorage,
	ExtensionAPI,
	ExtensionCommandContext,
	RegisteredCommand,
	SingleResult,
} from "@oh-my-pi/pi-coding-agent";
import * as codingAgent from "@oh-my-pi/pi-coding-agent";
import { ModelRegistry, Settings } from "@oh-my-pi/pi-coding-agent";
import { executePlan } from "../src/executor";
import moaExtension from "../src/extension";
import { buildPlan } from "../src/planner";
import { resolveSettings } from "../src/settings";

function createSubprocessResult(overrides: Partial<SingleResult>): SingleResult {
	return {
		index: overrides.index ?? 0,
		id: overrides.id ?? "subprocess",
		agent: overrides.agent ?? "worker",
		agentSource: overrides.agentSource ?? "project",
		task: overrides.task ?? "task",
		assignment: overrides.assignment,
		description: overrides.description,
		lastIntent: overrides.lastIntent,
		exitCode: overrides.exitCode ?? 0,
		output: overrides.output ?? "ok",
		stderr: overrides.stderr ?? "",
		truncated: overrides.truncated ?? false,
		durationMs: overrides.durationMs ?? 1,
		tokens: overrides.tokens ?? 0,
		modelOverride: overrides.modelOverride,
		error: overrides.error,
		aborted: overrides.aborted,
		abortReason: overrides.abortReason,
		usage: overrides.usage,
		outputPath: overrides.outputPath,
	};
}


describe("moa executePlan", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("runs workers then synthesis through subprocesses", async () => {
		const runSubprocessSpy = vi.spyOn(codingAgent, "runSubprocess");
		runSubprocessSpy.mockImplementation(async options => {
			if (options.id === "moa-synthesis") {
				return createSubprocessResult({
					id: "moa-synthesis",
					agent: "synthesis",
					output: "final recommendation",
				});
			}
			return createSubprocessResult({
				id: options.id,
				agent: options.agent.name,
				output: `${options.agent.name} output`,
			});
		});

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
			}),
		);
		const authStorage = {} as AuthStorage;
		const modelRegistry = { refresh: async () => {} } as unknown as ModelRegistry;
		const settings = Settings.isolated({}, { cwd: "/tmp/moa" });

		const result = await executePlan(plan, {
			cwd: "/tmp/moa",
			authStorage,
			modelRegistry,
			settings,
			runSubprocess: codingAgent.runSubprocess,
		});

		expect(result.workers).toHaveLength(3);
		expect(result.workers.map(worker => worker.ok)).toEqual([true, true, true]);
		expect(result.synthesis?.ok).toBe(true);
		expect(runSubprocessSpy).toHaveBeenCalledTimes(4);
		expect(runSubprocessSpy.mock.calls[0]?.[0]).toMatchObject({
			cwd: "/tmp/moa",
			id: "moa-worker-1-divergent",
			task: "Design the MOA panel",
			modelOverride: "provider/divergent",
			enableLsp: false,
		});
		expect(runSubprocessSpy.mock.calls[3]?.[0]).toMatchObject({
			id: "moa-synthesis",
			task: "Design the MOA panel",
			enableLsp: false,
		});
		expect(runSubprocessSpy.mock.calls[3]?.[0].agent).toMatchObject({
			name: "synthesis",
			tools: ["__none__"],
			model: ["provider/synthesis"],
		});
		expect(String(runSubprocessSpy.mock.calls[3]?.[0].agent.systemPrompt)).toContain("## divergent");
		expect(String(runSubprocessSpy.mock.calls[3]?.[0].agent.systemPrompt)).toContain("divergent output");
	});

	it("keeps synthesis running when a worker throws", async () => {
		const runSubprocessSpy = vi.spyOn(codingAgent, "runSubprocess");
		runSubprocessSpy.mockImplementation(async options => {
			if (options.id === "moa-worker-2-grounded") {
				throw new Error("grounded failed");
			}
			if (options.id === "moa-synthesis") {
				return createSubprocessResult({
					id: "moa-synthesis",
					agent: "synthesis",
					output: "synthesis with partial failures",
				});
			}
			return createSubprocessResult({
				id: options.id,
				agent: options.agent.name,
				output: `${options.agent.name} ok`,
			});
		});

		const plan = buildPlan("Stress test", resolveSettings());
		const result = await executePlan(plan, {
			cwd: "/tmp/moa",
			authStorage: {} as AuthStorage,
			modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
			settings: Settings.isolated({}, { cwd: "/tmp/moa" }),
			runSubprocess: codingAgent.runSubprocess,
		});

		expect(result.workers[1]).toMatchObject({ ok: false, stderr: "grounded failed", exitCode: null });
		expect(result.synthesis).toMatchObject({ ok: true, output: "synthesis with partial failures" });
		expect(String(runSubprocessSpy.mock.calls[3]?.[0].agent.systemPrompt)).toContain("### stderr\ngrounded failed");
	});
});

describe("moa extension", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("registers renderer and emits moa-result messages for /moa run", async () => {
		const sentMessages: Array<{ message: unknown; options: unknown }> = [];
		const notifications: Array<{ message: string; type?: "info" | "warning" | "error" }> = [];
		let command: RegisteredCommand | undefined;
		const registerMessageRenderer = vi.fn();
		const authStorageStub = {
			setFallbackResolver(): void {},
			hasAuth: () => false,
			getApiKey: async () => undefined,
			getAll: () => ({}),
			hasOAuth: () => false,
			peekApiKey: async () => undefined,
		} as unknown as AuthStorage;
		const runSubprocessSpy = vi.fn(async (options: Parameters<typeof codingAgent.runSubprocess>[0]) => {
			if (options.id === "moa-synthesis") {
				return createSubprocessResult({ id: "moa-synthesis", agent: "synthesis", output: "pick option A" });
			}
			return createSubprocessResult({
				id: options.id,
				agent: options.agent.name,
				output: `${options.agent.name} says go`,
			});
		});

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
				runSubprocess: runSubprocessSpy,
				settings: Settings.isolated({}, { cwd: "/tmp/moa-ext" }),
			},
			registerCommand(name: string, options: Omit<RegisteredCommand, "name">): void {
				command = { name, ...options };
			},
			registerFlag(): void {},
			registerMessageRenderer: registerMessageRenderer,
			registerShortcut(): void {},
			registerTool(): void {},
			sendMessage(message: unknown, options?: unknown): void {
				sentMessages.push({ message, options });
			},
			sendUserMessage(): void {},
			setActiveTools: async (): Promise<void> => {},
			setLabel(): void {},
		} as unknown as ExtensionAPI;
		moaExtension(api);
		if (!command) throw new Error("Expected moa command to register");

		const ctx = {
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
		} as unknown as ExtensionCommandContext;

		await command.handler("run Ship the MOA panel", ctx);

		expect(registerMessageRenderer).toHaveBeenCalledWith("moa-result", expect.any(Function));
			expect(runSubprocessSpy).toHaveBeenCalledTimes(4);
		expect(sentMessages).toHaveLength(1);
		expect(sentMessages[0]?.options).toEqual({ triggerTurn: false });
		expect(sentMessages[0]?.message).toMatchObject({
			customType: "moa-result",
			attribution: "agent",
			display: true,
		});
		expect(sentMessages[0]?.message).toMatchObject({
			details: expect.objectContaining({ task: "Ship the MOA panel", workerCount: 3 }),
		});
		expect(notifications).toHaveLength(0);
	});
});
