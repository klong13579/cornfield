/**
 * Tests for appendDeliveryFailureLog and the deliverWithRetry helper used
 * by the gateway's cron result delivery path.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { appendDeliveryFailureLog, setLogRoot } from "../src/scheduler/execution-log";

describe("appendDeliveryFailureLog", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-gateway-delivery-log-"));
		setLogRoot(tmpDir);
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	test("writes a single JSONL line to delivery-failures.jsonl", async () => {
		appendDeliveryFailureLog({
			ts: 1_700_000_000_000,
			taskId: "task-1",
			taskName: "daily-report",
			channel: "dingtalk:hr",
			userId: "user-42",
			reason: "sendToChannel returned false after 2 attempts",
			attempts: 2,
			exitCode: 0,
		});

		const logPath = path.join(tmpDir, "delivery-failures.jsonl");
		const content = await fs.readFile(logPath, "utf8");
		const lines = content.trim().split("\n");
		expect(lines).toHaveLength(1);
		const entry = JSON.parse(lines[0]!);
		expect(entry).toEqual({
			ts: 1_700_000_000_000,
			taskId: "task-1",
			taskName: "daily-report",
			channel: "dingtalk:hr",
			userId: "user-42",
			reason: "sendToChannel returned false after 2 attempts",
			attempts: 2,
			exitCode: 0,
		});
	});

	test("appends multiple entries on successive calls", async () => {
		for (let i = 0; i < 3; i++) {
			appendDeliveryFailureLog({
				ts: 1_700_000_000_000 + i * 1000,
				taskId: `task-${i}`,
				taskName: `name-${i}`,
				channel: "dingtalk:hr",
				userId: "user-42",
				reason: "channel down",
				attempts: 2,
				exitCode: 1,
			});
		}
		const logPath = path.join(tmpDir, "delivery-failures.jsonl");
		const content = await fs.readFile(logPath, "utf8");
		expect(content.trim().split("\n")).toHaveLength(3);
	});

	test("creates the log root directory if it does not exist", async () => {
		// Use a nested root that doesn't exist yet.
		const nestedRoot = path.join(tmpDir, "nested", "logs");
		setLogRoot(nestedRoot);
		appendDeliveryFailureLog({
			ts: 1_700_000_000_000,
			taskId: "task-x",
			taskName: "name-x",
			channel: "dingtalk:hr",
			userId: "user-1",
			reason: "ok",
			attempts: 1,
			exitCode: 0,
		});
		const stat = await fs.stat(path.join(nestedRoot, "delivery-failures.jsonl"));
		expect(stat.isFile()).toBe(true);
	});
});
