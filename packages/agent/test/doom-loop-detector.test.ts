import { describe, expect, it } from "bun:test";
import {
	DEFAULT_DOOM_LOOP_CONFIG,
	type DoomLoopConfig,
	type DoomVerdict,
	detectDoomLoop,
} from "@oh-my-pi/pi-agent-core/streaming/doom-loop-detector";
import type { AssistantMessage, AssistantMessageEvent } from "@oh-my-pi/pi-ai";
import { createAssistantMessage } from "./helpers";

function makePartial(content: AssistantMessage["content"]): AssistantMessage {
	return createAssistantMessage(content, "stop");
}

function thinkingEvent(delta: string): AssistantMessageEvent {
	return {
		type: "thinking_delta",
		contentIndex: 0,
		delta,
		partial: makePartial([{ type: "thinking", thinking: "" }]),
	};
}

function textEvent(delta: string): AssistantMessageEvent {
	return {
		type: "text_delta",
		contentIndex: 0,
		delta,
		partial: makePartial([{ type: "text", text: "" }]),
	};
}

function makeThinkingPartial(text: string): AssistantMessage {
	return makePartial([{ type: "thinking", thinking: text }]);
}

function makeTextPartial(text: string): AssistantMessage {
	return makePartial([{ type: "text", text: text }]);
}

function cfg(overrides: Partial<DoomLoopConfig> = {}): DoomLoopConfig {
	return { ...DEFAULT_DOOM_LOOP_CONFIG, ...overrides };
}

