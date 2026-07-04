/**
 * CrashLog JSONL persistence + recent() / recentCrashCount() readers.
 *
 * The on-disk JSONL is the only crash state that survives a gateway
 * restart, so these tests double as the spec for the file format.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CrashLog } from "../src/crash-log";

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
		expect(out.map(e => e.kind === "crash" && e.reason)).toEqual(["third", "second", "first"]);
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
		expect(out[0]!.kind === "crash" && out[0]!.reason).toBe("after");
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
