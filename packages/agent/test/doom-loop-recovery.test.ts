/**
 * End-to-end doom-loop recovery test.
 *
 * The companion `doom-loop-e2e.test.ts` proves the detector fires and
 * terminates the assistant turn with `stopReason: "length"`. This file
 * proves the next layer: when the detector fires, the agent loop
 * RETRIES — re-streaming the same prompt with thinking disabled — and
 * the LLM's second response is the one the user actually sees.
 *
 * Concretely:
 *   1. First streamFunction call: emit a degenerate thinking block
 *      (phrase repeated 280×) — the detector classifies it as doom.
 *   2. streamAttempt returns `{ kind: "doom", ... }`; the outer retry
 *      loop pops the bad message from `context.messages` and re-invokes
 *      `streamFunction` with `attempt=1`.
 *   3. Second streamFunction call: emit a clean text response. The
 *      detector does not fire; streamAttempt returns `{ kind: "clean" }`
 *      and the retry loop returns the clean message.
 *   4. The agent's final `assistant` message in `state.messages` is the
 *      clean one. The doom message is preserved in the agent event
 *      stream (two `message_end` events were emitted) and therefore in
 *      the session JSONL, but the model never sees it on a future turn.
 *
 * The test also asserts that the retry's `streamFunction` call does NOT
 * receive the doom thinking in its `messages` argument — proving the
 * strip-on-pop contract.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	getBundledModel,
	type Model,
} from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream as PiEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { createUsage } from "./helpers";

function makeModel() {
	return getBundledModel("google", "gemini-2.5-flash-lite-preview-06-17");
}

function makeAssistantMessageWithText(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: createUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function makeAssistantMessageWithThinking(thinking: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "thinking", thinking }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: createUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function makeDoomStream(phrase: string, repeats: number): AssistantMessageEventStream {
	const stream = new PiEventStream();
	queueMicrotask(() => {
		const text = phrase.repeat(repeats);
		stream.push({ type: "start", partial: makeAssistantMessageWithThinking("") });
		stream.push({ type: "thinking_start", contentIndex: 0, partial: makeAssistantMessageWithThinking("") });
		stream.push({
			type: "thinking_delta",
			contentIndex: 0,
			delta: text,
			partial: makeAssistantMessageWithThinking(text),
		});
		stream.push({
			type: "thinking_end",
			contentIndex: 0,
			content: text,
			partial: makeAssistantMessageWithThinking(text),
		});
	});
	return stream;
}

function makeCleanStream(text: string): AssistantMessageEventStream {
	const stream = new PiEventStream();
	queueMicrotask(() => {
		stream.push({ type: "start", partial: makeAssistantMessageWithText("") });
		stream.push({ type: "text_start", contentIndex: 0, partial: makeAssistantMessageWithText("") });
		stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: makeAssistantMessageWithText(text) });
		stream.push({ type: "text_end", contentIndex: 0, content: text, partial: makeAssistantMessageWithText(text) });
		stream.push({ type: "done", reason: "stop", message: makeAssistantMessageWithText(text) });
	});
	return stream;
}

/**
 * Find the n-th message_end event for an assistant message. Returns the
 * (stopReason, errorMessage) tuple and the index in the events list. Used
 * to assert both the doom message_end and the clean message_end fired.
 */
function findAssistantMessageEnds(events: Array<{ type: string; message?: unknown }>): Array<AssistantMessage> {
	const out: AssistantMessage[] = [];
	for (const e of events) {
		if (e.type !== "message_end") continue;
		const m = e.message as AssistantMessage | undefined;
		if (m?.role === "assistant") out.push(m);
	}
	return out;
}

