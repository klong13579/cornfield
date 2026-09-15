import { describe, expect, test } from "bun:test";
import { agentLoop } from "@cornfield/agent/agent-loop";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, AgentTool } from "@cornfield/agent/types";
import type { AssistantMessage, Message, Model, Usage, UserMessage } from "@cornfield/ai";
import { AssistantMessageEventStream } from "@cornfield/ai/utils/event-stream";
import { recoverInlineSloppyEdit, recoverInlineSloppyEditFromTools } from "@cornfield/coding-agent/edit";
import { Type } from "@sinclair/typebox";

/** Render one `<SM:EDIT>` block exactly as the sloppy mode prompt teaches it. */
function block(filePath: string, pairs: Array<[string, string]>): string {
	const body = pairs.map(([find, put]) => `<SM:FIND>\n${find}\n</SM:FIND>\n<SM:PUT>\n${put}\n</SM:PUT>`).join("\n");
	return `<SM:EDIT path="${filePath}">\n${body}\n</SM:EDIT>`;
}

function usage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: usage(),
		stopReason,
		timestamp: Date.now(),
	};
}

function textMessage(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return assistantMessage([{ type: "text", text }], stopReason);
}

// ───────────────────────────────────────────────────────────────────────────
// Unit: message rewriting
// ───────────────────────────────────────────────────────────────────────────

describe("recoverInlineSloppyEdit", () => {
	test("lifts a payload out of the text and synthesizes one edit call", () => {
		const payload = block("a.ts", [["old", "new"]]);
		const message = textMessage(`Applying it now:\n${payload}\n`);

		expect(recoverInlineSloppyEdit(message)).toBe(1);
		// The prose around the payload stays as text; the payload block itself is gone.
		expect(message.content).toHaveLength(2);
		const leading = message.content[0];
		expect(leading?.type === "text" ? leading.text : "").toBe("Applying it now:\n\n");
		const call = message.content[1];
		if (call?.type !== "toolCall") throw new Error("expected a tool call");
		expect(call.name).toBe("edit");
		expect(call.arguments).toEqual({ input: payload });
		expect(typeof call.id).toBe("string");
	});

	test("keeps surrounding prose in the text block", () => {
		const payload = block("a.ts", [["old", "new"]]);
		const message = textMessage(`before\n${payload}\nafter`);

		expect(recoverInlineSloppyEdit(message)).toBe(1);
		const text = message.content.find(c => c.type === "text");
		expect(text?.type === "text" ? text.text : "").toBe("before\n\nafter");
	});

	test("drops a text block that held nothing but the payload", () => {
		const message = textMessage(block("a.ts", [["old", "new"]]));

		expect(recoverInlineSloppyEdit(message)).toBe(1);
		expect(message.content.map(c => c.type)).toEqual(["toolCall"]);
	});

	test("recovers every region, in order, into a single call", () => {
		const first = block("a.ts", [["one", "two"]]);
		const second = block("b.ts", [["three", "four"]]);
		const message = textMessage(`${first}\nand\n${second}`);

		expect(recoverInlineSloppyEdit(message)).toBe(2);
		expect(message.content).toHaveLength(2);
		const call = message.content[1];
		if (call?.type !== "toolCall") throw new Error("expected a tool call");
		expect(call.arguments.input).toBe(`${first}\n${second}`);
		const text = message.content[0];
		expect(text?.type === "text" ? text.text : "").toBe("\nand\n");
	});

	test("recovers regions split across text blocks", () => {
		const first = block("a.ts", [["one", "two"]]);
		const second = block("b.ts", [["three", "four"]]);
		const message = assistantMessage([
			{ type: "text", text: `first\n${first}` },
			{ type: "thinking", thinking: "considering" },
			{ type: "text", text: `${second}\nlast` },
		]);

		expect(recoverInlineSloppyEdit(message)).toBe(2);
		// Two texts kept their surrounding prose, the thinking block is untouched,
		// and the recovered call is appended last.
		expect(message.content).toHaveLength(4);
		const call = message.content.at(-1);
		if (call?.type !== "toolCall") throw new Error("expected a tool call");
		expect(call.arguments.input).toBe(`${first}\n${second}`);
	});

	test("leaves a turn that already called tools untouched", () => {
		const payload = block("a.ts", [["old", "new"]]);
		const message = assistantMessage([
			{ type: "text", text: `quoted for reference:\n${payload}` },
			{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } },
		]);

		expect(recoverInlineSloppyEdit(message)).toBe(0);
		expect(message.content).toHaveLength(2);
		expect(message.content[0]?.type === "text" ? message.content[0].text : "").toContain("<SM:EDIT");
	});

	test("leaves a truncated (non-stop) turn untouched", () => {
		const message = textMessage(`payload:\n${block("a.ts", [["old", "new"]])}`, "length");

		expect(recoverInlineSloppyEdit(message)).toBe(0);
		expect(message.content).toHaveLength(1);
		expect(message.content[0]?.type).toBe("text");
	});

	test("leaves ordinary text untouched", () => {
		const message = textMessage("Nothing to change; the code reference `edit({ path })` is just prose.");

		expect(recoverInlineSloppyEdit(message)).toBe(0);
		expect(message.content).toHaveLength(1);
		expect(message.content[0]?.type).toBe("text");
	});

	test("leaves empty text untouched", () => {
		const message = textMessage("");

		expect(recoverInlineSloppyEdit(message)).toBe(0);
		expect(message.content).toHaveLength(1);
	});

	test("leaves an incomplete payload untouched — no half edit is materialized", () => {
		const message = textMessage(`<SM:EDIT path="a.ts">\n<SM:FIND>\nhalf a find`);

		expect(recoverInlineSloppyEdit(message)).toBe(0);
		expect(message.content[0]?.type).toBe("text");
	});

	test("recovers a trailing payload in a very long reply", () => {
		const payload = block("a.ts", [["old", "new"]]);
		const message = textMessage(`${"thinking out loud.\n".repeat(20_000)}${payload}`);

		expect(recoverInlineSloppyEdit(message)).toBe(1);
		const call = message.content.at(-1);
		if (call?.type !== "toolCall") throw new Error("expected a tool call");
		expect(call.arguments.input).toBe(payload);
	});

	test("gives each recovered call a distinct id", () => {
		const first = textMessage(block("a.ts", [["old", "new"]]));
		const second = textMessage(block("a.ts", [["old", "new"]]));

		recoverInlineSloppyEdit(first);
		recoverInlineSloppyEdit(second);
		const firstCall = first.content[0];
		const secondCall = second.content[0];
		if (firstCall?.type !== "toolCall" || secondCall?.type !== "toolCall") throw new Error("expected tool calls");
		expect(firstCall.id).not.toBe(secondCall.id);
	});
});

