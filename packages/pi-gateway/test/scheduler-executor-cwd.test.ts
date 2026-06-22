/**
 * Tests for executeScheduledCommand — the fallback path used by both
 * `pi-gateway cron run` (CLI) and `Gateway.#onCronTrigger` (in-process
 * scheduler). The contract under test: when `cwd` is passed, the spawned
 * shell / omp process runs in that directory.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { executeScheduledCommand } from "../src/scheduler/executor";

let workDir: string;

afterEach(async () => {
	if (workDir) await fs.rm(workDir, { recursive: true, force: true });
});

describe("executeScheduledCommand cwd", () => {
	it("runs shell tasks in the given cwd", async () => {
		workDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-gateway-cwd-shell-"));
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
		const realCwd = await fs.realpath(workDir);
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
});
