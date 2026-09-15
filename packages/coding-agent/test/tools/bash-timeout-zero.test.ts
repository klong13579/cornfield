import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { _resetSettingsForTest, Settings } from "@cornfield/coding-agent/config/settings";
import type { ToolSession } from "@cornfield/coding-agent/tools";
import { BashTool } from "@cornfield/coding-agent/tools/bash";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-timeout-zero-"));
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

/**
 * `timeout: 0` is an explicit "no deadline" request. Clamping it to the 1s minimum
 * killed the command after a second while the caller believed it had unbounded time —
 * silent, and the opposite of what was asked for.
 */
describe("bash timeout 0", () => {
	beforeEach(async () => {
		_resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: await makeTempDir() });
	});

	it("does not kill a command that runs longer than the minimum timeout", async () => {
		const dir = await makeTempDir();
		const tool = new BashTool(createSession(dir));

		const result = await tool.execute("call-zero", {
			command: "sleep 2 && echo done",
			timeout: 0,
		});
		const text = result.content
			.filter(block => block.type === "text")
			.map(block => block.text ?? "")
			.join("\n");

		expect(text).toContain("done");
		expect(text).toContain("Command deadline disabled");
	});

	it("still clamps a nonzero timeout to the allowed range", async () => {
		const dir = await makeTempDir();
		const tool = new BashTool(createSession(dir));

		const result = await tool.execute("call-small", { command: "echo hi", timeout: 5 });
		const details = result.details as { timeoutSeconds?: number };

		expect(details.timeoutSeconds).toBe(5);
	});
});
