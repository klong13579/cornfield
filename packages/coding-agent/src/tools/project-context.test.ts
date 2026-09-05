import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ProjectContextTool } from "./project-context";
import type { ToolSession } from "./index";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("project_context tool", () => {
  test("returns structured context with TODO summary and explicit errors", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "project-context-test-"));
    dirs.push(cwd);
    await Bun.write(path.join(cwd, "TODO.md"), "# TODO\n\n- ship it\n");
    const tool = new ProjectContextTool({ cwd, contextFiles: [{ path: path.join(cwd, "AGENTS.md"), content: "rules" }] } as ToolSession);
    const result = await tool.execute("call-1", {});
    const details = result.details!;
    expect(details.cwd).toBe(cwd);
    expect(details.projectRoot).toBeNull();
    expect(details.contextFiles).toEqual({ paths: [path.join(cwd, "AGENTS.md")], count: 1 });
    expect(details.todo.exists).toBe(true);
    expect(details.todo.summary).toContain("ship it");
    expect(Array.isArray(details.errors)).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('"todo"');
  });
});
