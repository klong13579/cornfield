import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@cornfield/coding-agent/config/settings";
import {
	EditTool,
	executeSloppySingle,
	extractInlineSloppyRegions,
	parseSloppyPayload,
} from "@cornfield/coding-agent/edit";
import { writethroughNoop } from "@cornfield/coding-agent/lsp";
import type { ToolSession } from "@cornfield/coding-agent/tools";

/** Render one `<SM:EDIT>` block exactly as the mode prompt teaches it. */
function block(filePath: string, pairs: Array<[string, string]>): string {
	const body = pairs.map(([find, put]) => `<SM:FIND>\n${find}\n</SM:FIND>\n<SM:PUT>\n${put}\n</SM:PUT>`).join("\n");
	return `<SM:EDIT path="${filePath}">\n${body}\n</SM:EDIT>`;
}

let dir: string;

beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "edit-sloppy-"));
});

afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

// ───────────────────────────────────────────────────────────────────────────
// Parser
// ───────────────────────────────────────────────────────────────────────────

describe("parseSloppyPayload", () => {
	test("parses one block with one pair and strips the formatting newlines", () => {
		expect(parseSloppyPayload(block("a.ts", [["old", "new"]]))).toEqual([
			{ path: "a.ts", pairs: [{ old_text: "old", new_text: "new" }] },
		]);
	});

	test("keeps multi-line bodies verbatim, indentation included", () => {
		const find = "function f() {\n\treturn 1;\n}";
		const put = "function f() {\n\treturn 2;\n}";
		expect(parseSloppyPayload(block("a.ts", [[find, put]]))).toEqual([
			{ path: "a.ts", pairs: [{ old_text: find, new_text: put }] },
		]);
	});

	test("keeps pairs in the order written, across blocks", () => {
		const input = [
			block("a.ts", [
				["one", "two"],
				["three", "four"],
			]),
			block("b.ts", [["five", "six"]]),
		].join("\n");
		expect(parseSloppyPayload(input)).toEqual([
			{
				path: "a.ts",
				pairs: [
					{ old_text: "one", new_text: "two" },
					{ old_text: "three", new_text: "four" },
				],
			},
			{ path: "b.ts", pairs: [{ old_text: "five", new_text: "six" }] },
		]);
	});

	test("accepts prose around the payload and CRLF line endings", () => {
		const input = `Here are the edits:\r\n\r\n${block("a.ts", [["old", "new"]])}\r\n\r\nDone.`;
		expect(parseSloppyPayload(input)).toEqual([{ path: "a.ts", pairs: [{ old_text: "old", new_text: "new" }] }]);
	});

	test("accepts an empty replacement (deletion)", () => {
		expect(parseSloppyPayload(block("a.ts", [["gone", ""]]))).toEqual([
			{ path: "a.ts", pairs: [{ old_text: "gone", new_text: "" }] },
		]);
	});

	test("accepts a single-quoted path attribute", () => {
		expect(
			parseSloppyPayload(`<SM:EDIT path='a.ts'>\n<SM:FIND>\nx\n</SM:FIND>\n<SM:PUT>\ny\n</SM:PUT>\n</SM:EDIT>`),
		).toEqual([{ path: "a.ts", pairs: [{ old_text: "x", new_text: "y" }] }]);
	});

	const malformed: Array<[string, RegExp]> = [
		["", /no <SM:EDIT> block found/],
		["just some prose about editing", /no <SM:EDIT> block found/],
		[`<SM:EDIT>\n<SM:FIND>\nx\n</SM:FIND>\n<SM:PUT>\ny\n</SM:PUT>\n</SM:EDIT>`, /missing its path attribute/],
		[`<SM:EDIT path="">\n<SM:FIND>\nx\n</SM:FIND>\n<SM:PUT>\ny\n</SM:PUT>\n</SM:EDIT>`, /empty path attribute/],
		[
			`<SM:EDIT path="a.ts" all="true">\n<SM:FIND>\nx\n</SM:FIND>\n<SM:PUT>\ny\n</SM:PUT>\n</SM:EDIT>`,
			/unsupported attribute/,
		],
		[`<SM:EDIT path="a.ts">\n</SM:EDIT>`, /carries no <SM:FIND>\/<SM:PUT> pair/],
		[`<SM:EDIT path="a.ts">\n<SM:FIND>\nx\n</SM:FIND>\n<SM:PUT>\ny\n</SM:PUT>`, /missing its closing <\/SM:EDIT>/],
		[
			`<SM:EDIT path="a.ts">\n<SM:FIND>\nx\n<SM:PUT>\ny\n</SM:PUT>\n</SM:EDIT>`,
			/unexpected <SM:PUT> inside the <SM:FIND>/,
		],
		[
			`<SM:EDIT path="a.ts">\n<SM:FIND>\nx\n</SM:FIND>\n<SM:PUT>\ny\n</SM:EDIT>`,
			/unexpected <\/SM:EDIT> inside the <SM:PUT>/,
		],
		[
			`<SM:EDIT path="a.ts">\n<SM:FIND>\n\n</SM:FIND>\n<SM:PUT>\ny\n</SM:PUT>\n</SM:EDIT>`,
			/<SM:FIND> in block 1 is empty/,
		],
		[`<SM:EDIT path="a.ts">\n<SM:FIND>\nx\n</SM:FIND>\n</SM:EDIT>`, /is not a valid follow-up to <\/SM:FIND>/],
		[
			`<SM:EDIT path="a.ts">\ntext\n<SM:FIND>\nx\n</SM:FIND>\n<SM:PUT>\ny\n</SM:PUT>\n</SM:EDIT>`,
			/unexpected text inside/,
		],
		[
			`<SM:EDIT path="a.ts">\n<SM:FIND>\nx\n</SM:FIND>\ntext\n<SM:PUT>\ny\n</SM:PUT>\n</SM:EDIT>`,
			/unexpected text between <\/SM:FIND> and its <SM:PUT>/,
		],
		[`<SM:FIND>\nx\n</SM:FIND>`, /appears outside an <SM:EDIT> block/],
		[`</SM:EDIT>`, /stray <\/SM:EDIT> outside an <SM:EDIT> block/],
		[
			`<SM:EDIT path="a.ts">\n<SM:FIND>\n<SM:EDIT path="b.ts">\nx\n</SM:EDIT>\n</SM:FIND>\n<SM:PUT>\ny\n</SM:PUT>\n</SM:EDIT>`,
			/unexpected <SM:EDIT path="b.ts"> inside the <SM:FIND>/,
		],
	];

	test.each(malformed)("rejects %p", (input, expected) => {
		expect(() => parseSloppyPayload(input)).toThrow(expected);
		expect(() => parseSloppyPayload(input)).toThrow(/Expected shape: <SM:EDIT path="file.ts">/);
	});
});

