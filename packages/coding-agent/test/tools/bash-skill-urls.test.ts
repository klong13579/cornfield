import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { Skill } from "../../src/extensibility/skills";
import { resolveLocalUrlToPath } from "../../src/internal-urls";
import { expandInternalUrls, resolveSkillUrlToPath } from "../../src/tools/bash-skill-urls";
import { ToolError } from "../../src/tools/tool-errors";

function shellEscape(p: string): string {
	return `'${p.replace(/'/g, "'\\''")}'`;
}

function createSkill(name: string, baseDir: string): Skill {
	const resolvedBaseDir = path.resolve(baseDir);
	return {
		name,
		description: `${name} description`,
		filePath: path.join(resolvedBaseDir, "SKILL.md"),
		baseDir: resolvedBaseDir,
		source: "test",
	};
}

function createInternalRouter(resources: Record<string, { sourcePath?: string; error?: string }>): {
	canHandle: (input: string) => boolean;
	resolve: (
		input: string,
	) => Promise<{ url: string; content: string; contentType: "text/plain"; sourcePath?: string }>;
} {
	return {
		canHandle: input => /^(agent|artifact|plan|memory|rule):\/\//.test(input),
		resolve: async input => {
			const entry = resources[input];
			if (!entry) {
				throw new Error(`No mapping for ${input}`);
			}
			if (entry.error) {
				throw new Error(entry.error);
			}
			return {
				url: input,
				content: "",
				contentType: "text/plain",
				sourcePath: entry.sourcePath,
			};
		},
	};
}

