import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { ToolError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(c => c.type === "text")
		.map(c => c.text ?? "")
		.join("\n");
}

function createSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => null,
		allocateOutputArtifact: async () => ({ id: "unused", path: "/dev/null" }),
		settings: Settings.isolated(),
	} as ToolSession;
}

describe("edit tool edits schema — accept both object and array", () => {
	let tmpDir: string;
	let editTool: EditTool;
	let testFile: string;
	let originalEditVariant: string | undefined;

	beforeEach(() => {
		originalEditVariant = Bun.env.PI_EDIT_VARIANT;
		Bun.env.PI_EDIT_VARIANT = "replace";
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fix-e2e-edit-"));
		testFile = path.join(tmpDir, "test.txt");
		fs.writeFileSync(testFile, "first\nsecond\nthird\n");
		editTool = new EditTool(createSession(tmpDir));
	});

	afterEach(() => {
		if (originalEditVariant === undefined) delete Bun.env.PI_EDIT_VARIANT;
		else Bun.env.PI_EDIT_VARIANT = originalEditVariant;
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("accepts edits as an array (normal form)", async () => {
		const result = await editTool.execute("arr-1", {
			path: testFile,
			edits: [{ old_text: "first\n", new_text: "hi\n" }],
		});
		expect(getText(result)).toContain("Successfully replaced");
		expect(fs.readFileSync(testFile, "utf-8")).toBe("hi\nsecond\nthird\n");
	});

	it("accepts edits as a single object (bug-compat)", async () => {
		const result = await editTool.execute("obj-1", {
			path: testFile,
			edits: { old_text: "second\n", new_text: "earth\n" },
		});
		expect(getText(result)).toContain("Successfully replaced");
		expect(fs.readFileSync(testFile, "utf-8")).toBe("first\nearth\nthird\n");
	});

	it("chains object edit then array edit on same file", async () => {
		await editTool.execute("obj-2a", {
			path: testFile,
			edits: { old_text: "first\n", new_text: "alpha\n" },
		});
		await editTool.execute("obj-2b", {
			path: testFile,
			edits: [{ old_text: "second\n", new_text: "beta\n" }],
		});
		expect(fs.readFileSync(testFile, "utf-8")).toBe("alpha\nbeta\nthird\n");
	});
});

describe("read tool — NOT FOUND error includes find/search hint", () => {
	let tmpDir: string;
	let readTool: ReadTool;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fix-e2e-read-"));
		readTool = new ReadTool(createSession(tmpDir));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("includes `find` and `search` in the error for non-existent paths", async () => {
		await expect(
			readTool.execute("not-found", { path: path.join(tmpDir, "nonexistent.md") }),
		).rejects.toThrow(/`find`.*`search`|`search`.*`find`/);
	});
});

describe("bash tool — Python syntax pre-check catches errors before execution", () => {
	let tmpDir: string;
	let bashTool: BashTool;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fix-e2e-bash-"));
		bashTool = new BashTool(createSession(tmpDir));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("rejects inline Python with trailing comma syntax error", async () => {
		await expect(
			bashTool.execute("py-syntax", { command: 'python3 -c "import sys,; print(1)"' }),
		).rejects.toThrow(/Python syntax check failed/);
	});

	it("rejects inline Python with invalid syntax", async () => {
		await expect(
			bashTool.execute("py-syntax-2", { command: 'python3 -c "if True print(1)"' }),
		).rejects.toThrow(/Python syntax check failed/);
	});

	it("allows valid Python to run normally", async () => {
		const result = await bashTool.execute("py-valid", {
			command: "python3 -c 'import sys; print(\"ok\");'",
		});
		expect(getText(result)).toContain("ok");
	});

	it("allows non-Python commands to run normally", async () => {
		const result = await bashTool.execute("echo-test", { command: "echo hello" });
		expect(getText(result)).toContain("hello");
	});
});