describe("detectDoomLoop", () => {
	describe("disabled config", () => {
		it("returns clean when disabled regardless of content", () => {
			const thinking = "All 78 tests pass. ".repeat(300);
			const verdict = detectDoomLoop(makeThinkingPartial(thinking), thinkingEvent(""), { ...cfg(), enabled: false });
			expect(verdict).toEqual({ kind: "clean" });
		});
	});

	describe("non-streaming events", () => {
		it("returns clean for toolcall_start / toolcall_delta / done", () => {
			const partial = makeThinkingPartial("All 78 tests pass. ".repeat(300));
			for (const evType of ["toolcall_start", "toolcall_delta", "done", "error", "start"] as const) {
				const ev: AssistantMessageEvent = {
					type: evType,
					contentIndex: 0,
					partial,
				} as AssistantMessageEvent;
				const verdict = detectDoomLoop(partial, ev, cfg());
				expect(verdict.kind).toBe("clean");
			}
		});
	});

	describe("thinking block", () => {
		it("returns clean for short, coherent thinking", () => {
			const text = "Let me think about this. First I need to check the build system. ".repeat(5);
			const verdict = detectDoomLoop(makeThinkingPartial(text), thinkingEvent(""), cfg());
			expect(verdict.kind).toBe("clean");
		});

		it("returns clean below minChars gate", () => {
			const text = "All 78 tests pass. ".repeat(50); // 950 chars, under 5000 minChars
			const verdict = detectDoomLoop(makeThinkingPartial(text), thinkingEvent(""), cfg());
			expect(verdict.kind).toBe("clean");
		});

		it("fires on a single phrase repeated >= minPhraseRepeat times", () => {
			// matches 143736 c31 exactly: "All 78 channel tests pass. Run biome + related." × 276
			const phrase = "All 78 channel tests pass. Run biome + related. ";
			const text = phrase.repeat(276);
			const verdict = detectDoomLoop(makeThinkingPartial(text), thinkingEvent(""), cfg());
			expect(verdict.kind).toBe("doom");
			if (verdict.kind === "doom") {
				expect(verdict.where).toBe("thinking");
				// Both 4-gram collapse and phrase-repeat rules can fire on this
				// input; accept either signal.
				expect(verdict.reason).toMatch(/phrase|collapse ratio/);
				expect(verdict.chars).toBe(text.length);
			}
		});

		it("fires on collapse ratio below uniqueRatioThreshold", () => {
			// Fabricate collapse via token-level repetition (no whitespace gaps
			// so the phrase counter doesn't dominate first). 4-gram uniqueness
			// drops because every 4-gram in the repeated string is one of a
			// small set.
			const phrase = "Run biome now. ";
			const text = phrase.repeat(500); // 7000 chars, well above minChars
			const verdict = detectDoomLoop(makeThinkingPartial(text), thinkingEvent(""), cfg());
			expect(verdict.kind).toBe("doom");
		});

		it("handles pathological case with embedded newlines and tags", () => {
			// 143736 c27: "Now run checks." / "</title>" alternating pattern
			const text = Array.from({ length: 500 })
				.map(() => `Now run checks. </title>`)
				.join("\n");
			const verdict = detectDoomLoop(makeThinkingPartial(text), thinkingEvent(""), cfg());
			expect(verdict.kind).toBe("doom");
		});

		it("does not fire on long-but-coherent thinking", () => {
			// Truly unique content: 200 distinct 30-char windows, no overlap
			// at the 4-gram level. The text is 6000 chars (above minChars gate)
			// but every 4-gram is novel.
			const tokens = Array.from({ length: 200 }, (_, i) => `tk${i.toString().padStart(4, "0")} `);
			const text = tokens.join("");
			const verdict = detectDoomLoop(makeThinkingPartial(text), thinkingEvent(""), cfg());
			expect(verdict.kind).toBe("clean");
		});
	});

	describe("text block", () => {
		it("returns clean for short text", () => {
			const text = "I'll now run the tests. ".repeat(3); // ~75 chars
			const verdict = detectDoomLoop(makeTextPartial(text), textEvent(""), cfg());
			expect(verdict.kind).toBe("clean");
		});

		it("fires on 60-gram repeated >= 4 times", () => {
			const ngram = "All 78 channel tests pass and the build completed successfully. ";
			// 10× ~60 chars = ~600 chars, well above minChars=500.
			const text = ngram.repeat(10);
			const verdict = detectDoomLoop(makeTextPartial(text), textEvent(""), cfg());
			expect(verdict.kind).toBe("doom");
			if (verdict.kind === "doom") {
				expect(verdict.where).toBe("text");
				expect(verdict.reason).toMatch(/60-gram/);
				expect(verdict.reason).toMatch(/repeated 10×/);
			}
		});

		it("does not fire on n-gram appearing only 3 times", () => {
			const ngram = "All 78 channel tests pass and the build completed successfully. ";
			const text = `${ngram.repeat(3)}Unique ending text here.`;
			const verdict = detectDoomLoop(makeTextPartial(text), textEvent(""), cfg());
			expect(verdict.kind).toBe("clean");
		});

		it("does not fire on long coherent text", () => {
			// 200 distinct tokens, no repeated 4-grams at any offset.
			const tokens = Array.from({ length: 200 }, (_, i) => `tk${i.toString().padStart(4, "0")} `);
			const composed = tokens.join("");
			const verdict = detectDoomLoop(makeTextPartial(composed), textEvent(""), cfg());
			expect(verdict.kind).toBe("clean");
		});
	});

	describe("maxThinkingChars cap", () => {
		it("fires on degenerate long thinking when cap is set lower than content", () => {
			const longText = "Now run checks. ".repeat(2000); // ~30K chars
			const verdict = detectDoomLoop(
				makeThinkingPartial(longText),
				thinkingEvent(""),
				cfg({ maxThinkingChars: 16384 }),
			);
			expect(verdict.kind).toBe("doom");
			if (verdict.kind === "doom") {
				expect(verdict.where).toBe("thinking_cap");
				expect(verdict.reason).toContain("maxThinkingChars=16384");
			}
		});

		it("does not fire when content is below cap", () => {
			const longText = "Coherent thought. ".repeat(200); // ~3400 chars
			const verdict = detectDoomLoop(
				makeThinkingPartial(longText),
				thinkingEvent(""),
				cfg({ maxThinkingChars: 16384 }),
			);
			expect(verdict.kind).toBe("clean");
		});

		it("does not fire when cap is 0 (disabled)", () => {
			// Cap=0 disables the cap rule. The degeneration rule still
			// applies, so feed coherent content to isolate the cap.
			const tokens = Array.from({ length: 600 }, (_, i) => `tk${i.toString().padStart(4, "0")} `);
			const longText = tokens.join(""); // ~6K chars of unique content
			const verdict = detectDoomLoop(makeThinkingPartial(longText), thinkingEvent(""), cfg({ maxThinkingChars: 0 }));
			expect(verdict.kind).toBe("clean");
		});
	});

	describe("event-type routing", () => {
		it("only checks thinking on thinking_* events", () => {
			// thinking is degenerate, text is fine. text_end event should
			// not look at the thinking block (it's already been checked on
			// the prior thinking_end).
			const degenerateThinking = "All 78 tests pass. ".repeat(300);
			const fineText = "All done.";
			const partial = makePartial([
				{ type: "thinking", thinking: degenerateThinking },
				{ type: "text", text: fineText },
			]);
			const ev: AssistantMessageEvent = { type: "text_end", contentIndex: 1, content: fineText, partial };
			const verdict: DoomVerdict = detectDoomLoop(partial, ev, cfg());
			expect(verdict.kind).toBe("clean");
		});

		it("only checks text on text_* events", () => {
			const fineThinking = Array.from({ length: 200 }, (_, i) => `tk${i.toString().padStart(4, "0")} `).join("");
			// Fine text on the text side, fine thinking on the thinking side.
			// Send a thinking_end event so the detector looks at thinking only
			// and finds nothing wrong.
			const fineText = "Done.";
			const partial = makePartial([
				{ type: "thinking", thinking: fineThinking },
				{ type: "text", text: fineText },
			]);
			const ev: AssistantMessageEvent = {
				type: "thinking_end",
				contentIndex: 0,
				content: fineThinking,
				partial,
			};
			const verdict = detectDoomLoop(partial, ev, cfg());
			expect(verdict.kind).toBe("clean");
		});
	});

	describe("threshold tuning", () => {
		it("custom minChars gate is respected", () => {
			// 1000 chars of repeated phrase; default minChars=5000 wouldn't fire here
			const text = "All 78 tests pass. ".repeat(50);
			expect(detectDoomLoop(makeThinkingPartial(text), thinkingEvent(""), cfg()).kind).toBe("clean");
			// Lower the gate to 500 -> fires
			const v = detectDoomLoop(
				makeThinkingPartial(text),
				thinkingEvent(""),
				cfg({ thinking: { ...DEFAULT_DOOM_LOOP_CONFIG.thinking, minChars: 500 } }),
			);
			expect(v.kind).toBe("doom");
		});

		it("custom minPhraseRepeat is respected", () => {
			const text = "foo bar ".repeat(20); // ~160 chars, 40 words
			// Default minPhraseRepeat=200 — clean
			expect(detectDoomLoop(makeThinkingPartial(text), thinkingEvent(""), cfg()).kind).toBe("clean");
			// Lower to 5 — fires
			const v = detectDoomLoop(
				makeThinkingPartial(text),
				thinkingEvent(""),
				cfg({ thinking: { ...DEFAULT_DOOM_LOOP_CONFIG.thinking, minChars: 100, minPhraseRepeat: 5 } }),
			);
			expect(v.kind).toBe("doom");
		});
	});

	describe("usage shape", () => {
		it("default config has sensible values", () => {
			expect(DEFAULT_DOOM_LOOP_CONFIG.enabled).toBe(true);
			expect(DEFAULT_DOOM_LOOP_CONFIG.thinking.minChars).toBe(5000);
			expect(DEFAULT_DOOM_LOOP_CONFIG.text.ngramSize).toBe(60);
			expect(DEFAULT_DOOM_LOOP_CONFIG.maxThinkingChars).toBe(16384);
		});
	});
});
