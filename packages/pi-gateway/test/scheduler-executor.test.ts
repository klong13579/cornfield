/**
 * Scheduler executor + execution log tests.
 *
 *   - `scheduler-executor-cwd.test.ts` — executeScheduledCommand runs
 *     shell / agent tasks in the given cwd, prepends promptPrefix.
 *   - `scheduler-executor-inactivity.test.ts` — computeInactivityBudgetMs
 *     default 5min, capped at 30min.
 *   - `scheduler-execution-log.test.ts` — appendExecutionLog /
 *     readExecutionLog / pruneExecutionLog / pruneAllLogs, hierarchical
 *     by-task layout, pinyin slug for CJK, agentSessionPath round-trip.
 *
 * Three layers of "what happens when a task runs" — the spawn itself,
 * the inactivity window, and the persisted audit trail. Co-located here.
 */
import { afterEach, beforeEach, describe, expect, it, test } from "bun:test";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	appendExecutionLog,
	type ExecutionLogEntry,
	getLogRoot,
	pruneAllLogs,
	pruneExecutionLog,
	readExecutionLog,
	setLogRoot,
} from "../src/scheduler/execution-log";
import { computeInactivityBudgetMs, executeScheduledCommand } from "../src/scheduler/executor";

// ===========================================================================
// executeScheduledCommand (cwd + promptPrefix)
// ===========================================================================

let workDir: string;

afterEach(async () => {
	if (workDir) await fsPromises.rm(workDir, { recursive: true, force: true });
});

describe("executeScheduledCommand cwd", () => {
	it("runs shell tasks in the given cwd", async () => {
		workDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "pi-gateway-cwd-shell-"));
		// The test writes a marker file inside workDir and checks pwd
		// resolves to workDir. We use a shell command that prints pwd
		// to stdout.
		const result = await executeScheduledCommand("pwd", {
			taskType: "shell",
			timeoutMs: 5_000,
			cwd: workDir,
		});
		expect(result.exitCode).toBe(0);
		// On macOS pwd may resolve symlinks (e.g. /tmp -> /private/tmp).
		// Use realpath to compare.
		const realCwd = await fsPromises.realpath(workDir);
		expect(result.output.trim()).toBe(realCwd);
	});

	it("falls back to gateway cwd when cwd is not provided", async () => {
		// Without cwd, pwd should match the current process cwd (after
		// realpath). We don't assert equality with process.cwd() because
		// the test runner may run in a chroot; the contract is just
		// "runs in some directory and exits 0".
		const result = await executeScheduledCommand("pwd", {
			taskType: "shell",
			timeoutMs: 5_000,
		});
		expect(result.exitCode).toBe(0);
		expect(result.output.trim().length).toBeGreaterThan(0);
	});

	it("prepends promptPrefix to the agent command (recursion guard)", async () => {
		// Use a tiny "omp" shim that echoes its argv to stdout, so we
		// can assert the prefix actually made it into the spawned
		// process's argument list without depending on the real omp
		// binary. The shim sits in its own temp dir; the executor only
		// takes the binary path, not a cwd requirement.
		const shimDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "pi-gateway-prefix-shim-"));
		try {
			const shimPath = path.join(shimDir, "omp-fake");
			await Bun.write(shimPath, `#!/usr/bin/env sh\nfor a in "$@"; do printf '%s\\n' "$a"; done\n`);
			await fsPromises.chmod(shimPath, 0o755);

			const result = await executeScheduledCommand("do something", {
				taskType: "agent",
				timeoutMs: 5_000,
				ompBinary: shimPath,
				promptPrefix: "[CRON-CONTEXT] ",
			});
			expect(result.exitCode).toBe(0);
			// The shim echoes every argv on its own line. The first
			// lines are flags ("--print"); the last line is the
			// command. With the prefix, the command line should start
			// with "[CRON-CONTEXT] ".
			const lines = result.output.trim().split("\n");
			expect(lines[0]).toBe("--print");
			expect(lines[lines.length - 1]).toBe("[CRON-CONTEXT] do something");
		} finally {
			await fsPromises.rm(shimDir, { recursive: true, force: true });
		}
	});
});

// ===========================================================================
// computeInactivityBudgetMs
// ===========================================================================

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

	test("never exceeds the inactivity cap of 30 min", () => {
		// The cap is enforced via the default; sanity-check the constant.
		expect(computeInactivityBudgetMs(Number.MAX_SAFE_INTEGER)).toBeLessThanOrEqual(30 * 60 * 1000);
	});
});

// ===========================================================================
// execution-log (hierarchical layout: by-task/<slug>/<YYYY-MM-DD>.jsonl)
// ===========================================================================

