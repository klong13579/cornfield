/**
 * Run the real CLI twice — once with stdout on a pipe, once with stdout on a
 * regular file — so a regression can compare the bytes each leg delivers.
 *
 * The process boundary is the thing under test. `console.log`, in a process
 * where winston has been loaded, writes only a whole number of pipe buffers
 * when stdout is a pipe; the tail of a larger payload is dropped before the
 * process exits and the exit code still reads 0. Writing to a regular file is
 * synchronous, so the file leg is the reference the pipe leg must match.
 *
 * The pipe leg's `\| cat` is load-bearing. A pipe created by `Bun.spawn` itself
 * does not reproduce the defect — the same broken CLI that loses its tail
 * through `omp … | jq` returns the whole payload when its stdout is a spawn
 * pipe (measured: 171875 bytes intact, against 65536 through a shell pipe). A
 * regression driven through a spawn pipe therefore passes on the broken code.
 */
import { expect } from "bun:test";
import * as path from "node:path";

const PACKAGE_DIR = path.join(import.meta.dir, "..", "..");
const CLI = path.join(PACKAGE_DIR, "src", "cli.ts");
/** `-o pipefail` so the pipeline reports the CLI's exit code, not `cat`'s. */
const SHELL = ["/bin/bash", "-o", "pipefail", "-c"] as const;

/** Pipe capacity: the boundary a single oversized write is cut at. */
export const PIPE_CAPACITY = 65536;

const RUN_TIMEOUT_MS = 120_000;

/** Quote one word for `bash -c`. */
function shellQuote(word: string): string {
	return `'${word.replace(/'/g, `'\\''`)}'`;
}

function within<T>(work: Promise<T>, label: string): Promise<T> {
	const timed = Promise.withResolvers<never>();
	const timer = setTimeout(
		() => timed.reject(new Error(`${label} did not finish within ${RUN_TIMEOUT_MS}ms`)),
		RUN_TIMEOUT_MS,
	);
	return Promise.race([work, timed.promise]).finally(() => clearTimeout(timer));
}

/** The file leg's destination lives outside the directories the command scans. */
export interface RunBothWaysOptions {
	/** argv after the CLI entry point, e.g. `["agent", "list", "--json"]`. */
	args: string[];
	/** Environment overrides merged over `process.env`. */
	env: Record<string, string>;
	/** Where the file leg writes stdout. Must live inside a directory the test owns. */
	outPath: string;
}

/**
 * Run the command once and discard its stdout.
 *
 * For a command whose first run mutates state it also reports on (e.g. `stats`
 * syncs before printing how many entries it synced), the two measured legs
 * would otherwise disagree on the report while agreeing on the payload.
 * Warming up first makes both legs observe the same state.
 */
export async function runCliOnce(opts: Omit<RunBothWaysOptions, "outPath">): Promise<void> {
	const argv = [process.execPath, CLI, ...opts.args];
	const env = { ...process.env, ...opts.env } as Record<string, string>;
	const proc = Bun.spawn(argv, { cwd: PACKAGE_DIR, env, stdout: "ignore", stderr: "pipe" });
	const [exit, stderr] = await within(
		Promise.all([proc.exited, new Response(proc.stderr).text()]),
		`warm-up cornfield ${opts.args.join(" ")}`,
	);
	expect(stderr).toBe("");
	expect(exit).toBe(0);
}

/** Result of the two legs, with the file leg's stderr asserted empty. */
export async function runBothWays(opts: RunBothWaysOptions): Promise<{ piped: string; file: string }> {
	const label = `cornfield ${opts.args.join(" ")}`;
	const env = { ...process.env, ...opts.env } as Record<string, string>;
	const full = [process.execPath, CLI, ...opts.args].map(shellQuote).join(" ");

	// Each spawn keeps its options inline so the stdout type stays literal.
	const pipeProc = Bun.spawn([...SHELL, `${full} | cat`], {
		cwd: PACKAGE_DIR,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [piped, pipeErr, pipeExit] = await within(
		Promise.all([new Response(pipeProc.stdout).text(), new Response(pipeProc.stderr).text(), pipeProc.exited]),
		`piped ${label}`,
	);
	expect(pipeErr).toBe("");
	expect(pipeExit).toBe(0);

	const fileProc = Bun.spawn([process.execPath, CLI, ...opts.args], {
		cwd: PACKAGE_DIR,
		env,
		stdout: Bun.file(opts.outPath),
		stderr: "pipe",
	});
	const [fileExit, fileErr] = await within(
		Promise.all([fileProc.exited, new Response(fileProc.stderr).text()]),
		`file ${label}`,
	);
	expect(fileErr).toBe("");
	expect(fileExit).toBe(0);

	const file = await Bun.file(opts.outPath).text();
	// Lengths first: a byte-for-byte comparison of two payloads that differ in
	// size prints the whole document in the failure report.
	expect(piped.length).toBe(file.length);
	return { piped, file };
}
