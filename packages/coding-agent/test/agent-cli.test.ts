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
import { runAgentInit, runAgentList, runAgentShow, runAgentValidate } from "../src/cli/agent-cli";

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-agent-test-"));
});

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
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

	test("rejects names with path separators", async () => {
		await expect(runAgentInit({ name: "bad/name", dir: tmpDir })).rejects.toThrow(/path separator/);
		await expect(runAgentInit({ name: "bad\\name", dir: tmpDir })).rejects.toThrow(/path separator/);
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
		const result = await runAgentValidate({ agentDir: path.join(tmpDir, "alpha") });
		expect(result.valid).toBe(true); // warnings don't invalidate
		const warnings = result.issues.filter(i => i.level === "warning");
		expect(warnings.map(i => i.file).sort()).toEqual([".gitignore", "prompt-includes.json"]);
	});
});
