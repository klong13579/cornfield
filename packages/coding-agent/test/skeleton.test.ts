/**
 * Tests for the agentDir skeleton module.
 *
 * Verifies the contract documented in `packages/agent/docs/agent-design-v1.md` §2 and §6.1:
 *   - All required skeleton files are created on first run.
 *   - The skeleton is idempotent (re-running on an initialized dir is a no-op).
 *   - Missing files are added additively when `mission.md` already exists.
 *   - Default content matches the design (mission, AGENTS, TOOLS, etc.).
 *   - User-created / optional directories (scripts, external) are NOT in the skeleton.
 *   - `resolveAgentDir` defaults to `~/.omp/agents/<id>` and respects an explicit override.
 *   - `buildAgentSessionPath` produces a `<agentDir>/sessions/cid_<safeId>.jsonl` path.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildAgentSessionPath, ensureAgentDir, resolveAgentDir } from "../src/skeleton";

/**
 * Files the skeleton must create on first run. Mirrors the layout in
 * `packages/agent/docs/agent-design-v1.md` §2.
 */
const REQUIRED_FILES = [
	// 5 always-on at root
	"AGENTS.md",
	"mission.md",
	"TOOLS.md",
	"TODO.md",
	"knowledge/external-workspaces.md",
	// runtime at root
	"prompt-includes.json",
	".gitignore",
	// runtime
	".omp/config.yml",
	".omp/SYSTEM.md",
	".agent/SYSTEM.md",
	// .agent/SYSTEM.md is deprecated (kept empty); .omp/SYSTEM.md is the override location
	".omp/skills/.gitkeep",
	".agent/prompts/.gitkeep",
	".agent/rules/.gitkeep",
	"knowledge/handbook/.gitkeep",
	"sessions/.gitkeep",
	"cron/tasks/.gitkeep",
	"cron/logs/.gitkeep",
];

/**
 * Per design §6.3 principle 5, optional / user-created directories must not be created
 * by the skeleton and must not raise errors when missing.
 */
const FORBIDDEN_PATHS = ["scripts", "scripts/.gitkeep", "external", "external/.gitkeep"];

