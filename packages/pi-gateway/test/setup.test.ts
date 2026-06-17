import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { ensureAgentDir, resolveAgentDir } from "../src/setup";

const REQUIRED_FILES = [
	"mission.md",
	"profile.yaml",
	".gitignore",
	".agent/SYSTEM.md",
	".agent/AGENTS.md",
	".agent/rules/security.md",
	".agent/skills/.gitkeep",
	".agent/prompts/.gitkeep",
	"sessions/.gitkeep",
	"cron/tasks/.gitkeep",
	"cron/logs/.gitkeep",
	"knowledge/.gitkeep",
	"knowledge/faq.md",
	"knowledge/external-workspaces.md",
	"knowledge/handbook/server-restart.md",
];

const FORBIDDEN_PATHS = [
	// Per design §6.1b rule #4: .omp/ is created by omp, not skeleton
	".omp/config.yml",
	".omp/prompt-includes.json",
	// Per design §6.1b rule #3: scripts/ and external/ are NOT in the
	// auto-create list, users create them when needed
	"scripts",
	"external",
	"external/.gitkeep",
	"scripts/.gitkeep",
];

describe("setup", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentdir-test-"));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	test("ensureAgentDir creates all required files matching design §6.1", async () => {
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
		// Pre-create just mission.md to simulate partial init
		await fs.writeFile(path.join(tmpDir, "mission.md"), "pre-existing");

		const created = await ensureAgentDir(tmpDir);
		expect(created).toBe(false);

		// All other files should be added
		for (const relPath of REQUIRED_FILES.filter(f => f !== "mission.md")) {
			const fullPath = path.join(tmpDir, relPath);
			await fs.access(fullPath);
		}
	});

	test("mission.md has default content with role template", async () => {
		await ensureAgentDir(tmpDir);
		const content = await Bun.file(path.join(tmpDir, "mission.md")).text();
		expect(content).toContain("身份");
		expect(content).toContain("行为准则");
	});

	test(".agent/SYSTEM.md documents system prompt override", async () => {
		await ensureAgentDir(tmpDir);
		const content = await Bun.file(path.join(tmpDir, ".agent/SYSTEM.md")).text();
		expect(content).toContain("系统提示词");
	});

	test(".agent/AGENTS.md documents context injection", async () => {
		await ensureAgentDir(tmpDir);
		const content = await Bun.file(path.join(tmpDir, ".agent/AGENTS.md")).text();
		expect(content).toContain("工具");
	});

	test(".gitignore matches design rule #7 (sessions, cron/logs, evolution, .omp, *.log)", async () => {
		await ensureAgentDir(tmpDir);
		const content = await Bun.file(path.join(tmpDir, ".gitignore")).text();
		expect(content).toContain("sessions/");
		expect(content).toContain("cron/logs/");
		expect(content).toContain("evolution/");
		expect(content).toContain(".omp/");
		expect(content).toContain("*.log");
	});

	test("knowledge/faq.md has default FAQ template content", async () => {
		await ensureAgentDir(tmpDir);
		const content = await Bun.file(path.join(tmpDir, "knowledge/faq.md")).text();
		expect(content).toContain("常见问题");
		expect(content).toContain("system prompt");
	});

	test("knowledge/external-workspaces.md has data source mapping template", async () => {
		await ensureAgentDir(tmpDir);
		const content = await Bun.file(path.join(tmpDir, "knowledge/external-workspaces.md")).text();
		expect(content).toContain("外部数据源");
		expect(content).toContain("钉钉知识库");
	});

	test("knowledge/handbook/server-restart.md has example handbook content", async () => {
		await ensureAgentDir(tmpDir);
		const content = await Bun.file(path.join(tmpDir, "knowledge/handbook/server-restart.md")).text();
		expect(content).toContain("服务器重启");
		expect(content).toContain("ssh");
	});

	test("skeleton does NOT create forbidden paths (per design §6.1b rules #3 and #4)", async () => {
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
});