describe("doom-loop recovery: doom → strip → retry with no-thinking → clean response", () => {
	let agent: Agent;
	const events: Array<{ type: string; message?: unknown }> = [];
	let callCount = 0;
	const seenMessagesByCall: Array<Context["messages"]> = [];
	const seenOptionsByCall: Array<{ reasoning?: unknown; [k: string]: unknown }> = [];

	beforeEach(() => {
		events.length = 0;
		callCount = 0;
		seenMessagesByCall.length = 0;
		seenOptionsByCall.length = 0;
		agent = new Agent({
			initialState: {
				model: makeModel(),
				systemPrompt: "You are helpful.",
				messages: [],
				tools: [],
			},
			doomLoop: {
				enabled: true,
				thinking: { minChars: 5000, uniqueRatioThreshold: 0.15, minPhraseRepeat: 200, minPhraseLength: 20 },
				text: { minChars: 500, ngramSize: 60, minNgramRepeat: 4 },
				maxThinkingChars: 16384,
				maxRetries: 1,
				// Track that retryStreamOptions is invoked; default disables
				// thinking. The hook can be replaced per-test.
				retryStreamOptions: (_model: Model, attempt: number) => {
					seenOptionsByCall.push({ reasoning: undefined, attempt });
					return { reasoning: undefined };
				},
			},
		});
		agent.subscribe(e => {
			events.push(e as { type: string; message?: unknown });
		});
	});

	afterEach(() => {
		agent.abort();
	});

	it("recovers via a single retry: first attempt dooms, second attempt is clean, user sees clean", async () => {
		const phrase = "All 78 channel tests pass. Run biome + related. ";
		const cleanText = "All 78 channel tests pass. The recovery succeeded.";

		agent.streamFn = (async (
			_model: Model,
			llmContext: Context,
			options: Parameters<NonNullable<Agent["streamFn"]>>[2],
		) => {
			const idx = callCount++;
			seenMessagesByCall.push(llmContext.messages);
			seenOptionsByCall.push({ ...(options as Record<string, unknown>) });
			if (idx === 0) return makeDoomStream(phrase, 280);
			return makeCleanStream(cleanText);
		}) as unknown as Agent["streamFn"];

		await agent.prompt("Run the channel tests.");

		// 1. The retry happened exactly once.
		expect(callCount).toBe(2);

		// 2. The retry's messages argument does NOT contain the doom
		// thinking. The user prompt is the only thing the model saw on
		// the second call.
		const retryMessages = seenMessagesByCall[1] ?? [];
		let retryThinking = "";
		for (const m of retryMessages) {
			const content = (m as { content?: unknown }).content;
			if (!Array.isArray(content)) continue;
			for (const c of content) {
				if (c && typeof c === "object" && (c as { type?: string }).type === "thinking") {
					retryThinking += (c as { thinking: string }).thinking;
				}
			}
		}
		expect(retryThinking).not.toContain("All 78 channel tests pass. Run biome + related.");

		// 3. The retry's stream options stripped `reasoning` — the
		// recovery took the no-thinking path.
		const retryOpts = seenOptionsByCall[1] ?? {};
		expect(retryOpts.reasoning).toBeUndefined();

		// 4. The agent's final assistant message in state.messages is the
		// clean one — what the user actually sees.
		const stateMessages = agent.state.messages;
		const assistants = stateMessages.filter(m => m.role === "assistant");
		expect(assistants.length).toBe(1);
		const finalAssistant = assistants[0] as AssistantMessage;
		expect(finalAssistant.stopReason).toBe("stop");
		expect(finalAssistant.errorMessage ?? "").not.toMatch(/Doom loop/);
		const textBlock = finalAssistant.content.find(c => c.type === "text");
		expect(textBlock).toBeDefined();
		if (textBlock && textBlock.type === "text") {
			expect(textBlock.text).toBe(cleanText);
		}

		// 5. The doom message is preserved in the event stream as a
		// separate message_end — the session JSONL gets both, so
		// postmortem can still see what happened.
		const assistantEnds = findAssistantMessageEnds(events);
		expect(assistantEnds.length).toBe(2);
		const [doomMsg, cleanMsg] = assistantEnds as [AssistantMessage, AssistantMessage];
		expect(doomMsg.stopReason).toBe("length");
		expect(doomMsg.errorMessage ?? "").toMatch(/Doom loop detected/);
		expect(cleanMsg.stopReason).toBe("stop");
		expect(cleanMsg.errorMessage ?? "").not.toMatch(/Doom loop/);

		// 6. agent_end fired so the JSONL writer flushes everything.
		expect(events.map(e => e.type)).toContain("agent_end");
	});

	it("gives up and surfaces the doom message when all retries also doom", async () => {
		const phrase = "All 78 channel tests pass. Run biome + related. ";
		agent.streamFn = ((_model: Model, _ctx: Context, _opts: Parameters<NonNullable<Agent["streamFn"]>>[2]) => {
			callCount++;
			return makeDoomStream(phrase, 280);
		}) as unknown as Agent["streamFn"];

		await agent.prompt("Run the channel tests.");

		// 1 retry attempted (total 2 streamFunction calls); both doom.
		expect(callCount).toBe(2);

		// Final message is the doom message — the retry did not save us.
		const stateMessages = agent.state.messages;
		const assistants = stateMessages.filter(m => m.role === "assistant");
		expect(assistants.length).toBe(1);
		const finalAssistant = assistants[0] as AssistantMessage;
		expect(finalAssistant.stopReason).toBe("length");
		expect(finalAssistant.errorMessage ?? "").toMatch(/Doom loop detected/);

		// Both message_end events fired; session log has the full history.
		const assistantEnds = findAssistantMessageEnds(events);
		expect(assistantEnds.length).toBe(2);
	});

	it("does not retry when the first attempt is clean", async () => {
		const cleanText = "The capital of France is Paris.";
		agent.streamFn = ((_model: Model, _ctx: Context, _opts: Parameters<NonNullable<Agent["streamFn"]>>[2]) => {
			callCount++;
			return makeCleanStream(cleanText);
		}) as unknown as Agent["streamFn"];

		await agent.prompt("What is the capital of France?");

		// No retry: only one streamFunction call.
		expect(callCount).toBe(1);
		// retryStreamOptions was never invoked.
		expect(seenOptionsByCall.find(o => "attempt" in o)).toBeUndefined();

		const stateMessages = agent.state.messages;
		const assistants = stateMessages.filter(m => m.role === "assistant");
		expect(assistants.length).toBe(1);
		const finalAssistant = assistants[0] as AssistantMessage;
		expect(finalAssistant.stopReason).toBe("stop");

		// Only one message_end was emitted.
		const assistantEnds = findAssistantMessageEnds(events);
		expect(assistantEnds.length).toBe(1);
	});

	it("maxRetries=0 preserves the legacy terminate-on-doom behavior", async () => {
		// Build a fresh agent with maxRetries=0 to verify the
		// "detection only, no recovery" knob still works.
		agent.abort();
		agent = new Agent({
			initialState: {
				model: makeModel(),
				systemPrompt: "You are helpful.",
				messages: [],
				tools: [],
			},
			doomLoop: {
				enabled: true,
				thinking: { minChars: 5000, uniqueRatioThreshold: 0.15, minPhraseRepeat: 200, minPhraseLength: 20 },
				text: { minChars: 500, ngramSize: 60, minNgramRepeat: 4 },
				maxThinkingChars: 16384,
				maxRetries: 0,
			},
		});
		agent.subscribe(e => {
			events.push(e as { type: string; message?: unknown });
		});

		const phrase = "All 78 channel tests pass. Run biome + related. ";
		let localCallCount = 0;
		agent.streamFn = ((_model: Model, _ctx: Context, _opts: Parameters<NonNullable<Agent["streamFn"]>>[2]) => {
			localCallCount++;
			return makeDoomStream(phrase, 280);
		}) as unknown as Agent["streamFn"];

		await agent.prompt("Run the channel tests.");

		// No retry: only one streamFunction call.
		expect(localCallCount).toBe(1);

		const stateMessages = agent.state.messages;
		const finalAssistant = stateMessages.find(m => m.role === "assistant") as AssistantMessage;
		expect(finalAssistant.stopReason).toBe("length");
		expect(finalAssistant.errorMessage ?? "").toMatch(/Doom loop detected/);

		// Only one message_end event — old behavior.
		const assistantEnds = findAssistantMessageEnds(events);
		expect(assistantEnds.length).toBe(1);
	});
});