describe("skill:// resolution through expandInternalUrls", () => {
	it("expands a basic skill:// URI to an absolute path", async () => {
		const skills = [createSkill("valid-skill", "/tmp/skills/valid-skill")];
		const command = "python skill://valid-skill/scripts/init.py";
		const expectedPath = path.join(skills[0].baseDir, "scripts/init.py");

		await expect(expandInternalUrls(command, { skills })).resolves.toBe(`python ${shellEscape(expectedPath)}`);
	});

	it("expands multiple skill:// URIs in one command", async () => {
		const skills = [
			createSkill("first-skill", "/tmp/skills/first-skill"),
			createSkill("second-skill", "/tmp/skills/second-skill"),
		];
		const command = "cp skill://first-skill/a.txt skill://second-skill/b.txt";
		const firstPath = path.join(skills[0].baseDir, "a.txt");
		const secondPath = path.join(skills[1].baseDir, "b.txt");

		await expect(expandInternalUrls(command, { skills })).resolves.toBe(
			`cp ${shellEscape(firstPath)} ${shellEscape(secondPath)}`,
		);
	});

	it("throws ToolError for unknown skills with available names", async () => {
		const skills = [
			createSkill("first-skill", "/tmp/skills/first-skill"),
			createSkill("second-skill", "/tmp/skills/second-skill"),
		];

		await expect(expandInternalUrls("python skill://missing/run.py", { skills })).rejects.toThrow(
			"Unknown skill: missing. Available: first-skill, second-skill",
		);
	});

	it("throws ToolError for path traversal attempts", async () => {
		const skills = [createSkill("valid-skill", "/tmp/skills/valid-skill")];

		await expect(expandInternalUrls("cat skill://valid-skill/../../../etc/passwd", { skills })).rejects.toThrow(
			"Path traversal (..) is not allowed in skill:// URLs",
		);
	});

	it("returns command unchanged when there are no skill:// tokens", async () => {
		const skills = [createSkill("valid-skill", "/tmp/skills/valid-skill")];
		const command = "git status";

		await expect(expandInternalUrls(command, { skills })).resolves.toBe(command);
	});

	it("expands URI in double quotes", async () => {
		const skills = [createSkill("valid-skill", "/tmp/skills/valid-skill")];
		const command = 'python "skill://valid-skill/scripts/init.py"';
		const expectedPath = path.join(skills[0].baseDir, "scripts/init.py");

		await expect(expandInternalUrls(command, { skills })).resolves.toBe(`python ${shellEscape(expectedPath)}`);
	});

	it("expands URI in single quotes", async () => {
		const skills = [createSkill("valid-skill", "/tmp/skills/valid-skill")];
		const command = "python 'skill://valid-skill/scripts/init.py'";
		const expectedPath = path.join(skills[0].baseDir, "scripts/init.py");

		await expect(expandInternalUrls(command, { skills })).resolves.toBe(`python ${shellEscape(expectedPath)}`);
	});

	it("shell-escapes paths with spaces", async () => {
		const skills = [createSkill("space-skill", "/tmp/skills/with space")];
		const command = "python skill://space-skill/scripts/my%20file.py";
		const expectedPath = path.join(skills[0].baseDir, "scripts/my file.py");

		await expect(expandInternalUrls(command, { skills })).resolves.toBe(`python ${shellEscape(expectedPath)}`);
	});

	it("shell-escapes paths containing single quotes", async () => {
		const skills = [createSkill("quote-skill", "/tmp/skills/with'quote")];
		const command = "python skill://quote-skill/scripts/init.py";
		const expectedPath = path.join(skills[0].baseDir, "scripts/init.py");

		await expect(expandInternalUrls(command, { skills })).resolves.toBe(`python ${shellEscape(expectedPath)}`);
	});

	it("resolves skill://name with no relative path to SKILL.md", async () => {
		const skills = [createSkill("valid-skill", "/tmp/skills/valid-skill")];
		const command = "cat skill://valid-skill";

		await expect(expandInternalUrls(command, { skills })).resolves.toBe(`cat ${shellEscape(skills[0].filePath)}`);
	});

	it("tells the caller there are no skills instead of passing the URI through", async () => {
		await expect(expandInternalUrls("python skill://valid-skill/scripts/init.py", { skills: [] })).rejects.toThrow(
			"Unknown skill: valid-skill. Available: none",
		);
	});

	it("throws ToolError when traversal is attempted with encoded segments", async () => {
		const skills = [createSkill("valid-skill", "/tmp/skills/valid-skill")];
		await expect(expandInternalUrls("cat skill://valid-skill/%2E%2E/%2E%2E/etc/passwd", { skills })).rejects.toThrow(
			ToolError,
		);
	});

	it("names the offending token when resolution fails", async () => {
		// 为什么要有 token：bash tool 在 shell 执行前替换命令里的每一处内部 URI，
		// 所以失败可能来自命令中与本次操作无关的一段文本 —— 2026-09-15：commit message 里的字面
		// skill:// 路径触发了 traversal 报错，而旧错误文本里没有任何指向它的信息。
		const skills = [createSkill("valid-skill", "/tmp/skills/valid-skill")];

		await expect(expandInternalUrls("cat skill://valid-skill/../../../etc/passwd", { skills })).rejects.toThrow(
			/token: skill:\/\/valid-skill\/\.\.\/\.\.\/\.\.\/etc\/passwd/,
		);
		await expect(expandInternalUrls("cat skill://missing/run.py", { skills })).rejects.toThrow(
			/token: skill:\/\/missing\/run\.py/,
		);
	});
});