describe("skeleton", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentdir-skeleton-test-"));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	test("ensureAgentDir creates all required files matching design §2", async () => {
		const created = await ensureAgentDir(tmpDir);
		expect(created).toBe(true);

		for (const relPath of REQUIRED_FILES) {
			const fullPath = path.join(tmpDir, relPath);
			await fs.access(fullPath);
		}
	});

	test("ensureAgentDir is idempotent — returns false on second call", async () => {
		const first = await ensureAgentDir(tmpDir);
		expect(first).toBe(true);

		const second = await ensureAgentDir(tmpDir);
		expect(second).toBe(false);
	});

	test("ensureAgentDir adds new skeleton files even when mission.md exists", async () => {
		// Pre-create just mission.md to simulate partial init (e.g. user-customized dir).
		await fs.writeFile(path.join(tmpDir, "mission.md"), "pre-existing user content");

		const created = await ensureAgentDir(tmpDir);
		expect(created).toBe(false);

		// Pre-existing mission.md must NOT be overwritten.
		const missionContent = await Bun.file(path.join(tmpDir, "mission.md")).text();
		expect(missionContent).toBe("pre-existing user content");

		// All other required files should be added.
		for (const relPath of REQUIRED_FILES.filter(f => f !== "mission.md")) {
			const fullPath = path.join(tmpDir, relPath);
			await fs.access(fullPath);
		}
	});

	test("AGENTS.md manifest explains file map and load order", async () => {
		await ensureAgentDir(tmpDir);
		const content = await Bun.file(path.join(tmpDir, "AGENTS.md")).text();
		expect(content).toContain("File Map");
		expect(content).toContain("prompt-includes.json");
		expect(content).toContain("MUST NOT");
	});

	test("mission.md has default role template", async () => {
		await ensureAgentDir(tmpDir);
		const content = await Bun.file(path.join(tmpDir, "mission.md")).text();
		expect(content).toContain("身份");
		expect(content).toContain("行为准则");
	});

	test("TOOLS.md lists OMP builtin tools with co-located MUST/MUST NOT", async () => {
		await ensureAgentDir(tmpDir);
		const content = await Bun.file(path.join(tmpDir, "TOOLS.md")).text();
		expect(content).toContain("`read`");
		expect(content).toContain("`grep`");
		expect(content).toContain("`bash`");
		expect(content).toContain("`write`");
		expect(content).toContain("`edit`");
		expect(content).toContain("MUST NOT");
	});

	test("TODO.md provides current-task + checklist structure", async () => {
		await ensureAgentDir(tmpDir);
		const content = await Bun.file(path.join(tmpDir, "TODO.md")).text();
		expect(content).toContain("当前任务");
		expect(content).toContain("待办");
	});

	test("prompt-includes.json lists the 5 always-on files at root", async () => {
		await ensureAgentDir(tmpDir);
		const content = await Bun.file(path.join(tmpDir, "prompt-includes.json")).text();
		const parsed = JSON.parse(content);
		expect(parsed).toHaveProperty("files");
		expect(Array.isArray(parsed.files)).toBe(true);
		expect(parsed.files).toEqual([
			"AGENTS.md",
			"mission.md",
			"TOOLS.md",
			"TODO.md",
			"knowledge/external-workspaces.md",
		]);
	});

	test(".omp/SYSTEM.md contains gateway agent system prompt baseline", async () => {
		await ensureAgentDir(tmpDir);
		const content = await Bun.file(path.join(tmpDir, ".omp/SYSTEM.md")).text();
		expect(content).toContain("Gateway Agent");
		expect(content).toContain("工具纪律");
		expect(content).toContain("安全与授权");
	});

	test(".agent/SYSTEM.md is empty (deprecated)", async () => {
		await ensureAgentDir(tmpDir);
		const content = await Bun.file(path.join(tmpDir, ".agent/SYSTEM.md")).text();
		expect(content.trim()).toBe("");
	});

	test(".omp/config.yml contains modelRoles default and theme", async () => {
		await ensureAgentDir(tmpDir);
		const content = await Bun.file(path.join(tmpDir, ".omp/config.yml")).text();
		expect(content).toContain("modelRoles");
		expect(content).toContain("default");
		expect(content).toContain("theme");
	});

	test(".gitignore matches design §2.2 (sessions, cron/logs, .omp/evolution, .omp, *.log, *.bak)", async () => {
		await ensureAgentDir(tmpDir);
		const content = await Bun.file(path.join(tmpDir, ".gitignore")).text();
		expect(content).toContain("sessions/");
		expect(content).toContain("cron/logs/");
		expect(content).toContain(".omp/evolution/");
		expect(content).toContain(".omp/");
		expect(content).toContain("*.log");
		expect(content).toContain("*.bak");
	});

	test("knowledge/external-workspaces.md documents data source mapping", async () => {
		await ensureAgentDir(tmpDir);
		const content = await Bun.file(path.join(tmpDir, "knowledge/external-workspaces.md")).text();
		expect(content).toContain("外部数据源");
		expect(content).toContain("钉钉知识库");
	});

	test("skeleton does NOT create forbidden paths (per design §6.3 principle 5)", async () => {
		await ensureAgentDir(tmpDir);
		for (const relPath of FORBIDDEN_PATHS) {
			const fullPath = path.join(tmpDir, relPath);
			let exists = false;
			try {
				await fs.access(fullPath);
				exists = true;
			} catch {
				exists = false;
			}
			expect(exists).toBe(false);
		}
	});

	test("resolveAgentDir defaults to ~/.omp/agents/<id> when no explicit dir", () => {
		const result = resolveAgentDir("test-account");
		const expected = path.join(os.homedir(), ".omp", "agents", "test-account");
		expect(result).toBe(expected);
	});

	test("resolveAgentDir uses explicit dir when provided", () => {
		const explicit = "/tmp/explicit-agent-dir";
		const result = resolveAgentDir("test-account", explicit);
		expect(result).toBe(explicit);
	});

	test("buildAgentSessionPath stores sessions under agentDir sessions", () => {
		const result = buildAgentSessionPath("/tmp/agent", "cid:with/slashes");
		expect(result).toBe(path.join("/tmp/agent", "sessions", "cid_with_slashes.jsonl"));
	});
});
