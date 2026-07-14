import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { AgentSession, AuthStorage, ModelRegistry } from "@oh-my-pi/pi-coding-agent";
import * as codingAgent from "@oh-my-pi/pi-coding-agent";
import type { SpawnWorkerInput } from "../src/subprocess";
import { createWorkerEngine } from "../src/worker-engine";

// ----------------------------------------------------------------------------
// Test fixtures
// ----------------------------------------------------------------------------

/**
 * Build an AssistantMessage with sensible defaults for the fields the
 * InProcessWorkerEngine reads (content / usage / stopReason / model).
 */
function makeAssistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	const textBlock = {
		type: "text" as const,
		text: overrides.content?.[0] && "text" in overrides.content[0] ? overrides.content[0].text : "ok",
	};
	return {
		role: "assistant",
		content: [textBlock],
		api: "anthropic-messages" as AssistantMessage["api"],
		provider: "anthropic",
		model: "test-model",
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	} as AssistantMessage;
}

/**
 * Build a fake AgentSession that records calls and exposes hooks for the
 * test to drive event emissions. We only implement the surface the engine
 * touches (subscribe / prompt / runEphemeralTurn / waitForIdle / dispose).
 */
interface FakeSession {
	session: AgentSession;
	emitMessageEnd: (msg: AssistantMessage) => void;
	emitAgentEnd: (messages: AssistantMessage[]) => void;
	disposeCalls: number;
}

function makeFakeSession(): FakeSession {
	let subscriber: ((e: { type: string; [k: string]: unknown }) => void) | null = null;
	const disposeCalls = { count: 0 };

	const session = {
		subscribe: (fn: (e: { type: string; [k: string]: unknown }) => void) => {
			subscriber = fn;
			return () => {
				if (subscriber === fn) subscriber = null;
			};
		},
		prompt: async () => {
			// Default: emit a single assistant message_end + agent_end so
			// the engine's basic path produces a non-empty output. Tests
			// that want different event sequences can spy + mock this.
			const msg = makeAssistantMessage();
			subscriber?.({ type: "message_end", message: msg });
			subscriber?.({ type: "agent_end", messages: [msg] });
		},
		runEphemeralTurn: async () => {
			const msg = makeAssistantMessage();
			return { assistantMessage: msg, replyText: "ok" };
		},
		waitForIdle: async () => {},
		dispose: async () => {
			disposeCalls.count += 1;
		},
	} as unknown as AgentSession;

	return {
		session,
		emitMessageEnd: msg => subscriber?.({ type: "message_end", message: msg }),
		emitAgentEnd: messages => subscriber?.({ type: "agent_end", messages }),
		get disposeCalls() {
			return disposeCalls.count;
		},
	} as FakeSession & { disposeCalls: number };
}

const dummyShared = {
	cwd: "/tmp/moa",
	authStorage: {} as AuthStorage,
	modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
	settings: codingAgent.Settings.isolated({}, { cwd: "/tmp/moa" }),
};

const baseInput: SpawnWorkerInput = {
	cwd: "/tmp/moa",
	task: "test task",
	systemPrompt: "system",
	tools: "all",
	timeoutMs: 30_000,
};

// ----------------------------------------------------------------------------
// In-process engine — internal behavior tests
// ----------------------------------------------------------------------------

