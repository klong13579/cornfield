import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolSession } from "./index";
import { ProjectContextTool } from "./project-context";

const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("project_context tool", () => {
	test("returns structured context with explicit errors and no TODO.md summary", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "project-context-test-"));
		dirs.push(cwd);
		// 盘上就算有一份 TODO.md，也不该被报出来：它已退出 agent 的任务流程（历史留档）。
		await Bun.write(path.join(cwd, "TODO.md"), "# TODO\n\n- ship it\n");
		const tool = new ProjectContextTool({
			cwd,
			contextFiles: [{ path: path.join(cwd, "AGENTS.md"), content: "rules" }],
		} as ToolSession);
		const result = await tool.execute("call-1", {});
		const details = result.details!;
		expect(details.cwd).toBe(cwd);
		expect(details.projectRoot).toBeNull();
		expect(details.contextFiles).toEqual({ paths: [path.join(cwd, "AGENTS.md")], count: 1 });
		expect(Array.isArray(details.errors)).toBe(true);
		expect(details).not.toHaveProperty("todo");
		expect((result.content[0] as { text: string }).text).not.toContain('"todo"');
	});
});
