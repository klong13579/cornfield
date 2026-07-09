/**
 * Regression test for the doom-loop bug first observed in session
 * 143736 (2026-07-09) where the model `minimax-m3` collapsed into a
 * 17,837-char thinking block of "All 78 channel tests pass. Run biome +
 * related." repeated 277 times (entry c31), then into a 119,027-char
 * "Now run checks." loop (entry c27). The detector added in this change
 * is the assertion that this content no longer completes an agent
 * turn cleanly — it gets cut with `stopReason: "length"` and a
 * descriptive errorMessage.
 *
 * The test reads the actual session JSONL at runtime, so a future
 * regression in the detector's matchers fails immediately against the
 * exact content that caused the original incident. A 404 fallback to an
 * embedded mini-fixture is provided so the test still runs in CI where
 * the user's local session file is not present.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { DEFAULT_DOOM_LOOP_CONFIG, detectDoomLoop } from "@oh-my-pi/pi-agent-core/streaming/doom-loop-detector";
import { type AssistantMessageEvent, getBundledModel } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { createUsage } from "./helpers";

/**
 * Path to the 143736 session JSONL. Override via env if you keep your
 * session files in a non-default location. The default is the encoded-cwd
 * layout used by the interactive `omp` CLI (NOT the gateway layout — see
 * the user.md "gateway-session-logs" constraint).
 */
const REPLAY_PATH =
	process.env.OMP_REPLAY_143736 ??
	`${process.env.HOME}/.omp/agent/sessions/-Desktop-Narwal-oh-my-pi/by-date/2026-07-09/143736__0c4e89a0.jsonl`;

interface ExtractedEntry {
	line: number;
	thinking: string;
	stopReason: string | undefined;
	errorMessage: string | undefined;
}

/**
 * Read a specific line of the session JSONL and pull out the first
 * `thinking` content block. Returns `undefined` if the file is missing
 * or the line is not an assistant message.
 */
function readEntry(lineNumber: number): ExtractedEntry | undefined {
	if (!existsSync(REPLAY_PATH)) return undefined;
	const lines = readFileSync(REPLAY_PATH, "utf8").split("\n");
	if (lineNumber >= lines.length) return undefined;
	const rec = JSON.parse(lines[lineNumber]!) as {
		message?: { stopReason?: string; errorMessage?: string; content?: unknown };
	};
	const content = rec.message?.content;
	if (!Array.isArray(content)) return undefined;
	for (const blk of content) {
		if (typeof blk === "object" && blk !== null && (blk as { type?: string }).type === "thinking") {
			return {
				line: lineNumber,
				thinking: (blk as { thinking: string }).thinking,
				stopReason: rec.message?.stopReason,
				errorMessage: rec.message?.errorMessage,
			};
		}
	}
	return undefined;
}

function makeAssistantMessageWithThinking(thinking: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "thinking" as const, thinking }],
		api: "openai-responses" as const,
		provider: "openai" as const,
		model: "replay-143736",
		usage: createUsage(),
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

