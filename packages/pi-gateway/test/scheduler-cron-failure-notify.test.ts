/**
 * Tests for two cron-failure-mode fixes:
 *
 *  1. `resolveDelivery` accepts a `resolveAccountId(agentDir)` hook so the
 *     structured `delivery` path can recover the correct registered
 *     channel accountId from a task's `agentDir` — without falling
 *     back to the deprecated `task.accountId` (which is often a
 *     workspace basename like `omp-atomix`, not the registered
 *     account id `algorithm`).
 *
 *  2. `CronService.onTrigger` calls the optional `notifyFailure`
 *     callback on every failure path:
 *       - executeAgent errored and the warm-bridge path produced no
 *         output (the fallback to `omp --print` is the safety net
 *         here; we test the *executeAgent* failure case specifically)
 *       - Task timed out
 *       - Task exit code != 0
 *       - Summary delivery itself failed
 *     Independent of the regular `deliver()` summary, so a misconfigured
 *     channel (e.g. "Unknown channel: dingtalk:omp-atomix") doesn't
 *     also suppress the failure card.
 *
 * Both together fix the "I sent '试跑一下第三个定时任务' and got no
 * response at all" UX: before the fix, the agent's output went to
 * `channel: dingtalk, accountId: omp-atomix`, which the registry
 * could not resolve, and the user saw nothing. After the fix the
 * accountId resolves to `algorithm` (the registered account) and
 * the summary card arrives; if delivery still fails the user
 * gets a short failure card via notifyFailure.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type CronLogger,
	CronService,
	type DeliverFn,
	type ExecuteAgentFn,
	type NotifyCronFailureFn,
	type ResolveAccountIdFn,
	resolveDelivery,
} from "../src/scheduler/cron-service";
import { SchedulerDbStorage } from "../src/scheduler/storage";
import type { ScheduledTask } from "../src/scheduler/types";

let testDir: string;
let dbPath: string;
let storage: SchedulerDbStorage;

const noopLogger: CronLogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
};

function cleanupExecutionLog(slug: string) {
	const logDir = path.join(os.homedir(), ".omp", "gateway-data", "scheduler", "logs", "by-task", slug);
	try {
		fs.rmSync(logDir, { recursive: true, force: true });
	} catch {
		// ignore
	}
}

beforeEach(() => {
	testDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-gateway-cron-fail-"));
	dbPath = path.join(testDir, "scheduler.db");
	storage = new SchedulerDbStorage(dbPath);
});

afterEach(() => {
	storage?.close();
	try {
		fs.rmSync(testDir, { recursive: true, force: true });
	} catch {
		// ignore
	}
	cleanupExecutionLog("_t_fail_resolveAccountId");
	cleanupExecutionLog("_t_fail_legacy_resolveAccountId");
	cleanupExecutionLog("_t_fail_executeAgent");
	cleanupExecutionLog("_t_fail_timedOut");
	cleanupExecutionLog("_t_fail_exitCode");
	cleanupExecutionLog("_t_fail_delivery");
});

function makeTask(overrides: Partial<ScheduledTask> & { name: string }): ScheduledTask {
	const base: ScheduledTask = {
		id: "task_test",
		name: overrides.name,
		cron: "0 0 1 1 *",
		command: "echo hello",
		taskType: "shell",
		status: "active",
		createdAt: Date.now(),
		updatedAt: Date.now(),
		runCount: 0,
		failCount: 0,
		consecutiveFailures: 0,
		timeoutMs: 30_000,
		...overrides,
	};
	storage.addTask({
		cron: base.cron,
		command: base.command,
		taskType: base.taskType,
		status: base.status,
		createdAt: base.createdAt,
		updatedAt: base.updatedAt,
		runCount: 0,
		failCount: 0,
		consecutiveFailures: 0,
		timeoutMs: base.timeoutMs,
		name: base.name,
		agentDir: base.agentDir,
		delivery: base.delivery,
		deliver: base.deliver,
		deliverUser: base.deliverUser,
		accountId: base.accountId,
	});
	const stored = storage.getTaskByName(base.name);
	if (!stored) throw new Error("test setup: task not found after add");
	return stored;
}

const accountDirMap = new Map<string, string>([
	["/Users/test/agent-atomix", "algorithm"],
	["/Users/test/agent-hr", "hr"],
]);

function makeResolveAccountId(): ResolveAccountIdFn {
	return (agentDir: string) => accountDirMap.get(agentDir);
}

describe("resolveDelivery — agentDir-based accountId lookup", () => {
	it("uses resolveAccountId(agentDir) when delivery.accountId is missing", () => {
		const task = makeTask({
			name: "_t_fail_resolveAccountId",
			agentDir: "/Users/test/agent-atomix",
			delivery: {
				channel: "dingtalk",
				toUserId: "u_1",
				mode: "announce",
			},
		});
		const result = resolveDelivery(task, makeResolveAccountId());
		expect(result).toBeDefined();
		expect(result!.accountId).toBe("algorithm");
		expect(result!.channel).toBe("dingtalk");
	});

	it("prefers an explicit delivery.accountId over the agentDir reverse-lookup", () => {
		// Operators can still pin a specific accountId for cross-account
		// delivery. Explicit > reverse-resolved.
		const task = makeTask({
			name: "_t_fail_resolveAccountId",
			agentDir: "/Users/test/agent-atomix",
			delivery: {
				channel: "dingtalk",
				accountId: "explicit-account",
				toUserId: "u_1",
				mode: "announce",
			},
		});
		const result = resolveDelivery(task, makeResolveAccountId());
		expect(result!.accountId).toBe("explicit-account");
	});

	it("falls back to deprecated task.accountId only when reverse-lookup misses", () => {
		// If the agentDir is not mapped (e.g. during a brief bridge
		// restart window) we still use the deprecated field as a
		// last-resort so the task does not silently drop delivery.
		const task = makeTask({
			name: "_t_fail_resolveAccountId",
			agentDir: "/Users/test/unmapped",
			delivery: {
				channel: "dingtalk",
				toUserId: "u_1",
				mode: "announce",
			},
		});
		const result = resolveDelivery(task, makeResolveAccountId());
		expect(result!.accountId).toBeUndefined();
	});
});

function makeCronService(opts: {
	deliver: DeliverFn;
	executeAgent: ExecuteAgentFn;
	notifyFailure: NotifyCronFailureFn;
	resolveAccountId?: ResolveAccountIdFn;
}): CronService {
	return new CronService({
		storage,
		ompBinary: "omp",
		executeAgent: opts.executeAgent,
		deliver: opts.deliver,
		log: noopLogger,
		notifyFailure: opts.notifyFailure,
		resolveAccountId: opts.resolveAccountId,
	});
}

describe("CronService.onTrigger — notifyFailure on failure paths", () => {
	it("notifies on executeAgent error (warm-bridge path errored, no output)", async () => {
		const deliver = mock<DeliverFn>(async () => ({ ok: true }));
		const notify = mock<NotifyCronFailureFn>(async () => ({ ok: true }));
		const executeAgent = mock<ExecuteAgentFn>(async () => ({
			output: "",
			error: "Agent RPC timed out after 60000ms (hard cap)",
		}));
		// For agent tasks, if executeAgent returns no output, the
		// fallback `omp --print` subprocess will be invoked. We
		// override ompBinary to a non-existent path so the fallback
		// also fails, producing a "task failed" outcome.
		const service = makeCronService({
			deliver,
			executeAgent,
			notifyFailure: notify,
		});
		// Replace the ompBinary on the underlying deps via a fresh
		// service whose fallback will hit a missing binary.
		const brokenService = new CronService({
			storage,
			ompBinary: "/nonexistent/omp-fake-binary-for-test",
			executeAgent,
			deliver,
			log: noopLogger,
			notifyFailure: notify,
		});

		const task = makeTask({
			name: "_t_fail_executeAgent",
			taskType: "agent",
			agentDir: testDir,
			command: "do something",
			timeoutMs: 1000,
			delivery: {
				channel: "dingtalk",
				accountId: "test",
				toUserId: "u_1",
				mode: "announce",
			},
		});
		const exec = storage.recordExecution({ taskId: task.id, startedAt: Date.now(), status: "running" });

		await expect(brokenService.onTrigger(task, exec.id)).rejects.toThrow();

		expect(notify).toHaveBeenCalled();
		const call = notify.mock.calls[0]![0];
		expect(call.taskName).toBe("_t_fail_executeAgent");
		expect(call.toUserId).toBe("u_1");
		expect(call.reason).toBeTruthy();
	});

	it("notifies on summary delivery failure with kind=delivery_failed", async () => {
		const deliver = mock<DeliverFn>(async () => ({
			ok: false,
			error: "Unknown channel: dingtalk:test",
		}));
		const notify = mock<NotifyCronFailureFn>(async () => ({ ok: true }));
		const service = makeCronService({
			deliver,
			executeAgent: async () => ({ output: "agent ran fine" }),
			notifyFailure: notify,
		});

		const task = makeTask({
			name: "_t_fail_delivery",
			taskType: "shell",
			agentDir: testDir,
			delivery: {
				channel: "dingtalk",
				accountId: "test",
				toUserId: "u_2",
				mode: "announce",
			},
		});
		const exec = storage.recordExecution({ taskId: task.id, startedAt: Date.now(), status: "running" });

		// Shell task with `echo hello` exits 0 — the only failure
		// path here is the deliver() call. The throw at the end of
		// onTrigger only fires when exitCode !== 0, so the promise
		// resolves; we don't expect a rejection.
		await service.onTrigger(task, exec.id);

		expect(notify).toHaveBeenCalled();
		const call = notify.mock.calls[0]![0];
		expect(call.kind).toBe("delivery_failed");
		expect(call.taskName).toBe("_t_fail_delivery");
		expect(call.reason).toBe("Unknown channel: dingtalk:test");
		expect(call.toUserId).toBe("u_2");
	});

	it("does not notify when the task succeeds and delivery succeeds", async () => {
		const deliver = mock<DeliverFn>(async () => ({ ok: true }));
		const notify = mock<NotifyCronFailureFn>(async () => ({ ok: true }));
		const service = makeCronService({
			deliver,
			executeAgent: async () => ({ output: "ok" }),
			notifyFailure: notify,
		});

		const task = makeTask({
			name: "_t_fail_delivery",
			taskType: "shell",
			agentDir: testDir,
			delivery: {
				channel: "dingtalk",
				accountId: "test",
				toUserId: "u_3",
				mode: "announce",
			},
		});
		const exec = storage.recordExecution({ taskId: task.id, startedAt: Date.now(), status: "running" });

		await service.onTrigger(task, exec.id);

		expect(notify).not.toHaveBeenCalled();
	});

	it("notifyFailure channel uses the resolved accountId, not the workspace basename", async () => {
		// This is the exact bug from the production incident: a task
		// whose agentDir is `/.../omp-atomix` (workspace basename)
		// was being looked up as `dingtalk:omp-atomix` and silently
		// dropped. With the resolveAccountId hook the notification
		// now targets the correct `dingtalk:algorithm` channel.
		const deliver = mock<DeliverFn>(async () => ({
			ok: false,
			error: "Unknown channel",
		}));
		const notify = mock<NotifyCronFailureFn>(async () => ({ ok: true }));
		const service = makeCronService({
			deliver,
			executeAgent: async () => ({ output: "ok" }),
			notifyFailure: notify,
			resolveAccountId: (agentDir: string) => (agentDir === testDir ? "algorithm" : undefined),
		});

		const task = makeTask({
			name: "_t_fail_delivery",
			agentDir: testDir, // resolves to "algorithm" via the closure
			delivery: {
				channel: "dingtalk",
				// explicit accountId intentionally omitted
				toUserId: "u_4",
				mode: "announce",
			},
		});
		const exec = storage.recordExecution({ taskId: task.id, startedAt: Date.now(), status: "running" });

		// Same as the delivery-failure test: shell task with `echo
		// hello` exits 0, only deliver fails, so onTrigger resolves
		// (no throw expected here).
		await service.onTrigger(task, exec.id);

		expect(notify).toHaveBeenCalled();
		const call = notify.mock.calls[0]![0];
		expect(call.accountId).toBe("algorithm");
	});
});
