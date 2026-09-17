/**
 * `cornfield grep` prints matching source lines verbatim, so a single write is
 * as large as the widest line in the searched tree — minified and generated
 * sources are routinely wider than the pipe buffer.
 *
 * With `console.log` a 200 KB line came back cut: 200185 bytes into a file,
 * 65697 into a pipe, exit code 0.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PIPE_CAPACITY, runBothWays } from "./helpers/cli-pipe";

const LINE_LENGTH = 200_000;
const TAIL_MARK = "TAIL-MARK-END-OF-LINE";

let root = "";
let scanDir = "";

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "cornfield-grep-pipe-"));
	scanDir = path.join(root, "scan");
	await fs.mkdir(scanDir, { recursive: true });
	await Bun.write(path.join(scanDir, "one-line.txt"), `NEEDLE${"q".repeat(LINE_LENGTH)}${TAIL_MARK}\n`);
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

describe("grep output through a pipe", () => {
	it("delivers the whole matching line, tail included", async () => {
		const { piped, file } = await runBothWays({
			args: ["grep", "NEEDLE", scanDir, "--no-gitignore"],
			// The file leg writes outside scanDir, so neither leg can match its own
			// stdout artefact.
			env: { CORNFIELD_AGENT_DIR: path.join(root, "config") },
			outPath: path.join(root, "grep.txt"),
		});

		// A payload that already fits in the pipe proves nothing, so its size is
		// asserted before the bytes are compared.
		expect(file.length).toBeGreaterThan(PIPE_CAPACITY);
		expect(piped).toBe(file);

		// The tail mark sits in the bytes the pipe used to drop.
		expect(piped).toContain(TAIL_MARK);
		expect(piped).toContain("Total matches: 1");
	});
});
