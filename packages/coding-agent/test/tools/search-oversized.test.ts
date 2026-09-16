/**
 * grep must never answer "No matches found" for content it did not read.
 *
 * The native search caps a file at `MAX_FILE_BYTES` (4 MiB). Before 2026-09-16 an
 * oversized file was dropped with no trace, so a caller could not tell "the literal
 * is not in this file" from "this file was never opened" — the exact false negative
 * reported three times in one day. Now an explicitly named oversized file is searched
 * over its leading window, every file that was not read in full is counted, and the
 * tool says so.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@cornfield/coding-agent/config/settings";
import type { ToolSession } from "@cornfield/coding-agent/tools";
import { SearchTool } from "@cornfield/coding-agent/tools/search";

/** Comfortably over the 4 MiB cap the native grep applies. */
const ABOVE_CAP_BYTES = 4 * 1024 * 1024 + 8192;
const FILLER_LINE = "filler line for the grep size cap 0123456789\n";

async function writeBigFile(filePath: string, needle: string, atTop: boolean): Promise<void> {
	let body = "";
	while (body.length <= ABOVE_CAP_BYTES) body += FILLER_LINE;
	await fs.writeFile(filePath, atTop ? `${needle}\n${body}` : `${body}${needle}\n`);
}

function createSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated(),
	};
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map(block => block.text ?? "").join("");
}

let tempDir = "";

afterEach(async () => {
	if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
	tempDir = "";
});

describe("grep on a file above the native size cap", () => {
	it("finds a match in the leading window of an explicitly named oversized file", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "cornfield-grep-cap-"));
		const big = path.join(tempDir, "big.log");
		const needle = "NEEDLE_AT_THE_TOP_a71f";
		await writeBigFile(big, needle, true);

		const result = await new SearchTool(createSession(tempDir)).execute("call-1", { pattern: needle, path: big });

		expect(textOf(result)).toContain(needle);
	});

	it("says a partially searched file was not read in full, instead of a bare no-match", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "cornfield-grep-cap-"));
		const big = path.join(tempDir, "tail.log");
		const needle = "NEEDLE_PAST_THE_WINDOW_b83c";
		await writeBigFile(big, needle, false);

		const result = await new SearchTool(createSession(tempDir)).execute("call-1", { pattern: needle, path: big });

		const text = textOf(result);
		expect(text).toContain("No matches found");
		expect(text).toContain("not searched in full");
		expect(text).not.toBe("No matches found");
	});

	it("keeps a file under the cap silent: a real negative stays a plain no-match", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "cornfield-grep-cap-"));
		const small = path.join(tempDir, "small.log");
		await fs.writeFile(small, "only filler here\n".repeat(50));

		const result = await new SearchTool(createSession(tempDir)).execute("call-1", {
			pattern: "NEEDLE_ABSENT_c40d",
			path: small,
		});

		expect(textOf(result)).toBe("No matches found");
	});
});
