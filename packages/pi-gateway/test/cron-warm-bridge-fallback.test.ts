/**
 * Contract test: cron warm-bridge fallback.
 *
 * Contract: When a cron agent task's warm-bridge executePrompt fails,
 * the gateway MUST fall back to subprocess execution (omp --print).
 * The task should succeed if the subprocess succeeds.
 *
 * This test exists because a prior review found the fallback guard
 * `if (!output && !stderr)` was dead code — the catch block set
 * `stderr` to the error message, making `!stderr` always false.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Gateway } from "../src/gateway";
import { JsonFileStorage } from "../src/scheduler/json-file-storage";
import type { GatewayConfig } from "../src/types";

/**
 * Fake omp binary:
 * - `--mode rpc`: emits "ready", handles switch_session / set_disabled_toolsets,
 *   but responds to "prompt" with success=false (simulates warm-bridge failure).
 * - `--print`: echoes the prompt (simulates successful fallback subprocess).
 */
const FAKE_OMP_SCRIPT = `#!/usr/bin/env bun
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

describe("cron warm-bridge fallback contract", () => {
	let tmpHome: string;
	let gateway: Gateway;

	beforeEach(async () => {
		tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "pi-gateway-cron-fallback-"));

		// os.homedir() on macOS does NOT respect $HOME, so we must spy on
		// it directly to redirect scheduler/session paths to the temp dir.
		vi.spyOn(os, "homedir").mockReturnValue(tmpHome);

		const fakeOmpPath = path.join(tmpHome, "fake-omp");
		await Bun.write(fakeOmpPath, FAKE_OMP_SCRIPT);
		await fs.chmod(fakeOmpPath, 0o755);

		// Seed task via JsonFileStorage BEFORE gateway start
		const schedulerDir = path.join(tmpHome, ".omp", "gateway-data", "scheduler");
		await fs.mkdir(schedulerDir, { recursive: true });
		const jobsPath = path.join(schedulerDir, "jobs.json");
		const seed = new JsonFileStorage(jobsPath);
		seed.addTask({
			name: "test-fallback",
			cron: "1s",
			command: "test prompt",
			status: "active",
			scheduleType: "interval",
			taskType: "agent",
			agentDir: tmpHome,
			accountId: "test",
			timeoutMs: 3_000,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			runCount: 0,
			failCount: 0,
			consecutiveFailures: 0,
		});
		seed.close();

		const config: GatewayConfig = {
			channels: {},
			agent: { ompPath: fakeOmpPath, timeoutMs: 5_000 },
			cron: { enabled: true, tickIntervalMs: 500, maxConcurrentRuns: 1 },
		};

		gateway = new Gateway(config);
		await gateway.start();

		// Debug: check if bridge is actually running via cron CLI
		// (the only public way to check internals)
		const { execSync } = require('child_process');
		const running = gateway?.['#cronLifecycle']?.['#schedulerEngine']?.['#running'];
		// These are private fields, use a cast instead
		const gw = gateway as unknown as { __cronRunning: boolean; __bridgeRunning: boolean };
		console.error("DEBUG: need to check bridge and engine state differently");
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

		// Act: wait for the scheduler to pick up the task (tick every 500ms)
		// and for the interval to fire (1s). Poll for a completed execution.
		let execution: { status: string; output: string | undefined } | undefined;
		for (let i = 0; i < 30; i++) {
			await Bun.sleep(500);
			const task = storage.getTaskByName("test-fallback");
			if (task) {
				const execs = storage.getExecutions(task.id, 1);
				if (execs.length > 0 && execs[0].status !== "running") {
					execution = execs[0];
					break;
				}
			}
		}

		// Assert: the fallback subprocess ran and the task succeeded.
		expect(execution).toBeDefined();
		expect(execution!.status).toBe("success");
		expect(execution!.output).toContain("FALLBACK-OK");

		storage.close();
	});
});
