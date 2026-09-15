import { describe, expect, it } from "bun:test";
import { checkBashInterception } from "@cornfield/coding-agent/tools/bash-interceptor";

const ALL_TOOLS = ["bash", "read", "grep", "glob", "edit", "write"];

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

	it("does NOT block `ls ~/.cornfield/agent/skills/` (legitimate discovery path)", () => {
		const result = checkBashInterception("ls ~/.cornfield/agent/skills/", ALL_TOOLS);
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
		const result = checkBashInterception("skill foo", ["bash", "grep", "glob", "edit", "write"]);
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
		expect(result.suggestedTool).toBe("grep");
	});

	it("still blocks `find dir -name foo`", () => {
		const result = checkBashInterception("find . -name '*.ts'", ALL_TOOLS);
		expect(result.block).toBe(true);
		expect(result.suggestedTool).toBe("glob");
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

describe("bash-interceptor: every segment is checked", () => {
	it("blocks a blocked program in the 2nd segment of a chain", () => {
		const result = checkBashInterception("ls && cat foo.txt", ALL_TOOLS);
		expect(result.block).toBe(true);
		expect(result.suggestedTool).toBe("read");
	});

	it("blocks it behind `;`, `||`, and a newline", () => {
		expect(checkBashInterception("ls; grep foo bar", ALL_TOOLS).suggestedTool).toBe("grep");
		expect(checkBashInterception("ls || find . -name '*.ts'", ALL_TOOLS).suggestedTool).toBe("glob");
		expect(checkBashInterception("ls\nsed -i 's/a/b/' f", ALL_TOOLS).suggestedTool).toBe("edit");
		expect(checkBashInterception("true && echo x > out.txt", ALL_TOOLS).suggestedTool).toBe("write");
	});

	it("quotes the original command, not the matched segment", () => {
		const command = "ls && cat foo.txt";
		expect(checkBashInterception(command, ALL_TOOLS).message).toContain(`Original command: ${command}`);
	});

	it("checks a segment without its leading environment assignments", () => {
		expect(checkBashInterception("FOO=1 cat foo.txt", ALL_TOOLS).suggestedTool).toBe("read");
		expect(checkBashInterception("FOO=1 BAR=2 grep x f", ALL_TOOLS).suggestedTool).toBe("grep");
	});

	it("keeps matching the complete input when the scanner declines it", () => {
		expect(checkBashInterception("cat $(ls)", ALL_TOOLS).block).toBe(true);
		expect(checkBashInterception("cat 'unterminated", ALL_TOOLS).block).toBe(true);
	});

	it("does not block a later segment when its tool is unavailable", () => {
		expect(checkBashInterception("ls && cat foo.txt", ["bash", "grep", "glob"]).block).toBe(false);
	});
});

describe("bash-interceptor: segments whose stdin is not a path", () => {
	it("does not block a stage fed by the pipe ahead of it", () => {
		expect(checkBashInterception("printf 'x\\n' | grep x", ALL_TOOLS).block).toBe(false);
		expect(checkBashInterception("find . | head -3", ALL_TOOLS).block).toBe(false);
	});

	it("still blocks the first stage of that pipeline", () => {
		expect(checkBashInterception("cat foo.txt | grep x", ALL_TOOLS).suggestedTool).toBe("read");
	});

	it("does not block a segment fed by a heredoc", () => {
		expect(checkBashInterception("cat <<'EOF'\nhello\nEOF", ALL_TOOLS).block).toBe(false);
		expect(checkBashInterception("grep foo <<'EOF'\nbar\nEOF", ALL_TOOLS).block).toBe(false);
		expect(checkBashInterception("python3 - <<'PY'\nprint(1)\nPY", ALL_TOOLS).block).toBe(false);
	});

	it("never reads a heredoc body as command text", () => {
		const command = "bun run scripts/x.ts <<'EOF'\ncat foo.txt\ngrep foo bar\nEOF";
		expect(checkBashInterception(command, ALL_TOOLS).block).toBe(false);
	});

	it("still blocks a segment that follows the heredoc", () => {
		const result = checkBashInterception("cat <<'EOF'\nbody\nEOF\ncat foo.txt", ALL_TOOLS);
		expect(result.block).toBe(true);
		expect(result.suggestedTool).toBe("read");
	});

	it("still blocks a heredoc that writes a file", () => {
		expect(checkBashInterception("cat > notes.md <<'EOF'\nhi\nEOF", ALL_TOOLS).block).toBe(true);
	});
});
