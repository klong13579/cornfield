/**
 * 会话工作区 resolver 的测试（T24）。
 *
 * 这是全仓唯一的「会话属于哪个 Project、在哪些根上跑」判定点，所以测试只盯三件事：
 *   - 三段判定的优先级：header 权威 → cwd 回落（只服务旧会话）→ 明确没有；
 *   - **读不到 ≠ 没声明**：注册表坏了、声明读不出内容都是硬失败，不许降级成「无归属」；
 *   - roots 的顺序与去重：边界是**声明过的根**，不是哪个路径猜出来的。
 *
 * 用真文件 + 真 HOME 隔离（同 `projects-wire.test.ts`）：换成 mock 存储，
 * 「读不到 ≠ 没声明」这条分界就什么都验不到了。
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { projectsFilePath, upsertProject } from "@cornfield/coding-agent/agent-domain/project-store";
import type { ProjectSource } from "@cornfield/coding-agent/agent-domain/types";
import type { SessionHeader } from "@cornfield/coding-agent/session/session-manager";
import {
	readPersistedProject,
	resolveSessionWorkspace,
	SessionWorkspaceError,
	type SessionWorkspaceSource,
} from "@cornfield/coding-agent/session/session-workspace";
import { workspaceFilePath } from "@cornfield/coding-agent/skeleton/workspace";

const ENV_KEYS = ["HOME", "CORNFIELD_CONFIG_DIR"] as const;

let home: string;
let agentDir: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(async () => {
	savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	home = await fs.mkdtemp(path.join(os.tmpdir(), "cornfield-session-workspace-"));
	process.env.HOME = home;
	delete process.env.CORNFIELD_CONFIG_DIR;
	agentDir = path.join(home, "agents", "hr");
	await fs.mkdir(agentDir, { recursive: true });
});

afterEach(async () => {
	for (const key of ENV_KEYS) {
		const value = savedEnv[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	await fs.rm(home, { recursive: true, force: true });
});

function header(overrides: Partial<SessionHeader> & { cwd: string }): SessionHeader {
	return { type: "session", id: "s1", timestamp: "2026-01-01T00:00:00.000Z", ...overrides };
}

function liveSession(recorded: SessionHeader | null, cwd: string): SessionWorkspaceSource {
	return { getHeader: () => recorded, getCwd: () => cwd };
}

/** 写一份 agentDir 声明（`attachedRoots` 按 workspace v2 形状）。 */
async function declareWorkspace(declaration: Record<string, unknown>): Promise<void> {
	await fs.mkdir(path.join(agentDir, ".cornfield"), { recursive: true });
	await Bun.write(
		workspaceFilePath(agentDir),
		`${JSON.stringify({ schemaVersion: 2, id: "hr", name: "hr-agent", type: "agent", root: ".", projectRoot: ".", ...declaration })}\n`,
	);
}

