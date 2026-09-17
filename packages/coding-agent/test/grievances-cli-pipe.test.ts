/**
 * The report store has exactly one exit: stdout.
 *
 * `console.log` — with the logger loaded (it imports winston) — cuts a single
 * payload larger than the pipe buffer when stdout is a pipe; the tail is lost
 * before the process exits, and the exit code still reads 0. Before this was
 * fixed the same command wrote 174467 bytes into a file and 65536 bytes into a
 * pipe, so `grievances -j | jq` silently parsed a truncated document.
 *
 * The harness lives in `./helpers/cli-pipe` — a pipe created by `Bun.spawn`
 * does not reproduce the defect, so these drive the CLI through a shell pipe.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PIPE_CAPACITY, runBothWays } from "./helpers/cli-pipe";

/** Enough rows that the JSON and the digest both clear the 64 KiB pipe buffer. */
const ROWS = 300;

let root = "";
/** The client dir: `autoqa.db` is client-scoped (`getClientDir()/autoqa.db`). */
let clientDir = "";

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "cornfield-grievances-pipe-"));
	clientDir = path.join(root, "agent");
	await fs.mkdir(clientDir, { recursive: true });
	seedGrievances();
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

/** Write the database directly — the reader must not depend on the tool running first. */
function seedGrievances(): void {
	const db = new Database(path.join(clientDir, "autoqa.db"));
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

/** The file leg's destination stays outside the database directory. */
function outPath(name: string): string {
	return path.join(root, name);
}

/**
 * Point both roots at the temp tree. `autoqa.db` is client-scoped, so the client dir
 * is the one that has to move; the config root moves with it so the run touches
 * nothing of the developer's `~/.cornfield`. `CORNFIELD_AGENT_DIR` — what this
 * fixture used to set — names neither root any more: the command opened the real
 * `~/.cornfield/agent/autoqa.db` and reported that database's rows.
 */
function env(): Record<string, string> {
	return { CORNFIELD_CONFIG_DIR: root, CORNFIELD_CLIENT_DIR: clientDir };
}

describe("grievances output through a pipe", () => {
	it("delivers the whole JSON document", async () => {
		const { piped, file } = await runBothWays({
			args: ["grievances", "-n", "2000", "-j"],
			env: env(),
			outPath: outPath("list.json"),
		});

		// If the payload fit in the pipe buffer the test would pass without
		// proving anything, so the size is asserted first.
		expect(file.length).toBeGreaterThan(PIPE_CAPACITY);
		expect(piped).toBe(file);

		const rows = JSON.parse(piped) as Array<{ id: number }>;
		expect(rows.length).toBe(ROWS);
	});

	it("delivers the whole markdown digest, tail included", async () => {
		const { piped, file } = await runBothWays({
			args: ["grievances", "-n", "2000", "-m"],
			env: env(),
			outPath: outPath("digest.md"),
		});

		expect(file.length).toBeGreaterThan(PIPE_CAPACITY);
		expect(piped).toBe(file);

		// The digest reads oldest-first, so the oldest row sits in the last bytes
		// the pipe used to drop.
		expect(piped).toContain(`row ${ROWS - 1} `);
		expect(piped.endsWith("\n")).toBe(true);
	});

	it("keeps small output on stdout too", async () => {
		const { piped, file } = await runBothWays({
			args: ["grievances", "-n", "5"],
			env: env(),
			outPath: outPath("small.txt"),
		});

		expect(piped).toBe(file);
		expect(piped).toContain("Showing 5 most recent");
	});
});
