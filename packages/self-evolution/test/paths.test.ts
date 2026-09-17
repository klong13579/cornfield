import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	encodeProjectPathForGlobalMemory,
	getMemoryRoot,
	resolveEvolutionPathLayout,
	resolveGlobalEvolutionDir,
	resolveProjectEvolutionDir,
	resolveProjectSkillsDir,
	resolveUserEvolutionDir,
} from "../src/paths";

describe("evolution paths", () => {
	let tempDir: string;

	afterEach(async () => {
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("uses project-local .cornfield layout when globalStore is false", () => {
		tempDir = path.join(os.tmpdir(), `evolution-paths-${Date.now()}`);
		const cwd = path.join(tempDir, "repo");
		const layout = resolveEvolutionPathLayout(cwd, false);

		expect(layout.scope).toBe("project");
		expect(layout.memoryDir).toBe(path.join(resolveProjectEvolutionDir(cwd), "memory"));
		expect(layout.evolutionDir).toBe(resolveProjectEvolutionDir(cwd));
		expect(layout.skillsDir).toBe(resolveProjectSkillsDir(cwd));
		expect(layout.dbPath).toBe(path.join(cwd, ".cornfield", "evolution", "evolution.db"));
		expect(layout.memoryDir).toBe(path.join(cwd, ".cornfield", "evolution", "memory"));
		expect(layout.skillsDir).toBe(path.join(cwd, ".cornfield", "skills"));
	});

	it("uses global user layout when globalStore is true", () => {
		tempDir = path.join(os.tmpdir(), `evolution-paths-global-${Date.now()}`);
		const cwd = path.join(tempDir, "repo");
		const _agentDir = path.join(tempDir, "agent");
		const layout = resolveEvolutionPathLayout(cwd, true);

		expect(layout.scope).toBe("user");
		expect(layout.evolutionDir).toBe(resolveGlobalEvolutionDir());
		expect(layout.memoryDir).toBe(
			path.join(resolveGlobalEvolutionDir(), "memory", encodeProjectPathForGlobalMemory(cwd)),
		);
		expect(layout.dbPath).toBe(path.join(resolveGlobalEvolutionDir(), "evolution.db"));
	});

	it("getMemoryRoot defaults to global user memory dir", () => {
		tempDir = path.join(os.tmpdir(), `evolution-paths-mem-${Date.now()}`);
		const cwd = path.join(tempDir, "repo");

		// 票 27：记忆根只由 memory key（配置/记忆的项目根）派生，签名里不再有 agentDir。
		expect(getMemoryRoot(cwd)).toBe(
			path.join(resolveGlobalEvolutionDir(), "memory", encodeProjectPathForGlobalMemory(cwd)),
		);
	});

	it("getMemoryRoot uses project memory when globalStore is false", () => {
		tempDir = path.join(os.tmpdir(), `evolution-paths-mem-proj-${Date.now()}`);
		const cwd = path.join(tempDir, "repo");

		expect(getMemoryRoot(cwd, { globalStore: false })).toBe(path.join(resolveProjectEvolutionDir(cwd), "memory"));
	});

	it("memoryKey 缺省 = evolutionKey：两把 key 相等时五条路径逐字节不变（裸跑 CLI / registry agent 的形状）", () => {
		tempDir = path.join(os.tmpdir(), `evolution-paths-keys-${Date.now()}`);
		const cwd = path.join(tempDir, "repo");

		expect(resolveEvolutionPathLayout(cwd, true, cwd)).toEqual(resolveEvolutionPathLayout(cwd, true));
		expect(resolveEvolutionPathLayout(cwd, false, cwd)).toEqual(resolveEvolutionPathLayout(cwd, false));
	});

	it("memoryKey 与 evolutionKey 分开时：只有 memoryDir 跟 memoryKey 走（票 27 的 serve default 形状）", () => {
		tempDir = path.join(os.tmpdir(), `evolution-paths-split-${Date.now()}`);
		const evolutionKey = path.join(tempDir, "repo");
		const memoryKey = path.join(tempDir, ".cornfield", "agents", "default");

		const split = resolveEvolutionPathLayout(evolutionKey, true, memoryKey);
		const byEvolutionKey = resolveEvolutionPathLayout(evolutionKey, true);

		expect(split.memoryDir).toBe(getMemoryRoot(memoryKey));
		expect(split.memoryDir).not.toBe(byEvolutionKey.memoryDir);
		// 另外四项与 memoryKey 无关（DB / skills / activity.log / 全局根都不跟记忆搬家）。
		expect(split.evolutionDir).toBe(byEvolutionKey.evolutionDir);
		expect(split.skillsDir).toBe(byEvolutionKey.skillsDir);
		expect(split.dbPath).toBe(byEvolutionKey.dbPath);
		expect(split.activityLogPath).toBe(byEvolutionKey.activityLogPath);
	});

	it("resolveUserEvolutionDir is under agent dir not project", () => {
		const agentDir = "/tmp/agent";
		expect(resolveUserEvolutionDir(agentDir)).toBe(path.join(agentDir, "evolution"));
		expect(resolveUserEvolutionDir(agentDir)).not.toContain(path.join("repo", ".cornfield"));
	});
});