describe("expandInternalUrls", () => {
	it("expands skill/agent/artifact/memory/rule URLs in one command", async () => {
		const skills = [createSkill("valid-skill", "/tmp/skills/valid-skill")];
		const router = createInternalRouter({
			"artifact://12": { sourcePath: "/tmp/artifacts/12.bash.log" },
			"agent://reviewer_0": { sourcePath: "/tmp/session/reviewer_0.md" },
			"memory://root/memory_summary.md": { sourcePath: "/tmp/memories/memory_summary.md" },
			"rule://rs-no-unwrap": { sourcePath: "/tmp/rules/rs-no-unwrap.md" },
		});
		const command =
			"cat agent://reviewer_0 artifact://12 memory://root/memory_summary.md rule://rs-no-unwrap skill://valid-skill/scripts/init.py";
		const expectedSkillPath = path.join(skills[0].baseDir, "scripts/init.py");

		await expect(expandInternalUrls(command, { skills, internalRouter: router })).resolves.toBe(
			`cat ${shellEscape("/tmp/session/reviewer_0.md")} ${shellEscape("/tmp/artifacts/12.bash.log")} ${shellEscape("/tmp/memories/memory_summary.md")} ${shellEscape("/tmp/rules/rs-no-unwrap.md")} ${shellEscape(expectedSkillPath)}`,
		);
	});

	it("expands quoted non-skill URLs and shell-escapes quotes in paths", async () => {
		const router = createInternalRouter({
			"artifact://7": { sourcePath: "/tmp/artifacts/with'quote.log" },
		});
		await expect(expandInternalUrls('cat "artifact://7"', { skills: [], internalRouter: router })).resolves.toBe(
			`cat ${shellEscape("/tmp/artifacts/with'quote.log")}`,
		);
	});

	it("expands agent:// URLs when router is available", async () => {
		const router = createInternalRouter({
			"agent://abc": { sourcePath: "/tmp/session/abc.md" },
		});
		await expect(expandInternalUrls("echo agent://abc", { skills: [], internalRouter: router })).resolves.toBe(
			`echo ${shellEscape("/tmp/session/abc.md")}`,
		);
	});

	it("expands local:// URLs to filesystem paths without requiring preexisting files", async () => {
		const localOptions = {
			getArtifactsDir: () => "/tmp/session-artifacts",
			getSessionId: () => "session-1",
		};
		const command = "mv /tmp/source.json local://handoffs/new-file.json";
		const expectedPath = resolveLocalUrlToPath("local://handoffs/new-file.json", localOptions);

		await expect(expandInternalUrls(command, { skills: [], localOptions })).resolves.toBe(
			`mv /tmp/source.json ${shellEscape(expectedPath)}`,
		);
	});

	it("expands local:/ (single-slash) URL in double quotes", async () => {
		const localOptions = {
			getArtifactsDir: () => "/tmp/session-artifacts",
			getSessionId: () => "session-1",
		};
		const command = 'cat "local:/PLAN.md"';
		const expectedPath = resolveLocalUrlToPath("local:///PLAN.md", localOptions);

		await expect(expandInternalUrls(command, { skills: [], localOptions })).resolves.toBe(
			`cat ${shellEscape(expectedPath)}`,
		);
	});

	it("expands local:/ (single-slash) URL in single quotes", async () => {
		const localOptions = {
			getArtifactsDir: () => "/tmp/session-artifacts",
			getSessionId: () => "session-1",
		};
		const command = "cat 'local:/PLAN.md'";
		const expectedPath = resolveLocalUrlToPath("local:///PLAN.md", localOptions);

		await expect(expandInternalUrls(command, { skills: [], localOptions })).resolves.toBe(
			`cat ${shellEscape(expectedPath)}`,
		);
	});

	it("expands local:/ (single-slash) URL without quotes", async () => {
		const localOptions = {
			getArtifactsDir: () => "/tmp/session-artifacts",
			getSessionId: () => "session-1",
		};
		const command = "cat local:/PLAN.md";
		const expectedPath = resolveLocalUrlToPath("local:///PLAN.md", localOptions);

		await expect(expandInternalUrls(command, { skills: [], localOptions })).resolves.toBe(
			`cat ${shellEscape(expectedPath)}`,
		);
	});

	it("throws when local:// URL is used without local protocol options", async () => {
		await expect(expandInternalUrls("mv foo local://bar", { skills: [] })).rejects.toThrow(
			"Cannot resolve local:// URL in bash command: local protocol options are unavailable for this session.",
		);
	});

	it("throws when non-skill URL is used without an internal router", async () => {
		await expect(expandInternalUrls("cat artifact://1", { skills: [] })).rejects.toThrow(
			"Cannot resolve artifact:// URL in bash command",
		);
	});

	it("throws when internal router resolves URL without sourcePath", async () => {
		const router = createInternalRouter({
			"rule://my-rule": {},
		});
		await expect(expandInternalUrls("cat rule://my-rule", { skills: [], internalRouter: router })).rejects.toThrow(
			"rule:// URL resolved without a filesystem path",
		);
	});

	it("surfaces resolver errors with actionable context", async () => {
		const router = createInternalRouter({
			"memory://root/missing.md": { error: "Memory file not found" },
		});
		await expect(
			expandInternalUrls("cat memory://root/missing.md", { skills: [], internalRouter: router }),
		).rejects.toThrow("Failed to resolve memory:// URL in bash command");
	});

	it("does not match local:/ inside filesystem paths (e.g. /repo/local:/PLAN.md)", async () => {
		const command = "cat /repo/local:/PLAN.md";
		await expect(expandInternalUrls(command, { skills: [] })).resolves.toBe(command);
	});

	it("does not match local:/ after ./ or ../ prefixes", async () => {
		const command = "cat ./local:/PLAN.md ../local:/other.md";
		await expect(expandInternalUrls(command, { skills: [] })).resolves.toBe(command);
	});

	it("still matches standalone local:/ at a real token boundary", async () => {
		const localOptions = {
			getArtifactsDir: () => "/tmp/session-artifacts",
			getSessionId: () => "session-1",
		};
		const command = "cat local:/PLAN.md";
		const expectedPath = resolveLocalUrlToPath("local://PLAN.md", localOptions);
		await expect(expandInternalUrls(command, { skills: [], localOptions })).resolves.toBe(
			`cat ${shellEscape(expectedPath)}`,
		);
	});

	it("does not match local:/ when embedded in words (e.g., notlocal:/, mylocal:/)", async () => {
		const command1 = "cat notlocal:/PLAN.md";
		await expect(expandInternalUrls(command1, { skills: [] })).resolves.toBe(command1);

		const command2 = "cat mylocal:/data.json";
		await expect(expandInternalUrls(command2, { skills: [] })).resolves.toBe(command2);

		const command3 = "cat getlocal:/file.txt";
		await expect(expandInternalUrls(command3, { skills: [] })).resolves.toBe(command3);

		const localOptions = {
			getArtifactsDir: () => "/tmp/session-artifacts",
			getSessionId: () => "session-1",
		};
		await expect(expandInternalUrls(command1, { skills: [], localOptions })).resolves.toBe(command1);
	});

	it("does not match local:/ after a hyphen (e.g. not-local:/PLAN.md)", async () => {
		const command = "cat not-local:/PLAN.md";
		await expect(expandInternalUrls(command, { skills: [] })).resolves.toBe(command);

		const localOptions = {
			getArtifactsDir: () => "/tmp/session-artifacts",
			getSessionId: () => "session-1",
		};
		await expect(expandInternalUrls(command, { skills: [], localOptions })).resolves.toBe(command);
	});
});

