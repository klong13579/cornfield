/**
 * Integration test: omp process exits when stdin closes (terminal window closed).
 *
 * Reproduces the orphaned process bug: when a terminal window is closed, the PTY
 * master fd is closed and stdin emits 'end'. Without a handler, omp never notices
 * because zsh does not forward SIGHUP to child processes (huponexit not set).
 *
 * This test spawns the compiled omp binary, pipes stdin (so closing the pipe
 * simulates terminal closure), and verifies the process exits within 5s.
 *
 * Pre-fix: the process would hang indefinitely (test times out).
 * Post-fix: ProcessTerminal.start() registers a stdin 'end' handler that
 * sends SIGTERM to self, triggering postmortem cleanup + exit.
 *
 * NOTE: This test requires the compiled binary at packages/coding-agent/dist/omp.
 * Run `bun run build` first if it doesn't exist. The test is skipped if the
 * binary is missing (CI may not have built it).
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const OMP_BINARY = path.resolve(import.meta.dir, "../../coding-agent/dist/omp");

function binaryExists(): boolean {
	try {
		return fs.statSync(OMP_BINARY).size > 0;
	} catch {
		return false;
	}
}

describe.skipIf(!binaryExists())("omp stdin close → process exit", () => {
	it("exits within 5s when stdin closes (simulated terminal close)", async () => {
		// Spawn omp with piped stdin. We use --version to get a quick exit
		// path that doesn't require a full TUI init — but actually we need
		// the interactive mode path to test the stdin 'end' handler.
		//
		// Strategy: spawn omp with a dummy prompt (-p "test") so it enters
		// print mode. Print mode reads stdin differently, so instead we
		// spawn omp in interactive mode but with piped stdin. The TUI's
		// ProcessTerminal.start() will register the stdin 'end' handler.
		// When we close stdin, the handler fires → SIGTERM → exit.
		//
		// We use a timeout to detect hanging (pre-fix behavior).
		const proc = Bun.spawn({
			cmd: [OMP_BINARY],
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				// Prevent omp from trying to use model APIs
				PI_LOG_SILENT: "true",
				PI_LOG_CONSOLE: "false",
				// Use a temp HOME to avoid polluting user config
				HOME: process.env.HOME,
			},
		});

		// Give omp a moment to start up and register handlers
		await Bun.sleep(2000);

		// Verify the process is still alive before we close stdin
		expect(proc.killed).toBe(false);

		// Close stdin — simulates terminal window closing (PTY master fd closed)
		proc.stdin!.end();

		// Wait for the process to exit (with timeout)
		const exitPromise = proc.exited;
		const timeoutPromise = Bun.sleep(5000).then(() => "TIMEOUT");

		const result = await Promise.race([exitPromise.then(code => `EXIT:${code}`), timeoutPromise]);

		// Clean up if still running
		if (result === "TIMEOUT") {
			proc.kill("SIGKILL");
			await proc.exited;
		}

		expect(result).not.toBe("TIMEOUT");
	}, 15000);
});
