import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { _resetSettingsForTest, Settings } from "@cornfield/coding-agent/config/settings";
import type { ToolSession } from "@cornfield/coding-agent/tools";
import { WriteTool } from "@cornfield/coding-agent/tools";

function createSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		enableLsp: false,
		hasEditTool: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	};
}

const tempDirs: string[] = [];

beforeAll(async () => {
	_resetSettingsForTest();
	const settingsDir = await fs.mkdtemp(path.join(os.tmpdir(), "write-content-object-settings-"));
	tempDirs.push(settingsDir);
	await Settings.init({ inMemory: true, cwd: settingsDir });
});

async function makeTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "write-content-object-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

async function captureError(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	throw new Error("expected promise to reject");
}

describe("write object/array content", () => {
	it("serializes object content into a new .json file with tab indentation", async () => {
		const dir = await makeTempDir();
		const target = path.join(dir, "config.json");
		const tool = new WriteTool(createSession(dir));
		await tool.execute("call-1", { path: target, content: { name: "cornfield", level: 3 } });
		const text = await Bun.file(target).text();
		expect(JSON.parse(text)).toEqual({ name: "cornfield", level: 3 });
		expect(text).toContain('\n\t"name": "cornfield"');
		expect(text.endsWith("\n")).toBe(true);
	});

	it("preserves existing indentation when overwriting a JSON file", async () => {
		const dir = await makeTempDir();
		const target = path.join(dir, "config.json");
		await Bun.write(target, '{\n  "old": true\n}\n');
		const tool = new WriteTool(createSession(dir));
		await tool.execute("call-1", { path: target, content: { name: "x" } });
		const text = await Bun.file(target).text();
		expect(JSON.parse(text)).toEqual({ name: "x" });
		expect(text).toContain('\n  "name": "x"');
		expect(text).not.toContain("\t");
	});

	it("serializes array content into a .jsonc file", async () => {
		const dir = await makeTempDir();
		const target = path.join(dir, "list.jsonc");
		const tool = new WriteTool(createSession(dir));
		await tool.execute("call-1", { path: target, content: ["a", "b", "c"] });
		const text = await Bun.file(target).text();
		expect(JSON.parse(text)).toEqual(["a", "b", "c"]);
	});

	it("rejects object content for a non-JSON target with an executable error", async () => {
		const dir = await makeTempDir();
		const target = path.join(dir, "notes.txt");
		const tool = new WriteTool(createSession(dir));
		const message = await captureError(tool.execute("call-1", { path: target, content: { a: 1 } }));
		expect(message).toContain("must be a string");
		expect(message).toContain(".json");
		expect(message).toContain("JSON.stringify");
	});

	it("includes the received args summary when a write fails", async () => {
		const dir = await makeTempDir();
		const tool = new WriteTool(createSession(dir));
		const message = await captureError(tool.execute("call-1", { path: "xd://nope", content: { a: 12345 } }));
		expect(message).toContain("Received write args:");
		expect(message).toContain("path=xd://nope");
		expect(message).toContain('"a":12345');
	});
});