describe("InProcessWorkerEngine — internal contract", () => {
	let createSessionSpy: ReturnType<typeof vi.spyOn>;
	let fake: ReturnType<typeof makeFakeSession>;

	beforeEach(() => {
		fake = makeFakeSession();
		createSessionSpy = vi.spyOn(codingAgent, "createAgentSession").mockResolvedValue({
			session: fake.session,
		} as never);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// ------------------------------------------------------------------------
	// Read-only tool enforcement (Alt 3b core fix)
	// ------------------------------------------------------------------------

	it("input.tools='all' forces toolNames to IN_PROCESS_TOOLS (read-only)", async () => {
		const engine = createWorkerEngine("in-process", dummyShared);
		const result = await engine.execute({ ...baseInput, tools: "all" });

		expect(createSessionSpy).toHaveBeenCalledTimes(1);
		const callArgs = createSessionSpy.mock.calls[0]?.[0] as { toolNames?: string[] };
		expect(callArgs?.toolNames).toEqual(["read", "search", "find", "web_search", "ast_grep"]);
		expect(callArgs?.toolNames).not.toContain("bash");
		expect(callArgs?.toolNames).not.toContain("write");
		expect(callArgs?.toolNames).not.toContain("edit");
		expect(callArgs?.toolNames).not.toContain("task");
		// The execute path should have succeeded (output is non-empty).
		expect(result.ok).toBe(true);
	});

	it("input.tools=['read','bash'] still collapses to IN_PROCESS_TOOLS (no tool-set escalation)", async () => {
		const engine = createWorkerEngine("in-process", dummyShared);
		await engine.execute({ ...baseInput, tools: ["read", "bash"] });

		const callArgs = createSessionSpy.mock.calls[0]?.[0] as { toolNames?: string[] };
		expect(callArgs?.toolNames).toEqual(["read", "search", "find", "web_search", "ast_grep"]);
	});

	it("input.tools='none' uses runEphemeralTurn with empty toolNames (no agent loop)", async () => {
		const engine = createWorkerEngine("in-process", dummyShared);
		const ephemeralSpy = vi.spyOn(fake.session, "runEphemeralTurn");
		const promptSpy = vi.spyOn(fake.session, "prompt");

		const result = await engine.execute({ ...baseInput, tools: "none" });

		expect(ephemeralSpy).toHaveBeenCalledTimes(1);
		expect(promptSpy).not.toHaveBeenCalled();
		const callArgs = createSessionSpy.mock.calls[0]?.[0] as { toolNames?: string[] };
		expect(callArgs?.toolNames).toEqual([]);
		expect(result.ok).toBe(true);
	});

	// ------------------------------------------------------------------------
	// Session metadata propagation
	// ------------------------------------------------------------------------

	it("propagates parentTaskPrefix / taskDepth / agentDisplayName to createAgentSession", async () => {
		const engine = createWorkerEngine("in-process", dummyShared);
		await engine.execute(baseInput);

		const callArgs = createSessionSpy.mock.calls[0]?.[0] as {
			parentTaskPrefix?: string;
			taskDepth?: number;
			agentDisplayName?: string;
		};
		expect(callArgs?.parentTaskPrefix).toBe("moa-worker");
		expect(callArgs?.taskDepth).toBe(1);
		expect(callArgs?.agentDisplayName).toBe("moa-worker");
	});

	it("passes attribution: 'agent' on session.prompt", async () => {
		const engine = createWorkerEngine("in-process", dummyShared);
		const promptSpy = vi.spyOn(fake.session, "prompt");

		// Simulate the prompt path completing with a message_end + agent_end
		// so the engine doesn't hang.
		promptSpy.mockImplementation(async () => {
			fake.emitMessageEnd(makeAssistantMessage());
			fake.emitAgentEnd([makeAssistantMessage()]);
		});

		await engine.execute(baseInput);

		expect(promptSpy).toHaveBeenCalledWith(baseInput.task, expect.objectContaining({ attribution: "agent" }));
	});

	// ------------------------------------------------------------------------
	// Usage accumulation across turns (Alt 3b: real turns, not hardcoded 1)
	// ------------------------------------------------------------------------

	it("accumulates usage across multiple message_end events (no double-count from agent_end)", async () => {
		const engine = createWorkerEngine("in-process", dummyShared);
		const promptSpy = vi.spyOn(fake.session, "prompt");

		// Two-turn worker: emits two assistant message_end events, then
		// agent_end with the same messages (mirroring the real event flow).
		promptSpy.mockImplementation(async () => {
			fake.emitMessageEnd(
				makeAssistantMessage({
					usage: {
						input: 100,
						output: 50,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 150,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
					},
				}),
			);
			fake.emitMessageEnd(
				makeAssistantMessage({
					usage: {
						input: 200,
						output: 80,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 280,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.02 },
					},
				}),
			);
			// agent_end re-emits the same 2 messages — usage must NOT be
			// re-accumulated, otherwise totals double.
			fake.emitAgentEnd([
				makeAssistantMessage({
					usage: {
						input: 999,
						output: 999,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 1998,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 99 },
					},
				}),
			]);
		});

		const result = await engine.execute(baseInput);

		// 2 turns from message_end, 0 from agent_end (text-only fallback).
		expect(result.usage.turns).toBe(2);
		expect(result.usage.input).toBe(300); // 100 + 200
		expect(result.usage.output).toBe(130); // 50 + 80
		expect(result.usage.cost).toBeCloseTo(0.03, 5);
	});

	// ------------------------------------------------------------------------
	// waitForIdle + dispose cleanup
	// ------------------------------------------------------------------------

	it("calls session.waitForIdle after session.prompt", async () => {
		const engine = createWorkerEngine("in-process", dummyShared);
		const promptSpy = vi.spyOn(fake.session, "prompt");
		const waitSpy = vi.spyOn(fake.session, "waitForIdle");

		promptSpy.mockImplementation(async () => {
			fake.emitMessageEnd(makeAssistantMessage());
			fake.emitAgentEnd([makeAssistantMessage()]);
		});

		await engine.execute(baseInput);

		const promptOrder = promptSpy.mock.invocationCallOrder[0]!;
		const waitOrder = waitSpy.mock.invocationCallOrder[0]!;
		expect(waitOrder).toBeGreaterThan(promptOrder);
	});

	it("always calls session.dispose, even on error", async () => {
		const engine = createWorkerEngine("in-process", dummyShared);
		const disposeSpy = vi.spyOn(fake.session, "dispose");

		// Make prompt throw.
		vi.spyOn(fake.session, "prompt").mockRejectedValue(new Error("boom"));
		const result = await engine.execute(baseInput);

		expect(disposeSpy).toHaveBeenCalledTimes(1);
		expect(result.ok).toBe(false);
		expect(result.stderr).toBe("boom");
		expect(result.exitCode).toBeNull();
	});

	// ------------------------------------------------------------------------
	// exitCode mapping
	// ------------------------------------------------------------------------

	it("exitCode=1 when last assistant stopReason is 'error'", async () => {
		const engine = createWorkerEngine("in-process", dummyShared);
		const promptSpy = vi.spyOn(fake.session, "prompt");
		promptSpy.mockImplementation(async () => {
			const errMsg = makeAssistantMessage({ stopReason: "error", errorMessage: "model down" });
			fake.emitMessageEnd(errMsg);
			fake.emitAgentEnd([errMsg]);
		});

		const result = await engine.execute(baseInput);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toBe("model down");
	});

	it("exitCode=1 when last assistant stopReason is 'aborted'", async () => {
		const engine = createWorkerEngine("in-process", dummyShared);
		const promptSpy = vi.spyOn(fake.session, "prompt");
		promptSpy.mockImplementation(async () => {
			const abortedMsg = makeAssistantMessage({ stopReason: "aborted" });
			fake.emitMessageEnd(abortedMsg);
			fake.emitAgentEnd([abortedMsg]);
		});

		const result = await engine.execute(baseInput);
		expect(result.exitCode).toBe(1);
	});

	it("exitCode=0 when last assistant stopReason is 'stop'", async () => {
		const engine = createWorkerEngine("in-process", dummyShared);
		const promptSpy = vi.spyOn(fake.session, "prompt");
		promptSpy.mockImplementation(async () => {
			const okMsg = makeAssistantMessage({ stopReason: "stop" });
			fake.emitMessageEnd(okMsg);
			fake.emitAgentEnd([okMsg]);
		});

		const result = await engine.execute(baseInput);
		expect(result.exitCode).toBe(0);
	});

	// ------------------------------------------------------------------------
	// Ephemeral path (tools="none") — used by discovery / rewrite / synthesis.
	// runEphemeralTurn does NOT emit message_end, so usage accumulation is
	// done manually in the engine. Before the fix, all ephemeral stages
	// reported 0 usage, silently breaking cost attribution.
	// ------------------------------------------------------------------------

	it("ephemeral path accumulates usage from the assistant message (regression: was 0)", async () => {
		const engine = createWorkerEngine("in-process", dummyShared);
		// Default makeAssistantMessage has usage.input=10, output=5, cost.total=0.001.
		const result = await engine.execute({ ...baseInput, tools: "none" });

		expect(result.usage.turns).toBe(1);
		expect(result.usage.input).toBe(10);
		expect(result.usage.output).toBe(5);
		expect(result.usage.cost).toBeCloseTo(0.001, 5);
	});

	it("ephemeral path captures text from the assistant message", async () => {
		const engine = createWorkerEngine("in-process", dummyShared);
		vi.spyOn(fake.session, "runEphemeralTurn").mockResolvedValue({
			assistantMessage: makeAssistantMessage({
				content: [{ type: "text", text: "rewritten worker prompt" }],
			}),
			replyText: "rewritten worker prompt",
		} as never);

		const result = await engine.execute({ ...baseInput, tools: "none" });
		expect(result.output).toBe("rewritten worker prompt");
		expect(result.ok).toBe(true);
	});

	it("ephemeral path maps stopReason='error' to exitCode=1 + stderr", async () => {
		const engine = createWorkerEngine("in-process", dummyShared);
		vi.spyOn(fake.session, "runEphemeralTurn").mockResolvedValue({
			assistantMessage: makeAssistantMessage({ stopReason: "error", errorMessage: "transport failed" }),
			replyText: "",
		} as never);

		const result = await engine.execute({ ...baseInput, tools: "none" });
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toBe("transport failed");
	});
});

// ----------------------------------------------------------------------------
// Factory dispatch (kept here so the file is self-contained)
// ----------------------------------------------------------------------------

describe("createWorkerEngine — dispatch", () => {
	it("returns SubprocessWorkerEngine for mode=subprocess", () => {
		const engine = createWorkerEngine("subprocess", dummyShared);
		expect(engine.constructor.name).toBe("SubprocessWorkerEngine");
	});

	it("returns InProcessWorkerEngine for mode=in-process", () => {
		const engine = createWorkerEngine("in-process", dummyShared);
		expect(engine.constructor.name).toBe("InProcessWorkerEngine");
	});
});