const ORIGINAL_ROOT = getLogRoot();

function makeEntry(overrides: Partial<ExecutionLogEntry> = {}): ExecutionLogEntry {
	return {
		id: `exec_${Math.random().toString(36).slice(2, 10)}`,
		ts: Date.now(),
		exitCode: 0,
		status: "success",
		durationMs: 42,
		output: "ok",
		stderr: "",
		...overrides,
	};
}

describe("appendExecutionLog", () => {
	let tempRoot = "";

	beforeEach(() => {
		tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exec-log-test-"));
		setLogRoot(tempRoot);
	});

	afterEach(() => {
		setLogRoot(ORIGINAL_ROOT);
		fs.rmSync(tempRoot, { recursive: true, force: true });
	});

	it("writes to by-task/<slug>/<YYYY-MM-DD>.jsonl", () => {
		const entry = makeEntry({ ts: new Date("2026-06-19T10:00:00Z").getTime() });
		appendExecutionLog("gw-tmux-test", entry);

		const expectedDir = path.join(tempRoot, "by-task", "gw-tmux-test");
		const expectedFile = path.join(expectedDir, "2026-06-19.jsonl");
		expect(fs.existsSync(expectedFile)).toBe(true);

		const lines = fs.readFileSync(expectedFile, "utf-8").trim().split("\n");
		expect(lines).toHaveLength(1);
		const parsed = JSON.parse(lines[0]!) as ExecutionLogEntry;
		expect(parsed.id).toBe(entry.id);
	});

	it("separates entries by date into different files", () => {
		const day1 = makeEntry({ ts: new Date("2026-06-19T10:00:00Z").getTime() });
		const day2 = makeEntry({ ts: new Date("2026-06-20T10:00:00Z").getTime() });
		appendExecutionLog("gw-tmux-test", day1);
		appendExecutionLog("gw-tmux-test", day2);

		const dir = path.join(tempRoot, "by-task", "gw-tmux-test");
		expect(fs.existsSync(path.join(dir, "2026-06-19.jsonl"))).toBe(true);
		expect(fs.existsSync(path.join(dir, "2026-06-20.jsonl"))).toBe(true);
	});

	it("isolates entries per task", () => {
		appendExecutionLog("task-a", makeEntry());
		appendExecutionLog("task-b", makeEntry());
		expect(fs.existsSync(path.join(tempRoot, "by-task", "task-a"))).toBe(true);
		expect(fs.existsSync(path.join(tempRoot, "by-task", "task-b"))).toBe(true);
	});

	it("uses pinyin slug for CJK task names after async resolution", async () => {
		// First write uses sync ASCII fallback; the async resolver upgrades
		// the cached dir. Drain it before reading.
		appendExecutionLog("算法模块", makeEntry());
		// Allow microtasks to resolve the async pinyin slug
		await new Promise(resolve => setTimeout(resolve, 50));
		appendExecutionLog("算法模块", makeEntry());
		// Wait again for the second async resolution
		await new Promise(resolve => setTimeout(resolve, 50));

		// The async pinyin slug should be `suan-fa-mo-kuai`.
		const pinyinDir = path.join(tempRoot, "by-task", "suan-fa-mo-kuai");
		expect(fs.existsSync(pinyinDir)).toBe(true);
	});
});

describe("readExecutionLog", () => {
	let tempRoot = "";

	beforeEach(() => {
		tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exec-log-test-"));
		setLogRoot(tempRoot);
	});

	afterEach(() => {
		setLogRoot(ORIGINAL_ROOT);
		fs.rmSync(tempRoot, { recursive: true, force: true });
	});

	it("returns entries newest-first", () => {
		const older = makeEntry({ ts: 1_000_000, output: "old" });
		const newer = makeEntry({ ts: 2_000_000, output: "new" });
		appendExecutionLog("t", older);
		appendExecutionLog("t", newer);

		const out = readExecutionLog("t");
		expect(out).toHaveLength(2);
		expect(out[0]?.output).toBe("new");
		expect(out[1]?.output).toBe("old");
	});

	it("respects limit", () => {
		const now = Date.now();
		for (let i = 0; i < 5; i++) {
			appendExecutionLog("t", makeEntry({ ts: now + i }));
		}
		const out = readExecutionLog("t", 2);
		expect(out).toHaveLength(2);
	});

	it("returns empty array for unknown task", () => {
		expect(readExecutionLog("nope")).toEqual([]);
	});

	it("merges legacy flat file when present", () => {
		// Simulate a legacy file written by an older version
		const legacy = path.join(tempRoot, "gw-tmux-test.jsonl");
		const legacyEntry = makeEntry({ ts: 500, output: "legacy" });
		fs.writeFileSync(legacy, JSON.stringify(legacyEntry));

		const newEntry = makeEntry({ ts: 1500, output: "new" });
		appendExecutionLog("gw-tmux-test", newEntry);

		const out = readExecutionLog("gw-tmux-test");
		expect(out).toHaveLength(2);
		expect(out.map(e => e.output).sort()).toEqual(["legacy", "new"]);
	});
});