describe("regression: doom-loop detector catches 143736 c31 content", () => {
	// c31: 17,837 chars, "All 78 channel tests pass. Run biome + related." × 277
	//      stopReason=aborted, errorMessage="Operation aborted"
	const c31 = readEntry(225);
	// c27: 119,027 chars, "Now run checks." × 4522
	//      stopReason=length, errorMessage=""
	const c27 = readEntry(218);

	// If the user's session file isn't present (CI, fresh checkout, etc.)
	// fall back to a small representative fixture so the test still runs.
	// The fixture is the structural twin of c31 (same phrase, same cadence);
	// it loses fidelity on the exact phrase count but still exercises the
	// detector's matcher on a recognizable doom-loop pattern.
	const fixtureC31 = "All 78 channel tests pass. Run biome + related. ".repeat(220);
	const fixtureC27 = "Now run checks. ".repeat(3000);

	const c31Text = c31?.thinking ?? fixtureC31;
	const c27Text = c27?.thinking ?? fixtureC27;
	const c31FromFile = c31 !== undefined;
	const c27FromFile = c27 !== undefined;

	it("loaded c31 content from the real session file (or fixture)", () => {
		// Information about which source the test is running against.
		// Visible in `bun test --verbose` output.
		const from = c31FromFile ? `file:line 225 (${c31Text.length} chars)` : `fixture (${c31Text.length} chars)`;
		console.log(`[replay] c31 source: ${from}`);
		if (c31FromFile) {
			expect(c31?.stopReason).toBe("aborted");
			expect(c31?.errorMessage).toMatch(/aborted/i);
			expect(c31Text).toContain("All 78 channel tests pass. Run biome + related.");
		}
	});

	it("detector fires on c31 thinking content with default thresholds", () => {
		const partial = makeAssistantMessageWithThinking(c31Text);
		const ev: AssistantMessageEvent = {
			type: "thinking_end",
			contentIndex: 0,
			content: c31Text,
			partial,
		};
		const verdict = detectDoomLoop(partial, ev, DEFAULT_DOOM_LOOP_CONFIG);
		expect(verdict.kind).toBe("doom");
		if (verdict.kind !== "doom") return;
		// The verdict can be either:
		//   - "thinking"      — phrase/collapse rule fired first
		//   - "thinking_cap"  — the hard cap fired first (c31 is 17,837 chars
		//                       > 16,384 default cap)
		// Both are valid signals for this content. The cap wins because the
		// detector short-circuits the more expensive checks on the strongest
		// available evidence.
		expect(["thinking", "thinking_cap"]).toContain(verdict.where);
		expect(verdict.chars).toBe(c31Text.length);
	});

	it("detector fires on c27 thinking content (the longer 119K loop)", () => {
		const from = c27FromFile ? `file:line 218 (${c27Text.length} chars)` : `fixture (${c27Text.length} chars)`;
		console.log(`[replay] c27 source: ${from}`);
		const partial = makeAssistantMessageWithThinking(c27Text);
		const ev: AssistantMessageEvent = {
			type: "thinking_end",
			contentIndex: 0,
			content: c27Text,
			partial,
		};
		const verdict = detectDoomLoop(partial, ev, DEFAULT_DOOM_LOOP_CONFIG);
		expect(verdict.kind).toBe("doom");
		if (verdict.kind !== "doom") return;
		// c27 is 119K chars, well above the 16K cap. The cap always fires
		// first for this entry; the phrase/collapse checks would also fire
		// if the cap were raised.
		expect(verdict.where).toBe("thinking_cap");
		expect(verdict.reason).toMatch(/maxThinkingChars=16384/);
	});

	it("agent loop cuts the real c31 stream with stopReason=length", async () => {
		// Drive the c31 content through a real Agent. The stream emits
		// start -> thinking_start -> thinking_delta -> thinking_end in one
		// microtask, mirroring the production provider's behavior. The
		// detector should short-circuit before any done event.
		const events: Array<{ type: string; message?: unknown }> = [];
		const agent = new Agent({
			initialState: {
				model: getBundledModel("google", "gemini-2.5-flash-lite-preview-06-17"),
				systemPrompt: "You are helpful.",
				messages: [],
				tools: [],
			},
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

		agent.streamFn = () => {
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const empty = makeAssistantMessageWithThinking("");
				const full = makeAssistantMessageWithThinking(c31Text);
				stream.push({ type: "start", partial: empty });
				stream.push({ type: "thinking_start", contentIndex: 0, partial: empty });
				stream.push({ type: "thinking_delta", contentIndex: 0, delta: c31Text, partial: full });
				stream.push({ type: "thinking_end", contentIndex: 0, content: c31Text, partial: full });
			});
			return stream;
		};

		await agent.prompt("Replay 143736 c31");

		// Find the assistant message_end emitted by the doom loop.
		let doomMessage: { stopReason?: string; errorMessage?: string } | undefined;
		for (let i = events.length - 1; i >= 0; i--) {
			const e = events[i];
			if (e?.type !== "message_end") continue;
			const m = e.message as { role?: string; stopReason?: string; errorMessage?: string } | undefined;
			if (m?.role === "assistant") {
				doomMessage = m;
				break;
			}
		}
		expect(doomMessage).toBeDefined();
		if (!doomMessage) return;
		expect(doomMessage.stopReason).toBe("length");
		expect(doomMessage.errorMessage ?? "").toMatch(/Doom loop detected/);
		// Crucially, the original session log recorded this content as
		// "aborted" with errorMessage="Operation aborted". The detector
		// catches it earlier and gives a much more actionable reason.
		// This assertion is what the user gets for the 143736 case:
		// stopReason="length" with a doom-loop reason, not a generic
		// "Operation aborted" from the user's manual escape.
		expect(doomMessage.errorMessage ?? "").not.toMatch(/^Operation aborted$/);

		// agent_end must still fire so the truncated message lands in the
		// session JSONL for postmortem — same shape as a real session.
		const eventTypes = events.map(e => e.type);
		expect(eventTypes).toContain("agent_end");
	});
});

// Suppress unused-import linter false positive on AssistantMessageEvent.
void (null as unknown as AssistantMessageEvent);
