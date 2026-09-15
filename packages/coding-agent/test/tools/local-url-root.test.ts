import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { _resetSettingsForTest, Settings } from "@cornfield/coding-agent/config/settings";
import { InternalUrlRouter, LocalProtocolHandler } from "@cornfield/coding-agent/internal-urls";
import type { ToolSession } from "@cornfield/coding-agent/tools";
import { ReadTool, WriteTool } from "@cornfield/coding-agent/tools";

const tempDirs: string[] = [];

beforeAll(async () => {
	_resetSettingsForTest();
	const settingsDir = await fs.mkdtemp(path.join(os.tmpdir(), "local-root-settings-"));
	tempDirs.push(settingsDir);
	await Settings.init({ inMemory: true, cwd: settingsDir });
});

async function makeTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "local-root-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

function getResultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(c => c.type === "text")
		.map(c => c.text ?? "")
		.join("\n");
}

/**
 * A subagent is handed its parent's `local://` root so both operate on the same
 * scratch space. `local://` is resolved in three places — the URL router (read),
 * plan-mode-guard (write/edit) and bash expansion — and a session that shares a
 * root must resolve the same URL to the same file in all three.
 */
describe("local:// root sharing", () => {
	it("writes local:// into the shared root, not the session's own root", async () => {
		const dir = await makeTempDir();
		const parentArtifacts = path.join(dir, "parent");
		const childArtifacts = path.join(dir, "child");

		const session = {
			cwd: dir,
			hasUI: false,
			enableLsp: false,
			hasEditTool: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
			getArtifactsDir: () => childArtifacts,
			localProtocolOptions: { getArtifactsDir: () => parentArtifacts },
		} as unknown as ToolSession;

		await new WriteTool(session).execute("call-1", { path: "local://note.md", content: "shared\n" });

		expect(await Bun.file(path.join(parentArtifacts, "local", "note.md")).text()).toBe("shared\n");
		expect(await Bun.file(path.join(childArtifacts, "local", "note.md")).exists()).toBe(false);
	});

	it("reads back the same file through the router", async () => {
		const dir = await makeTempDir();
		const parentArtifacts = path.join(dir, "parent");

		const session = {
			cwd: dir,
			hasUI: false,
			enableLsp: false,
			hasEditTool: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
			getArtifactsDir: () => path.join(dir, "child"),
			localProtocolOptions: { getArtifactsDir: () => parentArtifacts },
		} as unknown as ToolSession;

		await new WriteTool(session).execute("call-2", { path: "local://note.md", content: "shared\n" });

		const router = new InternalUrlRouter();
		router.register(new LocalProtocolHandler({ getArtifactsDir: () => parentArtifacts }));
		const readTool = new ReadTool({ ...session, internalRouter: router } as unknown as ToolSession);

		expect(getResultText(await readTool.execute("call-3", { path: "local://note.md" }))).toContain("shared");
	});

	it("keeps using the session's own root when no shared root is given", async () => {
		const dir = await makeTempDir();
		const ownArtifacts = path.join(dir, "own");

		const session = {
			cwd: dir,
			hasUI: false,
			enableLsp: false,
			hasEditTool: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
			getArtifactsDir: () => ownArtifacts,
		} as unknown as ToolSession;

		await new WriteTool(session).execute("call-4", { path: "local://own.md", content: "mine\n" });

		expect(await Bun.file(path.join(ownArtifacts, "local", "own.md")).text()).toBe("mine\n");
	});
});
