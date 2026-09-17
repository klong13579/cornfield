/**
 * `cornfield stats --json` prints the dashboard aggregate in a single write.
 * `byFolder` carries one row per project the local session history has ever
 * seen, so the document grows with the machine's activity rather than with any
 * fixed schema.
 *
 * With `console.log` a 400-project history came back cut — 226059 bytes into a
 * file, 65608 into a pipe, exit code 0.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PIPE_CAPACITY, runBothWays, runCliOnce } from "./helpers/cli-pipe";

/** Enough distinct project folders that `byFolder` clears the pipe buffer. */
const FOLDERS = 400;

const ASSISTANT_MESSAGE = `${JSON.stringify({
	type: "message",
	id: "entry-1",
	parentId: null,
	message: {
		role: "assistant",
		model: "seed/model-with-a-long-name",
		provider: "seed-provider",
		api: "openai-completions",
		timestamp: 1_757_000_000_000,
		stopReason: "stop",
		usage: {
			input: 10,
			output: 20,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 30,
			cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
		},
	},
})}\n`;

let root = "";
let agentDir = "";

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "cornfield-stats-pipe-"));
	agentDir = path.join(root, "agent");
	const sessionsDir = path.join(agentDir, "sessions");
	for (let i = 0; i < FOLDERS; i++) {
		const folder = path.join(
			sessionsDir,
			`--Users--seed--workspace--project-folder-with-a-long-name-${String(i).padStart(4, "0")}--`,
		);
		await fs.mkdir(folder, { recursive: true });
		await Bun.write(path.join(folder, "session.jsonl"), ASSISTANT_MESSAGE);
	}
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

/** The file leg's destination stays outside the sessions tree the command scans. */
function outPath(name: string): string {
	return path.join(root, name);
}

function env(): Record<string, string> {
	// HOME owns the stats database, the agent dir owns the session tree; both are
	// temp so the run neither reads nor writes a real history.
	return { HOME: path.join(root, "home"), CORNFIELD_AGENT_DIR: agentDir };
}

describe("stats output through a pipe", () => {
	it("delivers the whole dashboard document", async () => {
		// `stats` syncs the session history before printing, and reports how much it
		// synced — so the first run would make the two legs disagree about the
		// progress line. Sync once up front; the measured legs then see the same state.
		await runCliOnce({ args: ["stats", "--json"], env: env() });

		const { piped, file } = await runBothWays({
			args: ["stats", "--json"],
			env: env(),
			outPath: outPath("stats.json"),
		});

		// A payload that already fits in the pipe proves nothing, so its size is
		// asserted before the bytes are compared.
		expect(file.length).toBeGreaterThan(PIPE_CAPACITY);
		expect(piped).toBe(file);

		// The sync progress lines precede the document on stdout; the document
		// itself starts at the first brace.
		const stats = JSON.parse(piped.slice(piped.indexOf("{"))) as { byFolder: Array<{ folder: string }> };
		expect(stats.byFolder.length).toBe(FOLDERS);
		// The last folder sits in the bytes the pipe used to drop.
		expect(piped).toContain(`project-folder-with-a-long-name-${String(FOLDERS - 1).padStart(4, "0")}`);
	});
});
