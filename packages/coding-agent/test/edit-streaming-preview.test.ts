import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { dropIncompleteLastEdit, EDIT_MODE_STRATEGIES } from "@cornfield/coding-agent/edit";

describe("dropIncompleteLastEdit", () => {
	test("keeps all entries when partialJson is undefined", () => {
		const edits = [{ path: "a" }, { path: "b" }];
		expect(dropIncompleteLastEdit(edits, undefined, "edits")).toEqual(edits);
	});

	test("keeps all entries when the trailing object is closed", () => {
		const edits = [{ path: "a" }, { path: "b" }];
		const partial = '{"edits":[{"path":"a"},{"path":"b"}]}';
		expect(dropIncompleteLastEdit(edits, partial, "edits")).toEqual(edits);
	});

	test("drops the last entry when its closing } has not arrived", () => {
		const edits = [{ path: "a" }, { path: "b" }];
		const partial = '{"edits":[{"path":"a"},{"path":"b"';
		expect(dropIncompleteLastEdit(edits, partial, "edits")).toEqual([{ path: "a" }]);
	});

	test("drops the last entry when a new {} has opened after the last close", () => {
		const edits = [{ path: "a" }, { path: "b" }];
		const partial = '{"edits":[{"path":"a"},{"pat';
		expect(dropIncompleteLastEdit(edits, partial, "edits")).toEqual([{ path: "a" }]);
	});

	test("leaves empty edits alone", () => {
		expect(dropIncompleteLastEdit([], '{"edits":[', "edits")).toEqual([]);
	});
});

describe("apply_patch extractCompleteEdits", () => {
	const strategy = EDIT_MODE_STRATEGIES.apply_patch;

	test("returns args unchanged (payload is plain text)", () => {
		const args = { input: "*** Begin Patch\n*** Update File: a.ts\n@@\n-x\n+y\n*** End Patch\n" };
		expect(strategy.extractCompleteEdits(args, undefined)).toEqual(args);
	});
});

describe("vim extractCompleteEdits", () => {
	const strategy = EDIT_MODE_STRATEGIES.vim;

	test("returns args unchanged (vim stream handled elsewhere)", () => {
		const args = { file: "a.ts", steps: [] };
		expect(strategy.extractCompleteEdits(args, undefined)).toEqual(args);
	});
});

describe("sloppy streaming preview", () => {
	const strategy = EDIT_MODE_STRATEGIES.sloppy;
	let dir: string;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "edit-sloppy-preview-"));
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	function context(signal = new AbortController().signal) {
		return { cwd: dir, signal, allowFuzzy: true, fuzzyThreshold: 0.95 };
	}

	test("returns args unchanged (payload is plain text)", () => {
		const args = { input: '<SM:EDIT path="a.ts">' };
		expect(strategy.extractCompleteEdits(args, undefined)).toEqual(args);
	});

	test("has no preview until a block is closed", async () => {
		await fs.writeFile(path.join(dir, "a.ts"), "old\n");
		const partial = '<SM:EDIT path="a.ts">\n<SM:FIND>\nold\n</SM:FIND>\n<SM:PUT>\nnew';

		expect(await strategy.computeDiffPreview({ input: "" }, context())).toBeNull();
		expect(await strategy.computeDiffPreview({ input: partial }, context())).toBeNull();
	});

	test("previews the first complete block against the file on disk", async () => {
		await fs.writeFile(path.join(dir, "a.ts"), "old\n");
		const input = `<SM:EDIT path="a.ts">\n<SM:FIND>\nold\n</SM:FIND>\n<SM:PUT>\nnew\n</SM:PUT>\n</SM:EDIT>`;

		const preview = await strategy.computeDiffPreview({ input }, context());
		expect(preview).toHaveLength(1);
		expect(preview?.[0]?.path).toBe("a.ts");
		expect(preview?.[0]?.diff).toContain("new");
	});
});
