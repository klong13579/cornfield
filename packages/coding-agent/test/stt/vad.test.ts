/**
 * Tests for the pure VAD state machine.
 *
 * These tests do not need any mocks — VAD is a pure function over a state
 * and a stream of RMS samples. We feed it a synthetic audio timeline and
 * assert the auto-stop fires at the right moment.
 */
import { describe, expect, test } from "bun:test";
import {
	DEFAULT_VAD_OPTIONS,
	feedVadStream,
	initialVadStreamState,
	renderLevelBar,
	rmsToLevel,
} from "@oh-my-pi/pi-coding-agent/stt/vad";

describe("feedVadStream", () => {
	test("does not auto-stop if user never speaks within maxWait", () => {
		let state = initialVadStreamState();
		const startedAt = 0;
		const opts = { ...DEFAULT_VAD_OPTIONS, maxWaitMs: 1000 };

		// 500ms of silence
		state = feedVadStream(state, 50, 500, startedAt, opts).state;
		const r = feedVadStream(state, 50, 1100, startedAt, opts);
		expect(r.shouldStop).toBe(true);
	});

	test("does not auto-stop while user is speaking", () => {
		let state = initialVadStreamState();
		const startedAt = 0;
		const opts = DEFAULT_VAD_OPTIONS;

		// 5 seconds of continuous speech above threshold
		for (let t = 100; t <= 5000; t += 100) {
			const r = feedVadStream(state, 5000, t, startedAt, opts);
			state = r.state;
			expect(r.shouldStop).toBe(false);
		}
		expect(state.hasSpoken).toBe(true);
	});

	test("auto-stops after sustained silence following speech", () => {
		let state = initialVadStreamState();
		const startedAt = 0;
		const opts = { ...DEFAULT_VAD_OPTIONS, silenceDurationMs: 1000 };

		// 2 seconds of speech
		for (let t = 100; t <= 2000; t += 100) {
			state = feedVadStream(state, 5000, t, startedAt, opts).state;
		}
		expect(state.hasSpoken).toBe(true);

		// Silence starts at t=2500 (silenceStartMs gets set then)
		const partial = feedVadStream(state, 50, 2500, startedAt, opts);
		expect(partial.shouldStop).toBe(false);
		expect(partial.state.silenceStartMs).toBe(2500);

		// At t=3499, silence is 999ms — not yet
		const stillGoing = feedVadStream(partial.state, 50, 3499, startedAt, opts);
		expect(stillGoing.shouldStop).toBe(false);

		// At t=3500, silence is 1000ms — exactly at threshold, should fire
		const fired = feedVadStream(partial.state, 50, 3500, startedAt, opts);
		expect(fired.shouldStop).toBe(true);
	});

	test("speech during silence timer resets the timer", () => {
		let state = initialVadStreamState();
		const startedAt = 0;
		const opts = { ...DEFAULT_VAD_OPTIONS, silenceDurationMs: 1000 };

		// 2 seconds of speech
		for (let t = 100; t <= 2000; t += 100) {
			state = feedVadStream(state, 5000, t, startedAt, opts).state;
		}

		// Silence begins at t=2500
		const mid = feedVadStream(state, 50, 2500, startedAt, opts);
		expect(mid.state.silenceStartMs).toBe(2500);

		// Brief speech spike at t=2600 — should reset silence timer
		const spike = feedVadStream(mid.state, 5000, 2600, startedAt, opts);
		expect(spike.state.silenceStartMs).toBe(0);
		expect(spike.shouldStop).toBe(false);

		// Silence resumes at t=2700, fire at t=3700 (1000ms past restart)
		const restart = feedVadStream(spike.state, 50, 2700, startedAt, opts);
		expect(restart.state.silenceStartMs).toBe(2700);
		const fired = feedVadStream(restart.state, 50, 3700, startedAt, opts);
		expect(fired.shouldStop).toBe(true);
	});

	test("does not auto-stop before minSpeechDuration even with speech", () => {
		let state = initialVadStreamState();
		const startedAt = 0;
		const opts = { ...DEFAULT_VAD_OPTIONS, minSpeechDurationMs: 500, maxWaitMs: 100_000 };

		// 200ms of speech (below minSpeechDuration threshold)
		state = feedVadStream(state, 5000, 200, startedAt, opts).state;
		expect(state.hasSpoken).toBe(false);

		// Then silence — should NOT stop (hasSpoken is false, would only stop via maxWait)
		const after = feedVadStream(state, 50, 5000, startedAt, opts);
		expect(after.shouldStop).toBe(false);
	});

	test("tracks peakRms across the session", () => {
		let state = initialVadStreamState();
		const startedAt = 0;
		const opts = DEFAULT_VAD_OPTIONS;

		state = feedVadStream(state, 100, 100, startedAt, opts).state;
		state = feedVadStream(state, 8000, 200, startedAt, opts).state;
		state = feedVadStream(state, 50, 300, startedAt, opts).state;
		expect(state.peakRms).toBe(8000);
	});
});

describe("rmsToLevel", () => {
	test("clamps to 0-7 range", () => {
		expect(rmsToLevel(0)).toBe(0);
		expect(rmsToLevel(-100)).toBe(0);
		expect(rmsToLevel(16000)).toBe(7);
		expect(rmsToLevel(100000)).toBe(7);
	});

	test("non-linear scaling — quiet sound is lower than linear", () => {
		// Linear would give ~3.5; sqrt scaling should give ~5
		const mid = rmsToLevel(8000);
		expect(mid).toBeGreaterThanOrEqual(5);
		expect(mid).toBeLessThanOrEqual(6);
	});
});

describe("renderLevelBar", () => {
	test("renders 7 cells from 7 most recent values", () => {
		const bar = renderLevelBar([100, 200, 400, 800, 1600, 3200, 6400]);
		expect(bar.length).toBe(7);
		// Should contain at least one block character
		expect(bar).toMatch(/[▁▂▃▄▅▆▇█]/);
	});

	test("pads with zeros when fewer than 7 values", () => {
		const bar = renderLevelBar([1000, 2000]);
		expect(bar.length).toBe(7);
		// First 5 cells should be empty (▁)
		expect(bar.startsWith("▁▁▁▁▁")).toBe(true);
	});
});
