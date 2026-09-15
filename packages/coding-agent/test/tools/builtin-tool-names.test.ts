import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import { Settings } from "@cornfield/coding-agent/config/settings";
import type { ToolSession } from "@cornfield/coding-agent/tools";
import { createTools } from "@cornfield/coding-agent/tools";
import { normalizeToolName } from "@cornfield/coding-agent/tools/builtin-names";

function createSession(): ToolSession {
	return {
		cwd: os.tmpdir(),
		hasUI: false,
		enableLsp: false,
		hasEditTool: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	} as unknown as ToolSession;
}

describe("normalizeToolName", () => {
	it("resolves a legacy alias regardless of the case it was written in", () => {
		expect(normalizeToolName("find")).toBe("glob");
		expect(normalizeToolName("Search")).toBe("grep");
		expect(normalizeToolName("FIND")).toBe("glob");
		expect(normalizeToolName("Todo_Write")).toBe("todo");
	});

	it("leaves names outside the builtin alias table untouched", () => {
		expect(normalizeToolName("mcp__gitnexus_impact")).toBe("mcp__gitnexus_impact");
		expect(normalizeToolName("MyExtensionTool")).toBe("MyExtensionTool");
		expect(normalizeToolName("glob")).toBe("glob");
	});
});

/**
 * An explicit list is a contract: the caller said exactly which tools it wants.
 * Treating `[]` as "not provided" built the whole default set — and mounted the
 * `xd://` device catalog — for a caller that asked for no tools at all
 * (`--no-tools` passes `[]`, main.ts:575).
 */
describe("createTools with an explicit tool list", () => {
	it("builds nothing beyond the always-injected tools for an empty list", async () => {
		const names = (await createTools(createSession(), [])).map(tool => tool.name).sort();

		expect(names).toEqual(["exit_plan_mode", "identity"]);
	});

	it("builds exactly the requested tools plus the always-injected ones", async () => {
		const names = (await createTools(createSession(), ["read"])).map(tool => tool.name).sort();

		expect(names).toEqual(["exit_plan_mode", "identity", "read"]);
	});

	it("builds the default set when no list is given", async () => {
		const names = (await createTools(createSession())).map(tool => tool.name);

		expect(names.length).toBeGreaterThan(5);
		expect(names).toContain("read");
	});
});
