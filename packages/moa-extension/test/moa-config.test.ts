import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadMoaConfigOverrides } from "../src/moa-config";

const SAVED_HOME = process.env.HOME;

function mkTmp(prefix: string): string {
	return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
}

function writeConfig(dir: string, filename: string, body: string): string {
	mkdirSync(dir, { recursive: true });
	const fullPath = path.join(dir, filename);
	writeFileSync(fullPath, body);
	return fullPath;
}

describe("moa-config loader", () => {
	let fakeHome: string;
	let projectDir: string;

	beforeEach(() => {
		fakeHome = mkTmp("moa-config-home");
		projectDir = mkTmp("moa-config-proj");
		mkdirSync(path.join(projectDir, ".git"), { recursive: true });
		process.env.HOME = fakeHome;
	});

	afterEach(() => {
		process.env.HOME = SAVED_HOME;
		rmSync(fakeHome, { recursive: true, force: true });
		rmSync(projectDir, { recursive: true, force: true });
	});

	it("returns empty overrides when no config files exist", async () => {
		const result = await loadMoaConfigOverrides(projectDir);
		expect(result.overrides).toEqual({});
		expect(result.globalPath).toBeUndefined();
		expect(result.projectPath).toBeUndefined();
	});

	it("loads global config from $HOME/.omp/agent/moa.yml", async () => {
		writeConfig(
			path.join(fakeHome, ".omp", "agent"),
			"moa.yml",
			`workers:
  - { name: divergent, model: narwal-plan/qwen3.5-flash }
  - { name: grounded, model: alibaba-coding-plan/deepseek-v4-pro }
  - { name: critical, model: alibaba-coding-plan/kimi-k2.6 }
synthesisModel: narwal-plan/deepseek-v4-pro-202606
`,
		);
		const result = await loadMoaConfigOverrides(projectDir);
		expect(result.globalPath).toEndWith("/.omp/agent/moa.yml");
		expect(result.projectPath).toBeUndefined();
		expect(result.overrides.synthesisModel).toBe("narwal-plan/deepseek-v4-pro-202606");
		expect(result.overrides.workers).toHaveLength(3);
	});

	it("loads project config from <projectRoot>/.omp/moa.yml", async () => {
		writeConfig(
			path.join(projectDir, ".omp"),
			"moa.yml",
			`synthesisModel: alibaba-coding-plan/kimi-k2.6
`,
		);
		const result = await loadMoaConfigOverrides(projectDir);
		expect(result.projectPath).toEndWith("/.omp/moa.yml");
		expect(result.globalPath).toBeUndefined();
		expect(result.overrides.synthesisModel).toBe("alibaba-coding-plan/kimi-k2.6");
	});

	it("project config wins on conflict (shallow merge)", async () => {
		writeConfig(
			path.join(fakeHome, ".omp", "agent"),
			"moa.yml",
			`synthesisModel: narwal-plan/from-global
timeoutMs: 100000
`,
		);
		writeConfig(
			path.join(projectDir, ".omp"),
			"moa.yml",
			`synthesisModel: narwal-plan/from-project
`,
		);
		const result = await loadMoaConfigOverrides(projectDir);
		expect(result.overrides.synthesisModel).toBe("narwal-plan/from-project");
		// Shallow merge keeps timeoutMs from global
		expect(result.overrides.timeoutMs).toBe(100000);
	});

	it("walks up to find .git when cwd is a subdirectory", async () => {
		const subdir = path.join(projectDir, "packages", "sub");
		mkdirSync(subdir, { recursive: true });
		writeConfig(
			path.join(projectDir, ".omp"),
			"moa.yml",
			`synthesisModel: narwal-plan/walked-up
`,
		);
		const result = await loadMoaConfigOverrides(subdir);
		expect(result.projectPath).toBeDefined();
		expect(result.overrides.synthesisModel).toBe("narwal-plan/walked-up");
	});

	it("does not look for project config when cwd is undefined", async () => {
		writeConfig(
			path.join(fakeHome, ".omp", "agent"),
			"moa.yml",
			`synthesisModel: narwal-plan/global-only
`,
		);
		writeConfig(
			path.join(projectDir, ".omp"),
			"moa.yml",
			`synthesisModel: narwal-plan/project
`,
		);
		const result = await loadMoaConfigOverrides(undefined);
		expect(result.globalPath).toBeDefined();
		expect(result.projectPath).toBeUndefined();
		expect(result.overrides.synthesisModel).toBe("narwal-plan/global-only");
	});

	it("parses .json config files", async () => {
		writeConfig(
			path.join(fakeHome, ".omp", "agent"),
			"moa.json",
			JSON.stringify({
				synthesisModel: "alibaba-coding-plan/glm-5",
				workers: [{ name: "divergent", model: "alibaba-coding-plan/glm-5" }],
			}),
		);
		const result = await loadMoaConfigOverrides(projectDir);
		expect(result.overrides.synthesisModel).toBe("alibaba-coding-plan/glm-5");
	});

	it("returns empty overrides on malformed YAML (does not throw)", async () => {
		writeConfig(
			path.join(fakeHome, ".omp", "agent"),
			"moa.yml",
			"workers: [unclosed bracket\n  - { name: divergent\n",
		);
		const result = await loadMoaConfigOverrides(projectDir);
		expect(result.overrides).toEqual({});
	});

	it("returns empty overrides on malformed shape (array instead of object)", async () => {
		writeConfig(
			path.join(fakeHome, ".omp", "agent"),
			"moa.yml",
			`- item1
- item2
`,
		);
		const result = await loadMoaConfigOverrides(projectDir);
		expect(result.overrides).toEqual({});
	});

	it("picks moa.yml over moa.yaml over moa.json (first match in FILENAMES order)", async () => {
		const dir = path.join(fakeHome, ".omp", "agent");
		mkdirSync(dir, { recursive: true });
		writeFileSync(path.join(dir, "moa.json"), JSON.stringify({ synthesisModel: "from-json" }));
		writeFileSync(path.join(dir, "moa.yaml"), "synthesisModel: from-yaml\n");
		writeFileSync(path.join(dir, "moa.yml"), "synthesisModel: from-yml\n");
		const result = await loadMoaConfigOverrides(projectDir);
		expect(result.globalPath).toEndWith("/moa.yml");
		expect(result.overrides.synthesisModel).toBe("from-yml");
	});

	it("returns no project config when cwd has no .git ancestor", async () => {
		const orphanDir = mkTmp("moa-config-orphan");
		try {
			writeConfig(
				path.join(orphanDir, ".omp"),
				"moa.yml",
				`synthesisModel: narwal-plan/should-not-load
`,
			);
			const result = await loadMoaConfigOverrides(orphanDir);
			expect(result.projectPath).toBeUndefined();
			expect(result.overrides.synthesisModel).toBeUndefined();
		} finally {
			rmSync(orphanDir, { recursive: true, force: true });
		}
	});
});
