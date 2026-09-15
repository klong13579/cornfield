import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolContext } from "@cornfield/agent";
import { _resetSettingsForTest, Settings } from "@cornfield/coding-agent/config/settings";
import type { ToolSession } from "@cornfield/coding-agent/tools";
import { BashTool } from "@cornfield/coding-agent/tools/bash";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-pty-notice-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

function createSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		hasEditTool: false,
		enableLsp: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "async.enabled": false, "bash.autoBackground.enabled": false }),
	} as unknown as ToolSession;
}

function getResultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("\n");
}

/**
 * `pty: true` asks for a terminal. Without a UI there is none, and the command runs
 * as a plain pipe — the caller must be told, or it reads the output as if it came
 * from a tty.
 */
describe("bash pty availability notice", () => {
	beforeEach(async () => {
		_resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: await makeTempDir() });
	});

	it("states that the pty request was not honoured", async () => {
		const dir = await makeTempDir();
		const tool = new BashTool(createSession(dir));

		const result = await tool.execute("call-pty", { command: "echo hi", pty: true }, undefined, undefined, {
			hasUI: false,
		} as unknown as AgentToolContext);

		expect(getResultText(result)).toContain("pty requested but unavailable in this environment");
	});

	it("adds nothing when no pty was requested", async () => {
		const dir = await makeTempDir();
		const tool = new BashTool(createSession(dir));

		const result = await tool.execute("call-plain", { command: "echo hi" });

		expect(getResultText(result)).not.toContain("pty requested");
	});
});
