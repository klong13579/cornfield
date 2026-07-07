/**
 * Crash lifecycle tests.
 *
 * `crash-log.test.ts` covered CrashLog JSONL persistence — the file
 * format that survives a gateway restart and the recent() /
 * recentCrashCount() readers.
 * `crash-recovery-thresholds.test.ts` covered the CrashRecovery
 * 3-state machine (active / timeout / suppressed) and the
 * computeBackoffMs / attemptRecovery contract.
 *
 * Both are part of the same crash lifecycle — once a crash is
 * recorded, CrashRecovery decides whether to restart. Co-located here.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CrashLog } from "../src/crash-log";
import { CrashRecovery, computeBackoffMs } from "../src/crash-recovery";

let tmpDir: string;
let logPath: string;
let log: CrashLog;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-gateway-crash-log-"));
	logPath = path.join(tmpDir, "crash_log.jsonl");
	log = new CrashLog(logPath);
});

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// CrashLog JSONL persistence
// ---------------------------------------------------------------------------

describe("CrashLog JSONL persistence", () => {
	test("writes entries to logPath on append", async () => {
		log.logCrash("acct-1", "boom", 137);
		log.logRecovery("acct-1", 1, true);
		log.logSuppressed("acct-1", 11);
		const raw = await fs.readFile(logPath, "utf8");
		const lines = raw.trim().split("\n");
		expect(lines).toHaveLength(3);
		const parsed = lines.map(l => JSON.parse(l));
		expect(parsed[0]).toMatchObject({ kind: "crash", accountId: "acct-1", exitCode: 137, reason: "boom" });
		expect(parsed[1]).toMatchObject({ kind: "recovery", accountId: "acct-1", attempt: 1, success: true });
		expect(parsed[2]).toMatchObject({ kind: "suppressed", accountId: "acct-1", crashCount: 11 });
	});

	test("logCrash includes exitCode when provided", () => {
		log.logCrash("a", "reason", 137);
		const raw = require("node:fs").readFileSync(logPath, "utf8");
		const entry = JSON.parse(raw.trim());
		expect(entry.exitCode).toBe(137);
	});

	test("logCrash omits exitCode when undefined", () => {
		log.logCrash("a", "reason");
		const raw = require("node:fs").readFileSync(logPath, "utf8");
		const entry = JSON.parse(raw.trim());
		expect(entry).not.toHaveProperty("exitCode");
	});

	test("logState captures 3-state fields", () => {
		log.logState("a", "timeout", 5, false, true);
		const raw = require("node:fs").readFileSync(logPath, "utf8");
		const entry = JSON.parse(raw.trim());
		expect(entry).toMatchObject({
			kind: "state",
			accountId: "a",
			state: "timeout",
			windowCount: 5,
			suppressed: false,
			timeout: true,
		});
	});

	test("appends don't truncate previous entries", () => {
		log.logCrash("a", "first");
		log.logRecovery("a", 1, true);
		const raw = require("node:fs").readFileSync(logPath, "utf8");
		expect(raw.trim().split("\n")).toHaveLength(2);
	});

	test("creates parent dir automatically", () => {
		const nested = path.join(tmpDir, "a", "b", "c", "crash_log.jsonl");
		const nestedLog = new CrashLog(nested);
		nestedLog.logCrash("a", "x");
		const exists = require("node:fs").existsSync(nested);
		expect(exists).toBe(true);
	});

	test("recent() returns [] for missing file", async () => {
		const missing = new CrashLog(path.join(tmpDir, "nope.jsonl"));
		const out = await missing.recent("any");
		expect(out).toEqual([]);
	});

	test("recent() skips malformed lines", async () => {
		await fs.writeFile(
			logPath,
			`{not json}\n${JSON.stringify({ kind: "crash", ts: Date.now(), accountId: "a", reason: "ok" })}\n`,
			"utf8",
		);
		const out = await log.recent("a");
		expect(out).toHaveLength(1);
		expect(out[0]!.kind).toBe("crash");
	});
});

describe("CrashLog.recent", () => {
	test("returns entries newest first", async () => {
		const t0 = Date.now();
		log.append({ kind: "crash", accountId: "a", reason: "first" });
		await Bun.sleep(5);
		log.append({ kind: "crash", accountId: "a", reason: "second" });
		await Bun.sleep(5);
		log.append({ kind: "crash", accountId: "a", reason: "third" });
		const out = await log.recent("a", t0 - 1);
		expect(out.map(e => (e.kind === "crash" ? e.reason : null))).toEqual(["third", "second", "first"]);
	});

	test("filters by accountId", async () => {
		log.logCrash("a", "x");
		log.logCrash("b", "y");
		log.logCrash("a", "z");
		const aOut = await log.recent("a");
		const bOut = await log.recent("b");
		expect(aOut.every(e => e.accountId === "a")).toBe(true);
		expect(aOut).toHaveLength(2);
		expect(bOut.every(e => e.accountId === "b")).toBe(true);
		expect(bOut).toHaveLength(1);
	});

	test("respects sinceMs cutoff", async () => {
		log.logCrash("a", "before");
		await Bun.sleep(50);
		const cutoff = Date.now();
		await Bun.sleep(10);
		log.logCrash("a", "after");
		const out = await log.recent("a", cutoff);
		expect(out).toHaveLength(1);
		expect((out[0] as { kind: string; reason: string }).reason).toBe("after");
	});

	test("respects limit", async () => {
		for (let i = 0; i < 10; i++) log.logCrash("a", `r${i}`);
		const out = await log.recent("a", undefined, 3);
		expect(out).toHaveLength(3);
	});
});

describe("CrashLog.recentCrashCount", () => {
	test("counts only kind=crash within window", async () => {
		log.logCrash("a", "1");
		log.logCrash("a", "2");
		log.logRecovery("a", 1, true);
		log.logSuppressed("a", 2);
		const n = await log.recentCrashCount("a", 10 * 60 * 1000);
		expect(n).toBe(2);
	});

	test("excludes crashes older than window", async () => {
		log.logCrash("a", "old");
		await Bun.sleep(40);
		const n = await log.recentCrashCount("a", 10);
		expect(n).toBe(0);
	});

	test("zero for account with no events", async () => {
		const n = await log.recentCrashCount("ghost", 60_000);
		expect(n).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// CrashRecovery 3-state machine
// ---------------------------------------------------------------------------

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
