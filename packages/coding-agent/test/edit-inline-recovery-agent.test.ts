import { describe, expect, test } from "bun:test";
import { Agent, type AgentTool } from "@cornfield/agent";
import type { AssistantMessage, Model, Usage } from "@cornfield/ai";
import { AssistantMessageEventStream } from "@cornfield/ai/utils/event-stream";
import { recoverInlineSloppyEditFromTools } from "@cornfield/coding-agent/edit";
import { Type } from "@sinclair/typebox";

/**
 * Ordering contract behind the inline-recovery hook, measured on a live `Agent`
 * rather than on the bare loop.
 *
 * `message_end` is pushed while the assistant message is finalized, before the
 * loop's hook runs; `Agent` forwards events to subscribers asynchronously, and
 * `AgentSession` persists the assistant message from that subscriber
 * (`SessionManager.appendMessage` stringifies on the spot). So the question this
 * file answers is: does the message a subscriber sees at `message_end` already
 * carry the synthesized `edit` call?
 *
 * It must — otherwise the session JSONL would hold the pre-recovery prose while
 * the tool result that follows is written as usual, leaving an orphan result that
 * resume/compaction then read back.
 */

class MockAssistantStream extends AssistantMessageEventStream {}

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

function assistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: usage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

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

/** Render one `<SM:EDIT>` block exactly as the sloppy mode prompt teaches it. */
function block(filePath: string, pairs: Array<[string, string]>): string {
	const body = pairs.map(([find, put]) => `<SM:FIND>\n${find}\n</SM:FIND>\n<SM:PUT>\n${put}\n</SM:PUT>`).join("\n");
	return `<SM:EDIT path="${filePath}">\n${body}\n</SM:EDIT>`;
}

const editSchema = Type.Object({ input: Type.String() });

function makeEditTool(executed: string[]): AgentTool<any> {
	return {
		name: "edit",
		label: "Edit",
		description: "edit tool",
		parameters: editSchema,
		// The live tool's mode, as `EditTool.mode` exposes it (the extension wrapper
		// forwards the getter).
		mode: "sloppy",
		async execute(_id: string, params: { input: string }) {
			executed.push(params.input);
			return { content: [{ type: "text", text: "applied" }] };
		},
	} as unknown as AgentTool<any>;
}

describe("inline recovery under a live Agent", () => {
	/**
	 * A provider stream shaped like a real one: `start` arrives, the consumer drains
	 * it and goes back to waiting, and only then does the turn finish. This is the
	 * timing that decides whether a `message_end` subscriber sees the rewrite.
	 */
	function realisticStreamFn(payload: string): () => AssistantMessageEventStream {
		let callIndex = 0;
		return () => {
			const stream = new MockAssistantStream();
			const index = callIndex++;
			const partial = assistantMessage([{ type: "text", text: "" }]);
			stream.push({ type: "start", partial });
			setTimeout(() => {
				const message =
					index === 0
						? assistantMessage([{ type: "text", text: `Applying the edit as text:\n${payload}` }])
						: assistantMessage([{ type: "text", text: "done" }]);
				stream.push({ type: "done", reason: "stop", message });
			}, 0);
			return stream;
		};
	}

	/** A provider stream that finishes inside the same microtask batch as `start`. */
	function immediateStreamFn(payload: string): () => AssistantMessageEventStream {
		let callIndex = 0;
		return () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const message =
					callIndex === 0
						? assistantMessage([{ type: "text", text: `Applying the edit as text:\n${payload}` }])
						: assistantMessage([{ type: "text", text: "done" }]);
				callIndex += 1;
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};
	}

	async function runAgent(streamFn: () => AssistantMessageEventStream): Promise<{
		executed: string[];
		snapshots: Array<{ contentTypes: string; json: string }>;
		journal: string[];
		agent: Agent;
	}> {
		const executed: string[] = [];
		const agent = new Agent({
			getApiKey: () => "test-key",
			streamFn,
			initialState: {
				model: createModel(),
				systemPrompt: "Test",
				tools: [makeEditTool(executed)],
				messages: [],
			},
		});

		// Exactly what AgentSession installs.
		agent.setTransformAssistantMessage(message => {
			recoverInlineSloppyEditFromTools(agent.state.tools, message);
		});

		// The persistence analog: snapshot the message the moment `message_end`
		// arrives, the way SessionManager.appendMessage stringifies on the spot, and
		// keep the same order in a journal the way the session JSONL does.
		const snapshots: Array<{ contentTypes: string; json: string }> = [];
		const journal: string[] = [];
		agent.subscribe(event => {
			if (event.type !== "message_end") return;
			journal.push(JSON.stringify(event.message));
			if (event.message.role === "assistant") {
				snapshots.push({
					contentTypes: event.message.content.map(block => block.type).join(","),
					json: JSON.stringify(event.message),
				});
			}
		});

		await agent.prompt("apply it");
		return { executed, snapshots, journal, agent };
	}

	for (const [label, makeStreamFn] of [
		["turn finishing in the same microtask batch as start", immediateStreamFn],
		["turn finishing after the consumer drained start", realisticStreamFn],
	] as const) {
		test(`the message_end a session persists already carries the synthesized call (${label})`, async () => {
			const payload = block("a.ts", [["old", "new"]]);
			// One stream function for the whole run: it scripts call 0 (prose payload)
			// and every later call (plain "done").
			const { executed, snapshots, journal, agent } = await runAgent(makeStreamFn(payload));

			// 1. The recovered call was dispatched and executed.
			expect(executed).toEqual([payload]);

			// 2. The message the session persists already carries it — no orphan
			//    tool result in the JSONL.
			expect(snapshots[0]?.contentTypes).toBe("text,toolCall");
			expect(snapshots[0]?.json).toContain('"name":"edit"');

			// 3. The event-time message and the turn's stored message agree.
			const stored = agent.state.messages.find(message => message.role === "assistant");
			expect(stored?.content.map(block => block.type)).toEqual(["text", "toolCall"]);
			const storedCall = stored?.content.find(block => block.type === "toolCall");
			if (storedCall?.type !== "toolCall") throw new Error("expected a stored tool call");
			const eventCall = JSON.parse(snapshots[0]!.json).content.find(
				(block: { type: string }) => block.type === "toolCall",
			);
			expect(eventCall).toEqual(storedCall);

			// 4. What a resume/compaction read-back of that journal would pair up: the
			//    assistant line carries the call, and the tool result that follows names
			//    the same id.
			const lines = journal.map(
				line => JSON.parse(line) as { role: string; toolCallId?: string; content: unknown[] },
			);
			const assistantLine = lines.find(line => line.role === "assistant");
			const callBlock = (assistantLine?.content ?? []).find(
				(block): block is { type: "toolCall"; id: string } =>
					typeof block === "object" && block !== null && (block as { type?: string }).type === "toolCall",
			);
			const resultLine = lines.find(line => line.role === "toolResult");
			expect(callBlock).toBeDefined();
			expect(resultLine?.toolCallId).toBe(callBlock?.id);
		});
	}
});
