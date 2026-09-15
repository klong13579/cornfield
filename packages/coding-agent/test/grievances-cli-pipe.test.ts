/**
 * The report store has exactly one exit: stdout.
 *
 * `console.log` — with the logger loaded (it imports winston) — cuts a single
 * payload larger than the pipe buffer at 64 KiB when stdout is a pipe; the tail
 * is lost before the process exits. Before this was fixed the same command wrote
 * 174467 bytes into a file and 65536 bytes into a pipe, so `grievances -j | jq`
 * silently parsed a truncated document.
 *
 * These tests drive the real CLI through a real pipe (not the in-process
 * functions — the process boundary is the thing under test) and compare the
 * piped bytes with the bytes the same run writes to a regular file.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const PACKAGE_DIR = path.join(import.meta.dir, "..");
const CLI = path.join(PACKAGE_DIR, "src", "cli.ts");
/** Enough rows that the JSON and the digest both clear the 64 KiB pipe buffer. */
const ROWS = 300;
const PIPE_CAPACITY = 65536;
const RUN_TIMEOUT_MS = 60_000;

let agentDir = "";

beforeEach(async () => {
	agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "cornfield-grievances-pipe-"));
	seedGrievances();
});

afterEach(async () => {
	await fs.rm(agentDir, { recursive: true, force: true });
});

/** Write the database directly — the reader must not depend on the tool running first. */
function seedGrievances(): void {
	const db = new Database(path.join(agentDir, "autoqa.db"));
	try {
		db.run(`CREATE TABLE grievances (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			model TEXT NOT NULL,
			version TEXT NOT NULL,
			tool TEXT NOT NULL,
			report TEXT NOT NULL,
			createdAt INTEGER,
			sessionId TEXT,
			exported INTEGER NOT NULL DEFAULT 0
		)`);
		const insert = db.prepare(
			"INSERT INTO grievances (model, version, tool, report, createdAt, sessionId) VALUES (?, ?, ?, ?, ?, ?)",
		);
		for (let i = 0; i < ROWS; i++) {
			insert.run(
				"seed/model",
				"1.0.0",
				i % 2 === 0 ? "write" : "read",
				`row ${i} ${"x".repeat(200)}`,
				1_789_000_000_000 - i,
				`sess-${i}`,
			);
		}
	} finally {
		db.close();
	}
}

function within<T>(work: Promise<T>, label: string): Promise<T> {
	const timed = Promise.withResolvers<never>();
	const timer = setTimeout(
		() => timed.reject(new Error(`${label} did not finish within ${RUN_TIMEOUT_MS}ms`)),
		RUN_TIMEOUT_MS,
	);
	return Promise.race([work, timed.promise]).finally(() => clearTimeout(timer));
}

/** Run the command with stdout on a pipe once and on a regular file once. */
async function runBothWays(args: string[]): Promise<{ piped: string; file: string }> {
	const label = `grievances ${args.join(" ")}`;
	const argv = [process.execPath, CLI, "grievances", ...args];
	const env = { ...process.env, CORNFIELD_AGENT_DIR: agentDir } as Record<string, string>;

	// Each spawn keeps its options inline so the stdout type stays literal.
	const pipeProc = Bun.spawn(argv, { cwd: PACKAGE_DIR, env, stdout: "pipe", stderr: "pipe" });
	const [piped, pipeErr, pipeExit] = await within(
		Promise.all([new Response(pipeProc.stdout).text(), new Response(pipeProc.stderr).text(), pipeProc.exited]),
		`piped ${label}`,
	);
	expect(pipeErr).toBe("");
	expect(pipeExit).toBe(0);

	const outPath = path.join(agentDir, "out.txt");
	const fileProc = Bun.spawn(argv, { cwd: PACKAGE_DIR, env, stdout: Bun.file(outPath), stderr: "pipe" });
	const fileExit = await within(fileProc.exited, `file ${label}`);
	expect(fileExit).toBe(0);

	return { piped, file: await Bun.file(outPath).text() };
}

describe("grievances output through a pipe", () => {
	it("delivers the whole JSON document", async () => {
		const { piped, file } = await runBothWays(["-n", "2000", "-j"]);

		// If the payload fit in the pipe buffer the test would pass without
		// proving anything, so the size is asserted first.
		expect(file.length).toBeGreaterThan(PIPE_CAPACITY);
		expect(piped).toBe(file);

		const rows = JSON.parse(piped) as Array<{ id: number }>;
		expect(rows.length).toBe(ROWS);
	});

	it("delivers the whole markdown digest, tail included", async () => {
		const { piped, file } = await runBothWays(["-n", "2000", "-m"]);

		expect(file.length).toBeGreaterThan(PIPE_CAPACITY);
		expect(piped).toBe(file);

		// The digest reads oldest-first, so the oldest row sits in the last bytes
		// the pipe used to drop.
		expect(piped).toContain(`row ${ROWS - 1} `);
		expect(piped.endsWith("\n")).toBe(true);
	});

	it("keeps small output on stdout too", async () => {
		const { piped, file } = await runBothWays(["-n", "5"]);

		expect(piped).toBe(file);
		expect(piped).toContain("Showing 5 most recent");
	});
});
