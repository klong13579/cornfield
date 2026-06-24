/**
 * Tests for `omp agent` subcommand handlers.
 *
 * Covers:
 *   - init: creates a fresh agentDir, rejects bad names, supports --dir
 *   - list: enumerates agentDirs in a root, computes status from on-disk state
 *   - show: parses mission/AGENTS/TOOLS/skills/cron/sessions into a structured detail
 *   - validate: detects missing always-on, broken JSON/YAML, exits via `valid` flag
 *
 * All tests use a temp dir; the real `~/.omp/agents/` is never touched.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	runAgentInit,
	runAgentList,
	runAgentReconcile,
	runAgentRegister,
	runAgentShow,
	runAgentUnregister,
	runAgentValidate,
} from "../src/cli/agent-cli";

let tmpDir: string;
const savedHome = process.env.HOME;
let isolatedHome: string;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-agent-test-"));
	// Isolate HOME for every test in this file. The agent registry lives at
	// `~/.omp/agent/registry.json` and several test paths (runAgentInit,
	// runAgentReconcile's auto-register) call registerAgent as a side effect.
	// Without isolation, `bun test` writes to the user's real registry and
	// leaves dead entries pointing at temp dirs that the OS later cleans —
	// surfacing as "zombie agents" in `omp agent list`.
	isolatedHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-registry-iso-"));
	process.env.HOME = isolatedHome;
});

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
	// Restore FIRST so we never rm the real home, then clean the isolated one.
	process.env.HOME = savedHome;
	if (isolatedHome) {
		await fs.rm(isolatedHome, { recursive: true, force: true });
		isolatedHome = "";
	}
});

async function writeFile(rel: string, content: string): Promise<void> {
	const full = path.join(tmpDir, rel);
	await fs.mkdir(path.dirname(full), { recursive: true });
	await Bun.write(full, content);
}

// ────────────────────────────────────────────────────────────────────────────
// init
// ────────────────────────────────────────────────────────────────────────────

describe("runAgentInit", () => {
	test("creates a fresh agentDir with all skeleton files", async () => {
		const result = await runAgentInit({ name: "hr-bot", dir: tmpDir });
		expect(result.created).toBe(true);
		expect(result.agentDir).toBe(path.join(tmpDir, "hr-bot"));
		expect(result.filesWritten).toBeGreaterThan(0);

		// Always-on files
		for (const f of [
			"AGENTS.md",
			"mission.md",
			"TOOLS.md",
			"TODO.md",
			"knowledge/external-workspaces.md",
			"prompt-includes.json",
		]) {
			await fs.access(path.join(result.agentDir, f));
		}
	});

	test("rejects names with NUL or path-traversal segments", async () => {
		await expect(runAgentInit({ name: "bad\0name", dir: tmpDir })).rejects.toThrow(/NUL/);
		await expect(runAgentInit({ name: "../escape", dir: tmpDir })).rejects.toThrow(/\.\./);
		await expect(runAgentInit({ name: "ok/../escape", dir: tmpDir })).rejects.toThrow(/\.\./);
	});

	test("allows names with forward slashes (nested account ids)", async () => {
		// No throw — `ops/hr` is the canonical gateway account id shape.
		const result = await runAgentInit({ name: "ops/hr", dir: tmpDir });
		expect(result.created).toBe(true);
		expect(result.agentDir).toContain("ops");
		expect(result.agentDir).toContain("hr");
	});

	test("rejects unknown templates", async () => {
		await expect(runAgentInit({ name: "hr-bot", dir: tmpDir, template: "minimal" })).rejects.toThrow(
			/Unknown template/,
		);
	});

	test("additive update when mission.md already exists", async () => {
		await writeFile("ops-bot/mission.md", "user-customized content");
		const result = await runAgentInit({ name: "ops-bot", dir: tmpDir });
		expect(result.created).toBe(false);

		const mission = await Bun.file(path.join(result.agentDir, "mission.md")).text();
		expect(mission).toBe("user-customized content");
		// Other always-on files were added
		await fs.access(path.join(result.agentDir, "AGENTS.md"));
		await fs.access(path.join(result.agentDir, "TOOLS.md"));
	});

	test("seeds custom mission from --mission file", async () => {
		const missionPath = path.join(tmpDir, "my-mission.md");
		await Bun.write(missionPath, "你是一个 HR 助手");
		const result = await runAgentInit({
			name: "hr-bot",
			dir: tmpDir,
			mission: missionPath,
		});
		const written = await Bun.file(path.join(result.agentDir, "mission.md")).text();
		expect(written).toBe("你是一个 HR 助手");
	});

	test("explicit non-existing --dir is used as the full path", async () => {
		const target = path.join(tmpDir, "custom", "name");
		const result = await runAgentInit({ name: "ignored", dir: target });
		expect(result.agentDir).toBe(target);
		await fs.access(path.join(target, "mission.md"));
	});

	test("throws when --mission file is missing", async () => {
		await expect(runAgentInit({ name: "hr-bot", dir: tmpDir, mission: "/nope/missing.md" })).rejects.toThrow(
			/not found/,
		);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// list
// ────────────────────────────────────────────────────────────────────────────

describe("runAgentList", () => {
	test("returns empty array when root is missing", async () => {
		const result = await runAgentList({ dir: path.join(tmpDir, "no-such") });
		expect(result).toEqual([]);
	});

	test("skips non-directory entries", async () => {
		await writeFile("a-loose-file.md", "x");
		await runAgentInit({ name: "alpha", dir: tmpDir });
		const result = await runAgentList({ dir: tmpDir });
		expect(result.map(s => s.name)).toEqual(["alpha"]);
	});

	test("marks agentDirs as active when mission.md + .omp/config.yml present", async () => {
		await runAgentInit({ name: "alpha", dir: tmpDir });
		const result = await runAgentList({ dir: tmpDir });
		expect(result[0]?.status).toBe("active");
	});

	test("marks as incomplete when always-on files are missing", async () => {
		// Manually create a partial agentDir (no skeleton)
		await fs.mkdir(path.join(tmpDir, "partial"), { recursive: true });
		await Bun.write(path.join(tmpDir, "partial", "mission.md"), "x");
		const result = await runAgentList({ dir: tmpDir });
		const partial = result.find(s => s.name === "partial");
		expect(partial?.status).toBe("incomplete");
	});

	test("sorts results by name", async () => {
		await runAgentInit({ name: "zeta", dir: tmpDir });
		await runAgentInit({ name: "alpha", dir: tmpDir });
		await runAgentInit({ name: "mid", dir: tmpDir });
		const result = await runAgentList({ dir: tmpDir });
		expect(result.map(s => s.name)).toEqual(["alpha", "mid", "zeta"]);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// show
// ────────────────────────────────────────────────────────────────────────────

describe("runAgentShow", () => {
	test("returns exists=false for a missing agentDir", async () => {
		const result = await runAgentShow({ name: "ghost", dir: tmpDir });
		expect(result.exists).toBe(false);
		expect(result.identity).toEqual([]);
	});

	test("parses identity from mission.md (first 3 non-heading lines)", async () => {
		await runAgentInit({ name: "alpha", dir: tmpDir });
		const result = await runAgentShow({ name: "alpha", dir: tmpDir });
		expect(result.exists).toBe(true);
		expect(result.identity.length).toBeGreaterThan(0);
		expect(result.identity.length).toBeLessThanOrEqual(3);
		// mission.md skeleton starts with a heading, so identity should be the body lines
		expect(result.identity.every(l => !l.startsWith("#"))).toBe(true);
	});

	test("extracts hard constraints from AGENTS.md (bullet-list MUST/MUST NOT/NEVER lines only)", async () => {
		await runAgentInit({ name: "alpha", dir: tmpDir });
		const result = await runAgentShow({ name: "alpha", dir: tmpDir });
		expect(result.hardConstraints.length).toBeGreaterThan(0);
		// All extracted lines should match the bullet rule shape.
		for (const line of result.hardConstraints) {
			expect(line).toMatch(/^(MUST NOT|NEVER|MUST)\b/);
			// Lines that merely mention these keywords in prose should NOT be picked up.
			expect(line).not.toMatch(/extracted|extractor|heading|co-located|inject/i);
		}
	});

	test("lists tools from TOOLS.md `### \\`<name>\\`` headings", async () => {
		await runAgentInit({ name: "alpha", dir: tmpDir });
		const result = await runAgentShow({ name: "alpha", dir: tmpDir });
		// The skeleton TOOLS.md declares read, grep, bash, write, edit
		expect(result.tools).toContain("read");
		expect(result.tools).toContain("grep");
		expect(result.tools).toContain("bash");
		expect(result.tools).toContain("write");
		expect(result.tools).toContain("edit");
	});

	test("counts cron tasks and sessions (zero for fresh agent)", async () => {
		await runAgentInit({ name: "alpha", dir: tmpDir });
		const result = await runAgentShow({ name: "alpha", dir: tmpDir });
		expect(result.cronTaskCount).toBe(0);
		expect(result.sessionCount).toBe(0);
	});

	test("counts cron tasks when present", async () => {
		await runAgentInit({ name: "alpha", dir: tmpDir });
		await writeFile("alpha/cron/tasks/daily.json5", "{ schedule: '* * * * *' }");
		await writeFile("alpha/cron/tasks/weekly.json5", "{ schedule: '0 0 * * 0' }");
		const result = await runAgentShow({ name: "alpha", dir: tmpDir });
		expect(result.cronTaskCount).toBe(2);
	});

	test("reads skill name + frontmatter description", async () => {
		await runAgentInit({ name: "alpha", dir: tmpDir });
		await writeFile(
			"alpha/.omp/skills/gitlab-auto-login.md",
			"---\ndescription: Auto-login to GitLab via cookies\n---\n\n# body\n",
		);
		const result = await runAgentShow({ name: "alpha", dir: tmpDir });
		const skill = result.skills.find(s => s.name === "gitlab-auto-login");
		expect(skill?.description).toBe("Auto-login to GitLab via cookies");
	});
});

// ────────────────────────────────────────────────────────────────────────────
// validate
// ────────────────────────────────────────────────────────────────────────────

describe("runAgentValidate", () => {
	test("passes for a fully initialized agentDir", async () => {
		await runAgentInit({ name: "alpha", dir: tmpDir });
		const result = await runAgentValidate({ agentDir: path.join(tmpDir, "alpha") });
		expect(result.valid).toBe(true);
		expect(result.issues.filter(i => i.level === "error")).toEqual([]);
	});

	test("fails when always-on files are missing", async () => {
		await fs.mkdir(path.join(tmpDir, "bare"), { recursive: true });
		const result = await runAgentValidate({ agentDir: path.join(tmpDir, "bare") });
		expect(result.valid).toBe(false);
		const missing = result.issues.filter(i => i.level === "error" && i.message === "Missing always-on file");
		// Should flag all 5 always-on (alphabetical: D < S, so TODO.md < TOOLS.md)
		expect(missing.map(i => i.file).sort()).toEqual([
			"AGENTS.md",
			"TODO.md",
			"TOOLS.md",
			"knowledge/external-workspaces.md",
			"mission.md",
		]);
	});

	test("flags invalid prompt-includes.json", async () => {
		await runAgentInit({ name: "alpha", dir: tmpDir });
		await Bun.write(path.join(tmpDir, "alpha", "prompt-includes.json"), "not valid json");
		const result = await runAgentValidate({ agentDir: path.join(tmpDir, "alpha") });
		const issue = result.issues.find(i => i.file === "prompt-includes.json" && i.level === "error");
		expect(issue?.message).toContain("Invalid JSON");
	});

	test("flags prompt-includes.json without top-level `files` array", async () => {
		await runAgentInit({ name: "alpha", dir: tmpDir });
		await Bun.write(path.join(tmpDir, "alpha", "prompt-includes.json"), JSON.stringify({ wrong: "shape" }));
		const result = await runAgentValidate({ agentDir: path.join(tmpDir, "alpha") });
		const issue = result.issues.find(i => i.file === "prompt-includes.json" && i.level === "error");
		expect(issue?.message).toContain("`files` array");
	});

	test("flags invalid .omp/config.yml", async () => {
		await runAgentInit({ name: "alpha", dir: tmpDir });
		// Write something Bun.YAML can't parse: an unterminated flow sequence
		await Bun.write(path.join(tmpDir, "alpha", ".omp", "config.yml"), "modelRoles: [unterminated");
		const result = await runAgentValidate({ agentDir: path.join(tmpDir, "alpha") });
		const issue = result.issues.find(i => i.file === ".omp/config.yml" && i.level === "error");
		expect(issue?.message).toContain("Invalid YAML");
	});

	test("warns on missing recommended runtime files", async () => {
		await runAgentInit({ name: "alpha", dir: tmpDir });
		await fs.unlink(path.join(tmpDir, "alpha", "prompt-includes.json"));
		await fs.unlink(path.join(tmpDir, "alpha", ".gitignore"));
		await fs.unlink(path.join(tmpDir, "alpha", ".omp", "SYSTEM.md"));
		const result = await runAgentValidate({ agentDir: path.join(tmpDir, "alpha") });
		expect(result.valid).toBe(true); // warnings don't invalidate
		const warnings = result.issues.filter(i => i.level === "warning" && !i.rule);
		expect(warnings.map(i => i.file).sort()).toEqual([".gitignore", ".omp/SYSTEM.md", "prompt-includes.json"]);
	});
});

describe("runAgentValidate — MECE rules", () => {
	async function initAgent(name: string = "mece-test"): Promise<string> {
		await runAgentInit({ name, dir: tmpDir });
		return path.join(tmpDir, name);
	}

	test("R1: detects and repairs skeleton placeholders", async () => {
		const dir = await initAgent();
		await Bun.write(path.join(dir, "TODO.md"), "# TODO\n\n- [ ] 任务 1\n- [ ] 任务 2\n");
		const result = await runAgentValidate({ agentDir: dir });
		const violation = result.mece?.violations.find(v => v.rule === "no-skeleton-placeholder");
		expect(violation).toBeTruthy();
		// Fix
		const fixed = await runAgentValidate({ agentDir: dir, fix: true });
		expect(fixed.mece?.repaired.length).toBeGreaterThan(0);
		const todoAfter = await Bun.file(path.join(dir, "TODO.md")).text();
		expect(todoAfter).not.toContain("任务 1");
	});

	test("R2: detects and repairs tool list in mission.md", async () => {
		const dir = await initAgent();
		await Bun.write(
			path.join(dir, "mission.md"),
			"# Bot\n\n## 工具\n\n- 使用 `read` 读取文件\n- 使用 `bash` 运行命令\n",
		);
		const result = await runAgentValidate({ agentDir: dir });
		const violation = result.mece?.violations.find(v => v.rule === "no-tool-list-in-mission");
		expect(violation).toBeTruthy();
		// Fix
		await runAgentValidate({ agentDir: dir, fix: true });
		const missionAfter = await Bun.file(path.join(dir, "mission.md")).text();
		expect(missionAfter).not.toMatch(/使用 `read`/);
		expect(missionAfter).toMatch(/TOOLS\.md/);
	});

	test("R3: detects and repairs safety constraint duplication", async () => {
		const dir = await initAgent();
		const agentsContent = await Bun.file(path.join(dir, "AGENTS.md")).text();
		// Extract a MUST NOT line from the hard-constraints section
		const agentsLines = agentsContent.split("\n");
		let inHard = false;
		let mustNotLine: string | undefined;
		for (const line of agentsLines) {
			if (/##\s*Global hard constraints/i.test(line)) {
				inHard = true;
				continue;
			}
			if (inHard && /^##\s/.test(line)) {
				inHard = false;
			}
			if (inHard && /^-\s*MUST\s+NOT/i.test(line)) {
				mustNotLine = line;
				break;
			}
		}
		expect(mustNotLine).toBeTruthy();
		// Add the same line to SYSTEM.md
		await Bun.write(path.join(dir, ".omp", "SYSTEM.md"), `# System\n\n## 安全\n\n${mustNotLine}\n`);
		const result = await runAgentValidate({ agentDir: dir });
		const violation = result.mece?.violations.find(v => v.rule === "no-safety-duplication");
		expect(violation).toBeTruthy();
		// Fix
		await runAgentValidate({ agentDir: dir, fix: true });
		const systemAfter = await Bun.file(path.join(dir, ".omp", "SYSTEM.md")).text();
		// The duplicated line should be gone, but a reference should be added
		expect(systemAfter).toMatch(/AGENTS\.md/);
	});

	test("R4: detects and repairs space URLs in mission.md", async () => {
		const dir = await initAgent();
		await Bun.write(path.join(dir, "mission.md"), "# Bot\n\n知识库: https://alidocs.dingtalk.com/i/spaces/abc\n");
		const result = await runAgentValidate({ agentDir: dir });
		const violation = result.mece?.violations.find(v => v.rule === "no-space-urls-in-mission");
		expect(violation).toBeTruthy();
		// Fix
		await runAgentValidate({ agentDir: dir, fix: true });
		const missionAfter = await Bun.file(path.join(dir, "mission.md")).text();
		expect(missionAfter).not.toMatch(/alidocs\.dingtalk\.com/);
	});

	test("R5: detects and repairs dws commands in TOOLS.md", async () => {
		const dir = await initAgent();
		await Bun.write(
			path.join(dir, "TOOLS.md"),
			"# TOOLS\n\n## dws\n\n- `dws doc list --workspace <id>` — list docs\n- MUST 通过 bash 调用\n",
		);
		const result = await runAgentValidate({ agentDir: dir });
		const violation = result.mece?.violations.find(v => v.rule === "no-dws-commands-in-tools");
		expect(violation).toBeTruthy();
		// Fix
		await runAgentValidate({ agentDir: dir, fix: true });
		const toolsAfter = await Bun.file(path.join(dir, "TOOLS.md")).text();
		expect(toolsAfter).not.toMatch(/dws doc list/);
		expect(toolsAfter).toMatch(/MUST/); // constraint preserved
	});

	test("R6: detects and repairs skills path format", async () => {
		const dir = await initAgent();
		const agents = await Bun.file(path.join(dir, "AGENTS.md")).text();
		const oldAgents = agents.replace(".omp/skills/<name>/SKILL.md", ".omp/skills/<name>.md");
		await Bun.write(path.join(dir, "AGENTS.md"), oldAgents);
		const result = await runAgentValidate({ agentDir: dir });
		const violation = result.mece?.violations.find(v => v.rule === "skills-path-format");
		expect(violation).toBeTruthy();
		// Fix
		await runAgentValidate({ agentDir: dir, fix: true });
		const agentsAfter = await Bun.file(path.join(dir, "AGENTS.md")).text();
		expect(agentsAfter).toMatch(/<name>\/SKILL\.md/);
		expect(agentsAfter).not.toMatch(/<name>\.md/);
	});

	test("R7: warns on filemap inaccuracy (not repairable)", async () => {
		const dir = await initAgent();
		const agents = await Bun.file(path.join(dir, "AGENTS.md")).text();
		// Add a fake entry to the File Map
		const withFake = agents.replace(
			"| `sessions/*.jsonl`",
			"| `nonexistent/fake.md`          | FAKE                             | fake                                                                 |\n| `sessions/*.jsonl`",
		);
		await Bun.write(path.join(dir, "AGENTS.md"), withFake);
		const result = await runAgentValidate({ agentDir: dir });
		const violation = result.mece?.violations.find(
			v => v.rule === "filemap-accuracy" && v.message.includes("nonexistent/fake.md"),
		);
		expect(violation).toBeTruthy();
		expect(violation?.repairable).toBe(false);
	});

	test("--fix leaves non-repairable violations as warnings", async () => {
		const dir = await initAgent();
		const agents = await Bun.file(path.join(dir, "AGENTS.md")).text();
		const withFake = agents.replace(
			"| `sessions/*.jsonl`",
			"| `nonexistent/fake.md`          | FAKE                             | fake                                                                 |\n| `sessions/*.jsonl`",
		);
		await Bun.write(path.join(dir, "AGENTS.md"), withFake);
		const result = await runAgentValidate({ agentDir: dir, fix: true });
		const warning = result.issues.find(i => i.rule === "filemap-accuracy");
		expect(warning).toBeTruthy();
	});

	test("R8: detects and repairs deprecated .agent/ directory", async () => {
		const dir = await initAgent();
		// Create .agent/ directory with SYSTEM.md
		await fs.mkdir(path.join(dir, ".agent"), { recursive: true });
		await Bun.write(path.join(dir, ".agent", "SYSTEM.md"), "old system prompt");
		// Add .agent/ reference to AGENTS.md File Map
		const agents = await Bun.file(path.join(dir, "AGENTS.md")).text();
		const withDeprecated = agents.replace(".omp/SYSTEM.md", ".agent/SYSTEM.md");
		await Bun.write(path.join(dir, "AGENTS.md"), withDeprecated);
		// Validate — should detect
		const result = await runAgentValidate({ agentDir: dir });
		const dirViolation = result.mece?.violations.find(
			v => v.rule === "no-deprecated-agent-dir" && v.file === ".agent/",
		);
		expect(dirViolation).toBeTruthy();
		const refViolation = result.mece?.violations.find(
			v => v.rule === "no-deprecated-agent-dir" && v.file === "AGENTS.md",
		);
		expect(refViolation).toBeTruthy();
		expect(result.valid).toBe(false); // error
		// Fix
		await runAgentValidate({ agentDir: dir, fix: true });
		// .agent/ directory should be deleted
		await expect(fs.access(path.join(dir, ".agent"))).rejects.toThrow();
		// AGENTS.md should reference .omp/SYSTEM.md not .agent/SYSTEM.md
		const agentsAfter = await Bun.file(path.join(dir, "AGENTS.md")).text();
		expect(agentsAfter).not.toMatch(/\.agent\//);
		expect(agentsAfter).toMatch(/\.omp\/SYSTEM\.md/);
		// Re-validate — should be valid
		const reResult = await runAgentValidate({ agentDir: dir });
		expect(reResult.valid).toBe(true);
	});

	test("R8: deletes .agent/prompts/ rows instead of replacing with .omp/prompts/", async () => {
		const dir = await initAgent();
		await fs.mkdir(path.join(dir, ".agent"), { recursive: true });
		await Bun.write(path.join(dir, ".agent", "SYSTEM.md"), "old");
		// Add .agent/SYSTEM.md + .agent/prompts/ to AGENTS.md
		const agents = await Bun.file(path.join(dir, "AGENTS.md")).text();
		const withDeprecated = agents
			.replace(".omp/SYSTEM.md", ".agent/SYSTEM.md")
			.replace("| `sessions/*.jsonl`", "| `.agent/prompts/` | BEHAVIOR | templates |\n| `sessions/*.jsonl`");
		await Bun.write(path.join(dir, "AGENTS.md"), withDeprecated);
		// Fix
		await runAgentValidate({ agentDir: dir, fix: true });
		const agentsAfter = await Bun.file(path.join(dir, "AGENTS.md")).text();
		// SYSTEM.md path should be replaced
		expect(agentsAfter).toMatch(/\.omp\/SYSTEM\.md/);
		// prompts/ row should be deleted, not replaced
		expect(agentsAfter).not.toMatch(/\.agent\//);
		expect(agentsAfter).not.toMatch(/\.omp\/prompts/);
		// Re-validate — should be valid
		const reResult = await runAgentValidate({ agentDir: dir });
		expect(reResult.valid).toBe(true);
	});
});

describe("omp agent register / unregister / reconcile", () => {
	// HOME isolation is provided by the file-level beforeEach/afterEach so
	// every test in this file is sandboxed.

	test("register adds an existing agentDir", async () => {
		const liveDir = await fs.mkdtemp(path.join(os.tmpdir(), "live-"));
		const result = await runAgentRegister({ name: "live", dir: liveDir });
		expect(result.registered).toBe(true);
		expect(result.agentDir).toBe(liveDir);
	});

	test("register rejects non-existent path", async () => {
		await expect(runAgentRegister({ name: "x", dir: "/nonexistent/never" })).rejects.toThrow(/does not exist/);
	});

	test("unregister removes a previously-registered entry", async () => {
		const liveDir = await fs.mkdtemp(path.join(os.tmpdir(), "live-"));
		await runAgentRegister({ name: "u", dir: liveDir });
		const result = await runAgentUnregister({ name: "u" });
		expect(result.removed).toBe(true);
	});

	test("unregister returns false for unknown names", async () => {
		const result = await runAgentUnregister({ name: "nope" });
		expect(result.removed).toBe(false);
	});

	test("unregister without --delete-files leaves the agentDir intact", async () => {
		const liveDir = await fs.mkdtemp(path.join(os.tmpdir(), "live-"));
		await Bun.write(path.join(liveDir, "marker.txt"), "x");
		await runAgentRegister({ name: "kept", dir: liveDir });
		const result = await runAgentUnregister({ name: "kept" });
		expect(result.removed).toBe(true);
		expect(result.deletedFiles).toBeUndefined();
		expect(result.deleteFiles).toBeUndefined();
		// agentDir on disk must still exist with its content
		const content = await Bun.file(path.join(liveDir, "marker.txt")).text();
		expect(content).toBe("x");
	});

	test("--delete-files removes the agentDir on disk", async () => {
		const liveDir = await fs.mkdtemp(path.join(os.tmpdir(), "live-"));
		await Bun.write(path.join(liveDir, "marker.txt"), "x");
		await runAgentRegister({ name: "doomed", dir: liveDir });
		const result = await runAgentUnregister({ name: "doomed", deleteFiles: true });
		expect(result.removed).toBe(true);
		expect(result.deleteFiles).toBe(true);
		expect(result.deletedFiles).toBe(true);
		expect(result.agentDir).toBe(liveDir);
		// Directory should be gone
		await expect(fs.access(liveDir)).rejects.toThrow();
	});

	test("--delete-files with a missing agentDir just unregisters and reports nothing-to-delete", async () => {
		const { registerAgent } = await import("../src/skeleton/registry");
		await registerAgent("ghost", "/nonexistent/never/was");
		const result = await runAgentUnregister({ name: "ghost", deleteFiles: true });
		expect(result.removed).toBe(true);
		expect(result.deleteFiles).toBe(true);
		expect(result.deletedFiles).toBe(false);
		expect(result.agentDir).toBe("/nonexistent/never/was");
	});

	test("--delete-files refuses to wipe filesystem root even if a corrupt registry points there", async () => {
		const { registerAgent } = await import("../src/skeleton/registry");
		await registerAgent("root", "/");
		await expect(runAgentUnregister({ name: "root", deleteFiles: true })).rejects.toThrow(/Refusing/);
		// Throw happened BEFORE unregister, so the registry entry is preserved.
		const { findAgent } = await import("../src/skeleton/registry");
		const entry = await findAgent("root");
		expect(entry?.path).toBe("/");
		// Clean up so the afterEach isolation sees a consistent registry.
		await runAgentUnregister({ name: "root" });
	});

	test("reconcile prunes stale entries and reports them", async () => {
		const liveDir = await fs.mkdtemp(path.join(os.tmpdir(), "live-"));
		// Use the low-level registerAgent to add a "dead" entry pointing at a
		// non-existent path (runAgentRegister would reject that at the API layer).
		const { registerAgent } = await import("../src/skeleton/registry");
		await registerAgent("alive", liveDir);
		await registerAgent("dead", "/nonexistent/never/was");
		const result = await runAgentReconcile();
		expect(result.pruned).toContain("dead");
		expect(result.pruned).not.toContain("alive");
	});

	test("reconcile auto-registers agentDirs in the default location not in the registry", async () => {
		// Simulate a legacy agentDir (created before the registry existed) by
		// dropping it directly into the default location under the isolated HOME.
		const defaultRoot = path.join(isolatedHome, ".omp", "agents");
		const legacyDir = path.join(defaultRoot, "legacy-bot");
		await fs.mkdir(legacyDir, { recursive: true });
		// Sanity: the registry file is at ~/.omp/agent/registry.json under isolatedHome,
		// which the afterEach hook will clean up.
		const result = await runAgentReconcile();
		expect(result.registered).toContain("legacy-bot");
		const { findAgent } = await import("../src/skeleton/registry");
		const entry = await findAgent("legacy-bot");
		expect(entry?.path).toBe(legacyDir);
	});

	test("reconcile is idempotent: re-running after a clean registry is a no-op", async () => {
		const result = await runAgentReconcile();
		expect(result.pruned).toEqual([]);
		expect(result.registered).toEqual([]);
		const second = await runAgentReconcile();
		expect(second).toEqual(result);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// semantic audit (--semantic flag)
// ────────────────────────────────────────────────────────────────────────────

describe("runAgentValidate — semantic flag", () => {
	test("does not run semantic audit when flag is not set", async () => {
		await runAgentInit({ name: "alpha", dir: tmpDir });
		const result = await runAgentValidate({ agentDir: path.join(tmpDir, "alpha") });
		expect(result.semantic).toBeUndefined();
	});

	test("gracefully degrades when semantic flag is set but no model/apikey available", async () => {
		await runAgentInit({ name: "beta", dir: tmpDir });
		const result = await runAgentValidate({
			agentDir: path.join(tmpDir, "beta"),
			semantic: true,
		});
		// Should not crash — either errors out gracefully or returns empty violations
		expect(result.semantic).toBeDefined();
		// Issues should not contain semantic violations if the audit couldn't run
		if (result.semantic?.error) {
			expect(result.semantic.violations).toEqual([]);
		}
	}, 30000); // extended timeout for model registry refresh
});
