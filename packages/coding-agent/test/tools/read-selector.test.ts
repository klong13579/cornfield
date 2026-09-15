import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../../src/config/settings";
import type { ToolSession } from "../../src/sdk";
import { ReadTool, readToolRenderer } from "../../src/tools/read";
import { createRenderSurface } from "../helpers/render-assert";

function getResultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(c => c.type === "text")
		.map(c => c.text ?? "")
		.join("\n");
}

/**
 * `sel` must never be silently ignored. Before this contract, a selector the
 * local parser did not recognize fell through to "read everything" — the caller
 * asked for a slice and got the whole resource (measured: 104 such calls in 560
 * local sessions). Unsupported forms still fail loudly; the forms the tool can
 * address (`-N` tails, disjoint ranges) now return what they name instead.
 */
describe("read selector contract", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-sel-"));
		await Bun.write(path.join(tmpDir, "five.txt"), ["l1", "l2", "l3", "l4", "l5"].join("\n"));
		// No trailing newline: one line is one line.
		await Bun.write(path.join(tmpDir, "one.txt"), "only");
		await Bun.write(path.join(tmpDir, "empty.txt"), "");
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	function makeTool(options: { lineNumbers?: boolean } = {}): ReadTool {
		const session = {
			cwd: tmpDir,
			hasEditTool: false,
			settings: Settings.isolated({ "read.defaultLimit": 3000, readLineNumbers: options.lineNumbers ?? false }),
		} as unknown as ToolSession;
		return new ReadTool(session);
	}

	async function readWith(
		sel: string | undefined,
		file = "five.txt",
		options?: { lineNumbers?: boolean },
	): Promise<string> {
		const result = await makeTool(options).execute("c", { path: file, sel });
		return getResultText(result).trim().split("\n").join("|");
	}

	it("honors N-M, N, N+K and the open-ended N- form", async () => {
		expect(await readWith("2-3")).toBe("l2|l3");
		expect(await readWith("2")).toBe("l2|l3|l4|l5");
		expect(await readWith("2-")).toBe("l2|l3|l4|l5");
		expect(await readWith("2+2")).toBe("l2|l3");
	});

	it("merges adjacent ranges into the one window it can address", async () => {
		expect(await readWith("1-2,3-5")).toBe("l1|l2|l3|l4|l5");
	});

	it("reads the last N lines with -N", async () => {
		expect(await readWith("-2")).toBe("l4|l5");
		expect(await readWith("-1")).toBe("l5");
	});

	it("reads the whole file once N reaches its length, and never reads past the head", async () => {
		expect(await readWith("-5")).toBe("l1|l2|l3|l4|l5");
		expect(await readWith("-6")).toBe("l1|l2|l3|l4|l5");
		expect(await readWith("-1", "one.txt")).toBe("only");
		expect(await readWith("-2", "one.txt")).toBe("only");
	});

	it("returns an empty body for a tail read of an empty file instead of failing", async () => {
		expect(await readWith("-1", "empty.txt")).toBe("");
		expect(await readWith(undefined, "empty.txt")).toBe("");
	});

	it("rejects a tail selector that names no lines", async () => {
		expect(makeTool().execute("c", { path: "five.txt", sel: "-0" })).rejects.toThrow(/Tail selector -0 is invalid/);
	});

	it("reads disjoint ranges, keeping original line numbers and marking the gap", async () => {
		expect(await readWith("1-2,4-5")).toBe("l1|l2|…|l4|l5");
	});

	it("numbers disjoint ranges from the file, not from the block", async () => {
		expect(await readWith("1-2,4-5", "five.txt", { lineNumbers: true })).toBe("1|l1|2|l2|…|4|l4|5|l5");
	});

	it("treats an open-ended range in a list as running to the end", async () => {
		expect(await readWith("1-2,4-")).toBe("l1|l2|…|l4|l5");
	});

	it("clamps a disjoint range that runs past the end", async () => {
		expect(await readWith("1-2,4-9")).toBe("l1|l2|…|l4|l5");
	});

	it("reports a disjoint range that starts past the end instead of dropping it", async () => {
		const text = getResultText(await makeTool().execute("c", { path: "five.txt", sel: "1-2,10-12" }));
		expect(text).toContain("l1\nl2");
		expect(text).toContain("[Range 10-12 is beyond end of file (5 lines total); skipped]");
	});

	it("rejects line selectors on a directory", async () => {
		expect(makeTool().execute("c", { path: ".", sel: "-2" })).rejects.toThrow(
			/A tail selector \(-2\) cannot be applied to a directory/,
		);
		expect(makeTool().execute("c", { path: ".", sel: "1-2,4-5" })).rejects.toThrow(
			/A multi-range selector cannot be applied to a directory/,
		);
	});

	it("rejects an unrecognized selector instead of widening it", async () => {
		expect(makeTool().execute("c", { path: "five.txt", sel: "nonsense" })).rejects.toThrow(/Unsupported selector/);
	});

	it("rejects out-of-contract bounds", async () => {
		expect(makeTool().execute("c", { path: "five.txt", sel: "0" })).rejects.toThrow(/lines are 1-indexed/);
		expect(makeTool().execute("c", { path: "five.txt", sel: "10-5" })).rejects.toThrow(/end must be >= start/);
		expect(makeTool().execute("c", { path: "five.txt", sel: "5+0" })).rejects.toThrow(/count must be >= 1/);
	});

	it("keeps reading everything when sel is omitted or raw", async () => {
		expect(await readWith(undefined)).toBe("l1|l2|l3|l4|l5");
		expect(await readWith("")).toBe("l1|l2|l3|l4|l5");
		expect(await readWith("raw")).toBe("l1|l2|l3|l4|l5");
	});

	// The selector parse runs before the archive/sqlite dispatch; a SQLite `sel`
	// is table/query syntax and must not be rejected as a bad line selector.
	it("still hands a SQLite selector to the SQLite reader", async () => {
		const dbPath = path.join(tmpDir, "data.db");
		const db = new Database(dbPath);
		db.run("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)");
		db.run("INSERT INTO users (name) VALUES ('ada'), ('bob'), ('cyd')");
		db.close();

		const text = await readWith2(dbPath, "users?limit=2");
		expect(text).toContain("ada");
		expect(text).toContain("bob");
		expect(text).not.toContain("cyd");
	});

	async function readWith2(dbPath: string, sel: string): Promise<string> {
		const tool = makeTool();
		const relative = path.relative(tmpDir, dbPath);
		return getResultText(await tool.execute("c-sqlite", { path: relative, sel }));
	}

	// The model-facing text and the TUI share one source: the TUI renders
	// `displayContent`, so a multi-range read has to survive both without the
	// second window being renumbered or the gap collapsing.
	it("renders disjoint ranges with the gap still visible", async () => {
		const surface = await createRenderSurface({ width: 80 });
		const result = await makeTool().execute("c", { path: "five.txt", sel: "1-2,4-5" });

		const rendered = surface.text(
			readToolRenderer.renderResult(result, { expanded: true, isPartial: false }, surface.theme, {
				path: "five.txt",
			}),
		);
		expect(rendered).toContain("l1");
		expect(rendered).toContain("l4");
		expect(rendered).toContain("l5");
		expect(rendered).toContain("…");
		expect(rendered).not.toContain("l3");
	});
});
