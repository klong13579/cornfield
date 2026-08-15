/**
 * Tests that `omp gateway` is rejected at the CLI entry point.
 *
 * The gateway daemon was split out of omp into the standalone `omp-gateway`
 * binary (docs/gateway-binary-split-plan.md §5.5). `gateway` is a reserved
 * name in cli.ts: invoking `omp gateway ...` must print the migration hint
 * and exit non-zero — NOT silently fall through to interactive "launch"
 * mode (which would trap the user inside the TUI asking "gateway" as a
 * question).
 *
 * These tests spawn the real cli.ts as a subprocess; runCli exits(1), so it
 * cannot be asserted in-process.
 */

import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import * as os from "node:os";

const cliPath = path.join(import.meta.dir, "..", "src", "cli.ts");

async function runCliSpawn(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const proc = Bun.spawn(["bun", cliPath, ...args], {
		cwd: path.join(import.meta.dir, ".."),
		stdout: "pipe",
		stderr: "pipe",
		env: { ...Bun.env, PI_NO_TITLE: "1", HOME: os.tmpdir(), OMP_SETTINGS_PATH: "" },
	});
	const [stdout, stderr] = await Promise.all([proc.stdout.text(), proc.stderr.text()]);
	const exitCode = await proc.exited;
	return { stdout, stderr, exitCode };
}

describe("cli gateway reservation", () => {
	test("`gateway` bare is rejected with migration hint", async () => {
		const { stderr, exitCode } = await runCliSpawn(["gateway"]);
		expect(exitCode).toBe(1);
		expect(stderr).toContain("omp-gateway");
		expect(stderr).toContain("removed from omp");
	});

	test("`gateway status` is rejected (does not fall into launch)", async () => {
		const { stdout, stderr, exitCode } = await runCliSpawn(["gateway", "status"]);
		expect(exitCode).toBe(1);
		expect(stderr).toContain("omp-gateway");
		// If the reserved-name check were missing, `gateway status` would
		// route to launch and stdout would show the TUI/banner text.
		expect(stdout).not.toContain("welcome");
		expect(stdout).not.toContain("omp v");
	});
});