describe("recoverInlineSloppyEditFromTools", () => {
	const sloppyTool = { name: "edit", mode: "sloppy" } as unknown as AgentTool<any>;
	const replaceTool = { name: "edit", mode: "replace" } as unknown as AgentTool<any>;

	test("recovers when the live edit tool runs the sloppy mode", () => {
		const message = textMessage(block("a.ts", [["old", "new"]]));
		expect(recoverInlineSloppyEditFromTools([sloppyTool], message)).toBe(1);
	});

	test("does not recover when the edit tool runs another mode", () => {
		const message = textMessage(block("a.ts", [["old", "new"]]));
		expect(recoverInlineSloppyEditFromTools([replaceTool], message)).toBe(0);
		expect(message.content[0]?.type).toBe("text");
	});

	test("does not recover when there is no edit tool", () => {
		const message = textMessage(block("a.ts", [["old", "new"]]));
		expect(recoverInlineSloppyEditFromTools([], message)).toBe(0);
		expect(recoverInlineSloppyEditFromTools(undefined, message)).toBe(0);
	});
});

// ───────────────────────────────────────────────────────────────────────────
// Loop level: the recovered call is dispatched in the same turn.
//
// agent-session installs the recovery as the loop's `transformAssistantMessage`
// hook, so the rewrite happens between the finalized assistant message and the
// loop's tool-call check. This test drives the real agent loop with that hook.
// ───────────────────────────────────────────────────────────────────────────

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

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

const editSchema = Type.Object({ input: Type.String() });

/** The `edit` tool as the sloppy mode exposes it: one `input` string. */
function makeEditTool(executed: Array<{ input: string }>): AgentTool<typeof editSchema, { ok: boolean }> {
	return {
		name: "edit",
		label: "Edit",
		description: "edit tool",
		parameters: editSchema,
		async execute(_id, params) {
			executed.push({ input: params.input });
			return { content: [{ type: "text", text: "applied" }], details: { ok: true } };
		},
	};
}

describe("recovered payloads execute through the agent loop", () => {
	test("a payload written as prose is executed as an edit call in the same turn", async () => {
		const executed: Array<{ input: string }> = [];
		const payload = block("a.ts", [["old", "new"]]);
		const tools = [{ ...makeEditTool(executed), mode: "sloppy" }];

		let callIndex = 0;
		const streamFn = (): AssistantMessageEventStream => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const message =
					callIndex === 0
						? assistantMessage([{ type: "text", text: `Applying the edit as text:\n${payload}` }], "stop")
						: assistantMessage([{ type: "text", text: "done" }], "stop");
				callIndex += 1;
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};

		const context: AgentContext = { systemPrompt: "", messages: [], tools };
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			// The hook agent-session installs, verbatim.
			transformAssistantMessage: message => {
				recoverInlineSloppyEditFromTools(tools, message);
			},
		};

		const stream = agentLoop(
			[{ role: "user", content: "apply it" } as UserMessage],
			context,
			config,
			undefined,
			streamFn,
		);

		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		expect(executed).toEqual([{ input: payload }]);

		const toolStart = events.find(event => event.type === "tool_execution_start");
		expect(toolStart?.type === "tool_execution_start" ? toolStart.toolName : "").toBe("edit");

		// The assistant message that reached the context carries the recovered call,
		// paired with its tool result, so the next provider request is well formed.
		const messages = await stream.result();
		const storedAssistant = messages.find(message => message.role === "assistant");
		const storedCall = storedAssistant?.content.find(block => block.type === "toolCall");
		expect(storedCall?.name).toBe("edit");
		expect(messages.some(message => message.role === "toolResult")).toBe(true);
	});

	test("an edit tool that does not run sloppy leaves the prose alone", async () => {
		const executed: Array<{ input: string }> = [];
		const payload = block("a.ts", [["old", "new"]]);
		const tools = [{ ...makeEditTool(executed), mode: "replace" }];

		const context: AgentContext = { systemPrompt: "", messages: [], tools };
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			transformAssistantMessage: message => {
				recoverInlineSloppyEditFromTools(tools, message);
			},
		};
		const stream = agentLoop(
			[{ role: "user", content: "apply it" } as UserMessage],
			context,
			config,
			undefined,
			() => {
				const inner = new MockAssistantStream();
				queueMicrotask(() => {
					inner.push({
						type: "done",
						reason: "stop",
						message: assistantMessage([{ type: "text", text: `as text:\n${payload}` }], "stop"),
					});
				});
				return inner;
			},
		);

		for await (const _ of stream) {
			// consume
		}

		expect(executed).toEqual([]);
	});
});
