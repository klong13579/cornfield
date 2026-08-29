/**
 * omp-gateway CLI smoke — the standalone daemon binary's command table.
 *
 * Spawns the real `packages/omp-gateway/src/cli.ts` (the compiled
 * `omp-gateway` entrypoint) and exercises version, help, argv rewriting, and
 * a read-only status probe against an isolated HOME. No gateway is started
 * and no system state is touched.
 */

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const CLI_ENTRY = path.join(import.meta.dir, "..", "src", "cli.ts");

interface CliRun {
	stdout: string;
	stderr: string;
	exitCode: number;
}

async function runCli(args: string[], env: Record<string, string> = {}): Promise<CliRun> {
	const proc = Bun.spawn({
		cmd: [process.execPath, CLI_ENTRY, ...args],
		cwd: path.join(import.meta.dir, ".."),
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, ...env },
	});
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	return { stdout, stderr, exitCode: await proc.exited };
}

const isolatedHomes: string[] = [];

async function isolatedHome(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gateway-cli-"));
	isolatedHomes.push(dir);
	return dir;
}

afterEach(async () => {
	for (const dir of isolatedHomes.splice(0)) {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

describe("omp-gateway CLI", () => {
	test("--version prints the omp-gateway banner", async () => {
		const { stdout, exitCode } = await runCli(["--version"]);
		expect(exitCode).toBe(0);
		expect(stdout.trim()).toMatch(/^cornfield-gateway\//);
	});

	test("--help lists the gateway actions", async () => {
		const { stdout, exitCode } = await runCli(["--help"]);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("USAGE");
		expect(stdout).toContain("ACTIONS");
		expect(stdout).toContain("cornfield-gateway start"); // example lines survive the migration
		expect(stdout).toContain("cron");
		expect(stdout).toContain("service");
	});

	test("unknown subcommand fails loudly (no gateway shim on unknown args)", async () => {
		const { stderr, exitCode } = await runCli(["bogus-action"]);
		expect(exitCode).toBe(1);
		expect(stderr).toContain("not found");
	});

	test("status with an isolated HOME reports not running without touching the real gateway", async () => {
		const home = await isolatedHome();
		const { stdout, exitCode } = await runCli(["status"], { HOME: home });
		expect(exitCode).toBe(0);
		expect(stdout).toContain("Running: false");
	});

	test("status with a stale PID file reports the stale state", async () => {
		const home = await isolatedHome();
		const dataDir = path.join(home, ".cornfield", "gateway-data");
		await fs.mkdir(dataDir, { recursive: true });
		await fs.writeFile(path.join(dataDir, "gateway.pid"), "999999999\n");
		const { stdout, exitCode } = await runCli(["status"], { HOME: home });
		expect(exitCode).toBe(0);
		// A dead PID's file is unlinked; status surfaces a non-running gateway.
		expect(stdout).toContain("Running: false");
	});
});
