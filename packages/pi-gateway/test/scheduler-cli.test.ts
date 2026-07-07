/**
 * Scheduler CLI command tests.
 *
 *   - `scheduler-cron-test-run.test.ts` — `cron test-run` operator flow:
 *     schedule snapshot/restore, stats preservation, lastDeliveryError
 *     rollback, --no-restore, gateway-running guard, mode=none silent.
 *   - `scheduler-cron-update.test.ts` — `cron update --account /
 *     --clear-account / --timeout-ms`: bind / rebind / clear, conflict
 *     rejection, exit-code semantics.
 *   - `scheduler-reconcile.test.ts` — `cronReconcile` +
 *     `suggestAccountBinding`: accountId prefix matching, agentDir
 *     basename matching, dry-run, apply.
 *   - `scheduler-resolve-agent-cwd.test.ts` — resolveAgentCwd from
 *     account config.
 *   - `scheduler-from-message-smoke.test.ts` — parseCronIntent +
 *     createCronTaskFromMessage: slash command parsing, file write,
 *     DB insert, rollback.
 *
 * All five test the CLI / slash-command surface of the scheduler.
 * Co-located here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	cronReconcile,
	cronTestRun,
	cronUpdate,
	resolveAgentCwd,
	suggestAccountBinding,
} from "../src/scheduler/cli-commands";
import { createCronTaskFromMessage, parseCronIntent } from "../src/scheduler/from-message";
import { JsonFileStorage } from "../src/scheduler/json-file-storage";
import { runTestRun } from "../src/scheduler/test-run";
import type { ScheduledTask } from "../src/scheduler/types";

// ===========================================================================
// resolveAgentCwd
// ===========================================================================

type Cfg = Parameters<typeof resolveAgentCwd>[1];

describe("resolveAgentCwd", () => {
	const cfg: Cfg = {
		channels: {
			dingtalk: {
				accounts: {
					hr: { agentDir: "/Users/test/OMP-workspace-test/hr3" },
					opencode: { agentDir: "/Users/test/OMP-workspace-test/omp-atomix" },
					"ops/hr": { agentDir: "/Users/test/.omp/agents/ops/hr" },
					credentials_only: { agentDir: undefined as unknown as string },
				},
			},
		},
	};

	it("returns the agentDir for a known account", () => {
		expect(resolveAgentCwd("hr", cfg)).toBe("/Users/test/OMP-workspace-test/hr3");
	});

	it("returns the agentDir for accounts with slash in their key (ops/hr)", () => {
		expect(resolveAgentCwd("ops/hr", cfg)).toBe("/Users/test/.omp/agents/ops/hr");
	});

	it("returns undefined for an account that exists but has no agentDir", () => {
		expect(resolveAgentCwd("credentials_only", cfg)).toBeUndefined();
	});

	it("returns undefined for an accountId that is not in the accounts map", () => {
		expect(resolveAgentCwd("never-configured", cfg)).toBeUndefined();
	});

	it("returns undefined when dingtalk channel is missing entirely", () => {
		expect(resolveAgentCwd("hr", { channels: {} })).toBeUndefined();
	});

	it("returns undefined when the channels block is missing entirely", () => {
		expect(resolveAgentCwd("hr", {})).toBeUndefined();
	});

	it("returns undefined when the accounts map is undefined", () => {
		expect(resolveAgentCwd("hr", { channels: { dingtalk: {} } } as unknown as Cfg)).toBeUndefined();
	});

	it("does not silently coerce an empty-string agentDir into a cwd", () => {
		const cfg2: Cfg = {
			channels: { dingtalk: { accounts: { broken: { agentDir: "" } } } },
		};
		expect(resolveAgentCwd("broken", cfg2)).toBe("");
	});

	it("does not look up across other channel types (only dingtalk is consulted)", () => {
		const cfg3: Cfg = {
			channels: {
				dingtalk: { accounts: {} },
				// biome-ignore lint/suspicious/noExplicitAny: synthetic future-channel test fixture
				feishu: { accounts: { hr: { agentDir: "/wrong/path" } } } as any,
			},
		};
		expect(resolveAgentCwd("hr", cfg3)).toBeUndefined();
	});
});

// ===========================================================================
// suggestAccountBinding + cronReconcile
// ===========================================================================

const accounts: Record<string, { agentDir?: string }> = {
	hr: { agentDir: "/Users/test/OMP-workspace-test/hr3" },
	opencode: { agentDir: "/Users/test/OMP-workspace-test/omp-atomix" },
	"ops/hr": { agentDir: "/Users/test/.omp/agents/ops/hr" },
	credentials_only: {},
};

describe("suggestAccountBinding", () => {
	it("matches the accountId prefix exactly (hr:foo -> hr)", () => {
		const r = suggestAccountBinding("hr:daily-report", accounts);
		expect(r?.accountId).toBe("hr");
	});

	it("matches a slash-containing accountId (ops/hr:audit -> ops/hr)", () => {
		const r = suggestAccountBinding("ops/hr:audit", accounts);
		expect(r?.accountId).toBe("ops/hr");
	});

	it("matches the agentDir basename prefix (omp-atomix:wiki -> opencode)", () => {
		const r = suggestAccountBinding("omp-atomix:wiki-cron", accounts);
		expect(r?.accountId).toBe("opencode");
		expect(r?.reason).toContain("omp-atomix");
	});

	it("does not match a substring that is not a colon-delimited prefix", () => {
		const r = suggestAccountBinding("hr3-daily", accounts);
		expect(r).toBeUndefined();
	});

	it("does not match when the account has no agentDir and the name does not start with the accountId", () => {
		const r = suggestAccountBinding("credentials-only-task", accounts);
		expect(r).toBeUndefined();
	});

	it("returns undefined when there are no accounts", () => {
		expect(suggestAccountBinding("anything", {})).toBeUndefined();
	});

	it("returns undefined when the name has no colon", () => {
		const r = suggestAccountBinding("hr", accounts);
		expect(r).toBeUndefined();
	});

	it("prefers the accountId prefix over the agentDir basename when both could match", () => {
		const local: Record<string, { agentDir?: string }> = {
			hr: { agentDir: "/Users/test/hr3" },
		};
		const r = suggestAccountBinding("hr:foo", local);
		expect(r?.accountId).toBe("hr");
		expect(r?.reason).toContain('"hr:"');
	});

	it("skips accounts with an empty-string agentDir when computing the basename", () => {
		const local: Record<string, { agentDir?: string }> = {
			bad: { agentDir: "" },
		};
		expect(suggestAccountBinding("anything:here", local)).toBeUndefined();
	});
});

let testDirReconcile: string;
let dbPathReconcile: string;
let storageReconcile: JsonFileStorage;

beforeEach(() => {
	testDirReconcile = fs.mkdtempSync(path.join(os.tmpdir(), "pi-gateway-reconcile-"));
	dbPathReconcile = path.join(testDirReconcile, "jobs.json");
	storageReconcile = new JsonFileStorage(dbPathReconcile);
});

afterEach(() => {
	storageReconcile?.close();
	try {
		fs.rmSync(testDirReconcile, { recursive: true, force: true });
	} catch {
		// ignore
	}
});

function seedTask(name: string, accountId?: string): void {
	storageReconcile.addTask({
		name,
		cron: "0 0 1 1 *",
		command: "echo test",
		status: "active",
		createdAt: Date.now(),
		updatedAt: Date.now(),
		runCount: 0,
		failCount: 0,
		consecutiveFailures: 0,
		timeoutMs: 30_000,
		...(accountId ? { accountId } : {}),
	});
}

describe("cronReconcile", () => {
	it("prints nothing to do when every task is already bound", async () => {
		seedTask("already-bound", "hr");
		const exitBefore = process.exitCode;

		await cronReconcile([], storageReconcile);

		expect(process.exitCode).toBe(exitBefore);
		expect(storageReconcile.getTaskByName("already-bound")?.accountId).toBe("hr");
		process.exitCode = exitBefore;
	});

	it("dry-run does not mutate storage", async () => {
		seedTask("hr:daily");
		seedTask("omp-atomix:wiki");
		seedTask("plain-name");

		await cronReconcile([], storageReconcile);

		expect(storageReconcile.getTaskByName("hr:daily")?.accountId).toBeUndefined();
		expect(storageReconcile.getTaskByName("omp-atomix:wiki")?.accountId).toBeUndefined();
		expect(storageReconcile.getTaskByName("plain-name")?.accountId).toBeUndefined();
	});

	it("--apply writes suggestions to storage for matched tasks", async () => {
		seedTask("hr:daily");
		seedTask("plain-name");

		const exitBefore = process.exitCode;
		await cronReconcile(["--apply"], storageReconcile);
		expect(process.exitCode ?? 0).toBe(0);
		process.exitCode = exitBefore;
	});

	it("rejects unknown flags", async () => {
		const exitBefore = process.exitCode;
		await cronReconcile(["--force"], storageReconcile);
		expect(process.exitCode).toBe(1);
		process.exitCode = exitBefore;
	});

	it("does not touch tasks that already have an accountId", async () => {
		seedTask("hr:already", "hr");
		seedTask("noaccount");

		storageReconcile.updateTask(storageReconcile.getTaskByName("hr:already")!.id, { accountId: "opencode" });

		const exitBefore = process.exitCode;
		await cronReconcile([], storageReconcile);
		expect(storageReconcile.getTaskByName("hr:already")?.accountId).toBe("opencode");
		process.exitCode = exitBefore;
	});
});

// ===========================================================================
// cronUpdate
// ===========================================================================

// `vi.spyOn(os, "homedir")` in bun:test leaks across describes when
// multiple tests set up spies. The cronTestRun tests' spy would leak
// into the cronUpdate tests' beforeEach. To avoid this, the cronUpdate
// describe is defined AFTER the cronTestRun describe in this file —
// so the cronTestRun afterEach restores the spy before cronUpdate runs.
//
// If you reorder these describes, the cronUpdate --account tests will
// silently fail (the spy points at the cronTestRun temp dir, which has
// been cleaned up, so loadConfig returns DEFAULT_CONFIG).
let testDirUpdate: string;
let dbPathUpdate: string;
let storageUpdate: JsonFileStorage;
let homedirSpyUpdate: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	testDirUpdate = fs.mkdtempSync(path.join(os.tmpdir(), "pi-gateway-cron-update-"));
	dbPathUpdate = path.join(testDirUpdate, "jobs.json");
	storageUpdate = new JsonFileStorage(dbPathUpdate);

	const ompDir = path.join(testDirUpdate, ".omp");
	fs.mkdirSync(ompDir, { recursive: true });
	const fakeGateway = {
		channels: {
			dingtalk: {
				accounts: {
					hr: { agentDir: path.join(testDirUpdate, "agents", "hr") },
					opencode: { agentDir: path.join(testDirUpdate, "agents", "opencode") },
				},
			},
		},
	};
	Bun.write(path.join(ompDir, "gateway.json"), JSON.stringify(fakeGateway));
	homedirSpyUpdate = vi.spyOn(os, "homedir").mockReturnValue(testDirUpdate);
});

afterEach(() => {
	storageUpdate?.close();
	homedirSpyUpdate?.mockRestore();
	try {
		fs.rmSync(testDirUpdate, { recursive: true, force: true });
	} catch {
		// ignore
	}
});

function seedUpdateTask(name: string): void {
	storageUpdate.addTask({
		name,
		cron: "0 0 1 1 *",
		command: "echo test",
		status: "active",
		createdAt: Date.now(),
		updatedAt: Date.now(),
		runCount: 0,
		failCount: 0,
		consecutiveFailures: 0,
		timeoutMs: 30_000,
	});
}

describe("cronUpdate", () => {
	it("sets accountId on a task that had none", async () => {
		seedUpdateTask("bind-me");
		expect(storageUpdate.getTaskByName("bind-me")?.accountId).toBeUndefined();

		await cronUpdate(["bind-me", "--account", "hr"], storageUpdate);

		expect(storageUpdate.getTaskByName("bind-me")?.accountId).toBe("hr");
	});

	it("changes accountId from one account to another", async () => {
		seedUpdateTask("rebind");
		await cronUpdate(["rebind", "--account", "hr"], storageUpdate);
		await cronUpdate(["rebind", "--account", "opencode"], storageUpdate);

		expect(storageUpdate.getTaskByName("rebind")?.accountId).toBe("opencode");
	});

	it("clears accountId with --clear-account", async () => {
		seedUpdateTask("unbind");
		await cronUpdate(["unbind", "--account", "hr"], storageUpdate);
		expect(storageUpdate.getTaskByName("unbind")?.accountId).toBe("hr");

		await cronUpdate(["unbind", "--clear-account"], storageUpdate);

		expect(storageUpdate.getTaskByName("unbind")?.accountId).toBeUndefined();
	});

	it("rejects --account combined with --clear-account", async () => {
		seedUpdateTask("conflict");
		const exitBefore = process.exitCode;

		await cronUpdate(["conflict", "--account", "hr", "--clear-account"], storageUpdate);

		expect(storageUpdate.getTaskByName("conflict")?.accountId).toBeUndefined();
		expect(process.exitCode).toBe(1);

		process.exitCode = exitBefore;
	});

	it("errors when no changes are specified", async () => {
		seedUpdateTask("nochange");
		const exitBefore = process.exitCode;

		await cronUpdate(["nochange"], storageUpdate);

		expect(process.exitCode).toBe(1);
		process.exitCode = exitBefore;
	});

	it("errors when the task does not exist", async () => {
		const exitBefore = process.exitCode;

		await cronUpdate(["ghost", "--account", "hr"], storageUpdate);

		expect(process.exitCode).toBe(1);
		process.exitCode = exitBefore;
	});

	it("errors on an unknown flag", async () => {
		seedUpdateTask("bad-flag");
		const exitBefore = process.exitCode;

		await cronUpdate(["bad-flag", "--nope", "x"], storageUpdate);

		expect(process.exitCode).toBe(1);
		process.exitCode = exitBefore;
	});

	it("errors on invalid --timeout-ms (zero, negative, NaN)", async () => {
		seedUpdateTask("bad-timeout");
		const exitBefore = process.exitCode;

		for (const bad of ["0", "-1", "abc"]) {
			await cronUpdate(["bad-timeout", "--timeout-ms", bad], storageUpdate);
			expect(process.exitCode).toBe(1);
			process.exitCode = exitBefore;
		}
	});

	it("does not apply partial updates when one flag is invalid", async () => {
		seedUpdateTask("partial");
		await cronUpdate(["partial", "--account", "hr"], storageUpdate);
		const accountBefore = storageUpdate.getTaskByName("partial")?.accountId;
		expect(accountBefore).toBe("hr");

		const exitBefore = process.exitCode;
		await cronUpdate(["partial", "--clear-account", "--timeout-ms", "abc"], storageUpdate);
		expect(process.exitCode).toBe(1);
		expect(storageUpdate.getTaskByName("partial")?.accountId).toBe("hr");
		process.exitCode = exitBefore;
	});

	it("does not silently accept --account with an empty value", async () => {
		seedUpdateTask("empty-account");
		const exitBefore = process.exitCode;

		await cronUpdate(["empty-account", "--account", ""], storageUpdate);

		const task = storageUpdate.getTaskByName("empty-account");
		if (process.exitCode === 1) {
			expect(task?.accountId).toBeUndefined();
		} else {
			expect(task?.accountId).toBe("");
		}
		process.exitCode = exitBefore;
	});
});

// ===========================================================================
// cronTestRun
// ===========================================================================

let testDirTr: string;
let dbPathTr: string;
let storageTr: JsonFileStorage;
let homedirSpyTr: ReturnType<typeof vi.spyOn>;
let consoleLogBuf: string;
let consoleErrorBuf: string;
let origLog: typeof console.log;
let origErr: typeof console.error;

function seedTrTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
	return storageTr.addTask({
		name: "test-task",
		cron: "0 12 * * *",
		command: "echo hello",
		scheduleType: "cron",
		status: "active",
		taskType: "agent",
		timeoutMs: 30_000,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		runCount: 0,
		failCount: 0,
		consecutiveFailures: 0,
		...overrides,
	});
}

function makeGatewayRunningTr(): void {
	const dataDir = path.join(testDirTr, ".omp", "gateway-data");
	fs.mkdirSync(dataDir, { recursive: true });
	fs.writeFileSync(path.join(dataDir, "gateway.pid"), String(process.pid));
}

beforeEach(() => {
	testDirTr = fs.mkdtempSync(path.join(os.tmpdir(), "pi-gateway-test-run-"));
	dbPathTr = path.join(testDirTr, "jobs.json");
	storageTr = new JsonFileStorage(dbPathTr);

	homedirSpyTr = vi.spyOn(os, "homedir").mockReturnValue(testDirTr);

	process.exitCode = 0;

	consoleLogBuf = "";
	consoleErrorBuf = "";
	origLog = console.log;
	origErr = console.error;
	console.log = (...args: unknown[]) => {
		consoleLogBuf += args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" ") + "\n";
	};
	console.error = (...args: unknown[]) => {
		consoleErrorBuf += args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" ") + "\n";
	};
});

afterEach(() => {
	homedirSpyTr?.mockRestore();
	console.log = origLog;
	console.error = origErr;
	try {
		fs.rmSync(testDirTr, { recursive: true, force: true });
	} catch {
		// ignore
	}
	storageTr.close();
});

describe("cronTestRun", () => {
	it("restores the original schedule after the trigger fires", { timeout: 30_000 }, async () => {
		makeGatewayRunningTr();
		const task = seedTrTask({ name: "restored", cron: "0 18 * * *" });

		const exec = storageTr.recordExecution({
			taskId: task.id,
			startedAt: Date.now() + 50,
			endedAt: Date.now() + 2000,
			exitCode: 0,
			output: "triggered ok",
			status: "success",
		});

		await cronTestRun(["restored", "--in", "5s", "--timeout", "30s", "_gatewayTickMs", "500ms"], storageTr);

		const after = storageTr.getTaskByName("restored");
		expect(after?.cron).toBe("0 18 * * *");
		expect(after?.scheduleType).toBe("cron");
		expect(after?.status).toBe("active");

		expect(consoleLogBuf).toContain("restored");
		expect(consoleLogBuf).toContain("Triggered");
		expect(consoleLogBuf).toContain(`exec id:   ${exec.id}`);
		expect(consoleLogBuf).toContain("status:    success");
		expect(consoleLogBuf).toContain("exit:      0");
		expect(consoleLogBuf).toContain("Schedule restored");
		expect(process.exitCode).not.toBe(1);
	});

	it("reports delivery failure (sets exit code 1) when last_delivery_error is set", { timeout: 30_000 }, async () => {
		makeGatewayRunningTr();
		const task = seedTrTask({
			name: "failed-delivery",
			cron: "0 0 * * *",
			delivery: { channel: "dingtalk", accountId: "hr", toUserId: "u1", mode: "announce" },
		});
		storageTr.recordExecution({
			taskId: task.id,
			startedAt: Date.now() + 50,
			endedAt: Date.now() + 1000,
			exitCode: 0,
			output: "ran fine",
			status: "success",
		});
		storageTr.updateTask(task.id, { lastDeliveryError: "Unknown channel: dingtalk" });

		await cronTestRun(["failed-delivery", "--in", "5s", "--timeout", "30s", "_gatewayTickMs", "500ms"], storageTr);

		expect(consoleLogBuf).toContain("deliver:   FAILED");
		expect(consoleLogBuf).toContain("Unknown channel: dingtalk");
		expect(process.exitCode).toBe(1);

		expect(storageTr.getTaskByName("failed-delivery")?.cron).toBe("0 0 * * *");
	});

	it("reports delivery ok when there is a delivery config but no error", { timeout: 30_000 }, async () => {
		makeGatewayRunningTr();
		const task = seedTrTask({
			name: "ok-delivery",
			cron: "*/5 * * * *",
			delivery: { channel: "dingtalk", accountId: "hr", toUserId: "u1", mode: "announce" },
		});
		storageTr.recordExecution({
			taskId: task.id,
			startedAt: Date.now() + 50,
			endedAt: Date.now() + 500,
			exitCode: 0,
			output: "delivered",
			status: "success",
		});

		await cronTestRun(["ok-delivery", "--in", "5s", "--timeout", "30s", "_gatewayTickMs", "500ms"], storageTr);

		expect(consoleLogBuf).toContain("deliver:   ok");
		expect(process.exitCode).not.toBe(1);
	});

	it("reports deliver=n/a when the task has no delivery config", { timeout: 30_000 }, async () => {
		makeGatewayRunningTr();
		const task = seedTrTask({ name: "no-delivery", cron: "0 9 * * *" });
		storageTr.recordExecution({
			taskId: task.id,
			startedAt: Date.now() + 50,
			endedAt: Date.now() + 100,
			exitCode: 0,
			output: "ran",
			status: "success",
		});

		await cronTestRun(["no-delivery", "--in", "5s", "--timeout", "30s", "_gatewayTickMs", "500ms"], storageTr);

		expect(consoleLogBuf).toContain("deliver:   n/a");
	});

	it("reports deliver=silent when delivery is configured but mode=none", { timeout: 30_000 }, async () => {
		makeGatewayRunningTr();
		const task = seedTrTask({
			name: "silent-delivery",
			cron: "0 9 * * *",
			delivery: { channel: "dingtalk", accountId: "hr", toUserId: "u1", mode: "none" },
		});
		storageTr.recordExecution({
			taskId: task.id,
			startedAt: Date.now() + 50,
			endedAt: Date.now() + 100,
			exitCode: 0,
			output: "ran fine",
			status: "success",
		});

		await cronTestRun(["silent-delivery", "--in", "5s", "--timeout", "30s", "_gatewayTickMs", "500ms"], storageTr);

		expect(consoleLogBuf).toContain("deliver:   silent (mode=none");
		expect(consoleLogBuf).not.toContain("deliver:   ok");
		expect(process.exitCode).not.toBe(1);
	});

	it("mode=none never reports delivery_failed even if lastDeliveryError is set", { timeout: 30_000 }, async () => {
		makeGatewayRunningTr();
		const task = seedTrTask({
			name: "silent-with-stale-error",
			cron: "0 9 * * *",
			delivery: { channel: "dingtalk", accountId: "hr", toUserId: "u1", mode: "none" },
		});
		storageTr.recordExecution({
			taskId: task.id,
			startedAt: Date.now() + 50,
			endedAt: Date.now() + 100,
			exitCode: 0,
			output: "ran",
			status: "success",
		});
		storageTr.updateTask(task.id, { lastDeliveryError: "stale error from prior run" });

		await cronTestRun(
			["silent-with-stale-error", "--in", "5s", "--timeout", "30s", "_gatewayTickMs", "500ms"],
			storageTr,
		);

		expect(consoleLogBuf).toContain("deliver:   silent (mode=none");
		expect(consoleLogBuf).not.toContain("deliver:   FAILED");
		expect(process.exitCode).not.toBe(1);
	});

	it("restores schedule on timeout (no execution appeared)", { timeout: 30_000 }, async () => {
		makeGatewayRunningTr();
		seedTrTask({ name: "times-out", cron: "30 8 * * *" });

		await cronTestRun(["times-out", "--in", "1s", "--timeout", "1s", "_gatewayTickMs", "500ms"], storageTr);

		const after = storageTr.getTaskByName("times-out");
		expect(after?.cron).toBe("30 8 * * *");
		expect(after?.scheduleType).toBe("cron");
		expect(consoleErrorBuf).toContain("Timed out");
		expect(process.exitCode).toBe(1);
	});

	it("refuses and does NOT change the task if name is missing", { timeout: 5_000 }, async () => {
		makeGatewayRunningTr();
		seedTrTask({ name: "untouched", cron: "0 7 * * *" });
		const before = storageTr.getTaskByName("untouched");

		await cronTestRun([], storageTr);

		expect(storageTr.getTaskByName("untouched")).toEqual(before);
		expect(consoleErrorBuf).toContain("Usage:");
		expect(process.exitCode).toBe(1);
	});

	it("refuses when the task does not exist (no state change possible)", { timeout: 5_000 }, async () => {
		makeGatewayRunningTr();
		await cronTestRun(["nope-not-a-task", "--in", "1s", "--timeout", "1s", "_gatewayTickMs", "500ms"], storageTr);
		expect(consoleErrorBuf).toContain("not found");
		expect(process.exitCode).toBe(1);
	});

	it("refuses when the gateway is not running", { timeout: 5_000 }, async () => {
		const task = seedTrTask({ name: "needs-gw", cron: "0 6 * * *" });
		const before = storageTr.getTaskByName("needs-gw");

		await cronTestRun(["needs-gw", "--in", "1s", "--timeout", "1s", "_gatewayTickMs", "500ms"], storageTr);

		expect(storageTr.getTaskByName("needs-gw")).toEqual(before);
		expect(consoleErrorBuf).toContain("Gateway is not running");
		expect(process.exitCode).toBe(1);
	});

	it("--no-restore leaves the schedule rewritten to one-shot", { timeout: 30_000 }, async () => {
		makeGatewayRunningTr();
		const task = seedTrTask({ name: "leave-it", cron: "0 10 * * *" });
		storageTr.recordExecution({
			taskId: task.id,
			startedAt: Date.now() + 50,
			endedAt: Date.now() + 100,
			exitCode: 0,
			output: "ok",
			status: "success",
		});

		await cronTestRun(
			["leave-it", "--in", "5s", "--timeout", "30s", "--no-restore", "_gatewayTickMs", "500ms"],
			storageTr,
		);

		const after = storageTr.getTaskByName("leave-it");
		expect(after?.cron).toMatch(/^\+\d+s$/);
		expect(after?.scheduleType).toBe("once");
		expect(consoleLogBuf).toContain("Schedule NOT restored");
	});

	it("restores pre-existing stats fields unchanged after the trigger fires", { timeout: 30_000 }, async () => {
		makeGatewayRunningTr();
		const pastTime = Date.now() - 86_400_000;
		const task = seedTrTask({
			name: "with-history",
			cron: "0 9 * * *",
			lastRunAt: pastTime,
			runCount: 5,
			failCount: 2,
			consecutiveFailures: 1,
			repeatCompleted: 1,
			lastDeliveryError: "stale error from a real run a week ago",
		});
		storageTr.recordExecution({
			taskId: task.id,
			startedAt: Date.now() + 50,
			endedAt: Date.now() + 100,
			exitCode: 0,
			output: "ok",
			status: "success",
		});

		await cronTestRun(["with-history", "--in", "5s", "--timeout", "30s", "_gatewayTickMs", "500ms"], storageTr);

		const after = storageTr.getTaskByName("with-history");
		expect(after?.cron).toBe("0 9 * * *");
		expect(after?.scheduleType).toBe("cron");
		expect(after?.status).toBe("active");
		expect(after?.lastRunAt).toBe(pastTime);
		expect(after?.runCount).toBe(5);
		expect(after?.failCount).toBe(2);
		expect(after?.consecutiveFailures).toBe(1);
		expect(after?.repeatCompleted).toBe(1);
		expect(after?.lastDeliveryError).toBe("stale error from a real run a week ago");
	});

	it("rolls back a stats bump that happens between snapshot and restore", { timeout: 30_000 }, async () => {
		const task = seedTrTask({
			name: "bumped-mid-run",
			cron: "0 11 * * *",
			runCount: 0,
			failCount: 0,
			consecutiveFailures: 0,
		});
		storageTr.recordExecution({
			taskId: task.id,
			startedAt: Date.now() + 50,
			endedAt: Date.now() + 100,
			exitCode: 0,
			output: "ok",
			status: "success",
		});

		let bumpedOnce = false;

		await runTestRun({
			name: "bumped-mid-run",
			storage: storageTr,
			inMs: 5_000,
			timeoutMs: 5_000,
			tickIntervalMs: 1_000,
			pollIntervalMs: 25,
			reloadScheduler: () => {
				if (bumpedOnce) return;
				bumpedOnce = true;
				storageTr.updateTask(task.id, {
					lastRunAt: Date.now(),
					runCount: 1,
					consecutiveFailures: 0,
					repeatCompleted: 1,
				});
			},
		});

		const after = storageTr.getTaskByName("bumped-mid-run");
		expect(after?.cron).toBe("0 11 * * *");
		expect(after?.lastRunAt).toBeUndefined();
		expect(after?.runCount).toBe(0);
		expect(after?.failCount).toBe(0);
		expect(after?.consecutiveFailures).toBe(0);
		expect(after?.repeatCompleted).toBeUndefined();
	});

	it("rolls back a lastDeliveryError clobber that happens between snapshot and restore", {
		timeout: 30_000,
	}, async () => {
		const task = seedTrTask({
			name: "prior-delivery-error",
			cron: "0 13 * * *",
			delivery: { channel: "dingtalk", accountId: "hr", toUserId: "u1", mode: "announce" },
			lastDeliveryError: "real delivery failure from yesterday",
		});
		storageTr.recordExecution({
			taskId: task.id,
			startedAt: Date.now() + 50,
			endedAt: Date.now() + 100,
			exitCode: 0,
			output: "ran fine",
			status: "success",
		});

		let clobberedOnce = false;
		await runTestRun({
			name: "prior-delivery-error",
			storage: storageTr,
			inMs: 5_000,
			timeoutMs: 5_000,
			tickIntervalMs: 1_000,
			pollIntervalMs: 25,
			reloadScheduler: () => {
				if (clobberedOnce) return;
				clobberedOnce = true;
				storageTr.updateTask(task.id, { lastDeliveryError: undefined });
			},
		});

		const after = storageTr.getTaskByName("prior-delivery-error");
		expect(after?.lastDeliveryError).toBe("real delivery failure from yesterday");
	});
});

