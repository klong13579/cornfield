import { describe, expect, it } from "bun:test";
import {
	RETRY_FALLBACK_ESCALATION_FACTOR,
	RETRY_FALLBACK_FLAPPING_WINDOW_MS,
	RETRY_FALLBACK_MIN_ESCALATED_COOLDOWN_MS,
	computeRetryFallbackCooldown,
} from "../src/session/retry-fallback-cooldown";

describe("computeRetryFallbackCooldown", () => {
	const now = 1_000_000;

	describe("first failure (no prior history)", () => {
		it("returns the base cooldown when lastFailureAtMs is undefined", () => {
			expect(computeRetryFallbackCooldown(5_000, undefined, now)).toBe(5_000);
		});

		it("preserves the full base cooldown unchanged", () => {
			// 5min for UNKNOWN — should pass through unchanged
			expect(computeRetryFallbackCooldown(5 * 60_000, undefined, now)).toBe(5 * 60_000);
			// 1h for ACCESS_DENIED — should pass through unchanged
			expect(computeRetryFallbackCooldown(60 * 60_000, undefined, now)).toBe(60 * 60_000);
		});
	});

	describe("repeat failure inside flapping window (production bug)", () => {
		it("escalates a short cooldown (5s) to the 5min floor", () => {
			// The flapping bug: primary fails with retry-after-ms=5000, gets 5s cooldown,
			// restore cycle picks it again 5s later, fails again, 5s cooldown, etc.
			// With escalation: the second failure within 60s gets at least 5min.
			const cooldown = computeRetryFallbackCooldown(5_000, now - 10_000, now);
			expect(cooldown).toBe(RETRY_FALLBACK_MIN_ESCALATED_COOLDOWN_MS);
		});

		it("multiplies a 30s cooldown by 5x and floors at 5min", () => {
			// 30s * 5 = 150s = 2.5min, below the 5min floor → 5min
			const cooldown = computeRetryFallbackCooldown(30_000, now - 20_000, now);
			expect(cooldown).toBe(RETRY_FALLBACK_MIN_ESCALATED_COOLDOWN_MS);
		});

		it("multiplies a 90s cooldown by 5x (= 450s = 7.5min, above floor)", () => {
			// 90s * 5 = 450s. Above the 5min floor, so the multiplied value wins.
			const cooldown = computeRetryFallbackCooldown(90_000, now - 30_000, now);
			expect(cooldown).toBe(90_000 * RETRY_FALLBACK_ESCALATION_FACTOR);
		});

		it("multiplies a 1h ACCESS_DENIED cooldown by 5x (= 5h)", () => {
			// ACCESS_DENIED already has a long cooldown, but the same escalation
			// still applies: 1h * 5 = 5h. Prevents repeated 403 thrashing.
			const cooldown = computeRetryFallbackCooldown(60 * 60_000, now - 30_000, now);
			expect(cooldown).toBe(5 * 60 * 60_000);
		});

		it("treats a failure exactly at the window boundary as NOT flapping", () => {
			// lastFailure was exactly flappingWindow ago — not inside the window
			const lastFailure = now - RETRY_FALLBACK_FLAPPING_WINDOW_MS;
			expect(computeRetryFallbackCooldown(5_000, lastFailure, now)).toBe(5_000);
		});

		it("treats a failure just inside the window boundary as flapping", () => {
			// lastFailure was 1ms ago — inside the window
			const lastFailure = now - 1;
			const cooldown = computeRetryFallbackCooldown(5_000, lastFailure, now);
			expect(cooldown).toBe(RETRY_FALLBACK_MIN_ESCALATED_COOLDOWN_MS);
		});
	});

	describe("failure outside flapping window (cold cache)", () => {
		it("does not escalate a failure that is well outside the window", () => {
			// Selector was last seen 10 minutes ago. Treat this as a cold
			// failure — the previous flapping is no longer relevant.
			const lastFailure = now - 10 * 60_000;
			expect(computeRetryFallbackCooldown(5_000, lastFailure, now)).toBe(5_000);
		});
	});

	describe("custom flapping window", () => {
		it("honors a caller-provided flapping window", () => {
			// With a 2s window, a 1s-old failure is flapping; a 3s-old failure isn't.
			const window = 2_000;
			expect(computeRetryFallbackCooldown(1_000, now - 1_000, now, window)).toBe(
				RETRY_FALLBACK_MIN_ESCALATED_COOLDOWN_MS,
			);
			expect(computeRetryFallbackCooldown(1_000, now - 3_000, now, window)).toBe(1_000);
		});
	});

	describe("min cooldown floor (retry.fallbackCooldownMs)", () => {
		it("applies the floor when the computed cooldown is shorter", () => {
			// retry-after-ms=200 in prod → 200ms cooldown, but user floor is 60s.
			expect(computeRetryFallbackCooldown(200, undefined, now, undefined, 60_000)).toBe(60_000);
		});

		it("keeps the computed cooldown when it exceeds the floor", () => {
			// ACCESS_DENIED produces 1h; user floor 60s has no effect.
			expect(computeRetryFallbackCooldown(60 * 60_000, undefined, now, undefined, 60_000)).toBe(60 * 60_000);
		});

		it("ignores undefined/0/negative floor values", () => {
			expect(computeRetryFallbackCooldown(5_000, undefined, now, undefined, undefined)).toBe(5_000);
			expect(computeRetryFallbackCooldown(5_000, undefined, now, undefined, 0)).toBe(5_000);
			expect(computeRetryFallbackCooldown(5_000, undefined, now, undefined, -1)).toBe(5_000);
		});

		it("applies the floor AFTER flapping escalation (high user floor wins)", () => {
			// Flapping produces 5min (from the escalation floor). User sets floor to 10min.
			// The 10min user floor must NOT be multiplied by the escalation — it should win.
			const lastFailure = now - 10_000;
			expect(computeRetryFallbackCooldown(5_000, lastFailure, now, undefined, 10 * 60_000)).toBe(
				10 * 60_000,
			);
		});

		it("applies the floor on top of the flapping escalation when escalation wins", () => {
			// Flapping: 5s base × 5 = 25s, but escalation floor is 5min → 5min.
			// User floor is 1min — already below 5min, so escalation wins.
			const lastFailure = now - 10_000;
			expect(computeRetryFallbackCooldown(5_000, lastFailure, now, undefined, 60_000)).toBe(
				RETRY_FALLBACK_MIN_ESCALATED_COOLDOWN_MS,
			);
		});
	});
});
