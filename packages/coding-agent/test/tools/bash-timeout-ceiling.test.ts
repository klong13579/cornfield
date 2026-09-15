import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { _resetSettingsForTest, Settings } from "@cornfield/coding-agent/config/settings";
import type { ToolSession } from "@cornfield/coding-agent/tools";
import { BashTool } from "@cornfield/coding-agent/tools/bash";
import { clampTimeout } from "@cornfield/coding-agent/tools/tool-timeouts";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-timeout-ceiling-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

function createSession(cwd: string, maxTimeout: number): ToolSession {
	return {
		cwd,
		hasUI: false,
		hasEditTool: false,
		enableLsp: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({
			"async.enabled": false,
			"bash.autoBackground.enabled": false,
			"tools.maxTimeout": maxTimeout,
		}),
	} as unknown as ToolSession;
}

function timeoutSecondsOf(result: { details?: unknown }): number | undefined {
	return (result.details as { timeoutSeconds?: number } | undefined)?.timeoutSeconds;
}

describe("clampTimeout with a global ceiling", () => {
	it("caps the tool default as well as an explicit value", () => {
		expect(clampTimeout("bash", undefined, 30)).toBe(30);
		expect(clampTimeout("bash", 300, 30)).toBe(30);
		expect(clampTimeout("bash", 5, 30)).toBe(5);
	});

	it("ignores a zero or absent ceiling", () => {
		expect(clampTimeout("bash", undefined, 0)).toBe(300);
		expect(clampTimeout("bash", undefined)).toBe(300);
	});

	it("never drops below the tool minimum", () => {
		expect(clampTimeout("bash", undefined, 0.5)).toBe(1);
	});
});

/**
 * `tools.maxTimeout` is the session's global tool-timeout ceiling. It previously
 * applied only to a timeout the caller passed explicitly, so a call that omitted
 * `timeout` ran on the tool's own default (bash: 300s) no matter what the user set.
 */
describe("bash honours tools.maxTimeout when timeout is omitted", () => {
	beforeEach(async () => {
		_resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: await makeTempDir() });
	});

	it("caps an omitted timeout", async () => {
		const dir = await makeTempDir();
		const result = await new BashTool(createSession(dir, 30)).execute("call-omit", { command: "echo hi" });

		expect(timeoutSecondsOf(result)).toBe(30);
	});

	it("leaves the default alone with no ceiling configured", async () => {
		const dir = await makeTempDir();
		const result = await new BashTool(createSession(dir, 0)).execute("call-none", { command: "echo hi" });

		expect(timeoutSecondsOf(result)).toBe(300);
	});
});