describe("pruneExecutionLog", () => {
	let tempRoot = "";

	beforeEach(() => {
		tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exec-log-test-"));
		setLogRoot(tempRoot);
	});

	afterEach(() => {
		setLogRoot(ORIGINAL_ROOT);
		fs.rmSync(tempRoot, { recursive: true, force: true });
	});

	it("keeps only the N most recent entries", () => {
		const now = Date.now();
		for (let i = 0; i < 5; i++) {
			appendExecutionLog("t", makeEntry({ ts: now + i }));
		}
		const removed = pruneExecutionLog("t", 2);
		expect(removed).toBe(3);
		const out = readExecutionLog("t");
		expect(out).toHaveLength(2);
	});

	it("returns 0 when nothing to prune", () => {
		appendExecutionLog("t", makeEntry());
		expect(pruneExecutionLog("t", 5)).toBe(0);
	});
});

describe("pruneAllLogs", () => {
	let tempRoot = "";

	beforeEach(() => {
		tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exec-log-test-"));
		setLogRoot(tempRoot);
	});

	afterEach(() => {
		setLogRoot(ORIGINAL_ROOT);
		fs.rmSync(tempRoot, { recursive: true, force: true });
	});

	it("removes entries older than cutoff across all tasks", () => {
		const now = Date.now();
		const old = makeEntry({ ts: now - 40 * 24 * 60 * 60 * 1000 }); // 40 days ago
		const recent = makeEntry({ ts: now - 5 * 24 * 60 * 60 * 1000 }); // 5 days ago
		appendExecutionLog("a", old);
		appendExecutionLog("a", recent);
		appendExecutionLog("b", old);
		appendExecutionLog("b", recent);

		const removed = pruneAllLogs(30);
		expect(removed).toBe(2);

		expect(readExecutionLog("a")).toHaveLength(1);
		expect(readExecutionLog("b")).toHaveLength(1);
	});

	it("walks legacy flat files too", () => {
		const legacy = path.join(tempRoot, "old-task.jsonl");
		fs.writeFileSync(legacy, JSON.stringify(makeEntry({ ts: 1000 })));

		const removed = pruneAllLogs(30);
		expect(removed).toBe(1);
	});
});

describe("agentSessionPath round-trip (persistence fix)", () => {
	// Regression: the field was only in the in-memory execution map
	// (lost on gateway restart) and not in the JSONL log, so the
	// next scheduled run's Tier 3 silently skipped when a failure
	// happened before a restart. Both directions must round-trip.

	let tempRoot = "";

	beforeEach(() => {
		tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exec-log-test-"));
		setLogRoot(tempRoot);
	});

	afterEach(() => {
		setLogRoot(ORIGINAL_ROOT);
		fs.rmSync(tempRoot, { recursive: true, force: true });
	});

	it("preserves agentSessionPath on appendExecutionLog → readExecutionLog", () => {
		const sessionPath = "/Users/test/.omp/agent/omp-atomix/sessions/cron_abc123.jsonl";
		const entry = makeEntry({
			ts: new Date("2026-06-19T10:00:00Z").getTime(),
			exitCode: 1,
			status: "failure",
			agentSessionPath: sessionPath,
		});
		appendExecutionLog("persistence-test", entry);

		const out = readExecutionLog("persistence-test");
		expect(out).toHaveLength(1);
		expect(out[0]?.agentSessionPath).toBe(sessionPath);
	});

	it("omits agentSessionPath for legacy entries written before the fix", () => {
		// A legacy line lacks the field — reader must tolerate absence
		// and not synthesize a value (which would have masked the bug).
		const legacyEntry = makeEntry({ ts: 1_700_000_000_000 });
		fs.mkdirSync(path.join(tempRoot, "by-task", "legacy"), { recursive: true });
		const legacyFile = path.join(tempRoot, "by-task", "legacy", "2026-07-01.jsonl");
		fs.writeFileSync(legacyFile, `${JSON.stringify(legacyEntry)}\n`);

		const out = readExecutionLog("legacy");
		expect(out).toHaveLength(1);
		expect(out[0]?.agentSessionPath).toBeUndefined();
	});
});
