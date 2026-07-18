/**
 * Length-stall circuit (Approach B): fuse after N consecutive progressless
 * `length` turns (length + no toolCall) so follow-ups cannot empty-spin the run.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { type AssistantMessage, getBundledModel } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { Type } from "@sinclair/typebox";
import { createAssistantMessage } from "./helpers";

const MAX_CONSECUTIVE = 3;

function makeModel() {
	return getBundledModel("google", "gemini-2.5-flash-lite-preview-06-17");
}

function makeProgresslessLengthStream(thinking: string): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const message = createAssistantMessage([{ type: "thinking", thinking }], "length");
		stream.push({ type: "done", reason: "length", message });
	});
	return stream;
}

function makeLengthWithToolCallStream(toolCallId: string): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const message = createAssistantMessage(
			[{ type: "toolCall", id: toolCallId, name: "noop", arguments: { value: "x" } }],
			"length",
		);
		stream.push({ type: "done", reason: "length", message });
	});
	return stream;
}

function makeFollowUp(text: string) {
	return {
		role: "user" as const,
		content: [{ type: "text" as const, text }],
		timestamp: Date.now(),
	};
}

describe("length stall circuit — progressless length fuse", () => {
	let agent: Agent;
	const events: Array<{ type: string; message?: unknown }> = [];
	let callCount = 0;

	beforeEach(() => {
		events.length = 0;
		callCount = 0;
		agent = new Agent({
			initialState: {
				model: makeModel(),
				systemPrompt: "You are helpful.",
				messages: [],
				tools: [],
			},
		});
		agent.subscribe(e => {
			events.push(e as { type: string; message?: unknown });
		});
	});

	afterEach(() => {
		agent.abort();
	});

	it("fuses after N=3 consecutive progressless length turns; mid-run follow-up does not cause a 4th model call", async () => {
		agent.streamFn = () => {
			const idx = ++callCount;
			return makeProgresslessLengthStream(`progressless length thinking ${idx}`);
		};

		// Pre-queue enough follow-ups that, without a fuse, the outer loop would
		// keep re-entering (length is continuable; follow-ups restart the run).
		agent.followUp(makeFollowUp("follow-up after length 1"));
		agent.followUp(makeFollowUp("follow-up after length 2"));
		agent.followUp(makeFollowUp("follow-up after length 3 — must not trigger a 4th call"));
		agent.followUp(makeFollowUp("follow-up after length 4 — safety overflow"));

		// Queue one more mid-run after the second assistant turn ends, simulating
		// an async-result / follow-up arriving while the storm is in progress.
		agent.subscribe(e => {
			if (e.type !== "turn_end") return;
			const message = (e as { message?: AssistantMessage }).message;
			if (message?.role !== "assistant") return;
			if (callCount !== 2) return;
			agent.followUp(makeFollowUp("mid-run follow-up after 2nd length"));
		});

		await agent.prompt("Start a turn that will hit length with thinking only.");

		const eventTypes = events.map(e => e.type);
		expect(eventTypes).toContain("agent_start");
		expect(eventTypes).toContain("agent_end");

		// Fuse after N consecutive progressless length turns — no empty-spin past N.
		expect(callCount).toBeLessThanOrEqual(MAX_CONSECUTIVE);
		expect(callCount).toBe(MAX_CONSECUTIVE);

		const assistantEnds = events.filter(e => {
			if (e.type !== "message_end") return false;
			const m = e.message as AssistantMessage | undefined;
			return m?.role === "assistant";
		});
		expect(assistantEnds.length).toBe(MAX_CONSECUTIVE);
		for (const e of assistantEnds) {
			const m = e.message as AssistantMessage;
			expect(m.stopReason).toBe("length");
			expect(m.content.some(c => c.type === "toolCall")).toBe(false);
			expect(m.content.some(c => c.type === "thinking")).toBe(true);
		}
	});

	it("length + toolCall resets stallCount and allows continuation past near-fuse", async () => {
		// Sequence that distinguishes reset vs no-reset:
		//   progressless, progressless (stall=2), length+toolCall (reset→0),
		//   then 3 progressless → fuse. Total model calls = 6.
		// Without reset, stall would stay at 2 after toolCall and fuse on the
		// next progressless (call 4).
		const toolSchema = Type.Object({ value: Type.String() });
		const noopTool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "noop",
			label: "Noop",
			description: "No-op tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				return { content: [{ type: "text", text: `noop:${params.value}` }], details: { value: params.value } };
			},
		};

		agent.setTools([noopTool]);
		agent.streamFn = () => {
			const idx = ++callCount;
			if (idx === 3) {
				return makeLengthWithToolCallStream("tool-reset-1");
			}
			return makeProgresslessLengthStream(`progressless after reset path ${idx}`);
		};

		// Drive outer continues for the progressless turns (toolCall turn continues
		// via the inner tool loop without needing a follow-up).
		for (let i = 0; i < 8; i++) {
			agent.followUp(makeFollowUp(`follow-up ${i}`));
		}

		await agent.prompt("Near-fuse then length+toolCall should reset.");

		expect(events.map(e => e.type)).toContain("agent_end");
		expect(callCount).toBe(2 + 1 + MAX_CONSECUTIVE); // 6

		const assistantEnds = events.filter(e => {
			if (e.type !== "message_end") return false;
			const m = e.message as AssistantMessage | undefined;
			return m?.role === "assistant";
		});
		expect(assistantEnds.length).toBe(callCount);

		const third = assistantEnds[2]?.message as AssistantMessage;
		expect(third.stopReason).toBe("length");
		expect(third.content.some(c => c.type === "toolCall")).toBe(true);
	});
});