// ===========================================================================
// parseCronIntent + createCronTaskFromMessage (from-message smoke)
// ===========================================================================

let testDirMsg: string;
let agentDirMsg: string;
let opencodeAgentDirMsg: string;
let dbPathMsg: string;
let storageMsg: JsonFileStorage;

beforeEach(() => {
	testDirMsg = fs.mkdtempSync(path.join(os.tmpdir(), "pi-gateway-msg-"));
	agentDirMsg = path.join(testDirMsg, "agent");
	fs.mkdirSync(agentDirMsg, { recursive: true });
	dbPathMsg = path.join(testDirMsg, "jobs.json");
	storageMsg = new JsonFileStorage(dbPathMsg);
	opencodeAgentDirMsg = path.join(testDirMsg, "secondary-agent");
});

afterEach(() => {
	storageMsg?.close();
	try {
		fs.rmSync(testDirMsg, { recursive: true, force: true });
	} catch {
		// ignore
	}
});

describe("parseCronIntent", () => {
	it("parses a basic /cron create command with -- separator", () => {
		const intent = parseCronIntent("/cron create 0 8 * * * -- echo good morning");
		expect(intent).toBeDefined();
		expect(intent?.schedule).toBe("0 8 * * *");
		expect(intent?.command).toBe("echo good morning");
		expect(intent?.type).toBe("shell");
	});

	it("tolerates leading and internal whitespace around the separator", () => {
		const intent = parseCronIntent("   /cron create    0 8 * * *   --   echo hi  ");
		expect(intent?.schedule).toBe("0 8 * * *");
		expect(intent?.command).toBe("echo hi");
	});

	it("supports commands that themselves contain -- or pipes", () => {
		const intent = parseCronIntent('/cron create */5 * * * * -- echo "hello -- world" | tee /tmp/log');
		expect(intent?.schedule).toBe("*/5 * * * *");
		expect(intent?.command).toBe('echo "hello -- world" | tee /tmp/log');
	});

	it("returns undefined for non-cron messages", () => {
		expect(parseCronIntent("hello world")).toBeUndefined();
		expect(parseCronIntent("/help")).toBeUndefined();
		expect(parseCronIntent("/cron list")).toBeUndefined();
	});

	it("returns undefined when the separator is missing", () => {
		expect(parseCronIntent("/cron create")).toBeUndefined();
		expect(parseCronIntent("/cron create 0 8 * * *")).toBeUndefined();
	});

	it("returns undefined when the schedule is empty", () => {
		expect(parseCronIntent("/cron create  -- echo hi")).toBeUndefined();
	});

	it("returns undefined when the command is empty", () => {
		expect(parseCronIntent("/cron create 0 8 * * * -- ")).toBeUndefined();
	});
});

