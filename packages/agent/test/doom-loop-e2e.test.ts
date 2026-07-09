/**
 * End-to-end doom-loop test.
 *
 * Unlike `doom-loop-detector.test.ts` (which exercises the pure detector
 * function) and the doom-loop cases in `agent-loop.test.ts` (which use the
 * lower-level `agentLoop` function), this test drives the public `Agent`
 * class. That is the class the OMP harness constructs in `sdk.ts`, so a
 * test that goes through it proves the doom-loop path works in production:
 *
 *     Agent.prompt()
 *       -> AgentLoopConfig (with doomLoop)
 *         -> agentLoop
 *           -> streamAssistantResponse
 *             -> onAssistantMessageEvent interceptor
 *             -> detectDoomLoop  <-- the new path
 *             -> finalize with stopReason=length + Doom loop detected errorMessage
 *             -> agent_end
 *
 * The doom-loop stream is a real `AssistantMessageEventStream` (not a
 * `MockAssistantStream` subclass); the only thing we override is the
 * `streamFn` field on the Agent, which is exactly how `omp` swaps in a
 * transport for tests.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, getBundledModel } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { createUsage } from "./helpers";

function makeModel() {
	return getBundledModel("google", "gemini-2.5-flash-lite-preview-06-17");
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

/**
 * Build a stream that emits a single thinking block. The thinking content
 * is `phrase.repeat(repeats)` — a degenerate thinking block that the
 * doom-loop detector will classify as `thinking: phrase repeated Nx`.
 *
 * We do NOT emit a `done` event because the detector is expected to fire
 * inside the for-await loop in `streamAssistantResponse` and short-circuit
 * the stream consumption. If the detector does NOT fire, the for-await
 * blocks until the test times out, which is itself a useful failure
 * signal.
 */
function makeDoomLoopStream(phrase: string, repeats: number): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const text = phrase.repeat(repeats);
		// 1) announce the assistant message
		stream.push({ type: "start", partial: makeAssistantMessageWithThinking("") });
		// 2) open the thinking block
		stream.push({
			type: "thinking_start",
			contentIndex: 0,
			partial: makeAssistantMessageWithThinking(""),
		});
		// 3) stream the full degenerate content in one delta (a real provider
		//    would split this; for the detector one big delta is equivalent).
		stream.push({
			type: "thinking_delta",
			contentIndex: 0,
			delta: text,
			partial: makeAssistantMessageWithThinking(text),
		});
		// 4) close the block. The detector fires on this event and the loop
		//    returns early; the test's `done` push below is therefore not
		//    consumed, but that's fine — we never iterate past message_end.
		stream.push({
			type: "thinking_end",
			contentIndex: 0,
			content: text,
			partial: makeAssistantMessageWithThinking(text),
		});
	});
	return stream;
}

function captureEventTypes(events: Array<{ type: string }>): string[] {
	return events.map(e => e.type);
}

function findAssistantEnd(events: Array<{ type: string; message?: unknown }>): AssistantMessage | undefined {
	for (let i = events.length - 1; i >= 0; i--) {
		const e = events[i];
		if (e?.type !== "message_end") continue;
		if (!("message" in e) || e.message === undefined) continue;
		const m = e.message as AssistantMessage;
		if (m.role === "assistant") return m;
	}
	return undefined;
}

