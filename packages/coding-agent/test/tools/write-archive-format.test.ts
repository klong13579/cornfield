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
	const settingsDir = await fs.mkdtemp(path.join(os.tmpdir(), "write-archive-format-settings-"));
	tempDirs.push(settingsDir);
	await Settings.init({ inMemory: true, cwd: settingsDir });
});

async function makeTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "write-archive-format-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

async function isGzip(filePath: string): Promise<boolean> {
	const head = new Uint8Array((await Bun.file(filePath).arrayBuffer()).slice(0, 2));
	return head[0] === 0x1f && head[1] === 0x8b;
}

/**
 * The archive container must match the name the caller asked for. `Bun.Archive.write`
 * does not infer compression from the path, so a `.tar.gz` target needs an explicit
 * gzip option — otherwise the tool reports success and writes a plain tar that no
 * `tar -xzf` / npm / docker layer can read.
 */
describe("write archive container format", () => {
	it("writes a gzipped stream for .tar.gz and .tgz targets", async () => {
		const dir = await makeTempDir();
		const tool = new WriteTool(createSession(dir));

		for (const name of ["bundle.tar.gz", "bundle.tgz"]) {
			await tool.execute("call-gz", { path: `${name}:pkg/readme.md`, content: "hello\n" });
			expect(await isGzip(path.join(dir, name))).toBe(true);
		}
	});

	it("leaves a .tar target uncompressed", async () => {
		const dir = await makeTempDir();
		const tool = new WriteTool(createSession(dir));

		await tool.execute("call-tar", { path: "bundle.tar:pkg/readme.md", content: "hello\n" });
		expect(await isGzip(path.join(dir, "bundle.tar"))).toBe(false);
	});

	it("keeps the container gzipped when rewriting an existing entry", async () => {
		const dir = await makeTempDir();
		const tool = new WriteTool(createSession(dir));

		await tool.execute("call-new", { path: "bundle.tgz:a.txt", content: "first\n" });
		await tool.execute("call-update", { path: "bundle.tgz:b.txt", content: "second\n" });

		const archive = new Bun.Archive(await Bun.file(path.join(dir, "bundle.tgz")).bytes());
		const files = await archive.files();
		expect(await isGzip(path.join(dir, "bundle.tgz"))).toBe(true);
		expect([...files.keys()].sort()).toEqual(["a.txt", "b.txt"]);
		expect(await files.get("b.txt")?.text()).toBe("second\n");
	});
});
