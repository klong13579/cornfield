import { describe, expect, it } from "bun:test";
import { agentLoop } from "@cornfield/agent/agent-loop";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, AgentTool } from "@cornfield/agent/types";
import type { AssistantMessage, Message, Model, ToolResultMessage, UserMessage } from "@cornfield/ai";
import { AssistantMessageEventStream } from "@cornfield/ai/utils/event-stream";
import { Type } from "@sinclair/typebox";
import { createAssistantMessage } from "./helpers";

/**
 * `AgentLoopConfig.transformAssistantMessage`: the hook the loop calls on a
 * finalized assistant message right before it reads that message's tool calls.
 * It exists so a caller can rewrite the message into the shape the dispatcher
 * should see (e.g. materializing a tool call the model wrote as text).
 *
 * These tests pin the contract, including the two ways it must stay invisible:
 * with no hook, and when the hook throws.
 */

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
	return { role: "user", content: text, timestamp: Date.now() };
}

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

const echoSchema = Type.Object({ value: Type.String() });

function makeEchoTool(executed: string[]): AgentTool<typeof echoSchema, { value: string }> {
	return {
		name: "echo",
		label: "Echo",
		description: "Echo tool",
		parameters: echoSchema,
		async execute(_toolCallId, params) {
			executed.push(params.value);
			return { content: [{ type: "text", text: `echoed: ${params.value}` }], details: { value: params.value } };
		},
	};
}

/** Provider script: first call answers with `first`, later calls answer with plain text. */
function scriptedStreamFn(first: () => AssistantMessage): () => AssistantMessageEventStream {
	let callIndex = 0;
	return () => {
		const stream = new MockAssistantStream();
		queueMicrotask(() => {
			const message = callIndex === 0 ? first() : createAssistantMessage([{ type: "text", text: "done" }]);
			callIndex += 1;
			stream.push({ type: "done", reason: "stop", message });
		});
		return stream;
	};
}

async function runLoop(
	config: Partial<AgentLoopConfig>,
	tools: AgentTool<any>[] = [],
): Promise<{ events: AgentEvent[]; messages: AgentMessage[] }> {
	const context: AgentContext = { systemPrompt: "", messages: [], tools };
	const stream = agentLoop(
		[createUserMessage("go")],
		context,
		{ model: createModel(), convertToLlm: identityConverter, ...config } as AgentLoopConfig,
		undefined,
		scriptedStreamFn(() => createAssistantMessage([{ type: "text", text: "no tool call" }])),
	);

	const events: AgentEvent[] = [];
	for await (const event of stream) {
		events.push(event);
	}
	return { events, messages: await stream.result() };
}

describe("transformAssistantMessage", () => {
	it("dispatches a tool call the hook injects into a finalized message", async () => {
		const executed: string[] = [];
		const hookCalls: string[] = [];
		let injected = false;

		const { events, messages } = await runLoop(
			{
				transformAssistantMessage: message => {
					hookCalls.push(message.stopReason ?? "none");
					// One-shot, like a real recovery: the payload is gone once it runs.
					if (injected) return;
					injected = true;
					message.content = [
						{ type: "text", text: "" },
						{ type: "toolCall", id: "recovered-1", name: "echo", arguments: { value: "hello" } },
					];
				},
			},
			[makeEchoTool(executed)],
		);

		expect(executed).toEqual(["hello"]);
		// Two turns ran (the injected call, then the follow-up), so the hook saw both
		// finalized messages; only the first had a payload to recover.
		expect(hookCalls).toEqual(["stop", "stop"]);

		const toolStart = events.find(event => event.type === "tool_execution_start");
		expect(toolStart?.type === "tool_execution_start" ? toolStart.toolName : "").toBe("echo");

		// The injected call reaches the context paired with its result.
		const assistant = messages.find(message => message.role === "assistant");
		expect(assistant?.content.some(block => block.type === "toolCall")).toBe(true);
		const toolResult = messages.find((message): message is ToolResultMessage => message.role === "toolResult");
		expect(toolResult?.toolCallId).toBe("recovered-1");
	});

	it("leaves the turn untouched when no hook is passed", async () => {
		const executed: string[] = [];

		const { events, messages } = await runLoop({}, [makeEchoTool(executed)]);

		expect(executed).toEqual([]);
		expect(events.some(event => event.type === "tool_execution_start")).toBe(false);

		const assistant = messages.find(message => message.role === "assistant");
		expect(assistant?.content.map(block => block.type)).toEqual(["text"]);
		const text = assistant?.content[0];
		expect(text?.type === "text" ? text.text : "").toBe("no tool call");
	});

	it("continues the turn when the hook throws", async () => {
		const executed: string[] = [];

		const { events, messages } = await runLoop(
			{
				transformAssistantMessage: () => {
					throw new Error("recovery blew up");
				},
			},
			[makeEchoTool(executed)],
		);

		expect(executed).toEqual([]);
		expect(events.some(event => event.type === "agent_end")).toBe(true);
		const assistant = messages.find(message => message.role === "assistant");
		expect(assistant?.content.map(block => block.type)).toEqual(["text"]);
	});

	it("runs at most once per turn", async () => {
		let calls = 0;

		const { messages } = await runLoop({
			transformAssistantMessage: () => {
				calls += 1;
			},
		});

		// One assistant message in the run, so exactly one hook call.
		expect(messages.filter(message => message.role === "assistant")).toHaveLength(1);
		expect(calls).toBe(1);
	});

	it("does not run for an errored message", async () => {
		let calls = 0;
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [] };
		const stream = agentLoop(
			[createUserMessage("go")],
			context,
			{
				model: createModel(),
				convertToLlm: identityConverter,
				transformAssistantMessage: () => {
					calls += 1;
				},
			},
			undefined,
			scriptedStreamFn(() => ({
				...createAssistantMessage([{ type: "text", text: "partial" }]),
				stopReason: "error",
				errorMessage: "provider failed",
			})),
		);

		for await (const _ of stream) {
			// consume
		}

		expect(calls).toBe(0);
	});
});