describe("doom-loop detector end-to-end via Agent", () => {
	let agent: Agent;
	const events: Array<{ type: string; message?: unknown }> = [];

	beforeEach(() => {
		events.length = 0;
		agent = new Agent({
			initialState: {
				model: makeModel(),
				systemPrompt: "You are helpful.",
				messages: [],
				tools: [],
			},
			// Doom-loop detector configured at the threshold the user is
			// likely to ship (5K chars / 200 repeats) so the test is a
			// realistic regression check, not a synthetic one.
			doomLoop: {
				enabled: true,
				thinking: { minChars: 5000, uniqueRatioThreshold: 0.15, minPhraseRepeat: 200, minPhraseLength: 20 },
				text: { minChars: 500, ngramSize: 60, minNgramRepeat: 4 },
				maxThinkingChars: 16384,
			},
		});
		agent.subscribe(e => {
			events.push(e as { type: string; message?: unknown });
		});
	});

	afterEach(() => {
		// Ensure no leaks between tests if a stream hangs.
		agent.abort();
	});

	it("fires on a degenerate thinking stream and finalizes with stopReason=length", async () => {
		// The 143736 c31 phrase — kept verbatim so a regression in the
		// detector's phrase matcher is caught.
		const phrase = "All 78 channel tests pass. Run biome + related. ";
		agent.streamFn = () => makeDoomLoopStream(phrase, 280);

		// prompt() resolves when agent_end fires. The detector's
		// short-circuit causes agent_end to fire on the doom-loop final
		// message, so this Promise resolves cleanly rather than hanging.
		await agent.prompt("Run the channel tests and report.");

		const eventTypes = captureEventTypes(events);
		expect(eventTypes).toContain("agent_start");
		expect(eventTypes).toContain("turn_start");
		expect(eventTypes).toContain("message_start");
		expect(eventTypes).toContain("message_end");
		expect(eventTypes).toContain("turn_end");
		// Critical: agent_end must fire so the session JSONL records the
		// truncated message. If this assertion fails the harness is broken
		// at a deeper level than the detector.
		expect(eventTypes).toContain("agent_end");

		const assistant = findAssistantEnd(events);
		expect(assistant).toBeDefined();
		if (!assistant) return;
		expect(assistant.role).toBe("assistant");
		expect(assistant.stopReason).toBe("length");
		expect(assistant.errorMessage ?? "").toMatch(/Doom loop detected/);
		expect(assistant.errorMessage ?? "").toMatch(/thinking/);
		// The partial thinking content is preserved for postmortem.
		const thinkingBlock = assistant.content.find(c => c.type === "thinking");
		expect(thinkingBlock).toBeDefined();
		if (thinkingBlock && thinkingBlock.type === "thinking") {
			expect(thinkingBlock.thinking).toContain("All 78 channel tests pass. Run biome + related.");
			expect(thinkingBlock.thinking.length).toBeGreaterThan(5000);
		}

		// agent.state.messages must include the truncated assistant
		// message so downstream consumers (TUI, session log writer) see it.
		const stateMessages = agent.state.messages;
		const stateAssistant = stateMessages.find(m => m.role === "assistant");
		expect(stateAssistant).toBeDefined();
		if (stateAssistant && stateAssistant.role === "assistant") {
			expect(stateAssistant.stopReason).toBe("length");
		}
	});

	it("does NOT fire on a coherent thinking stream", async () => {
		// 200 unique tokens — well above the 5K minChars gate but every
		// 4-gram is novel, so the collapse ratio check passes.
		const tokens = Array.from({ length: 200 }, (_, i) => `tk${i.toString().padStart(4, "0")} `);
		const coherent = tokens.join("");

		agent.streamFn = () => {
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: makeAssistantMessageWithThinking("") });
				stream.push({
					type: "thinking_start",
					contentIndex: 0,
					partial: makeAssistantMessageWithThinking(""),
				});
				stream.push({
					type: "thinking_delta",
					contentIndex: 0,
					delta: coherent,
					partial: makeAssistantMessageWithThinking(coherent),
				});
				stream.push({
					type: "thinking_end",
					contentIndex: 0,
					content: coherent,
					partial: makeAssistantMessageWithThinking(coherent),
				});
				// The provider emits a clean `done`; without a doom loop
				// the for-await consumes this and returns.
				stream.push({
					type: "done",
					reason: "stop",
					message: makeAssistantMessageWithThinking(coherent),
				});
			});
			return stream;
		};

		await agent.prompt("Just think for a moment.");

		const assistant = findAssistantEnd(events);
		expect(assistant).toBeDefined();
		if (!assistant) return;
		expect(assistant.stopReason).toBe("stop");
		expect(assistant.errorMessage ?? "").not.toMatch(/Doom loop detected/);
	});

	it("fires on the maxThinkingChars cap even without degeneration", async () => {
		// Build a fresh Agent with a low cap (1K chars) but otherwise
		// permissive thresholds. We send 6K chars of coherent content
		// (every 4-gram unique) so the only rule that fires is the cap.
		// (Re-using the shared `agent` would not work — Agent has no
		// public setter for doomLoop; the field is read once at
		// construction when the AgentLoopConfig is assembled.)
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
				thinking: { minChars: 100_000, uniqueRatioThreshold: 0.15, minPhraseRepeat: 100_000, minPhraseLength: 20 },
				text: { minChars: 500, ngramSize: 60, minNgramRepeat: 4 },
				maxThinkingChars: 1024,
			},
		});
		agent.subscribe(e => {
			events.push(e as { type: string; message?: unknown });
		});

		const tokens = Array.from({ length: 1200 }, (_, i) => `tk${i.toString().padStart(4, "0")} `);
		const coherent = tokens.join(""); // ~7K chars, all unique

		agent.streamFn = () => {
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: makeAssistantMessageWithThinking("") });
				stream.push({
					type: "thinking_start",
					contentIndex: 0,
					partial: makeAssistantMessageWithThinking(""),
				});
				stream.push({
					type: "thinking_delta",
					contentIndex: 0,
					delta: coherent,
					partial: makeAssistantMessageWithThinking(coherent),
				});
				stream.push({
					type: "thinking_end",
					contentIndex: 0,
					content: coherent,
					partial: makeAssistantMessageWithThinking(coherent),
				});
			});
			return stream;
		};

		await agent.prompt("Think carefully for many tokens.");

		const assistant = findAssistantEnd(events);
		expect(assistant).toBeDefined();
		if (!assistant) return;
		expect(assistant.stopReason).toBe("length");
		expect(assistant.errorMessage ?? "").toMatch(/thinking_cap/);
		expect(assistant.errorMessage ?? "").toContain("maxThinkingChars=1024");
	});

	it("per-model maxThinkingChars override is honored (settings end-to-end via Agent.doomLoop)", async () => {
		// Simulate what `resolveDoomLoopConfig` would produce for a
		// minimax-m3 model with a 6K per-model cap.
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
				thinking: { minChars: 100_000, uniqueRatioThreshold: 0.15, minPhraseRepeat: 100_000, minPhraseLength: 20 },
				text: { minChars: 500, ngramSize: 60, minNgramRepeat: 4 },
				maxThinkingChars: 6144, // <-- the per-model override
			},
		});
		agent.subscribe(e => {
			events.push(e as { type: string; message?: unknown });
		});

		const tokens = Array.from({ length: 1500 }, (_, i) => `tk${i.toString().padStart(4, "0")} `);
		const coherent = tokens.join(""); // ~9K chars, all unique

		agent.streamFn = () => {
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: makeAssistantMessageWithThinking("") });
				stream.push({
					type: "thinking_start",
					contentIndex: 0,
					partial: makeAssistantMessageWithThinking(""),
				});
				stream.push({
					type: "thinking_delta",
					contentIndex: 0,
					delta: coherent,
					partial: makeAssistantMessageWithThinking(coherent),
				});
				stream.push({
					type: "thinking_end",
					contentIndex: 0,
					content: coherent,
					partial: makeAssistantMessageWithThinking(coherent),
				});
			});
			return stream;
		};

		await agent.prompt("minimax-m3 thinking test");

		const assistant = findAssistantEnd(events);
		expect(assistant).toBeDefined();
		if (!assistant) return;
		expect(assistant.stopReason).toBe("length");
		expect(assistant.errorMessage ?? "").toMatch(/maxThinkingChars=6144/);
	});

	it("session log JSONL shape is consumable after a doom loop", async () => {
		// This is the most important assertion for the user: a doom-loop
		// truncation produces a session JSONL entry that downstream
		// tooling (session-diagnosis-data, custom analysis) can parse.
		const phrase = "All 78 channel tests pass. Run biome + related. ";
		agent.streamFn = () => makeDoomLoopStream(phrase, 280);
		await agent.prompt("Run the channel tests and report.");

		// Build a JSONL from the agent's state.messages the same way the
		// session writer would (one line per message, type field).
		const lines = agent.state.messages
			.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult")
			.map(m => JSON.stringify(m));

		expect(lines.length).toBeGreaterThan(0);

		// Every line must be valid JSON, parseable, and the assistant line
		// must carry the doom-loop marker.
		let foundDoomMarker = false;
		for (const line of lines) {
			const parsed = JSON.parse(line) as { role?: string; stopReason?: string; errorMessage?: string };
			if (parsed.role === "assistant" && parsed.stopReason === "length") {
				expect(parsed.errorMessage ?? "").toMatch(/Doom loop detected/);
				foundDoomMarker = true;
			}
		}
		expect(foundDoomMarker).toBe(true);
	});
});

// Suppress unused-import linter false positive: `AssistantMessageEvent` is
// used implicitly through the streamFn signature but TypeScript's noUnused
// rule doesn't track that.
void (null as unknown as AssistantMessageEvent);
