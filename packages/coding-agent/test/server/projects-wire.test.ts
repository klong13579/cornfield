/**
 * serve 侧 Project 只读桥的测试（T8）。
 *
 * 用真文件、真存储：这三个用例的意义全在「读不到 ≠ 没有」这条分界上，
 * 换成 mock 存储就什么都验不到了。
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { projectsFilePath, upsertProject } from "@cornfield/coding-agent/agent-domain/project-store";
import { readProjectContext } from "@cornfield/coding-agent/server/projects-wire";

const ENV_KEYS = ["HOME", "CORNFIELD_CONFIG_DIR"] as const;

let home: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(async () => {
	savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	home = await fs.mkdtemp(path.join(os.tmpdir(), "cornfield-projects-wire-"));
	process.env.HOME = home;
	delete process.env.CORNFIELD_CONFIG_DIR;
});

afterEach(async () => {
	for (const key of ENV_KEYS) {
		const value = savedEnv[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	await fs.rm(home, { recursive: true, force: true });
});

describe("readProjectContext", () => {
	it("没有存储文件 = 明确空集（不是错误）", async () => {
		expect(await readProjectContext()).toEqual({ projects: [] });
	});

	it("把已声明的 Project 原样带出来（没有 defaultAgentId 就不补）", async () => {
		await upsertProject({ projectId: "cornfield", root: path.join(home, "cornfield"), name: "CornField" });
		await upsertProject({
			projectId: "dtc",
			root: path.join(home, "dtc"),
			name: "米克原子 DTC",
			defaultAgentId: "hr",
		});

		expect(await readProjectContext()).toEqual({
			projects: [
				{ projectId: "cornfield", root: path.join(home, "cornfield"), name: "CornField" },
				{ projectId: "dtc", root: path.join(home, "dtc"), name: "米克原子 DTC", defaultAgentId: "hr" },
			],
		});
	});

	it("会话 cwd 落在某个 Project 里时给出归属（原目录与子目录都算）", async () => {
		const root = path.join(home, "repo");
		const nested = path.join(root, "packages", "app");
		await fs.mkdir(nested, { recursive: true });
		await upsertProject({ projectId: "repo", root, name: "Repo" });
		await upsertProject({ projectId: "app", root: nested, name: "App" });

		// 最深声明的祖先 root 获胜（与域里 matchProjectForPath 同一规则）
		expect((await readProjectContext(root)).currentProjectId).toBe("repo");
		expect((await readProjectContext(nested)).currentProjectId).toBe("app");
	});

	it("会话 cwd 不在任何 Project 里 = 不给归属（不编一个）", async () => {
		await upsertProject({ projectId: "repo", root: path.join(home, "repo"), name: "Repo" });

		const result = await readProjectContext(path.join(home, "elsewhere"));
		expect(result.projects).toHaveLength(1);
		expect(result.currentProjectId).toBeUndefined();
	});

	it("不给会话 cwd 时不做归属判断（不拿别的路径冒充会话上下文）", async () => {
		await upsertProject({ projectId: "repo", root: home, name: "Repo" });

		const result = await readProjectContext();
		expect(result.currentProjectId).toBeUndefined();
	});

	it("存储损坏时报错，不退化成空列表（否则「声明过但坏了」会显示成「没声明过」）", async () => {
		const file = projectsFilePath();
		await fs.mkdir(path.dirname(file), { recursive: true });
		await Bun.write(file, "{ not json");

		await expect(readProjectContext()).rejects.toThrow(/not valid JSON/);
	});

	it("存储版本不符同样报错", async () => {
		const file = projectsFilePath();
		await fs.mkdir(path.dirname(file), { recursive: true });
		await Bun.write(file, `${JSON.stringify({ version: 99, projects: {} })}\n`);

		await expect(readProjectContext()).rejects.toThrow(/version 99/);
	});
});