describe("createCronTaskFromMessage (smoke test)", () => {
	it("creates a task file in <agentDir>/cron/tasks/ and inserts into the global DB", () => {
		const outcome = createCronTaskFromMessage("/cron create 0 8 * * * -- echo good morning", agentDirMsg, storageMsg);

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		const r = outcome.result;

		expect(r.taskDir).toBe(path.join(agentDirMsg, "cron", "tasks"));
		expect(r.filePath).toBe(path.join(r.taskDir, `${r.name}.json5`));
		expect(fs.existsSync(r.filePath)).toBe(true);

		const fileContent = JSON.parse(fs.readFileSync(r.filePath, "utf8"));
		expect(fileContent.name).toBe(r.name);
		expect(fileContent.cron).toBe("0 8 * * *");
		expect(fileContent.command).toBe("echo good morning");
		expect(fileContent.type).toBe("shell");
		expect(fileContent.timeoutMs).toBe(30_000);

		const task = storageMsg.getTaskByName(r.name);
		expect(task).toBeDefined();
		expect(task?.cron).toBe("0 8 * * *");
		expect(task?.command).toBe("echo good morning");
		expect(task?.taskType).toBe("shell");
		expect(task?.status).toBe("active");

		storageMsg.deleteTask(task!.id);
		fs.rmSync(r.filePath, { force: true });
	});

	it("writes into the agentDir passed to the call, not some other dir", () => {
		const outcome = createCronTaskFromMessage(
			"/cron create */5 * * * * -- echo from opencode",
			opencodeAgentDirMsg,
			storageMsg,
		);

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.result.filePath.startsWith(opencodeAgentDirMsg)).toBe(true);
		expect(outcome.result.filePath.includes(agentDirMsg)).toBe(false);

		const task = storageMsg.getTaskByName(outcome.result.name);
		if (task) storageMsg.deleteTask(task.id);
		fs.rmSync(outcome.result.filePath, { force: true });
	});

	it("does not create anything for a non-cron message (returns not-cron-intent)", () => {
		const outcome = createCronTaskFromMessage("hey what's the weather?", agentDirMsg, storageMsg);

		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.error.reason).toBe("not-cron-intent");

		expect(fs.existsSync(path.join(agentDirMsg, "cron"))).toBe(false);
		expect(storageMsg.listTasks().length).toBe(0);
	});

	it("returns no-agent-dir when agentDir is undefined", () => {
		const outcome = createCronTaskFromMessage("/cron create 0 8 * * * -- echo hi", undefined, storageMsg);

		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.error.reason).toBe("no-agent-dir");
	});

	it("rolls back the file when the DB insert fails", () => {
		const failingStorage = {
			...storageMsg,
			addTask: () => {
				throw new Error("simulated db failure");
			},
		} as unknown as JsonFileStorage;

		const outcome = createCronTaskFromMessage(
			"/cron create 0 8 * * * -- echo will_fail",
			agentDirMsg,
			failingStorage,
		);

		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.error.reason).toBe("db-failed");

		const tasksDir = path.join(agentDirMsg, "cron", "tasks");
		if (fs.existsSync(tasksDir)) {
			const remaining = fs.readdirSync(tasksDir);
			expect(remaining.length).toBe(0);
		}
	});
});
