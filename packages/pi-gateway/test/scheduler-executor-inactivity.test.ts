/**
 * Tests for the executor helpers that don't need a real omp subprocess.
 */
import { describe, expect, test } from "bun:test";
import { computeInactivityBudgetMs } from "../src/scheduler/executor";

describe("computeInactivityBudgetMs", () => {
	test("uses the default 5 min when timeoutMs is not provided", () => {
		expect(computeInactivityBudgetMs(undefined)).toBe(5 * 60 * 1000);
		expect(computeInactivityBudgetMs(0)).toBe(5 * 60 * 1000);
	});

	test("uses the wall-clock timeout when it is tighter than the default", () => {
		// A 30s wall-clock task should also have a 30s inactivity window.
		expect(computeInactivityBudgetMs(30_000)).toBe(30_000);
		// 1 min wall-clock → 1 min inactivity.
		expect(computeInactivityBudgetMs(60_000)).toBe(60_000);
	});

	test("caps at the default when wall-clock is larger than the default", () => {
		// 1 hour wall-clock → 5 min inactivity (capped).
		expect(computeInactivityBudgetMs(60 * 60 * 1000)).toBe(5 * 60 * 1000);
	});

	test("never exceeds the hard cap of 30 min", () => {
		// The cap is enforced via the default; sanity-check the constant.
		expect(computeInactivityBudgetMs(Number.MAX_SAFE_INTEGER)).toBeLessThanOrEqual(30 * 60 * 1000);
	});
});
