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
import { SchedulerDbStorage } from "../src/scheduler/storage";
import { getSchedulerDbPath } from "../src/scheduler/types";
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
	let fakeOmpPath: string;
	let gateway: Gateway;
	let storage: SchedulerDbStorage;

	beforeEach(async () => {
		tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "pi-gateway-cron-fallback-"));

		// os.homedir() on macOS does NOT respect $HOME, so we must spy on
		// it directly to redirect scheduler/session paths to the temp dir.
		vi.spyOn(os, "homedir").mockReturnValue(tmpHome);

		fakeOmpPath = path.join(tmpHome, "fake-omp");
		await Bun.write(fakeOmpPath, FAKE_OMP_SCRIPT);
		await fs.chmod(fakeOmpPath, 0o755);

		// Config: no channels enabled (avoids DingTalk connect timeout),
		// cron enabled with fast tick. The default bridge starts in
		// single-account mode; getAccountBridge() falls back to it
		fakeOmpPath = path.join(tmpHome, "fake-omp");
		await Bun.write(fakeOmpPath, FAKE_OMP_SCRIPT);
		await fs.chmod(fakeOmpPath, 0o755);

		const dataDir = path.join(tmpHome, "gateway-data");
		await fs.mkdir(dataDir, { recursive: true });

		// Config: no channels enabled (avoids DingTalk connect timeout),
		// cron enabled with fast tick. The default bridge starts in
		// single-account mode; getAccountBridge() falls back to it
		// when #accountBridges is empty.
		const config: GatewayConfig = {
			channels: {},
			agent: {
				ompPath: fakeOmpPath,
				timeoutMs: 5_000,
			},
			cron: {
				enabled: true,
				tickIntervalMs: 500,
				maxConcurrentRuns: 1,
			},
			dataDir,
		};

		gateway = new Gateway(config);
		await gateway.start();

		// Open a separate storage handle pointing at the same DB
		// (the gateway created the schema during start()).
		storage = new SchedulerDbStorage(getSchedulerDbPath());
	});

	afterEach(async () => {
		storage.close();
		await gateway.stop();
		vi.restoreAllMocks();
		await fs.rm(tmpHome, { recursive: true, force: true });
	});

	test("falls back to omp --print when warm-bridge executePrompt fails", async () => {
		// Arrange: schedule an agent task whose warm-bridge execution will
		// fail (fake RPC responds with success=false on "prompt").
		storage.addTask({
			name: "test-fallback",
			cron: "1s",
			command: "test prompt",
			status: "active",
			scheduleType: "interval",
			taskType: "agent",
			accountId: "test",
			timeoutMs: 3_000,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			runCount: 0,
			failCount: 0,
			consecutiveFailures: 0,
		});

		// Act: wait for the scheduler to pick up the task (tick every 500ms)
		// and for the interval to fire (1s). Poll the DB for a completed
		// (non-running) execution.
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
		// If the bug exists (fallback never fires), status will be "failure"
		// and output will not contain "FALLBACK-OK".
		expect(execution).toBeDefined();
		expect(execution!.status).toBe("success");
		expect(execution!.output).toContain("FALLBACK-OK");
	});
});
