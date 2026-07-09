/**
 * End-to-end settings round-trip test for the doom-loop detector group.
 *
 * `Settings.isolated()` is the unit-test seam that production code uses to
 * construct an in-memory `Settings` instance. The settings schema for
 * `streaming.doomLoop.*` lives in
 * `packages/coding-agent/src/config/settings-schema.ts`; this test confirms
 * the schema round-trips through `Settings.isolated()` and the
 * `getGroup("streaming")` accessor, so the wiring
 *
 *     user config.yml -> SETTINGS_SCHEMA -> Settings -> resolveDoomLoopConfig -> Agent.doomLoop
 *
 * is whole, not stitched together at the seam only.
 */

import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

/**
 * `Settings.getGroup(prefix)` strips the prefix and returns the remaining
 * suffix verbatim — flat keys, not nested. So `g["doomLoop.enabled"]` is
 * the right accessor, not `g.doomLoop.enabled`. (See
 * `Settings.getGroup` in `config/settings.ts`.)
 */
type StreamingGroup = {
	"doomLoop.enabled": boolean;
	"doomLoop.thinking.minChars": number;
	"doomLoop.thinking.uniqueRatio": number;
	"doomLoop.thinking.minPhraseRepeat": number;
	"doomLoop.thinking.minPhraseLength": number;
	"doomLoop.text.minChars": number;
	"doomLoop.text.ngramSize": number;
	"doomLoop.text.minNgramRepeat": number;
	"doomLoop.maxThinkingChars": number;
	"doomLoop.maxThinkingCharsByModel": Record<string, number>;
};

function asStreaming(g: Record<string, unknown>): StreamingGroup {
	return g as unknown as StreamingGroup;
}

describe("streaming.doomLoop settings end-to-end", () => {
	it("default settings have the expected doom-loop defaults", () => {
		const s = Settings.isolated();
		const g = asStreaming(s.getGroup("streaming"));
		expect(g["doomLoop.enabled"]).toBe(true);
		expect(g["doomLoop.thinking.minChars"]).toBe(5000);
		expect(g["doomLoop.thinking.uniqueRatio"]).toBe(0.15);
		expect(g["doomLoop.thinking.minPhraseRepeat"]).toBe(200);
		expect(g["doomLoop.thinking.minPhraseLength"]).toBe(20);
		expect(g["doomLoop.text.minChars"]).toBe(500);
		expect(g["doomLoop.text.ngramSize"]).toBe(60);
		expect(g["doomLoop.text.minNgramRepeat"]).toBe(4);
		expect(g["doomLoop.maxThinkingChars"]).toBe(16384);
		expect(g["doomLoop.maxThinkingCharsByModel"]).toEqual({});
	});

	it("per-model maxThinkingCharsByModel round-trips", () => {
		const s = Settings.isolated({
			"streaming.doomLoop.maxThinkingCharsByModel": { "minimax-m3": 6144 },
		});
		const g = asStreaming(s.getGroup("streaming"));
		expect(g["doomLoop.maxThinkingCharsByModel"]).toEqual({ "minimax-m3": 6144 });
	});

	it("all doom-loop thresholds round-trip when overridden", () => {
		const s = Settings.isolated({
			"streaming.doomLoop.enabled": false,
			"streaming.doomLoop.thinking.minChars": 8000,
			"streaming.doomLoop.thinking.uniqueRatio": 0.1,
			"streaming.doomLoop.thinking.minPhraseRepeat": 300,
			"streaming.doomLoop.thinking.minPhraseLength": 30,
			"streaming.doomLoop.text.minChars": 1000,
			"streaming.doomLoop.text.ngramSize": 80,
			"streaming.doomLoop.text.minNgramRepeat": 5,
			"streaming.doomLoop.maxThinkingChars": 8192,
		});
		const g = asStreaming(s.getGroup("streaming"));
		expect(g["doomLoop.enabled"]).toBe(false);
		expect(g["doomLoop.thinking.minChars"]).toBe(8000);
		expect(g["doomLoop.thinking.uniqueRatio"]).toBe(0.1);
		expect(g["doomLoop.thinking.minPhraseRepeat"]).toBe(300);
		expect(g["doomLoop.thinking.minPhraseLength"]).toBe(30);
		expect(g["doomLoop.text.minChars"]).toBe(1000);
		expect(g["doomLoop.text.ngramSize"]).toBe(80);
		expect(g["doomLoop.text.minNgramRepeat"]).toBe(5);
		expect(g["doomLoop.maxThinkingChars"]).toBe(8192);
	});

	it("multi-model maxThinkingCharsByModel round-trips", () => {
		const s = Settings.isolated({
			"streaming.doomLoop.maxThinkingCharsByModel": {
				"minimax-m3": 6144,
				deepseek: 24576,
			},
		});
		const g = asStreaming(s.getGroup("streaming"));
		expect(g["doomLoop.maxThinkingCharsByModel"]).toEqual({
			"minimax-m3": 6144,
			deepseek: 24576,
		});
	});

	it("set() at runtime mutates the doom-loop config (the UI toggle path)", () => {
		// Settings has a `set()` method that triggers persistence hooks. The
		// settings panel for the doom-loop group uses this path when the
		// user toggles a value at runtime, so the round-trip must work
		// there too, not just at construction.
		const s = Settings.isolated();
		s.set("streaming.doomLoop.enabled", false);
		s.set("streaming.doomLoop.maxThinkingChars", 0);
		const g = asStreaming(s.getGroup("streaming"));
		expect(g["doomLoop.enabled"]).toBe(false);
		expect(g["doomLoop.maxThinkingChars"]).toBe(0);
	});
});
