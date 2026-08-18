import { describe, expect, it, vi } from "bun:test";
import { agentLoop } from "@oh-my-pi/pi-agent-core/agent-loop";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	CanUseToolContext,
} from "@oh-my-pi/pi-agent-core/types";
import type { Message, Model, UserMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { Type } from "@sinclair/typebox";
import { createAssistantMessage } from "./helpers";

const DENIED_MESSAGE = "Tool execution was denied by approval";

class MockAssistantStream extends AssistantMessageEventStream {}

function createModel(): Model<"openai-responses"> {
	return {
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function createUserMessage(text: string): UserMessage {
	return {
		role: "user",
		content: text,
		timestamp: Date.now(),
	};
}

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

const echoSchema = Type.Object({ value: Type.String() });

function createEchoTool(executed: string[]): AgentTool<typeof echoSchema, { value: string }> {
	return {
		name: "echo",
		label: "Echo",
		description: "Echo tool",
		parameters: echoSchema,
		async execute(_toolCallId, params) {
			executed.push(params.value);
			return {
				content: [{ type: "text", text: `echoed: ${params.value}` }],
				details: { value: params.value },
			};
		},
	};
}

/**
 * Emits a single `echo` tool call on the first model call, then a clean text
 * "done" response on the follow-up (after tool results are fed back).
 */
function createToolThenDoneStreamFn(callIndex: { n: number }) {
	return () => {
		const stream = new MockAssistantStream();
		queueMicrotask(() => {
			if (callIndex.n === 0) {
				const message = createAssistantMessage(
					[{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }],
					"toolUse",
				);
				stream.push({ type: "done", reason: "toolUse", message });
			} else {
				const message = createAssistantMessage([{ type: "text", text: "done" }]);
				stream.push({ type: "done", reason: "stop", message });
			}
			callIndex.n += 1;
		});
		return stream;
	};
}

function findErrorToolEnd(events: AgentEvent[]) {
	return events.find(
		(e): e is Extract<AgentEvent, { type: "tool_execution_end" }> =>
			e.type === "tool_execution_end" && e.isError === true,
	);
}

function expectDenied(events: AgentEvent[], executed: string[]): void {
	expect(executed).toEqual([]);
	const end = findErrorToolEnd(events);
	expect(end).toBeDefined();
	if (end?.type === "tool_execution_end") {
		const first = end.result.content[0];
		expect(first?.type).toBe("text");
		if (first?.type === "text") {
			expect(first.text).toBe(DENIED_MESSAGE);
		}
	}
}

describe("canUseTool approval gate", () => {
	it("executes tools normally when canUseTool is not set (zero-change)", async () => {
		const executed: string[] = [];
		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [createEchoTool(executed)],
		};
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop(
			[createUserMessage("start")],
			context,
			config,
			undefined,
			createToolThenDoneStreamFn({ n: 0 }),
		);
		for await (const event of stream) {
			events.push(event);
		}

		expect(executed).toEqual(["hello"]);
		expect(findErrorToolEnd(events)).toBeUndefined();
	});

	it("waits on a pending canUseTool promise and executes after external approval", async () => {
		const executed: string[] = [];
		const { promise: entered, resolve: enteredResolve } = Promise.withResolvers<void>();
		const { promise: approval, resolve: approve } = Promise.withResolvers<boolean>();
		const canUseTool = () => {
			enteredResolve();
			return approval;
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [createEchoTool(executed)],
		};
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			canUseTool,
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop(
			[createUserMessage("start")],
			context,
			config,
			undefined,
			createToolThenDoneStreamFn({ n: 0 }),
		);
		const streamTask = (async () => {
			for await (const event of stream) {
				events.push(event);
			}
		})();

		// Gate is entered but approval is still pending: tool must not run yet.
		await entered;
		expect(executed).toEqual([]);

		approve(true);
		await streamTask;

		expect(executed).toEqual(["hello"]);
		expect(findErrorToolEnd(events)).toBeUndefined();
	});

	it("denies tool execution when canUseTool returns false", async () => {
		const executed: string[] = [];
		const seen: CanUseToolContext[] = [];
		const canUseTool = (ctx: CanUseToolContext) => {
			seen.push(ctx);
			return false;
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [createEchoTool(executed)],
		};
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			canUseTool,
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop(
			[createUserMessage("start")],
			context,
			config,
			undefined,
			createToolThenDoneStreamFn({ n: 0 }),
		);
		for await (const event of stream) {
			events.push(event);
		}

		expectDenied(events, executed);

		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({
			toolCallId: "tool-1",
			name: "echo",
			args: { value: "hello" },
			index: 0,
			total: 1,
		});
		expect(typeof seen[0]?.batchId).toBe("string");
	});

	it("denies execution when approval hangs past the 120s timeout", async () => {
		vi.useFakeTimers();
		try {
			const executed: string[] = [];
			const { promise: entered, resolve: enteredResolve } = Promise.withResolvers<void>();
			const canUseTool = () => {
				enteredResolve();
				return new Promise<boolean>(() => {});
			};

			const context: AgentContext = {
				systemPrompt: "",
				messages: [],
				tools: [createEchoTool(executed)],
			};
			const config: AgentLoopConfig = {
				model: createModel(),
				convertToLlm: identityConverter,
				canUseTool,
			};

			const events: AgentEvent[] = [];
			const stream = agentLoop(
				[createUserMessage("start")],
				context,
				config,
				undefined,
				createToolThenDoneStreamFn({ n: 0 }),
			);
			const streamTask = (async () => {
				for await (const event of stream) {
					events.push(event);
				}
			})();

			await entered;
			vi.advanceTimersByTime(120_000);
			await streamTask;

			expectDenied(events, executed);
		} finally {
			vi.useRealTimers();
		}
	});

	it("denies execution immediately when aborted while approval is pending", async () => {
		const executed: string[] = [];
		const { promise: entered, resolve: enteredResolve } = Promise.withResolvers<void>();
		const canUseTool = () => {
			enteredResolve();
			return new Promise<boolean>(() => {});
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [createEchoTool(executed)],
		};
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			canUseTool,
		};

		const abortController = new AbortController();
		const events: AgentEvent[] = [];
		const stream = agentLoop(
			[createUserMessage("start")],
			context,
			config,
			abortController.signal,
			createToolThenDoneStreamFn({ n: 0 }),
		);
		const streamTask = (async () => {
			for await (const event of stream) {
				events.push(event);
			}
		})();

		await entered;
		abortController.abort();
		await streamTask;

		expectDenied(events, executed);
	});
});