describe("判定顺序", () => {
	it("header.projectId 是权威：cwd 落在另一个 Project 里也按 header 算", async () => {
		const repoRoot = path.join(home, "repo");
		const otherRoot = path.join(home, "other");
		await upsertProject({ projectId: "repo", root: repoRoot, name: "Repo" });
		await upsertProject({ projectId: "other", root: otherRoot, name: "Other" });

		// 会话记录的是 repo，而它的 cwd 在 other 里 —— 记录赢，cwd 只是旧会话的回落。
		const resolved = await resolveSessionWorkspace({
			agentDir,
			header: header({ cwd: path.join(otherRoot, "src"), projectId: "repo", projectSource: "session" }),
		});

		expect(resolved.projectId).toBe("repo");
		expect(resolved.projectRoot).toBe(repoRoot);
		expect(resolved.projectSource).toBe("session");
		expect(resolved.roots[0]).toBe(repoRoot);
	});

	it("调用方给的 projectId（新会话，还没有 header）进第一档，来源是会话自己", async () => {
		const repoRoot = path.join(home, "repo");
		await upsertProject({ projectId: "repo", root: repoRoot, name: "Repo" });

		const resolved = await resolveSessionWorkspace({ agentDir, header: null, projectId: "repo" });

		expect(resolved.projectId).toBe("repo");
		expect(resolved.projectRoot).toBe(repoRoot);
		expect(resolved.projectSource).toBe("session");
	});

	it("调用方与 header 各说一个 Project = 冲突，不是「谁优先」", async () => {
		await upsertProject({ projectId: "repo", root: path.join(home, "repo"), name: "Repo" });
		await upsertProject({ projectId: "other", root: path.join(home, "other"), name: "Other" });

		const attempt = resolveSessionWorkspace({
			agentDir,
			header: header({ cwd: home, projectId: "repo", projectSource: "session" }),
			projectId: "other",
		});

		await expect(attempt).rejects.toThrow(/recorded as belonging to project "repo"/);
		await expect(attempt).rejects.toMatchObject({ failure: { kind: "project-conflict" } });
	});

	it("没有记录、cwd 落在声明过的 root 里 = 按 cwd 回落，来源写明是 cwd", async () => {
		const repoRoot = path.join(home, "repo");
		await upsertProject({ projectId: "repo", root: repoRoot, name: "Repo" });

		const resolved = await resolveSessionWorkspace({
			agentDir,
			header: header({ cwd: path.join(repoRoot, "packages", "app") }),
		});

		expect(resolved.projectId).toBe("repo");
		expect(resolved.projectSource).toBe("cwd");
	});

	it("cwd 落在嵌套 Project 里 = 最深的那个（与域里 matchProjectForPath 同一规则）", async () => {
		const repoRoot = path.join(home, "repo");
		const appRoot = path.join(repoRoot, "packages", "app");
		await fs.mkdir(appRoot, { recursive: true });
		await upsertProject({ projectId: "repo", root: repoRoot, name: "Repo" });
		await upsertProject({ projectId: "app", root: appRoot, name: "App" });

		const resolved = await resolveSessionWorkspace({ agentDir, header: header({ cwd: appRoot }) });

		expect(resolved.projectId).toBe("app");
		expect(resolved.projectSource).toBe("cwd");
	});

	it("没有任何归属且 cwd 不匹配 = 明确 undefined + none，不写空串冒充", async () => {
		await upsertProject({ projectId: "repo", root: path.join(home, "repo"), name: "Repo" });

		const resolved = await resolveSessionWorkspace({
			agentDir,
			header: header({ cwd: path.join(home, "elsewhere") }),
		});

		expect(resolved.projectId).toBeUndefined();
		expect(resolved.projectRoot).toBeUndefined();
		expect(resolved.projectSource).toBe("none");
		expect("projectId" in resolved).toBe(true);
	});

	it("连 cwd 都不知道（全新会话）时不去匹配任何路径", async () => {
		// 把 home 顶层声明成 Project:若实现拿进程 cwd / agentDir 顶替会话 cwd，这条会拿到归属。
		await upsertProject({ projectId: "home", root: home, name: "Home" });

		const resolved = await resolveSessionWorkspace({ agentDir });

		expect(resolved.projectId).toBeUndefined();
		expect(resolved.projectSource).toBe("none");
	});
});

describe("读不到要说真话", () => {
	it("header 记的 Project 注册表里没有 = 硬失败，不降级成「没归属」", async () => {
		await upsertProject({ projectId: "repo", root: path.join(home, "repo"), name: "Repo" });

		const attempt = resolveSessionWorkspace({
			agentDir,
			header: header({ cwd: path.join(home, "repo"), projectId: "gone", projectSource: "session" }),
		});

		await expect(attempt).rejects.toMatchObject({
			failure: { kind: "project-unknown", projectId: "gone", source: "session" },
		});
	});

	it("调用方给的 Project 没声明过 = 同样硬失败", async () => {
		const attempt = resolveSessionWorkspace({ agentDir, header: null, projectId: "gone" });

		await expect(attempt).rejects.toMatchObject({
			failure: { kind: "project-unknown", projectId: "gone", source: "session" },
		});
	});

	it("注册表坏了 = 抛错，不当成「没声明过 Project」", async () => {
		await fs.mkdir(path.dirname(projectsFilePath()), { recursive: true });
		await Bun.write(projectsFilePath(), "{ not json");

		await expect(resolveSessionWorkspace({ agentDir, header: header({ cwd: home }) })).rejects.toThrow(
			/not valid JSON/,
		);
	});

	it("注册表版本不符 = 抛错（不许当空注册表用）", async () => {
		await fs.mkdir(path.dirname(projectsFilePath()), { recursive: true });
		await Bun.write(projectsFilePath(), `${JSON.stringify({ version: 99, projects: {} })}\n`);

		await expect(resolveSessionWorkspace({ agentDir, header: header({ cwd: home }) })).rejects.toThrow(/version 99/);
	});

	it("声明文件在但读不出内容 = 抛错，不静默丢掉它声明的 roots", async () => {
		await declareWorkspace({ schemaVersion: 1 }); // 不是 v2 声明
		await upsertProject({ projectId: "repo", root: path.join(home, "repo"), name: "Repo" });

		const attempt = resolveSessionWorkspace({
			agentDir,
			header: header({ cwd: path.join(home, "repo"), projectId: "repo", projectSource: "session" }),
		});

		await expect(attempt).rejects.toMatchObject({ failure: { kind: "workspace-declaration-unreadable" } });
		await expect(attempt).rejects.toThrow(/schema-v2|declaration/);
	});

	it("没有声明文件 = 就是没有额外根（不是错误）", async () => {
		const resolved = await resolveSessionWorkspace({ agentDir, header: header({ cwd: home }) });

		expect(resolved.roots).toEqual([agentDir]);
	});
});