// ───────────────────────────────────────────────────────────────────────────
// Region extraction (recovery input)
// ───────────────────────────────────────────────────────────────────────────

describe("extractInlineSloppyRegions", () => {
	test("returns nothing for empty text", () => {
		expect(extractInlineSloppyRegions("")).toEqual([]);
	});

	test("returns nothing for ordinary prose and code references", () => {
		const text = [
			"I looked at `edit` mode and the hashline anchors:",
			"",
			"```ts",
			"const x = edit({ path: 'a.ts' });",
			"```",
			"",
			"No changes were needed — <the SM:EDIT format> is optional.",
		].join("\n");
		expect(extractInlineSloppyRegions(text)).toEqual([]);
	});

	test("extracts one complete region with its exact offsets", () => {
		const payload = block("a.ts", [["old", "new"]]);
		const text = `Here it is:\n${payload}\nThat is all.`;
		const regions = extractInlineSloppyRegions(text);

		expect(regions).toHaveLength(1);
		expect(regions[0]!.payload).toBe(payload);
		expect(text.slice(regions[0]!.start, regions[0]!.end)).toBe(payload);
	});

	test("extracts several regions in document order", () => {
		const first = block("a.ts", [["one", "two"]]);
		const second = block("b.ts", [["three", "four"]]);
		const regions = extractInlineSloppyRegions(`${first}\nbetween\n${second}`);

		expect(regions.map(r => r.payload)).toEqual([first, second]);
		expect(regions[0]!.end).toBeLessThan(regions[1]!.start);
	});

	test("ignores an unclosed region — a truncated payload is never materialized", () => {
		const text = `${block("a.ts", [["old", "new"]])}\n<SM:EDIT path="b.ts">\n<SM:FIND>\nhalf a find`;
		const regions = extractInlineSloppyRegions(text);

		expect(regions).toHaveLength(1);
		expect(regions[0]!.payload).toContain('path="a.ts"');
	});

	test("pairs an opening tag with the first closing tag that follows it", () => {
		// An unclosed outer block swallows the next block's close. The region is
		// then not a valid payload and the tool rejects it — a half edit is never
		// executed silently.
		const text = `<SM:EDIT path="a.ts">\n<SM:FIND>\nunfinished\n${block("b.ts", [["x", "y"]])}\n</SM:EDIT>`;
		const regions = extractInlineSloppyRegions(text);

		expect(regions).toHaveLength(1);
		expect(() => parseSloppyPayload(regions[0]!.payload)).toThrow(
			/unexpected <SM:EDIT path="b.ts"> inside the <SM:FIND>/,
		);
	});

	test("extracts a closed region even when its body is malformed", () => {
		// The tool reports the malformed payload; dropping it would silently lose
		// an edit the model believed it had made.
		const malformed = `<SM:EDIT path="a.ts">\n<SM:FIND>\nx\n</SM:FIND>\n</SM:EDIT>`;
		const regions = extractInlineSloppyRegions(`payload:\n${malformed}`);
		expect(regions.map(r => r.payload)).toEqual([malformed]);
	});

	test("scans a long reply linearly and still finds the trailing region", () => {
		const payload = block("a.ts", [["old", "new"]]);
		const filler = "note: nothing to change here.\n".repeat(20_000);
		const text = `${block("b.ts", [["first", "second"]])}\n${filler}${payload}\n`;

		const regions = extractInlineSloppyRegions(text);
		expect(regions).toHaveLength(2);
		expect(regions[1]!.payload).toBe(payload);
	});
});

