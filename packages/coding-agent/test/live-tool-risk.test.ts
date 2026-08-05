/**
 * Tool risk classification tests (P1 design §5) — the safety table that
 * decides what voice may do without asking.
 */
import { describe, expect, test } from "bun:test";
import { classifyToolRisk, describeToolCall } from "../src/live/tool-risk";

describe("classifyToolRisk", () => {
	test("read-only tools are green", () => {
		for (const name of ["read", "search", "find", "ast_grep", "lsp", "web_search", "calc", "list_models"]) {
			expect(classifyToolRisk(name, {})).toBe("green");
		}
	});

	test("file/state mutation tools are yellow", () => {
		for (const name of ["edit", "write", "ast_edit", "notebook", "todo_write", "task", "irc", "rewind"]) {
			expect(classifyToolRisk(name, {})).toBe("yellow");
		}
	});

	test("arbitrary-code, remote, and external tools are red", () => {
		for (const name of ["python", "debug", "recipe", "ssh", "github", "browser", "resolve", "exit_plan_mode"]) {
			expect(classifyToolRisk(name, {})).toBe("red");
		}
	});

	test("unknown / MCP / extension tools default to red (fail safe)", () => {
		expect(classifyToolRisk("mcp__some_server__do_thing", {})).toBe("red");
		expect(classifyToolRisk("brand_new_tool", {})).toBe("red");
	});

	test("bash is yellow for benign commands", () => {
		expect(classifyToolRisk("bash", { command: "bun test" })).toBe("yellow");
		expect(classifyToolRisk("bash", { command: "git status --short" })).toBe("yellow");
		expect(classifyToolRisk("bash", {})).toBe("yellow");
	});

	test("bash escalates to red on destructive patterns", () => {
		expect(classifyToolRisk("bash", { command: "rm -rf dist" })).toBe("red");
		expect(classifyToolRisk("bash", { command: "git push origin main" })).toBe("red");
		expect(classifyToolRisk("bash", { command: "git reset --hard HEAD~1" })).toBe("red");
		expect(classifyToolRisk("bash", { command: "sudo systemctl restart docker" })).toBe("red");
		expect(classifyToolRisk("bash", { command: "kill -9 1234" })).toBe("red");
		expect(classifyToolRisk("bash", { command: "curl -X POST https://api.example.com/x" })).toBe("red");
		expect(classifyToolRisk("bash", { command: "bun publish" })).toBe("red");
	});
});

describe("describeToolCall", () => {
	test("names the target file for edit/write", () => {
		expect(describeToolCall("edit", { path: "src/foo.ts" })).toBe("修改 src/foo.ts");
		expect(describeToolCall("write", { path: "notes.md" })).toBe("写入 notes.md");
	});

	test("quotes bash commands, clipped", () => {
		const description = describeToolCall("bash", { command: "x".repeat(200) });
		expect(description.startsWith("执行命令：")).toBe(true);
		expect(description.length).toBeLessThan(100);
		expect(description.endsWith("…")).toBe(true);
	});

	test("falls back to the tool name when nothing readable is present", () => {
		expect(describeToolCall("mcp__x", {})).toBe("mcp__x");
	});
});
