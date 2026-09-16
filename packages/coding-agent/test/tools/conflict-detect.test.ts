import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../../src/config/settings";
import type { ToolSession } from "../../src/sdk";
import { parseConflictUri, scanConflictLines, spliceConflict } from "../../src/tools/conflict-detect";
import { ReadTool, readToolRenderer } from "../../src/tools/read";
import { WriteTool } from "../../src/tools/write";
import { createRenderSurface } from "../helpers/render-assert";

function git(cwd: string, args: string[]): void {
	const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	// `merge` exits non-zero when it leaves a conflict, which is the state these
	// fixtures are built to produce.
	if (result.exitCode !== 0 && !args.includes("merge")) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
	}
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("\n");
}

/**
 * Unresolved merge conflicts, end to end: a real git repository produces the
 * markers, `read` surfaces and numbers them, and `write conflict://<N>` splices
 * one back out. Fixtures are built with real `git merge` rather than
 * hand-written marker text — the marker shape (labels, the diff3 base line,
 * CRLF handling) is exactly what this feature has to match, and hand-written
 * fixtures would only assert this code's own assumptions back at itself.
 *
 * One session per test, deliberately: conflict ids are session state, and a
 * fresh session per call would mask a read→write id handoff that does not work.
 */
describe("conflict discovery", () => {
	let repo: string;
	let session: ToolSession;
	let readTool: ReadTool;
	let writeTool: WriteTool;
	const file = "src/app.ts";

	beforeEach(async () => {
		repo = await fs.mkdtemp(path.join(os.tmpdir(), "conflict-read-"));
		await fs.mkdir(path.join(repo, "src"), { recursive: true });
		git(repo, ["init", "-q", "-b", "main"]);
		git(repo, ["config", "user.email", "test@example.com"]);
		git(repo, ["config", "user.name", "Test"]);
		// Keep the fixture bytes as written: the CRLF case is about the tool's
		// handling of the markers, not the repository's normalization.
		git(repo, ["config", "core.autocrlf", "false"]);
		session = {
			cwd: repo,
			hasEditTool: false,
			enableLsp: false,
			settings: Settings.isolated({ "read.defaultLimit": 3000, readLineNumbers: false }),
		} as unknown as ToolSession;
		readTool = new ReadTool(session);
		writeTool = new WriteTool(session);
	});

	afterEach(async () => {
		await fs.rm(repo, { recursive: true, force: true });
	});

	/** Commit a base, diverge on `theirs`, then merge into `main` and leave the conflict. */
	async function conflictingFile(options: {
		base: string;
		ours: string;
		theirs: string;
		style?: "merge" | "diff3";
		eol?: string;
	}): Promise<void> {
		const eol = options.eol ?? "\n";
		const write = (text: string) => Bun.write(path.join(repo, file), text.replace(/\n/g, eol));
		await write(options.base);
		git(repo, ["add", file]);
		git(repo, ["commit", "-qm", "base"]);
		git(repo, ["checkout", "-q", "-b", "theirs"]);
		await write(options.theirs);
		git(repo, ["add", file]);
		git(repo, ["commit", "-qm", "theirs"]);
		git(repo, ["checkout", "-q", "main"]);
		await write(options.ours);
		git(repo, ["add", file]);
		git(repo, ["commit", "-qm", "ours"]);
		git(repo, ["-c", `merge.conflictStyle=${options.style ?? "merge"}`, "merge", "--no-edit", "theirs"]);
	}

	function read(filePath: string, sel?: string): Promise<string> {
		return readTool.execute("c-read", { path: filePath, sel }).then(textOf);
	}

	function write(pathArg: string, content: string): Promise<string> {
		return writeTool.execute("c-write", { path: pathArg, content }).then(textOf);
	}

	function disk(): Promise<string> {
		return Bun.file(path.join(repo, file)).text();
	}

	it("indexes a real conflict by id, line range and both sides", async () => {
		await conflictingFile({ base: "l1\nl2\nl3\nl4\n", ours: "l1\nOURS\nl3\nl4\n", theirs: "l1\nTHEIRS\nl3\nl4\n" });

		const index = await read(`${file}:conflicts`);
		expect(index).toContain("⚠ 1 unresolved conflict in src/app.ts");
		expect(index).toContain("- ours = HEAD");
		expect(index).toContain("- theirs = theirs");
		expect(index).toContain("#1  L2-6");
		expect(index).not.toContain("(3-way)");

		// Same request through the `sel` mode, so the two notations cannot drift.
		expect(await read(file, "conflicts")).toContain("#1  L2-6");
	});

	it("keeps a block's id stable across repeated reads of the same file", async () => {
		await conflictingFile({ base: "a\nb\n", ours: "a\nOURS\n", theirs: "a\nTHEIRS\n" });
		expect(await read(`${file}:conflicts`)).toContain("#1  L2-6");
		const second = await read(`${file}:conflicts`);
		expect(second).toContain("#1  L2-6");
		expect(second).not.toContain("#2");
	});

	it("reads one block, and one side of it, at the recorded file line numbers", async () => {
		await conflictingFile({ base: "l1\nl2\nl3\nl4\n", ours: "l1\nOURS\nl3\nl4\n", theirs: "l1\nTHEIRS\nl3\nl4\n" });
		await read(`${file}:conflicts`);

		expect(await read("conflict://1")).toBe("<<<<<<< HEAD\nOURS\n=======\nTHEIRS\n>>>>>>> theirs");
		expect(await read("conflict://1/ours")).toBe("OURS");
		expect(await read("conflict://1/theirs")).toBe("THEIRS");
	});

	it("resolves a block, leaving the rest of the file untouched", async () => {
		await conflictingFile({ base: "l1\nl2\nl3\nl4\n", ours: "l1\nOURS\nl3\nl4\n", theirs: "l1\nTHEIRS\nl3\nl4\n" });
		await read(`${file}:conflicts`);

		expect(await write("conflict://1", "@ours")).toContain("Resolved conflict #1 at lines 2\u20136 in src/app.ts.");
		expect(await disk()).toBe("l1\nOURS\nl3\nl4\n");
		expect(await read(`${file}:conflicts`)).toContain("No unresolved git merge conflicts");
	});

	it("keeps a later id valid after an earlier block in the same file is resolved", async () => {
		// Two edits far enough apart that git reports them as two conflicts rather
		// than one merged hunk.
		const filler = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `l${from + i}`);
		const lines = (a: string | null, b: string | null) =>
			[
				"l1",
				"l2",
				...(a === null ? ["l3"] : [a]),
				...filler(4, 24),
				...(b === null ? ["l25"] : [b]),
				...filler(26, 30),
				"",
			].join("\n");
		await conflictingFile({
			base: lines(null, null),
			ours: lines("OURS_A", "OURS_B"),
			theirs: lines("THEIRS_A", "THEIRS_B"),
		});

		const index = await read(`${file}:conflicts`);
		expect(index).toContain("⚠ 2 unresolved conflicts");
		expect(index).toContain("#1");
		expect(index).toContain("#2");

		// Resolving #1 rewrites the file; #2 keeps its id and its recorded region.
		expect(await write("conflict://1", "@ours")).toContain("Resolved conflict #1");
		expect(await disk()).toContain("OURS_A");
		expect(await write("conflict://2", "@theirs")).toContain("Resolved conflict #2");
		const resolved = await disk();
		expect(resolved).toContain("OURS_A");
		expect(resolved).toContain("THEIRS_B");
		expect(resolved).not.toContain("<<<<<<<");
	});

	it("reports the base side only for diff3 conflicts", async () => {
		await conflictingFile({
			base: "l1\nl2\nl3\n",
			ours: "l1\nOURS\nl3\n",
			theirs: "l1\nTHEIRS\nl3\n",
			style: "diff3",
		});

		expect(await read(`${file}:conflicts`)).toContain("(3-way)");
		const block = await read("conflict://1");
		expect(block).toContain("||||||| ");
		expect(block).toContain("l2");
		expect(await read("conflict://1/base")).toBe("l2");

		expect(await write("conflict://1", "@base")).toContain("Resolved conflict #1");
		expect(await disk()).toBe("l1\nl2\nl3\n");
	});

	it("refuses to invent a base side for a 2-way conflict", async () => {
		await conflictingFile({ base: "l1\nl2\nl3\n", ours: "l1\nOURS\nl3\n", theirs: "l1\nTHEIRS\nl3\n" });
		await read(`${file}:conflicts`);
		expect(read("conflict://1/base")).rejects.toThrow(/has no base section \(2-way merge\)/);
		expect(write("conflict://1", "@base")).rejects.toThrow(/has no base section \(2-way merge\)/);
	});

	it("detects CRLF conflicts and writes the resolution back as CRLF", async () => {
		await conflictingFile({
			base: "l1\nl2\nl3\nl4\n",
			ours: "l1\nOURS\nl3\nl4\n",
			theirs: "l1\nTHEIRS\nl3\nl4\n",
			eol: "\r\n",
		});

		expect(await read(`${file}:conflicts`)).toContain("⚠ 1 unresolved conflict");
		// Recorded sides are LF-normalized; only the file round-trip keeps CRLF.
		expect(await read("conflict://1/ours")).toBe("OURS");

		await write("conflict://1", "@ours");
		expect(await disk()).toBe("l1\r\nOURS\r\nl3\r\nl4\r\n");
	});

	it("resolves every registered conflict in one call", async () => {
		await Bun.write(
			path.join(repo, file),
			[
				"<<<<<<< HEAD",
				"A",
				"=======",
				"A_theirs",
				">>>>>>> theirs",
				"middle",
				"<<<<<<< HEAD",
				"B",
				"=======",
				"B_theirs",
				">>>>>>> theirs",
				"",
			].join("\n"),
		);

		await read(`${file}:conflicts`);
		expect(await write("conflict://*", "@ours")).toContain("Resolved 2 conflicts across 1 file:");
		expect(await disk()).toBe("A\nmiddle\nB\n");
	});

	it("resolves a listed subset in per-id directive mode and keeps the rest registered", async () => {
		await Bun.write(
			path.join(repo, file),
			[
				"<<<<<<< HEAD",
				"A",
				"=======",
				"A_theirs",
				">>>>>>> theirs",
				"middle",
				"<<<<<<< HEAD",
				"B",
				"=======",
				"B_theirs",
				">>>>>>> theirs",
				"",
			].join("\n"),
		);
		await read(`${file}:conflicts`);

		const result = await write("conflict://*", "2: @theirs");
		expect(result).toContain("Resolved 1 conflict across 1 file:");
		expect(result).toContain("Directive mode: 1 unlisted conflict still registered (#1).");
		// Only block #2 was resolved; block #1 is still on disk with its id.
		expect(await disk()).toBe("<<<<<<< HEAD\nA\n=======\nA_theirs\n>>>>>>> theirs\nmiddle\nB_theirs\n");
		expect(await write("conflict://1", "@ours")).toContain("Resolved conflict #1");
		expect(await disk()).toBe("A\nmiddle\nB_theirs\n");
	});

	it("refuses a mixed per-id block instead of pasting it into every conflict", async () => {
		await Bun.write(
			path.join(repo, file),
			["<<<<<<< HEAD", "A", "=======", "A_theirs", ">>>>>>> theirs", ""].join("\n"),
		);
		await read(`${file}:conflicts`);
		expect(write("conflict://*", "1: @ours\nsome literal text")).rejects.toThrow(
			/Malformed `conflict:\/\/\*` per-id block/,
		);
		expect(await disk()).toContain("<<<<<<< HEAD");
	});

	it("rejects unknown ids, wildcard reads and scoped writes", async () => {
		await conflictingFile({ base: "a\nb\n", ours: "a\nOURS\n", theirs: "a\nTHEIRS\n" });
		expect(read("conflict://7")).rejects.toThrow(/Conflict #7 not found/);
		expect(write("conflict://7", "@ours")).rejects.toThrow(/Conflict #7 not found/);
		await read(`${file}:conflicts`);
		expect(write("conflict://*", "9: @ours")).rejects.toThrow(/unknown conflict id\(s\) #9/);
		expect(read("conflict://*")).rejects.toThrow(/wildcards are write-only/);
		expect(write("conflict://1/ours", "@ours")).rejects.toThrow(/scope '\/ours' is read-only/);
	});

	it("warns when a window contains conflicts and stays silent otherwise", async () => {
		await Bun.write(
			path.join(repo, file),
			[
				"<<<<<<< HEAD",
				"A",
				"=======",
				"A_theirs",
				">>>>>>> theirs",
				...Array.from({ length: 40 }, (_, i) => `filler ${i}`),
				"<<<<<<< HEAD",
				"B",
				"=======",
				"B_theirs",
				">>>>>>> theirs",
				"",
			].join("\n"),
		);

		const window = await read(file, "1-5");
		expect(window).toContain("⚠ 1 of 2 unresolved conflicts visible in this window");
		expect(window).toContain("`src/app.ts:conflicts`");
		// The footer is the only addition — the window's own lines are untouched
		// and come first.
		expect(window.startsWith("<<<<<<< HEAD\nA\n=======\nA_theirs\n>>>>>>> theirs\n⚠ ")).toBe(true);
		// A window that shows the whole conflict does not count the other one as visible.
		expect(window).not.toContain("#2");
		expect(window.indexOf("⚠")).toBeGreaterThan(window.indexOf("[41 more lines in file."));

		await Bun.write(path.join(repo, file), "clean\nfile");
		expect(await read(file)).toBe("clean\nfile");
	});

	it("does not treat a file whose name ends in :conflicts as a selector", async () => {
		await Bun.write(path.join(repo, "odd:conflicts"), "not a conflict");
		expect(await read("odd:conflicts")).toBe("not a conflict");
	});

	it("badges a conflicted read in the rendered title", async () => {
		await Bun.write(
			path.join(repo, file),
			["<<<<<<< HEAD", "A", "=======", "A_theirs", ">>>>>>> theirs", "", "trailing", ""].join("\n"),
		);
		const result = await readTool.execute("c", { path: file });
		const surface = await createRenderSurface({ width: 80 });
		const rendered = surface.text(
			readToolRenderer.renderResult(result, { expanded: true, isPartial: false }, surface.theme, { path: file }),
		);
		expect(rendered).toContain("1 conflict");

		// A clean read carries no badge.
		await Bun.write(path.join(repo, file), "clean\nfile");
		const clean = await readTool.execute("c2", { path: file });
		expect(
			surface.text(
				readToolRenderer.renderResult(clean, { expanded: true, isPartial: false }, surface.theme, { path: file }),
			),
		).not.toContain("conflict");
	});
});

describe("conflict scanning units", () => {
	it("only matches column-0 markers of the exact shape", () => {
		const blocks = scanConflictLines(["<<<<<<< HEAD", "a", "=======", "b", ">>>>>>> theirs", "x <<<<<<< HEAD"], 10);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toMatchObject({ startLine: 10, separatorLine: 12, endLine: 14 });
		expect(scanConflictLines(["  <<<<<<< HEAD", "a", "=======", "b", ">>>>>>> theirs"], 1)).toHaveLength(0);
		expect(scanConflictLines(["<<<<<<<HEAD"], 1)).toHaveLength(0);
	});

	it("drops a block whose closer is outside the window", () => {
		expect(scanConflictLines(["<<<<<<< HEAD", "a", "=======", "b"], 1)).toHaveLength(0);
	});

	it("drops a multi-line echo of the context above the region", () => {
		const original = [
			"const a = 1;",
			"const b = 2;",
			"<<<<<<< HEAD",
			"const merged = 1;",
			"=======",
			"const merged = 2;",
			">>>>>>> theirs",
			"tail",
			"",
		].join("\n");
		const entry = {
			id: 1,
			absolutePath: "/tmp/x.ts",
			displayPath: "x.ts",
			startLine: 3,
			separatorLine: 5,
			endLine: 7,
			oursLabel: "HEAD",
			theirsLabel: "theirs",
			oursLines: ["const merged = 1;"],
			theirsLines: ["const merged = 2;"],
		};
		// The model re-wrote the surrounding lines along with the resolution.
		const splice = spliceConflict(original, entry, "const a = 1;\nconst b = 2;\nconst merged = 3;");
		expect(splice.trimmedLeading).toBe(2);
		expect(splice.trimmedTrailing).toBe(0);
		expect(splice.text).toBe("const a = 1;\nconst b = 2;\nconst merged = 3;\ntail\n");
	});

	it("drops a single-line echo when keeping it would unbalance the region", () => {
		const original = ["}", "<<<<<<< HEAD", "return 1;", "=======", "return 2;", ">>>>>>> theirs", "}", ""].join("\n");
		const entry = {
			id: 1,
			absolutePath: "/tmp/x.ts",
			displayPath: "x.ts",
			startLine: 2,
			separatorLine: 4,
			endLine: 6,
			oursLabel: "HEAD",
			theirsLabel: "theirs",
			oursLines: ["return 1;"],
			theirsLines: ["return 2;"],
		};
		const splice = spliceConflict(original, entry, "}\nreturn 1;");
		expect(splice.trimmedLeading).toBe(1);
		expect(splice.text).toBe("}\nreturn 1;\n}\n");
	});

	it("keeps a single-line echo that the recorded sides do not justify dropping", () => {
		const original = ["}", "<<<<<<< HEAD", "return 1;", "=======", "return 2;", ">>>>>>> theirs", "}", ""].join("\n");
		const entry = {
			id: 1,
			absolutePath: "/tmp/x.ts",
			displayPath: "x.ts",
			startLine: 2,
			separatorLine: 4,
			endLine: 6,
			oursLabel: "HEAD",
			theirsLabel: "theirs",
			oursLines: ["return 1;"],
			theirsLines: ["return 2;"],
		};
		const splice = spliceConflict(original, entry, "}");
		expect(splice.trimmedLeading).toBe(0);
		expect(splice.text).toBe("}\n}\n}\n");
	});

	it("fails loudly when the recorded marker block is gone", () => {
		const entry = {
			id: 4,
			absolutePath: "/tmp/x.ts",
			displayPath: "x.ts",
			startLine: 1,
			separatorLine: 2,
			endLine: 3,
			oursLabel: "HEAD",
			theirsLabel: "theirs",
			oursLines: ["a"],
			theirsLines: ["b"],
		};
		expect(() => spliceConflict("nothing to see\n", entry, "x")).toThrow(/Conflict #4 no longer present/);
	});

	it("parses the conflict uri grammar", () => {
		expect(parseConflictUri("conflict://3")).toEqual({ id: 3 });
		expect(parseConflictUri("conflict://3/theirs")).toEqual({ id: 3, scope: "theirs" });
		expect(parseConflictUri("conflict://*")).toEqual({ id: "*" });
		expect(parseConflictUri("src/app.ts:conflict://2")).toMatchObject({ id: 2, recoveredPrefix: "src/app.ts" });
		expect(parseConflictUri("src/app.ts")).toBeNull();
		expect(parseConflictUri("src/app.ts:conflicts")).toBeNull();
		expect(() => parseConflictUri("conflict://abc")).toThrow(/must be 'conflict:\/\/<N>'/);
		expect(() => parseConflictUri("conflict://0")).toThrow(/id must be ≥ 1/);
		expect(() => parseConflictUri("conflict://1/sideways")).toThrow(/scope must be one of/);
		expect(() => parseConflictUri("conflict://*/ours")).toThrow(/does not accept a scope segment/);
	});
});