/**
 * `cwd: "skill://<name>"` means the skill directory. Resolving a bare skill URL to
 * SKILL.md is right for command text (the URL names a file there), but as a working
 * directory it made the call fail against a path that is never a directory.
 */
describe("skill:// as a working directory", () => {
	const skills = [createSkill("valid-skill", "/tmp/skills/valid-skill")];

	it("resolves a bare skill URL to the skill directory when one is asked for", () => {
		expect(resolveSkillUrlToPath("skill://valid-skill", skills, { forDirectory: true })).toBe(skills[0]!.baseDir);
	});

	it("still resolves a bare skill URL to SKILL.md by default", () => {
		expect(resolveSkillUrlToPath("skill://valid-skill", skills)).toBe(skills[0]!.filePath);
	});

	it("expands a cwd skill URL through expandInternalUrls", async () => {
		const expanded = await expandInternalUrls("skill://valid-skill", {
			skills,
			noEscape: true,
			skillUrlForDirectory: true,
		});

		expect(expanded).toBe(skills[0]!.baseDir);
	});
});

/**
 * The expansion rewrites text, so there has to be a way to say "this is text".
 * A quoted heredoc body is the shell's own way of saying it; a leading backslash is
 * ours for every other position.
 */
describe("internal URIs as data rather than paths", () => {
	const skills = [createSkill("valid-skill", "/tmp/skills/valid-skill")];
	const uri = "skill://valid-skill/scripts/init.py";
	const resolvedPath = path.join(skills[0].baseDir, "scripts/init.py");

	it("keeps a URI in a single-quoted heredoc body exactly as written", async () => {
		const command = `python3 - <<'PY'\nopen("t.ts", "w").write("import x from "${uri}"")\nPY`;

		await expect(expandInternalUrls(command, { skills })).resolves.toBe(command);
	});

	it("keeps a URI in a double-quoted heredoc body exactly as written", async () => {
		const command = `cat <<"EOF" > notes.md\nsee ${uri}\nEOF`;

		await expect(expandInternalUrls(command, { skills })).resolves.toBe(command);
	});

	it("keeps a URI in a tab-stripped heredoc body exactly as written", async () => {
		const command = `cat <<-'EOF'\n\tsee ${uri}\n\tEOF`;

		await expect(expandInternalUrls(command, { skills })).resolves.toBe(command);
	});

	it("protects an unterminated quoted heredoc to the end of the command", async () => {
		const command = `cat <<'EOF'\nsee ${uri}`;

		await expect(expandInternalUrls(command, { skills })).resolves.toBe(command);
	});

	it("resolves after the body while the body stays literal", async () => {
		const command = `python3 - <<'PY'\nprint("${uri}")\nPY\ncat ${uri}`;

		await expect(expandInternalUrls(command, { skills })).resolves.toBe(
			`python3 - <<'PY'\nprint("${uri}")\nPY\ncat ${shellEscape(resolvedPath)}`,
		);
	});

	it("still resolves inside an unquoted heredoc body", async () => {
		// POSIX expands inside `<<EOF`; a URI there is command text like any other.
		const command = `cat <<EOF\n${uri}\nEOF`;

		await expect(expandInternalUrls(command, { skills })).resolves.toBe(
			`cat <<EOF\n${shellEscape(resolvedPath)}\nEOF`,
		);
	});

	it("treats <<< as a here-string, not a heredoc", async () => {
		const command = `cat <<< ${uri}`;

		await expect(expandInternalUrls(command, { skills })).resolves.toBe(`cat <<< ${shellEscape(resolvedPath)}`);
	});

	it("consumes two heredoc bodies in order when one line opens both", async () => {
		const command = `cat <<'A' <<B\n${uri}\nA\n${uri}\nB\ncat ${uri}`;

		await expect(expandInternalUrls(command, { skills })).resolves.toBe(
			`cat <<'A' <<B\n${uri}\nA\n${shellEscape(resolvedPath)}\nB\ncat ${shellEscape(resolvedPath)}`,
		);
	});

	it("keeps an escaped URI literal and drops the backslash", async () => {
		await expect(expandInternalUrls("echo \\skill://valid-skill/scripts/init.py", { skills })).resolves.toBe(
			"echo skill://valid-skill/scripts/init.py",
		);
	});

	it("keeps an escaped URI literal inside quotes", async () => {
		await expect(expandInternalUrls('echo "\\skill://valid-skill/x"', { skills })).resolves.toBe(
			'echo "skill://valid-skill/x"',
		);
	});

	it("does not fail on an escaped URI whose target does not exist", async () => {
		await expect(expandInternalUrls("git commit -m 'see \\skill://missing'", { skills })).resolves.toBe(
			"git commit -m 'see skill://missing'",
		);
	});

	it("leaves an even number of backslashes alone and resolves the URI", async () => {
		await expect(expandInternalUrls("echo \\\\skill://valid-skill/scripts/init.py", { skills })).resolves.toBe(
			`echo \\\\${shellEscape(resolvedPath)}`,
		);
	});
});
