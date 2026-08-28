import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effort } from "@oh-my-pi/pi-ai";
import { _resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getProjectAgentDir, Snowflake } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";

describe("Settings", () => {
	let testDir: string;
	let agentDir: string;
	let projectDir: string;

	beforeEach(() => {
		// Reset global singleton so each test gets a fresh instance
		_resetSettingsForTest();

		// Use snowflake to isolate parallel test runs (SQLite files can't be shared)
		testDir = path.join(os.tmpdir(), "test-settings-tmp", Snowflake.next());
		agentDir = path.join(testDir, "agent");
		projectDir = path.join(testDir, "project");

		if (fs.existsSync(testDir)) {
			fs.rmSync(testDir, { recursive: true });
		}
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(getProjectAgentDir(projectDir), { recursive: true });
	});

	const getConfigPath = () => path.join(agentDir, "config.yml");

	const writeSettings = async (settings: Record<string, unknown>) => {
		await Bun.write(getConfigPath(), YAML.stringify(settings, null, 2));
	};

	const readSettings = async (): Promise<Record<string, unknown>> => {
		const file = Bun.file(getConfigPath());
		if (!(await file.exists())) return {};
		const content = await file.text();
		const parsed = YAML.parse(content);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return parsed as Record<string, unknown>;
	};

	afterEach(() => {
		if (fs.existsSync(testDir)) {
			fs.rmSync(testDir, { recursive: true });
		}
	});

	// Tests that SettingsManager merges with DB state on save rather than blindly overwriting.
	// This ensures external edits (via AgentStorage directly) aren't lost when the app saves.
	describe("preserves externally added settings", () => {
		it("should preserve enabledModels when changing thinking level", async () => {
			// Seed initial settings in config.yml
			await writeSettings({
				theme: "dark",
				modelRoles: { default: "claude-sonnet" },
			});

			// Settings loads the initial state
			const settings = await Settings.init({ cwd: projectDir, agentDir });

			// Simulate external edit (e.g., user modifying DB directly or another process)
			await writeSettings({
				theme: { dark: "anthracite" },
				modelRoles: { default: "claude-sonnet" },
				enabledModels: ["claude-opus-4-5", "gpt-5.2-codex"],
			});

			// Settings saves a change - should merge, not overwrite
			settings.set("defaultThinkingLevel", Effort.High);
			await settings.flush();

			const savedSettings = await readSettings();
			expect(savedSettings.enabledModels).toEqual(["claude-opus-4-5", "gpt-5.2-codex"]);
			expect(savedSettings.defaultThinkingLevel).toBe(Effort.High);
			expect(savedSettings.theme).toEqual({ dark: "anthracite" });
			expect((savedSettings.modelRoles as { default?: string } | undefined)?.default).toBe("claude-sonnet");
		});

		it("should preserve custom settings when changing theme", async () => {
			await writeSettings({
				modelRoles: { default: "claude-sonnet" },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			await writeSettings({
				modelRoles: { default: "claude-sonnet" },
				shellPath: "/bin/zsh",
				extensions: ["/path/to/extension.ts"],
			});

			settings.set("theme.dark", "anthracite");
			await settings.flush();

			const savedSettings = await readSettings();
			expect(savedSettings.shellPath).toBe("/bin/zsh");
			expect(savedSettings.extensions).toEqual(["/path/to/extension.ts"]);
			expect(savedSettings.theme).toEqual({ dark: "anthracite" });
		});

		it("should let in-memory changes override file changes for same key", async () => {
			await writeSettings({
				theme: { dark: "anthracite" },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			await writeSettings({
				theme: { dark: "anthracite" },
				defaultThinkingLevel: Effort.Low,
			});

			settings.set("defaultThinkingLevel", Effort.High);
			await settings.flush();

			const savedSettings = await readSettings();
			expect(savedSettings.defaultThinkingLevel).toBe(Effort.High);
		});
	});

	describe("pinned model list", () => {
		it("defaults to empty", () => {
			const settings = Settings.isolated();
			expect(settings.getPinned()).toEqual([]);
			expect(settings.isPinned("alibaba-coding-plan/qwen3-coder-plus")).toBe(false);
		});

		it("togglePinned adds and removes", () => {
			const settings = Settings.isolated();
			expect(settings.togglePinned("alibaba-coding-plan/qwen3-coder-plus")).toBe(true);
			expect(settings.getPinned()).toEqual(["alibaba-coding-plan/qwen3-coder-plus"]);
			expect(settings.isPinned("alibaba-coding-plan/qwen3-coder-plus")).toBe(true);

			expect(settings.togglePinned("alibaba-coding-plan/qwen3.6-plus")).toBe(true);
			expect(settings.getPinned()).toEqual([
				"alibaba-coding-plan/qwen3-coder-plus",
				"alibaba-coding-plan/qwen3.6-plus",
			]);

			// toggling existing key removes it
			expect(settings.togglePinned("alibaba-coding-plan/qwen3-coder-plus")).toBe(false);
			expect(settings.getPinned()).toEqual(["alibaba-coding-plan/qwen3.6-plus"]);
		});

		it("setPinned replaces list", () => {
			const settings = Settings.isolated();
			settings.setPinned(["anthropic/claude-opus-4-5"]);
			expect(settings.getPinned()).toEqual(["anthropic/claude-opus-4-5"]);
		});
	});

		describe("recommended model list", () => {
		it("defaults to empty", () => {
			const settings = Settings.isolated();
			expect(settings.getRecommendedModels()).toEqual([]);
			expect(settings.isRecommended("alibaba-coding-plan/qwen3-coder-plus")).toBe(false);
		});

		it("setRecommendedModels replaces list and preserves configured order", () => {
			const settings = Settings.isolated();
			settings.setRecommendedModels(["anthropic/claude-opus-4-5", "narwal-plan/minimax-m3"]);
			expect(settings.getRecommendedModels()).toEqual(["anthropic/claude-opus-4-5", "narwal-plan/minimax-m3"]);
			expect(settings.isRecommended("anthropic/claude-opus-4-5")).toBe(true);
			expect(settings.isRecommended("narwal-plan/minimax-m3")).toBe(true);
			expect(settings.isRecommended("alibaba-coding-plan/qwen3-coder-plus")).toBe(false);
		});
	});

	describe("Settings.create（serve per-agent 持久化实例）", () => {
		it("creates an independent persistent instance without touching the global singleton", async () => {
			const global = await Settings.init({ cwd: projectDir, agentDir });
			global.set("theme", "light");
			await global.flush();

			// 模拟 registry agent 的独立 agentDir
			const opsDir = path.join(testDir, "ops-agent");
			await fs.mkdirSync(opsDir, { recursive: true });
			const agent = await Settings.create({ cwd: opsDir, agentDir: opsDir });
			agent.set("theme", "dark");
			agent.set("search.enabled", false);
			await agent.flush();

			// 全局单例不受影响（内存 + 默认值）
			expect(global.get("theme")).toBe("light");
			expect(global.get("search.enabled")).toBe(true);

			// 独立实例写自己的 config.yml
			const opsFile = YAML.parse(await Bun.file(path.join(opsDir, "config.yml")).text()) as Record<string, unknown>;
			expect(opsFile.theme).toBe("dark");
			expect(opsFile.search).toEqual({ enabled: false });

			// 全局单例的文件不被动到
			const globalFile = await readSettings();
			expect(globalFile.theme).toBe("light");
			expect(globalFile.search).toBeUndefined();
		});

		it("reloads existing per-agent config.yml on create (双进程/重启后同文件语义)", async () => {
			const opsDir = path.join(testDir, "ops-agent");
			await fs.mkdirSync(opsDir, { recursive: true });
			// 预置一个已修改的 config.yml（模拟 gateway 进程先写过）
			await Bun.write(path.join(opsDir, "config.yml"), YAML.stringify({ search: { enabled: false } }, null, 2));

			const agent = await Settings.create({ cwd: opsDir, agentDir: opsDir });
			expect(agent.get("search.enabled")).toBe(false);
			expect(agent.get("find.enabled")).toBe(true); // 未配置路径回落内核默认
		});
	});
});
