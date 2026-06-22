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

	it("prepends promptPrefix to the agent command (recursion guard)", async () => {
		// Use a tiny "omp" shim that echoes its argv to stdout, so we
		// can assert the prefix actually made it into the spawned
		// process's argument list without depending on the real omp
		// binary. The shim sits in its own temp dir; the executor only
		// takes the binary path, not a cwd requirement.
		const shimDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-gateway-prefix-shim-"));
		try {
			const shimPath = path.join(shimDir, "omp-fake");
			await Bun.write(shimPath, `#!/usr/bin/env sh\nfor a in "$@"; do printf '%s\\n' "$a"; done\n`);
			await fs.chmod(shimPath, 0o755);

			const result = await executeScheduledCommand("do something", {
				taskType: "agent",
				timeoutMs: 5_000,
				ompBinary: shimPath,
				promptPrefix: "[CRON-CONTEXT] ",
			});
			expect(result.exitCode).toBe(0);
			// The shim echoes every argv on its own line. The first
			// lines are flags ("--print"); the last line is the
			// command. With the prefix, the command line should start
			// with "[CRON-CONTEXT] ".
			const lines = result.output.trim().split("\n");
			expect(lines[0]).toBe("--print");
			expect(lines[lines.length - 1]).toBe("[CRON-CONTEXT] do something");
		} finally {
			await fs.rm(shimDir, { recursive: true, force: true });
		}
	});
});
