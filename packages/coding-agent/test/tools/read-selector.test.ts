import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../../src/config/settings";
import type { ToolSession } from "../../src/sdk";
import { ReadTool } from "../../src/tools/read";

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
 * local sessions). Unsupported forms now fail loudly instead.
 */
describe("read selector contract", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-sel-"));
		await Bun.write(path.join(tmpDir, "five.txt"), ["l1", "l2", "l3", "l4", "l5"].join("\n"));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	function makeTool(): ReadTool {
		const session = {
			cwd: tmpDir,
			hasEditTool: false,
			settings: Settings.isolated({ "read.defaultLimit": 3000, readLineNumbers: false }),
		} as unknown as ToolSession;
		return new ReadTool(session);
	}

	async function readWith(sel: string | undefined): Promise<string> {
		return getResultText(await makeTool().execute("c", { path: "five.txt", sel }))
			.trim()
			.split("\n")
			.join("|");
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

	it("rejects a disjoint multi-range selector instead of widening it", async () => {
		expect(makeTool().execute("c", { path: "five.txt", sel: "1-2,4-5" })).rejects.toThrow(
			/Multi-range selectors are not supported/,
		);
	});

	it("rejects a tail selector instead of widening it", async () => {
		expect(makeTool().execute("c", { path: "five.txt", sel: "-2" })).rejects.toThrow(/Unsupported selector/);
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
});
