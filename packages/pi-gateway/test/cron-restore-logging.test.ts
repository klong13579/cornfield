/**
 * Contract test: cron model/toolset restore failures must be logged.
 *
 * Contract: When setModel or setDisabledToolsets throws during the
 * finally-block restore after a cron task, the error MUST be logged
 * (not silently swallowed). Operators need to know the bridge is
 * in a stale state (wrong model / disabled toolsets).
 *
 * This test exists because the original code used `catch {}` which
 * made restore failures completely invisible.
 *
 * Approach: fake omp in RPC mode returns get_state with a model (so
 * originalModel is saved), succeeds on first set_model (cron override),
 * fails on prompt (triggers fallback), and fails on second set_model
 * (restore). The finally block runs regardless of prompt outcome.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { Gateway } from "../src/gateway";
import { JsonFileStorage } from "../src/scheduler/json-file-storage";
import { setLogRoot } from "../src/scheduler/execution-log";
import type { GatewayConfig } from "../src/types";

const FAKE_OMP_SCRIPT = `#!/usr/bin/env bun
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

describe("cron model restore failure logging", () => {
	let tmpHome: string;
	let gateway: Gateway;
	let errorSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(async () => {
		tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "pi-gateway-restore-"));
		vi.spyOn(os, "homedir").mockReturnValue(tmpHome);

		// Ensure log root is inside the temp dir too (module-level DEFAULT_LOG_ROOT
		// would have been computed with the real homedir at import time).
		setLogRoot(path.join(tmpHome, ".omp", "gateway-data", "scheduler", "logs"));

		const fakeOmpPath = path.join(tmpHome, "fake-omp");
		await Bun.write(fakeOmpPath, FAKE_OMP_SCRIPT);
		await fs.chmod(fakeOmpPath, 0o755);

		// Seed task via JsonFileStorage BEFORE gateway start
		const schedulerDir = path.join(tmpHome, ".omp", "gateway-data", "scheduler");
		await fs.mkdir(schedulerDir, { recursive: true });
		const jobsPath = path.join(schedulerDir, "jobs.json");
		const seed = new JsonFileStorage(jobsPath);
		seed.addTask({
			name: "restore-fail-test",
			cron: "1s",
			command: "test prompt",
			status: "active",
			scheduleType: "interval",
			taskType: "agent",
			accountId: "test",
			model: "cron-task-model",
			provider: "cron-provider",
			timeoutMs: 5_000,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			runCount: 0,
			failCount: 0,
			consecutiveFailures: 0,
		});
		seed.close();

		const config: GatewayConfig = {
			channels: {},
			agent: { ompPath: fakeOmpPath, timeoutMs: 10_000 },
			cron: { enabled: true, tickIntervalMs: 500, maxConcurrentRuns: 1 },
		};

		gateway = new Gateway(config);
		await gateway.start();

		errorSpy = vi.spyOn(logger, "error");

		// Verify spy works
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

		// Wait for the task to execute and complete
		const deadline = Date.now() + 15_000;
		while (Date.now() < deadline) {
			await Bun.sleep(500);
			const task = storage.getTaskByName("restore-fail-test");
			if (task) {
				const execs = storage.getExecutions(task.id, 1);
				if (execs.length > 0 && execs[0].status !== "running") break;
			}
		}

		// Assert: the restore failure was logged, not silently swallowed.
		const restoreErrors = errorSpy.mock.calls.filter(
			call => typeof call[0] === "string" && call[0].includes("Failed to restore original model"),
		);
		expect(restoreErrors.length).toBeGreaterThan(0);

		storage.close();
	});
});