// ───────────────────────────────────────────────────────────────────────────
// Executor
// ───────────────────────────────────────────────────────────────────────────

function executeOptions(input: string, cwd: string) {
	return {
		session: { cwd } as ToolSession,
		input,
		allowFuzzy: false,
		fuzzyThreshold: 0.95,
		// The production no-LSP path: writes the final content through the file
		// handle the caller already opened, and reports no diagnostics.
		writethrough: writethroughNoop,
		beginDeferredDiagnosticsForPath: () => {
			throw new Error("unexpected deferred diagnostics request");
		},
	};
}

describe("executeSloppySingle", () => {
	test("applies a single pair to disk and reports a diff", async () => {
		const file = path.join(dir, "a.ts");
		await fs.writeFile(file, "const a = 1;\n");

		const result = await executeSloppySingle(executeOptions(block(file, [["const a = 1;", "const a = 2;"]]), dir));

		await expect(fs.readFile(file, "utf8")).resolves.toBe("const a = 2;\n");
		expect(result.details?.diff).toContain("const a = 2;");
		expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain(file);
	});

	test("applies pairs in payload order — each pair sees the previous one's result", async () => {
		const file = path.join(dir, "a.ts");
		await fs.writeFile(file, "alpha\nbeta\n");

		const result = await executeSloppySingle(
			executeOptions(
				block(file, [
					["alpha", "ALPHA"],
					["ALPHA\nbeta", "ALPHA\nBETA"],
				]),
				dir,
			),
		);

		await expect(fs.readFile(file, "utf8")).resolves.toBe("ALPHA\nBETA\n");
		expect(result.details?.diff).toContain("BETA");
		// One file, so the result stays a single-file result (no per-file split).
		expect(result.details?.perFileResults).toBeUndefined();
	});

	test("applies blocks across files and reports one result per file", async () => {
		const a = path.join(dir, "a.ts");
		const b = path.join(dir, "b.ts");
		await fs.writeFile(a, "one\n");
		await fs.writeFile(b, "two\n");

		const result = await executeSloppySingle(
			executeOptions(`${block(a, [["one", "1"]])}\n${block(b, [["two", "2"]])}`, dir),
		);

		await expect(fs.readFile(a, "utf8")).resolves.toBe("1\n");
		await expect(fs.readFile(b, "utf8")).resolves.toBe("2\n");
		expect(result.details?.perFileResults?.map(r => r.path)).toEqual([a, b]);
		expect(result.details?.perFileResults?.every(r => !r.isError)).toBe(true);
	});

	test("keeps applying later pairs when one pair fails", async () => {
		const file = path.join(dir, "a.ts");
		await fs.writeFile(file, "alpha\nbeta\n");

		const result = await executeSloppySingle(
			executeOptions(
				block(file, [
					["does not exist", "never"],
					["beta", "BETA"],
				]),
				dir,
			),
		);

		await expect(fs.readFile(file, "utf8")).resolves.toBe("alpha\nBETA\n");
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain(`Error editing ${file}:`);
	});

	test("does not fuzzy-match when fuzzy is off", async () => {
		const file = path.join(dir, "a.ts");
		await fs.writeFile(file, "  indented();\n");

		await expect(
			executeSloppySingle(executeOptions(block(file, [["indented(x);", "indented(y);"]]), dir)),
		).rejects.toThrow(/Could not find the exact text/);
		await expect(fs.readFile(file, "utf8")).resolves.toBe("  indented();\n");
	});

	test("rejects a malformed payload before touching the file", async () => {
		const file = path.join(dir, "a.ts");
		await fs.writeFile(file, "const a = 1;\n");

		await expect(
			executeSloppySingle(executeOptions(`<SM:EDIT path="${file}">\n<SM:FIND>\nconst a = 1;\n</SM:FIND>`, dir)),
		).rejects.toThrow(/Invalid sloppy edit payload/);
		await expect(fs.readFile(file, "utf8")).resolves.toBe("const a = 1;\n");
	});
});

