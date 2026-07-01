/**
 * CrashRecovery 3-state machine + computeBackoffMs + attemptRecovery backoff.
 *
 * Covers the openclaw-inspired state machine (active/timeout/suppressed),
 * the backoff formula, and timing of attemptRecovery. Tests use small
 * baseDelayMs / windowMs values so the suite stays under a second.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { CrashRecovery, computeBackoffMs } from "../src/crash-recovery";

describe("CrashRecovery 3-state machine", () => {
	test("starts in active state with 0 crashes", () => {
		const cr = new CrashRecovery(async () => {});
		expect(cr.state).toBe("active");
		expect(cr.suppressed).toBe(false);
		expect(cr.timeout).toBe(false);
	});

	test("transitions active → timeout at 5 crashes", () => {
		const cr = new CrashRecovery(async () => {}, {
			windowMs: 60_000,
			windowLimit: 10,
			timeoutThreshold: 5,
		});
		for (let i = 0; i < 5; i++) cr.recordCrash();
		expect(cr.state).toBe("timeout");
		expect(cr.timeout).toBe(true);
		expect(cr.suppressed).toBe(false);
	});

	test("transitions active → timeout at exactly threshold; 10 stays in timeout", () => {
		const cr = new CrashRecovery(async () => {}, {
			windowMs: 60_000,
			windowLimit: 10,
			timeoutThreshold: 5,
		});
		for (let i = 0; i < 4; i++) cr.recordCrash();
		expect(cr.state).toBe("active");
		for (let i = 0; i < 6; i++) cr.recordCrash();
		expect(cr.state).toBe("timeout");
	});

	test("transitions timeout → suppressed when windowCount > windowLimit", () => {
		const cr = new CrashRecovery(async () => {}, {
			windowMs: 60_000,
			windowLimit: 10,
			timeoutThreshold: 5,
		});
		for (let i = 0; i < 11; i++) cr.recordCrash();
		expect(cr.state).toBe("suppressed");
		expect(cr.suppressed).toBe(true);
	});

	test("exactly 10 crashes keeps the bridge in timeout (not suppressed)", () => {
		const cr = new CrashRecovery(async () => {}, {
			windowMs: 60_000,
			windowLimit: 10,
			timeoutThreshold: 5,
		});
		for (let i = 0; i < 10; i++) cr.recordCrash();
		expect(cr.state).toBe("timeout");
		expect(cr.suppressed).toBe(false);
	});

	test("exposes windowCount in snapshot", () => {
		const cr = new CrashRecovery(async () => {}, { windowMs: 60_000 });
		cr.recordCrash();
		cr.recordCrash();
		cr.recordCrash();
		const snap = cr.snapshot();
		// windowCount = crashes recorded within the window
		expect(snap.windowCount).toBe(3);
		// count = restart attempts via attemptRecovery (still 0)
		expect(snap.count).toBe(0);
		expect(snap.state).toBe("active");
		expect(snap.suppressed).toBe(false);
		expect(snap.timeout).toBe(false);
	});

	test("reset() returns to active and clears counters", () => {
		const cr = new CrashRecovery(async () => {}, {
			windowMs: 60_000,
			timeoutThreshold: 3,
		});
		for (let i = 0; i < 5; i++) cr.recordCrash();
		expect(cr.state).toBe("timeout");
		cr.reset();
		expect(cr.state).toBe("active");
		const snap = cr.snapshot();
		expect(snap.count).toBe(0);
		expect(snap.windowCount).toBe(0);
	});

	test("setReady(true) updates lastActivityAt", () => {
		const cr = new CrashRecovery(async () => {});
		const before = Date.now();
		cr.setReady(true);
		const after = Date.now();
		expect(cr.lastActivityAt).toBeGreaterThanOrEqual(before);
		expect(cr.lastActivityAt).toBeLessThanOrEqual(after);
	});

	test("isCrashError recognises crash error messages", () => {
		expect(CrashRecovery.isCrashError(new Error("Agent RPC process exited with code 1"))).toBe(true);
		expect(CrashRecovery.isCrashError(new Error("Agent RPC process exited before ready"))).toBe(true);
		expect(CrashRecovery.isCrashError(new Error("transport not running"))).toBe(true);
		expect(CrashRecovery.isCrashError(new Error("network reset"))).toBe(false);
		expect(CrashRecovery.isCrashError("not an error")).toBe(false);
		expect(CrashRecovery.isCrashError(undefined)).toBe(false);
	});
});

describe("computeBackoffMs", () => {
	test("n=1 returns base delay", () => {
		expect(computeBackoffMs(1, 2_000, 60_000)).toBe(2_000);
	});

	test("n=2 doubles", () => {
		expect(computeBackoffMs(2, 2_000, 60_000)).toBe(4_000);
	});

	test("n=3 quadruples", () => {
		expect(computeBackoffMs(3, 2_000, 60_000)).toBe(8_000);
	});

	test("caps at maxDelay", () => {
		expect(computeBackoffMs(10, 2_000, 60_000)).toBe(60_000);
		expect(computeBackoffMs(20, 2_000, 60_000)).toBe(60_000);
	});

	test("n<1 returns base delay", () => {
		expect(computeBackoffMs(0, 2_000, 60_000)).toBe(2_000);
	});

	test("negative index returns base", () => {
		expect(computeBackoffMs(-1, 2_000, 60_000)).toBe(2_000);
	});

	test("produces the documented sequence 2,4,8,16,32,60,60", () => {
		const seq = [2, 4, 8, 16, 32, 60, 60].map(s => s * 1_000);
		const got: number[] = [];
		for (let n = 1; n <= 7; n++) got.push(computeBackoffMs(n, 2_000, 60_000));
		expect(got).toEqual(seq);
	});
});

describe("attemptRecovery backoff timing", () => {
	test("calls restart exactly once per attempt with backoff", async () => {
		let calls = 0;
		const restart = async () => {
			calls++;
		};
		const cr = new CrashRecovery(restart, {
			baseDelayMs: 80,
			maxDelayMs: 500,
			maxRetries: 3,
		});
		const start = Date.now();
		await cr.attemptRecovery();
		const elapsed = Date.now() - start;
		expect(calls).toBe(1);
		expect(elapsed).toBeGreaterThanOrEqual(60);
		expect(elapsed).toBeLessThan(500);
	});

	test("gives up after maxRetries — restart not called past limit", async () => {
		let calls = 0;
		const restart = async () => {
			calls++;
		};
		const cr = new CrashRecovery(restart, {
			baseDelayMs: 5,
			maxDelayMs: 20,
			maxRetries: 2,
		});
		await cr.attemptRecovery();
		await cr.attemptRecovery();
		await cr.attemptRecovery();
		expect(calls).toBe(2);
	});

	test("does not call restart when suppressed", async () => {
		let calls = 0;
		const restart = async () => {
			calls++;
		};
		const cr = new CrashRecovery(restart, {
			windowMs: 60_000,
			windowLimit: 3,
			timeoutThreshold: 2,
			baseDelayMs: 5,
			maxDelayMs: 20,
		});
		for (let i = 0; i < 4; i++) cr.recordCrash();
		expect(cr.suppressed).toBe(true);
		await cr.attemptRecovery();
		expect(calls).toBe(0);
	});

	test("uses exponential backoff: second attempt waits longer than first", async () => {
		const waits: number[] = [];
		const restart = async () => {};
		const cr = new CrashRecovery(restart, {
			baseDelayMs: 30,
			maxDelayMs: 1_000,
			maxRetries: 4,
		});
		const s1 = Date.now();
		await cr.attemptRecovery();
		waits.push(Date.now() - s1);
		const s2 = Date.now();
		await cr.attemptRecovery();
		waits.push(Date.now() - s2);
		expect(waits[1]).toBeGreaterThan(waits[0]!);
	});

	// afterEach to silence no-floating-promises
	afterEach(() => {});
});