describe("roots", () => {
	it("顺序是 Project root → 声明的 attachedRoots → agentDir", async () => {
		const repoRoot = path.join(home, "repo");
		const shared = path.join(home, "shared");
		await upsertProject({ projectId: "repo", root: repoRoot, name: "Repo" });
		await declareWorkspace({ attachedRoots: [shared] });

		const resolved = await resolveSessionWorkspace({
			agentDir,
			header: header({ cwd: repoRoot, projectId: "repo", projectSource: "session" }),
		});

		expect(resolved.roots).toEqual([repoRoot, shared, agentDir]);
	});

	it("未绑定 Project 时 = 声明过的 attachedRoots + agentDir（没有声明就正好是 agentDir）", async () => {
		const shared = path.join(home, "shared");
		await declareWorkspace({ attachedRoots: [shared] });

		const resolved = await resolveSessionWorkspace({ agentDir, header: header({ cwd: home }) });

		expect(resolved.roots).toEqual([shared, agentDir]);
	});

	it("声明里的相对 attachedRoot 相对 agentDir 解析（与其它声明路径同一读法）", async () => {
		await declareWorkspace({ attachedRoots: ["knowledge"] });

		const resolved = await resolveSessionWorkspace({ agentDir, header: header({ cwd: home }) });

		expect(resolved.roots).toEqual([path.join(agentDir, "knowledge"), agentDir]);
	});

	it("agentDir 就是 Project root 时只出现一次", async () => {
		await upsertProject({ projectId: "hr", root: agentDir, name: "HR" });

		const resolved = await resolveSessionWorkspace({
			agentDir,
			header: header({ cwd: agentDir, projectId: "hr", projectSource: "session" }),
		});

		expect(resolved.roots).toEqual([agentDir]);
	});

	it("同一处通过符号链接写两遍只算一个根（按真实路径去重）", async () => {
		const real = path.join(home, "real-repo");
		const link = path.join(home, "link-repo");
		await fs.mkdir(real, { recursive: true });
		await fs.symlink(real, link);
		// Project 声明用真实路径，agentDir 用符号链接路径 —— 同一处目录。
		await upsertProject({ projectId: "repo", root: real, name: "Repo" });

		const resolved = await resolveSessionWorkspace({
			agentDir: link,
			header: header({ cwd: real, projectId: "repo", projectSource: "session" }),
		});

		expect(resolved.roots).toEqual([real]);
	});
});

describe("活的 session 与纯 header", () => {
	it("给活的 session 时用它的 header 与当前 cwd", async () => {
		const repoRoot = path.join(home, "repo");
		await upsertProject({ projectId: "repo", root: repoRoot, name: "Repo" });

		const resolved = await resolveSessionWorkspace({
			agentDir,
			session: liveSession(header({ cwd: path.join(repoRoot, "src") }), path.join(repoRoot, "src")),
		});

		expect(resolved.projectId).toBe("repo");
		expect(resolved.projectSource).toBe("cwd");
	});

	it("session 还没写 header（全新会话）= 没有归属，agentId 也不编", async () => {
		const resolved = await resolveSessionWorkspace({
			agentDir,
			session: liveSession(null, path.join(home, "repo")),
		});

		expect(resolved.projectId).toBeUndefined();
		expect(resolved.projectSource).toBe("none");
		expect(resolved.agentId).toBeUndefined();
	});

	it("agentId 是「会话记了什么就回什么」：记了 hr 就回 hr", async () => {
		const resolved = await resolveSessionWorkspace({
			agentDir,
			header: header({ cwd: home, agentId: "hr", agentSource: "session" }),
		});

		expect(resolved.agentId).toBe("hr");
		expect(resolved.agentDir).toBe(agentDir);
	});
});

describe("readPersistedProject", () => {
	it("没记录 = null（不是错误，也不是空绑定）", () => {
		expect(readPersistedProject(header({ cwd: home }))).toBeNull();
		expect(readPersistedProject(null)).toBeNull();
	});

	it("记了 id 与 source 就原样带出来", () => {
		expect(readPersistedProject(header({ cwd: home, projectId: "repo", projectSource: "cwd" }))).toEqual({
			projectId: "repo",
			source: "cwd",
		});
	});

	it("记了 id 但 source 不是认识的值：仍算会话自己的记录（与 session-agent 同一读法）", () => {
		// 盘上的文件可以是任何东西：这个值来自别的写入方或手改，不是类型能给的。
		const record = readPersistedProject(
			header({ cwd: home, projectId: "repo", projectSource: "somewhere" as ProjectSource }),
		);

		expect(record).toEqual({ projectId: "repo", source: "session" });
	});
});

describe("错误类型", () => {
	it("SessionWorkspaceError 带机器可读的 failure，且 message 可读", async () => {
		await expect(resolveSessionWorkspace({ agentDir, header: null, projectId: "gone" })).rejects.toBeInstanceOf(
			SessionWorkspaceError,
		);
	});
});
