/**
 * Integration test verifying the daily-kb-sync timeout bug fix.
 *
 * Bug: When warm bridge timed out but subprocess fallback also timed out
 * with exitCode=0, JSONL recorded status="success" despite actual timeout.
 *
 * Contract:
 *   1. JSONL entry MUST have status="failure" when warm bridge fails
 *      AND subprocess fallback times out.
 *   2. JSONL entry MUST include structured `diagnostics` with entries
 *      from both the agent-run and exec sources.
 *
 * Approach: fake omp in RPC mode returns error on prompt (simulating
 * warm bridge inactivity), then --print mode hangs until timeout
 * (simulating subprocess timeout). A short timeoutMs ensures the
 * test completes quickly.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Gateway } from "../src/gateway";
import { readExecutionLog } from "../src/scheduler/execution-log";
import { JsonFileStorage } from "../src/scheduler/json-file-storage";
import type { GatewayConfig } from "../src/types";

/**
 * Fake OMP that:
 *   RPC mode  → fails on prompt (warm bridge failure)
 *   --print   → hangs waiting on a never-arriving signal (subprocess timeout)
 *
 * The hang is achieved by reading stdin without ever flushing it.
 * Bun.spawn sees no stdout activity and the shell wrapper's SIGTERM
 * (sent by executeScheduledCommand) kills the process.
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
        // Succeed on switch_session and get_state, fail on prompt
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

describe("cron timeout diagnostics bugfix", () => {
	let tmpHome: string;
	let gateway: Gateway;

	beforeEach(async () => {
		tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "pi-gateway-diag-"));
		vi.spyOn(os, "homedir").mockReturnValue(tmpHome);

		const fakeOmpPath = path.join(tmpHome, "fake-omp");
		await Bun.write(fakeOmpPath, FAKE_OMP_SCRIPT);
		await fs.chmod(fakeOmpPath, 0o755);

		// CronLifecycle uses getGatewayDataDir() which resolves to
		// os.homedir() + "/.omp/gateway-data". Since os.homedir() is
		// mocked to tmpHome, seed the jobs.json there.
		const schedulerDir = path.join(tmpHome, ".omp", "gateway-data", "scheduler");
		await fs.mkdir(schedulerDir, { recursive: true });
		const jobsPath = path.join(schedulerDir, "jobs.json");

		const seed = new JsonFileStorage(jobsPath);
		seed.addTask({
			name: "timeout-diag-test",
			cron: "1s",
			command: "some prompt",
			status: "active",
			scheduleType: "interval",
			taskType: "agent",
			accountId: "test",
			timeoutMs: 1_000,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			runCount: 0,
			failCount: 0,
			consecutiveFailures: 0,
		});
		seed.close();

		const config: GatewayConfig = {
			channels: {},
			agent: { ompPath: fakeOmpPath, timeoutMs: 1_000 },
			cron: { enabled: true, tickIntervalMs: 500, maxConcurrentRuns: 1 },
			// dataDir is not set so getGatewayDataDir() controls the path
		};

		gateway = new Gateway(config);
		await gateway.start();
		// Gateway's CronLifecycle.start() creates its own JsonFileStorage
		// which reads from jobs.json (seeded above).
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

		// Wait for the task to execute and complete (warm bridge failure
		// is immediate, subprocess timeout is 1s, add margin).
		for (let i = 0; i < 30; i++) {
			await Bun.sleep(500);
			const task = storage.getTaskByName("timeout-diag-test");
			if (task) {
				const execs = storage.getExecutions(task.id, 1);
				if (execs.length > 0 && execs[0].status !== "running") break;
			}
		}

		// Verify the execution record shows failure
		const task = storage.getTaskByName("timeout-diag-test")!;
		const execs = storage.getExecutions(task.id, 3);
		const exec = execs[0];
		expect(exec).toBeDefined();
		expect(exec.status).toBe("failure");

		// Verify the JSONL entry has status="failure" and diagnostics
		const logEntries = readExecutionLog("timeout-diag-test", 5);
		const failedEntry = logEntries.find(e => e.status === "failure");
		expect(failedEntry).toBeDefined();
		expect(failedEntry!.exitCode).toBeGreaterThan(0);

		// Verify structured diagnostics are present
		expect(failedEntry!.diagnostics).toBeDefined();
		expect(failedEntry!.diagnostics!.entries.length).toBeGreaterThanOrEqual(2);

		// At least one diagnostic from agent-run (warm bridge failure)
		const agentRunDiag = failedEntry!.diagnostics!.entries.find(e => e.source === "agent-run");
		expect(agentRunDiag).toBeDefined();
		expect(agentRunDiag!.message).toContain("simulated bridge inactivity");

		// At least one diagnostic from exec (subprocess timeout)
		const execDiag = failedEntry!.diagnostics!.entries.find(e => e.source === "exec");
		expect(execDiag).toBeDefined();
		expect(execDiag!.message).toContain("timed out");

		storage.close();
	});
});
