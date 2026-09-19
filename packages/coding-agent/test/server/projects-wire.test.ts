/**
 * serve 侧 Project 桥的测试（T8 读面 / 写面，T27 改成权威归属）。
 *
 * 用真文件、真存储、真会话：
 *   - 读面的意义全在「归属从哪来」这条分界上（会话头记的权威值 → cwd 回落 → 没有）
 *     与「读不到 ≠ 没有」上（换成 mock 存储就什么都验不到了）；
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
import { SessionManager } from "@cornfield/coding-agent/session/session-manager";

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

/**
 * 一个真会话：归属的权威就是它头里那一份（`SessionManager` 结构上就满足查询要的 `session`）。
 * 会话文件写进临时目录 —— 那条路径只是为了让会话真的是会话，不是被测的东西。
 */
async function sessionAt(
	cwd: string,
	project?: { projectId: string; source: "session" | "cwd" },
): Promise<SessionManager> {
	const manager = SessionManager.create(cwd, path.join(home, "sessions"));
	if (project) await manager.newSession({ project });
	return manager;
}

/** 查归属要给的 agentDir：一个空目录就够（声明文件不存在 = 没有额外 roots）。 */
function agentDirOf(): string {
	return path.join(home, "agent-home");
}

describe("readProjectContext（会话归属）", () => {
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

	it("不问会话就不做归属判断（连来源都不给，不拿别的路径冒充会话上下文）", async () => {
		await upsertProject({ projectId: "repo", root: home, name: "Repo" });

		const result = await readProjectContext();
		expect(result.currentProjectId).toBeUndefined();
		// 「没问过」与「问了、没有」不是同一件事：前者连来源字段都不出现。
		expect("currentProjectSource" in result).toBe(false);
	});

	it("权威优先：会话头记的归属胜出，即使 cwd 落在另一个 Project 里", async () => {
		await upsertProject({ projectId: "repo", root: path.join(home, "repo"), name: "Repo" });
		await upsertProject({ projectId: "dtc", root: path.join(home, "dtc"), name: "DTC" });
		// cwd 在 repo 里，但会话记的是 dtc：记录是断言，cwd 不是。
		const session = await sessionAt(path.join(home, "repo"), { projectId: "dtc", source: "session" });

		const result = await readProjectContext({ session, agentDir: agentDirOf() });

		expect(result.currentProjectId).toBe("dtc");
		expect(result.currentProjectSource).toBe("session");
	});

	it("旧会话（头里没记）= 按 cwd 匹配回落，来源标 cwd（原目录与子目录都算，最深声明的祖先赢）", async () => {
		const root = path.join(home, "repo");
		const nested = path.join(root, "packages", "app");
		await fs.mkdir(nested, { recursive: true });
		await upsertProject({ projectId: "repo", root, name: "Repo" });
		await upsertProject({ projectId: "app", root: nested, name: "App" });

		const atRoot = await sessionAt(root);
		const atNested = await sessionAt(nested);

		const fromRoot = await readProjectContext({ session: atRoot, agentDir: agentDirOf() });
		expect(fromRoot.currentProjectId).toBe("repo");
		expect(fromRoot.currentProjectSource).toBe("cwd");

		const fromNested = await readProjectContext({ session: atNested, agentDir: agentDirOf() });
		expect(fromNested.currentProjectId).toBe("app");
		expect(fromNested.currentProjectSource).toBe("cwd");
	});

	it("问了、确实没有归属 = 没有 currentProjectId + 来源 none（不是「没问过」）", async () => {
		await upsertProject({ projectId: "repo", root: path.join(home, "repo"), name: "Repo" });
		const session = await sessionAt(path.join(home, "elsewhere"));

		const result = await readProjectContext({ session, agentDir: agentDirOf() });

		expect(result.projects).toHaveLength(1);
		expect(result.currentProjectId).toBeUndefined();
		expect(result.currentProjectSource).toBe("none");
	});

	it("会话记的 Project 注册表里没有 = 报错，不静默回落成 cwd 或「未归属」", async () => {
		const atRepo = path.join(home, "repo");
		await fs.mkdir(atRepo, { recursive: true });
		await upsertProject({ projectId: "repo", root: atRepo, name: "Repo" });
		// 会话说自己在 ghost 上：按 cwd 能匹配到 repo —— 回落过去等于把一条已经不成立的归属
		// 改写成另一条，调用方再也看不到「这个会话的绑定失效了」。
		const session = await sessionAt(atRepo, { projectId: "ghost", source: "session" });

		await expect(readProjectContext({ session, agentDir: agentDirOf() })).rejects.toThrow(/does not declare/);
	});

	it("存储损坏时报错，不退化成空列表（否则「声明过但坏了」会显示成「没声明过」）", async () => {
		const file = projectsFilePath();
		await fs.mkdir(path.dirname(file), { recursive: true });
		await Bun.write(file, "{ not json");

		await expect(readProjectContext()).rejects.toThrow(/not valid JSON/);
	});

	it("存储版本不符同样报错（问了会话也一样）", async () => {
		const file = projectsFilePath();
		await fs.mkdir(path.dirname(file), { recursive: true });
		await Bun.write(file, `${JSON.stringify({ version: 99, projects: {} })}\n`);
		const session = await sessionAt(path.join(home, "repo"));

		await expect(readProjectContext()).rejects.toThrow(/version 99/);
		await expect(readProjectContext({ session, agentDir: agentDirOf() })).rejects.toThrow(/version 99/);
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

	it("写进去又读得回来：声明 → 读面能看到它，且 root 一致（带会话归属一起）", async () => {
		await declareProject({ projectId: "repo", name: "Repo", root: path.join(home, "repo") });
		const session = await sessionAt(path.join(home, "repo", "src"));

		expect(await readProjectContext({ session, agentDir: agentDirOf() })).toEqual({
			projects: [{ projectId: "repo", root: path.join(home, "repo"), name: "Repo" }],
			currentProjectId: "repo",
			currentProjectSource: "cwd",
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
		const session = await sessionAt(path.join(home, "repo"));

		await dropProject("repo");

		// 项目没了，会话头里什么都没记：归属回落到 cwd 也匹配不上了。
		expect(await readProjectContext({ session, agentDir: agentDirOf() })).toEqual({
			projects: [],
			currentProjectSource: "none",
		});
	});
});

describe("declareProject 缺省身份（projectId / name 由 root 推导）", () => {
	it("两个字段都缺省 → id 取 root 的目录名，name 跟随 id", async () => {
		const root = path.join(home, "repo");

		const written = await declareProject({ root });

		expect(written.project.projectId).toBe("repo");
		expect(written.project.name).toBe("repo");
		expect(await loadProjects()).toEqual([{ projectId: "repo", name: "repo", root }]);
	});

	it("同一个 root 再声明一次 = 更新：复用原 id、保留已有名字，不多出一条", async () => {
		const root = path.join(home, "repo");
		await declareProject({ root, name: "我的仓库" });

		const again = await declareProject({ root });

		// 第二次点「声明」不能变成新项目（那会多出一个 <目录名>-2），
		// 也不该把用户起的名字改回目录名。
		expect(again.project.projectId).toBe("repo");
		expect(again.project.name).toBe("我的仓库");
		expect(await loadProjects()).toHaveLength(1);
	});

	it("目录名撞了要避让：已声明的 id 不被覆盖，新声明拿 -2", async () => {
		await declareProject({ root: path.join(home, "a", "repo") });

		const second = await declareProject({ root: path.join(home, "b", "repo") });

		expect(second.project.projectId).toBe("repo-2");
		expect((await loadProjects()).map(project => project.projectId)).toEqual(["repo", "repo-2"]);
	});

	it("id 走推导时，显式 name 仍然原样（不被 trim）", async () => {
		const written = await declareProject({ name: "  我 的 仓库  ", root: path.join(home, "repo") });

		expect(written.project.projectId).toBe("repo");
		expect(written.project.name).toBe("  我 的 仓库  ");
	});
});
