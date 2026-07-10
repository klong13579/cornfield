/**
 * Cron lifecycle integration tests.
 *
 *   - `cron-card-delivery.test.ts` — deliverCronResultAsCard: card
 *     create + finish, status emoji mapping, ButtonGroup actions, error
 *     fallbacks (returns ok:false on create-null / finish-throw).
 *   - `cron-diagnostics-bugfix.test.ts` — warm bridge fail + subprocess
 *     timeout: JSONL must record status="failure" with structured
 *     diagnostics from both agent-run and exec sources.
 *   - `cron-restore-logging.test.ts` — setModel/setDisabledToolsets
 *     throw during the finally-block restore after a cron task: error
 *     MUST be logged, not silently swallowed.
 *   - `cron-warm-bridge-fallback.test.ts` — warm-bridge executePrompt
 *     failure must fall back to subprocess (omp --print); task
 *     succeeds if the subprocess succeeds.
 *
 * All four test the cron execution lifecycle: delivery rendering,
 * failure diagnostics, restore error logging, fallback orchestration.
 * Co-located here.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import * as cardModule from "../src/channels/dingtalk-card";
import { Gateway } from "../src/gateway";
import { type CronCardPayload, deliverCronResultAsCard } from "../src/scheduler/cron-card-delivery";
import { readExecutionLog, setLogRoot } from "../src/scheduler/execution-log";
import { JsonFileStorage } from "../src/scheduler/json-file-storage";
import type { DingTalkConfig, GatewayConfig } from "../src/types";

// ===========================================================================
// deliverCronResultAsCard (unit-level card rendering)
// ===========================================================================

const DINGTALK_CONFIG: DingTalkConfig = {
	enabled: true,
	appKey: "test-app-key",
	appSecret: "test-app-secret",
	robotCode: "test-robot-code",
};

const FAKE_CARD: cardModule.AICardInstance = {
	cardInstanceId: "card_test_123",
	accessToken: "fake-token",
	tokenExpireTime: Date.now() + 2 * 60 * 60 * 1000,
	inputingStarted: false,
};

const USER_TARGET: cardModule.AICardTarget = { type: "user", userId: "user_test_1" };

function makePayload(overrides: Partial<CronCardPayload> = {}): CronCardPayload {
	return {
		taskName: "daily-brief",
		taskId: "task_abc",
		slug: "daily-brief",
		status: "success",
		exitCode: 0,
		durationMs: 1234,
		output: "## Summary\n\n3 PRs merged today.\n\n- PR #1\n- PR #2",
		...overrides,
	};
}

describe("deliverCronResultAsCard", () => {
	let createSpy: ReturnType<typeof spyOn>;
	let finishSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		createSpy = spyOn(cardModule, "createAICardForTarget").mockResolvedValue(FAKE_CARD);
		finishSpy = spyOn(cardModule, "finishAICard").mockResolvedValue(undefined);
	});

	afterEach(() => {
		createSpy.mockRestore();
		finishSpy.mockRestore();
	});

	it("creates a card and finishes it with the agent's full output as the body", async () => {
		const payload = makePayload({
			output: "## Hello\n\nLong markdown body that would have been truncated to 2000 chars by the legacy text path.",
		});

		const result = await deliverCronResultAsCard({
			dingtalkConfig: DINGTALK_CONFIG,
			target: USER_TARGET,
			card: payload,
		});

		expect(result.ok).toBe(true);

		expect(createSpy).toHaveBeenCalledTimes(1);
		const [, , createOpts] = createSpy.mock.calls[0]!;
		expect(createOpts?.statusLine).toBe("exit 0 · 1.2s");

		expect(finishSpy).toHaveBeenCalledTimes(1);
		const [, finishedData] = finishSpy.mock.calls[0]!;
		expect(finishedData.content).toContain("Long markdown body that would have been truncated");
		expect(finishedData.content).toMatch(/^✅ daily-brief \(exit 0, 1\.2s\)/);
		expect(finishedData.copyContent).toBe(finishedData.content);
	});

	it("includes a ButtonGroup block with 查看执行日志 and 复制输出 buttons", async () => {
		const payload = makePayload();

		const result = await deliverCronResultAsCard({
			dingtalkConfig: DINGTALK_CONFIG,
			target: USER_TARGET,
			card: payload,
		});
		expect(result.ok).toBe(true);

		const finishedData = finishSpy.mock.calls[0]![1];
		const actionBlock = finishedData.blockList.find(b => b.type === cardModule.BlockType.STOP);
		expect(actionBlock).toBeDefined();
		expect(actionBlock?.btns).toHaveLength(2);

		const logBtn = actionBlock?.btns?.find(b => b.text === "查看执行日志");
		expect(logBtn?.actionType).toBe("url");
		expect(logBtn?.url).toMatch(
			/^file:\/\/.*\.omp\/gateway-data\/scheduler\/logs\/by-task\/daily-brief\/\d{4}-\d{2}-\d{2}\.jsonl$/,
		);

		const copyBtn = actionBlock?.btns?.find(b => b.text === "复制输出");
		expect(copyBtn?.actionType).toBe("call_back");
		expect(copyBtn?.params?.copyText).toContain("## Summary");
	});

	it("renders failure status with ❌ emoji and surfaces the error in the footer", async () => {
		const payload = makePayload({
			status: "failure",
			exitCode: 1,
			output: "Tool call failed",
			error: "ENOSPC: no space left on device",
		});

		const result = await deliverCronResultAsCard({
			dingtalkConfig: DINGTALK_CONFIG,
			target: USER_TARGET,
			card: payload,
		});
		expect(result.ok).toBe(true);

		const [, finishedData] = finishSpy.mock.calls[0]!;
		expect(finishedData.content).toMatch(/^❌ daily-brief \(exit 1,/);
		expect(finishedData.statusLine).toContain("ENOSPC");
	});

	it("renders timed_out status with ⏰ emoji", async () => {
		const payload = makePayload({ status: "timed_out", exitCode: 124, durationMs: 60_000 });

		const result = await deliverCronResultAsCard({
			dingtalkConfig: DINGTALK_CONFIG,
			target: USER_TARGET,
			card: payload,
		});
		expect(result.ok).toBe(true);

		const [, finishedData] = finishSpy.mock.calls[0]!;
		expect(finishedData.content).toMatch(/^⏰ daily-brief \(exit 124,/);
	});

	it("substitutes a placeholder when the output is empty", async () => {
		const payload = makePayload({ output: "   \n\n  " });

		const result = await deliverCronResultAsCard({
			dingtalkConfig: DINGTALK_CONFIG,
			target: USER_TARGET,
			card: payload,
		});
		expect(result.ok).toBe(true);

		const [, finishedData] = finishSpy.mock.calls[0]!;
		expect(finishedData.content).toContain("无输出");
	});

	it("returns { ok: false } and does NOT call finishAICard when createAICardForTarget returns null", async () => {
		createSpy.mockResolvedValue(null);

		const result = await deliverCronResultAsCard({
			dingtalkConfig: DINGTALK_CONFIG,
			target: USER_TARGET,
			card: makePayload(),
		});

		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/createAICardForTarget returned null/);
		expect(finishSpy).not.toHaveBeenCalled();
	});

	it("returns { ok: false } when finishAICard throws (retries exhausted / 4xx business error)", async () => {
		finishSpy.mockRejectedValue(new Error("FINISHED non-retryable failure: status=400 body=..."));

		const result = await deliverCronResultAsCard({
			dingtalkConfig: DINGTALK_CONFIG,
			target: USER_TARGET,
			card: makePayload(),
		});

		expect(result.ok).toBe(false);
		expect(result.error).toContain("FINISHED non-retryable failure");
	});

	it("does not throw on createAICardForTarget rejection (defensive)", async () => {
		createSpy.mockRejectedValue(new Error("network down"));

		const result = await deliverCronResultAsCard({
			dingtalkConfig: DINGTALK_CONFIG,
			target: USER_TARGET,
			card: makePayload(),
		});

		expect(result.ok).toBe(false);
		expect(result.error).toContain("network down");
	});
});

// ===========================================================================
// Integration tests (Gateway + fake OMP)
// ===========================================================================

async function makeFakeOmpScript(dir: string, script: string): Promise<string> {
	const fakeOmpPath = path.join(dir, "fake-omp");
	await Bun.write(fakeOmpPath, script);
	await fs.chmod(fakeOmpPath, 0o755);
	return fakeOmpPath;
}

async function seedTask(
	jobsPath: string,
	task: {
		name: string;
		cron: string;
		command: string;
		scheduleType: "interval" | "cron" | "once";
		taskType: "agent" | "shell";
		timeoutMs: number;
		accountId?: string;
		model?: string;
		provider?: string;
		agentDir?: string;
	},
): Promise<void> {
	const dir = path.dirname(jobsPath);
	await fs.mkdir(dir, { recursive: true });
	const seed = new JsonFileStorage(jobsPath);
	seed.addTask({
		name: task.name,
		cron: task.cron,
		command: task.command,
		status: "active",
		scheduleType: task.scheduleType,
		taskType: task.taskType,
		accountId: task.accountId,
		model: task.model,
		provider: task.provider,
		agentDir: task.agentDir,
		timeoutMs: task.timeoutMs,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		runCount: 0,
		failCount: 0,
		consecutiveFailures: 0,
	});
	seed.close();
}

async function waitForExecution(
	storage: JsonFileStorage,
	taskName: string,
	deadlineMs: number = 30_000,
	intervalMs: number = 500,
): Promise<{ status: string; output: string | undefined } | undefined> {
	const deadline = Date.now() + deadlineMs;
	while (Date.now() < deadline) {
		await Bun.sleep(intervalMs);
		const task = storage.getTaskByName(taskName);
		if (task) {
			const execs = storage.getExecutions(task.id, 1);
			if (execs.length > 0 && execs[0].status !== "running") {
				return execs[0];
			}
		}
	}
	return undefined;
}

// Fake OMP: RPC mode fails on prompt, --print hangs forever (subprocess timeout)
const FAKE_OMP_HANG_SCRIPT = `#!/usr/bin/env bun
const args = process.argv.slice(2);

if (args[0] === "--mode" && args[1] === "rpc") {
  process.stdout.write(JSON.stringify({ type: "ready" }) + "\\n");
  let buffer = "";
  for await (const chunk of Bun.stdin.stream()) {
    buffer += new TextDecoder().decode(chunk);
    let idx = buffer.indexOf("\\n");
    while (idx !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) {
        const frame = JSON.parse(line);
        if (frame.type === "switch_session") {
          process.stdout.write(JSON.stringify({ type: "response", id: frame.id, command: "switch_session", success: true, data: { cancelled: false } }) + "\\n");
        } else if (frame.type === "get_state") {
          process.stdout.write(JSON.stringify({ type: "response", id: frame.id, command: "get_state", success: true, data: { model: "test-model", provider: "test-provider" } }) + "\\n");
        } else if (frame.type === "prompt") {
          process.stdout.write(JSON.stringify({ type: "response", id: frame.id, command: "prompt", success: false, error: "simulated bridge inactivity (971s)" }) + "\\n");
        } else {
          process.stdout.write(JSON.stringify({ type: "response", id: frame.id, command: frame.type, success: true, data: {} }) + "\\n");
        }
      }
      idx = buffer.indexOf("\\n");
    }
  }
} else if (args[0] === "--print") {
  // Hang — never write or exit. The timeout in executeScheduledCommand
  // will SIGTERM this process.
  await new Promise(() => {});
}
`;

// Fake OMP: RPC mode succeeds on get_state, succeeds on first set_model,
// fails on prompt, fails on second set_model (restore). --print succeeds.
const FAKE_OMP_RESTORE_FAIL_SCRIPT = `#!/usr/bin/env bun
const args = process.argv.slice(2);

if (args[0] === "--mode" && args[1] === "rpc") {
  process.stdout.write(JSON.stringify({ type: "ready" }) + "\\n");
  let setModelCount = 0;
  let buffer = "";
  for await (const chunk of Bun.stdin.stream()) {
    buffer += new TextDecoder().decode(chunk);
    let idx = buffer.indexOf("\\n");
    while (idx !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) {
        const frame = JSON.parse(line);
        if (frame.type === "switch_session") {
          process.stdout.write(JSON.stringify({ type: "response", id: frame.id, command: "switch_session", success: true, data: { cancelled: false } }) + "\\n");
        } else if (frame.type === "get_state") {
          process.stdout.write(JSON.stringify({ type: "response", id: frame.id, command: "get_state", success: true, data: { model: "original-model", provider: "test-provider" } }) + "\\n");
        } else if (frame.type === "set_model") {
          setModelCount++;
          if (setModelCount <= 1) {
            process.stdout.write(JSON.stringify({ type: "response", id: frame.id, command: "set_model", success: true, data: {} }) + "\\n");
          } else {
            process.stdout.write(JSON.stringify({ type: "response", id: frame.id, command: "set_model", success: false, error: "simulated restore failure" }) + "\\n");
          }
        } else if (frame.type === "prompt") {
          process.stdout.write(JSON.stringify({ type: "response", id: frame.id, command: "prompt", success: false, error: "warm bridge failure" }) + "\\n");
        } else {
          process.stdout.write(JSON.stringify({ type: "response", id: frame.id, command: frame.type, success: true, data: {} }) + "\\n");
        }
      }
      idx = buffer.indexOf("\\n");
    }
  }
} else if (args[0] === "--print") {
  process.stdout.write("FALLBACK-OK");
  process.exit(0);
}
`;

// Fake OMP: RPC mode fails on prompt (warm-bridge failure). --print echoes
// the prompt (successful fallback).
const FAKE_OMP_FALLBACK_SCRIPT = `#!/usr/bin/env bun
const args = process.argv.slice(2);

if (args[0] === "--mode" && args[1] === "rpc") {
  process.stdout.write(JSON.stringify({ type: "ready" }) + "\\n");
  let buffer = "";
  for await (const chunk of Bun.stdin.stream()) {
    buffer += new TextDecoder().decode(chunk);
    let idx = buffer.indexOf("\\n");
    while (idx !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) {
        const frame = JSON.parse(line);
        if (frame.type === "switch_session") {
          process.stdout.write(JSON.stringify({ type: "response", id: frame.id, command: "switch_session", success: true, data: { cancelled: false } }) + "\\n");
        } else if (frame.type === "prompt") {
          process.stdout.write(JSON.stringify({ type: "response", id: frame.id, command: "prompt", success: false, error: "simulated warm-bridge failure" }) + "\\n");
        } else {
          process.stdout.write(JSON.stringify({ type: "response", id: frame.id, command: frame.type, success: true, data: {} }) + "\\n");
        }
      }
      idx = buffer.indexOf("\\n");
    }
  }
} else if (args[0] === "--print") {
  const prompt = args.slice(1).join(" ");
  process.stdout.write("FALLBACK-OK: " + prompt.slice(0, 30));
  process.exit(0);
}
`;

// ---------------------------------------------------------------------------
// cron timeout diagnostics bugfix (was: cron-diagnostics-bugfix.test.ts)
// ---------------------------------------------------------------------------

describe("cron timeout diagnostics bugfix", () => {
	let tmpHome: string;
	let gateway: Gateway;

	beforeEach(async () => {
		tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "pi-gateway-diag-"));
		vi.spyOn(os, "homedir").mockReturnValue(tmpHome);

		const fakeOmpPath = await makeFakeOmpScript(tmpHome, FAKE_OMP_HANG_SCRIPT);

		const schedulerDir = path.join(tmpHome, ".omp", "gateway-data", "scheduler");
		const jobsPath = path.join(schedulerDir, "jobs.json");
		await seedTask(jobsPath, {
			name: "timeout-diag-test",
			cron: "1s",
			command: "some prompt",
			scheduleType: "interval",
			taskType: "agent",
			accountId: "test",
			timeoutMs: 1_000,
		});

		const config: GatewayConfig = {
			channels: {},
			agent: { ompPath: fakeOmpPath },
			cron: { enabled: true, tickIntervalMs: 500, maxConcurrentRuns: 1 },
		};

		gateway = new Gateway(config);
		await gateway.start();
	});

	afterEach(async () => {
		await gateway.stop();
		vi.restoreAllMocks();
		await fs.rm(tmpHome, { recursive: true, force: true });
	});

	test("JSONL records failure with structured diagnostics when warm bridge and subprocess both fail", async () => {
		const schedulerDir = path.join(tmpHome, ".omp", "gateway-data", "scheduler");
		const jobsPath = path.join(schedulerDir, "jobs.json");
		const storage = new JsonFileStorage(jobsPath);

		const exec = await waitForExecution(storage, "timeout-diag-test", 30_000);
		expect(exec).toBeDefined();
		expect(exec!.status).toBe("failure");

		const logEntries = readExecutionLog("timeout-diag-test", 5);
		const failedEntry = logEntries.find(e => e.status === "failure");
		expect(failedEntry).toBeDefined();
		expect(failedEntry!.exitCode).toBeGreaterThan(0);
		expect(failedEntry!.diagnostics).toBeDefined();
		expect(failedEntry!.diagnostics!.entries.length).toBeGreaterThanOrEqual(2);

		const agentRunDiag = failedEntry!.diagnostics!.entries.find(e => e.source === "agent-run");
		expect(agentRunDiag).toBeDefined();
		expect(agentRunDiag!.message).toContain("simulated bridge inactivity");

		const execDiag = failedEntry!.diagnostics!.entries.find(e => e.source === "exec");
		expect(execDiag).toBeDefined();
		expect(execDiag!.message).toContain("timed out");

		storage.close();
	});
});

// ---------------------------------------------------------------------------
// cron model restore failure logging (was: cron-restore-logging.test.ts)
// ---------------------------------------------------------------------------

describe("cron model restore failure logging", () => {
	let tmpHome: string;
	let gateway: Gateway;
	let errorSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(async () => {
		tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "pi-gateway-restore-"));
		vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
		setLogRoot(path.join(tmpHome, ".omp", "gateway-data", "scheduler", "logs"));

		const fakeOmpPath = await makeFakeOmpScript(tmpHome, FAKE_OMP_RESTORE_FAIL_SCRIPT);

		const schedulerDir = path.join(tmpHome, ".omp", "gateway-data", "scheduler");
		const jobsPath = path.join(schedulerDir, "jobs.json");
		await seedTask(jobsPath, {
			name: "restore-fail-test",
			cron: "1s",
			command: "test prompt",
			scheduleType: "interval",
			taskType: "agent",
			accountId: "test",
			model: "cron-task-model",
			provider: "cron-provider",
			timeoutMs: 5_000,
		});

		const config: GatewayConfig = {
			channels: {},
			agent: { ompPath: fakeOmpPath },
			cron: { enabled: true, tickIntervalMs: 500, maxConcurrentRuns: 1 },
		};

		gateway = new Gateway(config);
		await gateway.start();

		errorSpy = vi.spyOn(logger, "error");
		logger.error("TEST_SPY_CHECK", { test: true });
		errorSpy.mockClear();
	});

	afterEach(async () => {
		await gateway.stop();
		vi.restoreAllMocks();
		await fs.rm(tmpHome, { recursive: true, force: true });
	});

	test("logs error when model restore fails after cron task", async () => {
		const schedulerDir = path.join(tmpHome, ".omp", "gateway-data", "scheduler");
		const jobsPath = path.join(schedulerDir, "jobs.json");
		const storage = new JsonFileStorage(jobsPath);

		await waitForExecution(storage, "restore-fail-test", 15_000);

		const restoreErrors = errorSpy.mock.calls.filter(
			call => typeof call[0] === "string" && call[0].includes("Failed to restore original model"),
		);
		expect(restoreErrors.length).toBeGreaterThan(0);

		storage.close();
	});
});

// ---------------------------------------------------------------------------
// cron warm-bridge fallback contract (was: cron-warm-bridge-fallback.test.ts)
// ---------------------------------------------------------------------------

describe("cron warm-bridge fallback contract", () => {
	let tmpHome: string;
	let gateway: Gateway;

	beforeEach(async () => {
		tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "pi-gateway-cron-fallback-"));
		vi.spyOn(os, "homedir").mockReturnValue(tmpHome);

		const fakeOmpPath = await makeFakeOmpScript(tmpHome, FAKE_OMP_FALLBACK_SCRIPT);

		const schedulerDir = path.join(tmpHome, ".omp", "gateway-data", "scheduler");
		const jobsPath = path.join(schedulerDir, "jobs.json");
		await seedTask(jobsPath, {
			name: "test-fallback",
			cron: "1s",
			command: "test prompt",
			scheduleType: "interval",
			taskType: "agent",
			agentDir: tmpHome,
			accountId: "test",
			timeoutMs: 3_000,
		});

		const config: GatewayConfig = {
			channels: {},
			agent: { ompPath: fakeOmpPath },
			cron: { enabled: true, tickIntervalMs: 500, maxConcurrentRuns: 1 },
		};

		gateway = new Gateway(config);
		await gateway.start();
	});

	afterEach(async () => {
		await gateway.stop();
		vi.restoreAllMocks();
		await fs.rm(tmpHome, { recursive: true, force: true });
	});

	test("falls back to omp --print when warm-bridge executePrompt fails", async () => {
		const schedulerDir = path.join(tmpHome, ".omp", "gateway-data", "scheduler");
		const jobsPath = path.join(schedulerDir, "jobs.json");
		const storage = new JsonFileStorage(jobsPath);

		const execution = await waitForExecution(storage, "test-fallback", 30_000);
		expect(execution).toBeDefined();
		expect(execution!.status).toBe("success");
		expect(execution!.output).toContain("FALLBACK-OK");

		storage.close();
	});
});
