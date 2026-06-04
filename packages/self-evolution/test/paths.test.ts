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

	it("uses project-local .omp layout when globalStore is false", () => {
		tempDir = path.join(os.tmpdir(), `evolution-paths-${Date.now()}`);
		const cwd = path.join(tempDir, "repo");
		const layout = resolveEvolutionPathLayout(cwd, false);

		expect(layout.scope).toBe("project");
		expect(layout.memoryDir).toBe(path.join(resolveProjectEvolutionDir(cwd), "memory"));
		expect(layout.evolutionDir).toBe(resolveProjectEvolutionDir(cwd));
		expect(layout.skillsDir).toBe(resolveProjectSkillsDir(cwd));
		expect(layout.dbPath).toBe(path.join(cwd, ".omp", "evolution", "evolution.db"));
		expect(layout.memoryDir).toBe(path.join(cwd, ".omp", "evolution", "memory"));
		expect(layout.skillsDir).toBe(path.join(cwd, ".omp", "skills"));
	});

	it("uses global user layout when globalStore is true", () => {
		tempDir = path.join(os.tmpdir(), `evolution-paths-global-${Date.now()}`);
		const cwd = path.join(tempDir, "repo");
		const agentDir = path.join(tempDir, "agent");
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
		const agentDir = path.join(tempDir, "agent");

		expect(getMemoryRoot(agentDir, cwd)).toBe(
			path.join(resolveGlobalEvolutionDir(), "memory", encodeProjectPathForGlobalMemory(cwd)),
		);
	});

	it("getMemoryRoot uses project memory when globalStore is false", () => {
		tempDir = path.join(os.tmpdir(), `evolution-paths-mem-proj-${Date.now()}`);
		const cwd = path.join(tempDir, "repo");
		const agentDir = path.join(tempDir, "agent");

		expect(getMemoryRoot(agentDir, cwd, { globalStore: false })).toBe(
			path.join(resolveProjectEvolutionDir(cwd), "memory"),
		);
	});

	it("resolveUserEvolutionDir is under agent dir not project", () => {
		const agentDir = "/tmp/agent";
		expect(resolveUserEvolutionDir(agentDir)).toBe(path.join(agentDir, "evolution"));
		expect(resolveUserEvolutionDir(agentDir)).not.toContain(path.join("repo", ".omp"));
	});
});
