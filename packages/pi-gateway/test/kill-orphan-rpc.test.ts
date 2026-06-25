/**
 * Contract test: killOrphanRpcProcesses must only kill --mode rpc processes.
 *
 * Contract: The function MUST NOT kill omp processes that are not running
 * in RPC mode (e.g., interactive sessions, --print mode). It must only
 * kill processes whose command line contains both "omp" and "--mode rpc"
 * and whose PPID is 1 (orphaned).
 *
 * This test exists because the original code matched `parts[2] === "omp"`
 * on the `comm` column, which killed ALL omp processes with PPID=1
 * regardless of their mode.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test, vi } from "bun:test";
import { killOrphanRpcProcesses } from "../src/gateway";

describe("killOrphanRpcProcesses — target only --mode rpc", () => {
	let killSpy: ReturnType<typeof spyOn>;
	let spawnSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		killSpy = spyOn(process, "kill").mockImplementation(() => true);
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("kills omp --mode rpc with PPID=1", async () => {
		spawnSpy = spyOn(Bun, "spawnSync").mockReturnValue({
			exitCode: 0,
			stdout: Buffer.from("  PID  PPID COMMAND\n 1001     1 omp --mode rpc\n"),
			stderr: Buffer.from(""),
		} as any);

		await killOrphanRpcProcesses();

		expect(killSpy).toHaveBeenCalledWith(1001, "SIGKILL");
	});

	test("does NOT kill omp interactive session (no --mode rpc)", async () => {
		spawnSpy = spyOn(Bun, "spawnSync").mockReturnValue({
			exitCode: 0,
			stdout: Buffer.from("  PID  PPID COMMAND\n 1002     1 omp\n"),
			stderr: Buffer.from(""),
		} as any);

		await killOrphanRpcProcesses();

		expect(killSpy).not.toHaveBeenCalled();
	});

	test("does NOT kill omp --print process", async () => {
		spawnSpy = spyOn(Bun, "spawnSync").mockReturnValue({
			exitCode: 0,
			stdout: Buffer.from("  PID  PPID COMMAND\n 1003     1 omp --print 'hello'\n"),
			stderr: Buffer.from(""),
		} as any);

		await killOrphanRpcProcesses();

		expect(killSpy).not.toHaveBeenCalled();
	});

	test("does NOT kill non-omp process with --mode rpc in args", async () => {
		spawnSpy = spyOn(Bun, "spawnSync").mockReturnValue({
			exitCode: 0,
			stdout: Buffer.from("  PID  PPID COMMAND\n 1004     1 some-other-app --mode rpc\n"),
			stderr: Buffer.from(""),
		} as any);

		await killOrphanRpcProcesses();

		expect(killSpy).not.toHaveBeenCalled();
	});

	test("does NOT kill omp --mode rpc with non-1 PPID", async () => {
		spawnSpy = spyOn(Bun, "spawnSync").mockReturnValue({
			exitCode: 0,
			stdout: Buffer.from("  PID  PPID COMMAND\n 1005  2000 omp --mode rpc\n"),
			stderr: Buffer.from(""),
		} as any);

		await killOrphanRpcProcesses();

		expect(killSpy).not.toHaveBeenCalled();
	});

	test("kills multiple omp --mode rpc orphans, skips others", async () => {
		spawnSpy = spyOn(Bun, "spawnSync").mockReturnValue({
			exitCode: 0,
			stdout: Buffer.from(
				"  PID  PPID COMMAND\n" +
					" 2001     1 omp --mode rpc\n" +
					" 2002     1 omp\n" +
					" 2003     1 omp --print test\n" +
					" 2004     1 omp --mode rpc\n" +
					" 2005  3000 omp --mode rpc\n",
			),
			stderr: Buffer.from(""),
		} as any);

		await killOrphanRpcProcesses();

		// Only 2001 and 2004 should be killed (PPID=1 + omp + --mode rpc)
		const killedPids = killSpy.mock.calls.map(c => c[0]);
		expect(killedPids).toContain(2001);
		expect(killedPids).toContain(2004);
		expect(killedPids).not.toContain(2002);
		expect(killedPids).not.toContain(2003);
		expect(killedPids).not.toContain(2005);
	});
});
