/**
 * serve 侧 Project 桥的测试（T8 读面 / 写面）。
 *
 * 用真文件、真存储：
 *   - 读面的意义全在「读不到 ≠ 没有」这条分界上（换成 mock 存储就什么都验不到了）；
 *   - 写面的意义全在「答复 = 盘上现在那一份」上 —— 一次 `set_project` 说成功而盘上没变，
 *     或一次 `delete_project` 说删掉了而东西还在，都是把没发生的事说成发生了。所以这里
 *     每一步都回读真文件来对账，而不是断言桥的返回值跟自己一致。
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadProjects, projectsFilePath, upsertProject } from "@cornfield/coding-agent/agent-domain/project-store";
import { declareProject, dropProject, readProjectContext } from "@cornfield/coding-agent/server/projects-wire";

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

describe("declareProject（set_project 的写面）", () => {
	it("答复是存储里现在那一份：root 由存储归一，不是发出去的那个字符串", async () => {
		const written = await declareProject({
			projectId: "repo",
			name: "Repo",
			root: path.join(home, "a", "..", "repo"),
		});

		const stored = await loadProjects();
		expect(stored).toEqual([{ projectId: "repo", name: "Repo", root: path.join(home, "repo") }]);
		// 桥的答复必须与磁盘一致（这就是它回读一次的理由）
		expect(written.project.root).toBe(path.join(home, "repo"));
		expect(written.project).toEqual(stored[0]);
	});

	it("名字不静默改写：前后空格原样落盘、原样回（要不要 trim 是调用方的事）", async () => {
		const written = await declareProject({ projectId: "repo", name: "  Repo  ", root: path.join(home, "repo") });

		expect(written.project.name).toBe("  Repo  ");
		expect((await loadProjects())[0].name).toBe("  Repo  ");
	});

	it("省略 defaultAgentId = 没声明默认 Agent（落盘记录里就没有这个键）", async () => {
		await declareProject({ projectId: "repo", name: "Repo", root: path.join(home, "repo") });

		expect("defaultAgentId" in (await loadProjects())[0]).toBe(false);
	});

	it("声明了 defaultAgentId 就落盘、就回出来", async () => {
		const written = await declareProject({
			projectId: "dtc",
			name: "DTC",
			root: path.join(home, "dtc"),
			defaultAgentId: "hr",
		});

		expect(written.project.defaultAgentId).toBe("hr");
		expect((await loadProjects())[0].defaultAgentId).toBe("hr");
	});

	it("相对 root 报错，并且盘上什么都没多出来", async () => {
		await expect(declareProject({ projectId: "repo", name: "Repo", root: "relative/repo" })).rejects.toThrow(
			/absolute path/,
		);

		expect(await loadProjects()).toEqual([]);
	});

	it("空 projectId / 空 name / 空 root / 显式空 defaultAgentId 各自报错，盘上不变", async () => {
		await upsertProject({ projectId: "keep", root: path.join(home, "keep"), name: "Keep" });

		await expect(declareProject({ projectId: "  ", name: "N", root: path.join(home, "a") })).rejects.toThrow(
			/projectId/,
		);
		await expect(declareProject({ projectId: "a", name: "  ", root: path.join(home, "a") })).rejects.toThrow(/name/);
		await expect(declareProject({ projectId: "a", name: "N", root: "   " })).rejects.toThrow(/root/);
		await expect(
			declareProject({ projectId: "a", name: "N", root: path.join(home, "a"), defaultAgentId: " " }),
		).rejects.toThrow(/defaultAgentId/);

		expect(await loadProjects()).toEqual([{ projectId: "keep", name: "Keep", root: path.join(home, "keep") }]);
	});

	it("root 被别的 Project 占用时报错，且原来那条声明不动", async () => {
		await upsertProject({ projectId: "dtc", root: path.join(home, "dtc"), name: "DTC" });

		await expect(declareProject({ projectId: "repo", name: "Repo", root: path.join(home, "dtc") })).rejects.toThrow(
			/already declared by project "dtc"/,
		);

		expect(await loadProjects()).toEqual([{ projectId: "dtc", name: "DTC", root: path.join(home, "dtc") }]);
	});

	it("同 projectId 更新（含换 root、去掉 defaultAgentId）成功，别的 Project 不受影响", async () => {
		await upsertProject({ projectId: "keep", root: path.join(home, "keep"), name: "Keep" });
		await upsertProject({ projectId: "repo", root: path.join(home, "old"), name: "Old", defaultAgentId: "hr" });

		const written = await declareProject({ projectId: "repo", name: "New", root: path.join(home, "new") });

		expect(written.project).toEqual({ projectId: "repo", name: "New", root: path.join(home, "new") });
		expect(await loadProjects()).toEqual([
			{ projectId: "keep", name: "Keep", root: path.join(home, "keep") },
			{ projectId: "repo", name: "New", root: path.join(home, "new") },
		]);
	});

	it("存储不可信时报错，不假装声明成功", async () => {
		const file = projectsFilePath();
		await fs.mkdir(path.dirname(file), { recursive: true });
		await Bun.write(file, `${JSON.stringify({ version: 99, projects: {} })}\n`);

		await expect(declareProject({ projectId: "repo", name: "Repo", root: path.join(home, "repo") })).rejects.toThrow(
			/version 99/,
		);
	});

	it("写进去又读得回来：声明 → 读面能看到它，且 root 一致", async () => {
		await declareProject({ projectId: "repo", name: "Repo", root: path.join(home, "repo") });

		expect(await readProjectContext(path.join(home, "repo", "src"))).toEqual({
			projects: [{ projectId: "repo", root: path.join(home, "repo"), name: "Repo" }],
			currentProjectId: "repo",
		});
	});
});

describe("dropProject（delete_project 的写面）", () => {
	it("真的删掉：答复 projectId，盘上不再有它，别的 Project 照旧", async () => {
		await upsertProject({ projectId: "keep", root: path.join(home, "keep"), name: "Keep" });
		await upsertProject({ projectId: "repo", root: path.join(home, "repo"), name: "Repo" });

		const removed = await dropProject("repo");

		expect(removed).toEqual({ projectId: "repo" });
		expect(await loadProjects()).toEqual([{ projectId: "keep", name: "Keep", root: path.join(home, "keep") }]);
	});

	it("删一个本来就不在的 Project = 错误，而且不动别人的声明", async () => {
		await upsertProject({ projectId: "keep", root: path.join(home, "keep"), name: "Keep" });

		await expect(dropProject("nope")).rejects.toThrow(/no Project declared with projectId "nope"/);

		expect(await loadProjects()).toEqual([{ projectId: "keep", name: "Keep", root: path.join(home, "keep") }]);
	});

	it("删两次：第二次报错（不是一次成功的空删除）", async () => {
		await upsertProject({ projectId: "repo", root: path.join(home, "repo"), name: "Repo" });

		await dropProject("repo");
		await expect(dropProject("repo")).rejects.toThrow(/nothing was removed/);
	});

	it("空 projectId 报错，盘上不变", async () => {
		await upsertProject({ projectId: "keep", root: path.join(home, "keep"), name: "Keep" });

		await expect(dropProject("   ")).rejects.toThrow(/projectId/);

		expect(await loadProjects()).toHaveLength(1);
	});

	it("存储损坏时报错，不假装删掉了", async () => {
		const file = projectsFilePath();
		await fs.mkdir(path.dirname(file), { recursive: true });
		await Bun.write(file, "{ not json");

		await expect(dropProject("repo")).rejects.toThrow(/not valid JSON/);
	});

	it("删完之后读面也看不到它（写面与读面是同一份事实）", async () => {
		await upsertProject({ projectId: "repo", root: path.join(home, "repo"), name: "Repo" });

		await dropProject("repo");

		expect(await readProjectContext(path.join(home, "repo"))).toEqual({ projects: [] });
	});
});