// ───────────────────────────────────────────────────────────────────────────
// Tool surface: the mode is selectable by config and documents its format
// ───────────────────────────────────────────────────────────────────────────

function createTool(session: ToolSession): EditTool {
	return new EditTool(session);
}

describe("EditTool in sloppy mode", () => {
	const originalEditVariant = Bun.env.PI_EDIT_VARIANT;

	afterEach(() => {
		if (originalEditVariant === undefined) {
			delete Bun.env.PI_EDIT_VARIANT;
		} else {
			Bun.env.PI_EDIT_VARIANT = originalEditVariant;
		}
	});

	function session(settings: Record<string, unknown>): ToolSession {
		return {
			cwd: dir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getArtifactsDir: () => null,
			settings: Settings.isolated(settings, { agentDir: path.join(dir, "agent") }),
		} as ToolSession;
	}

	test("is selected by edit.mode: sloppy", () => {
		delete Bun.env.PI_EDIT_VARIANT;
		const tool = createTool(session({ "edit.mode": "sloppy" }));
		expect(tool.mode).toBe("sloppy");
		expect(tool.parameters).toMatchObject({ required: ["input"] });
	});

	test("describes the payload format the parser accepts", () => {
		delete Bun.env.PI_EDIT_VARIANT;
		const tool = createTool(session({ "edit.mode": "sloppy" }));

		expect(tool.description).toContain("**REQUIRED FIELDS**");
		expect(tool.description).toContain("<SM:EDIT path=");
		expect(tool.description).toContain("<SM:FIND>");
		expect(tool.description).toContain("<SM:PUT>");
		// The documented example must survive a round-trip through the parser.
		const example = tool.description.match(/<SM:EDIT path="[\s\S]*?<\/SM:EDIT>/)?.[0] ?? "";
		expect(example.length).toBeGreaterThan(0);
		expect(() => parseSloppyPayload(example)).not.toThrow();
	});
});
