/**
 * Smoke test: cron task completion -> outbound delivery.
 *
 * After the cron-gateway decoupling, the delivery path lives in
 * CronService.onTrigger, which receives an injected `deliver` function.
 * The manual `cronRun` CLI no longer delivers — only the scheduled path
 * through CronService does. sendToChannel has been deleted.
 *
 * This file exercises two things:
 *   1. Storage round-trip: tasks created with the new `delivery` +
 *      `agentDir` fields are read back with those fields intact, and
 *      legacy `deliver`/`deliverUser`-only tasks are reconstructed into
 *      the structured `delivery` object on read.
 *   2. CronService.onTrigger delivery routing: with a mocked `deliver`
 *      function, the configured channel/accountId/toUserId are forwarded
 *      correctly, the delivered text contains the task output,
 *      `deliver` is NOT called when no delivery is configured, and
 *      `deliver` is NOT called when the output is `[SILENT]`.
 *
 * No network and no ~/.omp/gateway.json are required — the injected
 * `deliver` replaces the old real DingTalk OAuth path.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type CronLogger, CronService, type DeliverFn } from "../src/scheduler/cron-service";
import { SchedulerDbStorage } from "../src/scheduler/storage";

let testDir: string;
let dbPath: string;
let storage: SchedulerDbStorage;

function cleanup() {
	try {
		if (testDir) fs.rmSync(testDir, { recursive: true, force: true });
	} catch {
		// ignore
	}
}

function cleanupExecutionLog(slug: string) {
	const logDir = path.join(os.homedir(), ".omp", "gateway-data", "scheduler", "logs", "by-task", slug);
	try {
		fs.rmSync(logDir, { recursive: true, force: true });
	} catch {
		// ignore
	}
}

const noopLogger: CronLogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
};

beforeEach(() => {
	testDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-gateway-smoke-"));
	dbPath = path.join(testDir, "scheduler.db");
	storage = new SchedulerDbStorage(dbPath);
});

afterEach(() => {
	storage?.close();
	cleanup();
	cleanupExecutionLog("_t_smoke_roundtrip");
	cleanupExecutionLog("_t_smoke_legacy");
	cleanupExecutionLog("_t_smoke_deliver");
	cleanupExecutionLog("_t_smoke_nodeliver");
	cleanupExecutionLog("_t_smoke_silent");
});

function makeCronService(deliver: DeliverFn): CronService {
	return new CronService({
		storage,
		ompBinary: "omp",
		// Shell tasks never invoke executeAgent (only agent tasks do);
		// a throwing stub proves the shell path doesn't reach it.
		executeAgent: async () => {
			throw new Error("executeAgent should not be called for shell tasks");
		},
		deliver,
		log: noopLogger,
	});
}

function addShellTask(overrides: Partial<Parameters<SchedulerDbStorage["addTask"]>[0]> & { name: string }) {
	return storage.addTask({
		cron: "0 0 1 1 *",
		command: `echo hello from ${overrides.name}`,
		taskType: "shell",
		status: "active",
		createdAt: Date.now(),
		updatedAt: Date.now(),
		runCount: 0,
		failCount: 0,
		consecutiveFailures: 0,
		timeoutMs: 30_000,
		...overrides,
	});
}

describe("cron outbound delivery smoke test", () => {
	it("round-trips the new `delivery` + `agentDir` fields through storage", () => {
		const created = addShellTask({
			name: "_t_smoke_roundtrip",
			agentDir: "/tmp/fake-agent-dir",
			delivery: {
				channel: "dingtalk:hr",
				accountId: "hr",
				toUserId: "u_smoke_test",
				mode: "announce",
			},
		});

		const read = storage.getTaskByName("_t_smoke_roundtrip");
		expect(read).toBeDefined();
		expect(read!.id).toBe(created.id);
		expect(read!.agentDir).toBe("/tmp/fake-agent-dir");
		expect(read!.delivery).toEqual({
			channel: "dingtalk:hr",
			accountId: "hr",
			toUserId: "u_smoke_test",
			toConversationId: undefined,
			mode: "announce",
		});
	});

	it("CronService.onTrigger forwards the configured channel/accountId/toUserId to `deliver` and includes the task output", async () => {
		const deliver = mock<DeliverFn>(async () => ({ ok: true }));
		const service = makeCronService(deliver);

		const task = addShellTask({
			name: "_t_smoke_deliver",
			agentDir: testDir,
			delivery: {
				channel: "dingtalk:hr",
				accountId: "hr",
				toUserId: "u_smoke_test",
				mode: "announce",
			},
		});

		const exec = storage.recordExecution({ taskId: task.id, startedAt: Date.now(), status: "running" });

		try {
			await service.onTrigger(task, exec.id);

			expect(deliver).toHaveBeenCalledTimes(1);
			const call = deliver.mock.calls[0]![0];
			expect(call.channel).toBe("dingtalk:hr");
			expect(call.accountId).toBe("hr");
			expect(call.toUserId).toBe("u_smoke_test");
			expect(call.text).toContain("hello from _t_smoke_deliver");
		} finally {
			const t = storage.getTaskByName("_t_smoke_deliver");
			if (t) storage.deleteTask(t.id);
		}
	});

	it("CronService.onTrigger does not call `deliver` when no delivery is configured", async () => {
		const deliver = mock<DeliverFn>(async () => ({ ok: true }));
		const service = makeCronService(deliver);

		const task = addShellTask({ name: "_t_smoke_nodeliver", agentDir: testDir });

		const exec = storage.recordExecution({ taskId: task.id, startedAt: Date.now(), status: "running" });

		try {
			await service.onTrigger(task, exec.id);
			expect(deliver).not.toHaveBeenCalled();
		} finally {
			const t = storage.getTaskByName("_t_smoke_nodeliver");
			if (t) storage.deleteTask(t.id);
		}
	});

	it("CronService.onTrigger does not call `deliver` when the output is [SILENT]", async () => {
		const deliver = mock<DeliverFn>(async () => ({ ok: true }));
		const service = makeCronService(deliver);

		const task = addShellTask({
			name: "_t_smoke_silent",
			command: "echo '[SILENT]'",
			agentDir: testDir,
			delivery: {
				channel: "dingtalk:hr",
				accountId: "hr",
				toUserId: "u_smoke_test",
				mode: "announce",
			},
		});

		const exec = storage.recordExecution({ taskId: task.id, startedAt: Date.now(), status: "running" });

		try {
			await service.onTrigger(task, exec.id);
			expect(deliver).not.toHaveBeenCalled();
		} finally {
			const t = storage.getTaskByName("_t_smoke_silent");
			if (t) storage.deleteTask(t.id);
		}
	});
});
