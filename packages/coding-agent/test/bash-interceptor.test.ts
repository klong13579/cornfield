import { describe, expect, it } from "bun:test";
import { checkBashInterception } from "@oh-my-pi/pi-coding-agent/tools/bash-interceptor";

const ALL_TOOLS = ["bash", "read", "search", "find", "edit", "write"];

describe("bash-interceptor: skill shell command", () => {
	it("blocks `skill foo` and suggests read tool", () => {
		const result = checkBashInterception("skill foo", ALL_TOOLS);
		expect(result.block).toBe(true);
		expect(result.suggestedTool).toBe("read");
		expect(result.message).toContain("skill");
		expect(result.message).toContain("skill://<name>");
	});

	it("blocks `skill` with no argument (followed by EOF)", () => {
		const result = checkBashInterception("skill", ALL_TOOLS);
		expect(result.block).toBe(true);
		expect(result.suggestedTool).toBe("read");
	});

	it("blocks `skill` with leading whitespace", () => {
		const result = checkBashInterception("   skill foo", ALL_TOOLS);
		expect(result.block).toBe(true);
		expect(result.suggestedTool).toBe("read");
	});

	it("blocks `skill;` (followed by semicolon chain)", () => {
		const result = checkBashInterception("skill; echo x", ALL_TOOLS);
		expect(result.block).toBe(true);
	});

	it("blocks `skill &&` (followed by logical and)", () => {
		const result = checkBashInterception("skill && ls", ALL_TOOLS);
		expect(result.block).toBe(true);
	});

	it("blocks `skill |` (followed by pipe)", () => {
		const result = checkBashInterception("skill | grep foo", ALL_TOOLS);
		expect(result.block).toBe(true);
	});

	it("does NOT block `python skill://my-skill/scripts/init.py` (legitimate skill script invocation)", () => {
		const result = checkBashInterception("python skill://my-skill/scripts/init.py", ALL_TOOLS);
		expect(result.block).toBe(false);
	});

	it("does NOT block `ls ~/.omp/agent/skills/` (legitimate discovery path)", () => {
		const result = checkBashInterception("ls ~/.omp/agent/skills/", ALL_TOOLS);
		expect(result.block).toBe(false);
	});

	it("does NOT block `cat ./SKILL.md` (legitimate file read)", () => {
		const result = checkBashInterception("cat ./SKILL.md", ALL_TOOLS);
		// `cat` is blocked by a different rule, but that's a separate concern.
		// We only assert that the `skill` rule does not match here.
		// (cat rule will block this command, not the skill rule.)
		if (result.block) {
			expect(result.message).not.toContain("no `skill` shell command");
		}
	});

	it("does NOT block when `read` tool is unavailable (guard works)", () => {
		const result = checkBashInterception("skill foo", ["bash", "search", "find", "edit", "write"]);
		expect(result.block).toBe(false);
	});

	it("does NOT match `subskill` or `myskills` (word-boundary safety)", () => {
		expect(checkBashInterception("subskill foo", ALL_TOOLS).block).toBe(false);
		expect(checkBashInterception("myskills", ALL_TOOLS).block).toBe(false);
		expect(checkBashInterception("./skill-foo", ALL_TOOLS).block).toBe(false);
	});
});

describe("bash-interceptor: existing rules regression", () => {
	it("still blocks `cat file`", () => {
		const result = checkBashInterception("cat file.txt", ALL_TOOLS);
		expect(result.block).toBe(true);
		expect(result.suggestedTool).toBe("read");
	});

	it("still blocks `grep pattern file`", () => {
		const result = checkBashInterception("grep foo file.txt", ALL_TOOLS);
		expect(result.block).toBe(true);
		expect(result.suggestedTool).toBe("search");
	});

	it("still blocks `find dir -name foo`", () => {
		const result = checkBashInterception("find . -name '*.ts'", ALL_TOOLS);
		expect(result.block).toBe(true);
		expect(result.suggestedTool).toBe("find");
	});

	it("still blocks `sed -i ...`", () => {
		const result = checkBashInterception("sed -i 's/a/b/' file.txt", ALL_TOOLS);
		expect(result.block).toBe(true);
		expect(result.suggestedTool).toBe("edit");
	});

	it("still blocks `echo foo > file`", () => {
		const result = checkBashInterception("echo foo > file.txt", ALL_TOOLS);
		expect(result.block).toBe(true);
		expect(result.suggestedTool).toBe("write");
	});

	it("does NOT block plain `ls` (legitimate)", () => {
		const result = checkBashInterception("ls", ALL_TOOLS);
		expect(result.block).toBe(false);
	});
});
