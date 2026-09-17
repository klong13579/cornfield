/**
 * serve 的会话装配按 (agentDir, projectRoot)（T25）。
 *
 * 这个测试守的是 serve 真正要修的那条根：**工作根 / session 目录 / 配置根是三行不同的东西**
 * （`docs/client/agent-hub.md` §1.1a）。所以用例分四组：
 *
 *   1. 装配：绑定 Project 时工作根 = Project root，session 文件仍归 `<agentDir>/sessions`，
 *      配置的 project 层跟着工作根走；没绑定 Project 时三行与今天逐字节一致。
 *   2. 并存：同一个 Agent 服务两个 Project，两个会话同时活着，谁也不顶替谁。
 *   3. 失败要真话：未声明的 projectId / Project 注册表读不出来 / 归属写不进会话头
 *      → 不建会话、不落回任何默认根、不留孤儿会话。
 *   4. agent 列表的边界：绑 Project 的附件不在 agent 行里冒充（它不是这个 Agent 自己根上的会话）。
 *
 * 隔离：真文件 + 真 HOME（同 `session-workspace.test.ts`）+ config root override，afterEach 全部还原。
 * 装配用例跑真 `createAgentSession`：只有真跑一遍才知道 session 文件到底落在哪。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getConfigRootDir, setConfigRootDir } from "@cornfield/utils";
import { projectsFilePath, upsertProject } from "../../src/agent-domain/project-store";
import { createServeSessionFactory } from "../../src/commands/serve";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import * as sdkModule from "../../src/sdk";
import { type CreateAgentSessionOptions, createAgentSession, discoverAuthStorage } from "../../src/sdk";
import {
	type AgentMeta,
	attachmentKey,
	attachmentRoot,
	type SessionFactory,
	SessionRegistry,
} from "../../src/server/session-registry";
import { AgentSession } from "../../src/session/agent-session";
import { SessionManager } from "../../src/session/session-manager";
import { type ResolvedSessionWorkspace, SessionWorkspaceError } from "../../src/session/session-workspace";

const ENV_KEYS = ["HOME", "CORNFIELD_CONFIG_DIR"] as const;

/**
 * 真 `createAgentSession` 的用例每次要一两秒（模型目录 + MCP 发现），默认 5s 在整目录串跑时会打满
 * —— 给它们一个够用的上限，不靠运气。
 */
const SESSION_TEST_TIMEOUT = 30_000;

let home: string;
let agentDir: string;
let savedEnv: Record<string, string | undefined>;
let savedConfigRoot: string;
let registries: SessionRegistry[];

beforeEach(async () => {
	savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	savedConfigRoot = getConfigRootDir();
	home = await fs.mkdtemp(path.join(os.tmpdir(), "cornfield-serve-session-"));
	process.env.HOME = home;
	// 项目注册表的路径 = HOME + getConfigDirName()（`projectsFilePath`）；config root 指到同一处，
	// 让 createAgentSession 内部那些「默认目录」也落在 temp 里，一个字节都不写到真 HOME。
	delete process.env.CORNFIELD_CONFIG_DIR;
	setConfigRootDir(path.join(home, ".cornfield"));
	agentDir = path.join(home, "agents", "hr");
	await fs.mkdir(agentDir, { recursive: true });
	registries = [];
});

afterEach(async () => {
	vi.restoreAllMocks();
	for (const registry of registries) await registry.disposeAll();
	for (const key of ENV_KEYS) {
		const value = savedEnv[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	setConfigRootDir(savedConfigRoot);
	await fs.rm(home, { recursive: true, force: true });
});

function hrMeta(): AgentMeta {
	return { id: "hr", name: "hr", agentDir };
}

/** 真 `createAgentSession` 的原件（`recordAssembly` 里透传调用，不能是被替换后的那个）。 */
const realCreateAgentSession = sdkModule.createAgentSession;

/** 建 registry 并登记清理（每个用例都要 disposeAll，否则真 session 会漏在进程里）。 */
function makeRegistry(factory: SessionFactory): SessionRegistry {
	const registry = new SessionRegistry(factory);
	registries.push(registry);
	return registry;
}

/** 真 AgentSession（session 文件在内存里），簿记类用例用它。 */
async function makeInMemorySession(cwd: string): Promise<AgentSession> {
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		sessionManager: SessionManager.inMemory(cwd),
		settings: Settings.isolated(),
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
	});
	return session;
}

/** 在 resolver 给的工作根上建真 AgentSession —— 与 serve 的工厂同一套规则（`attachmentRoot`）。 */
function rootSessionFactory(): SessionFactory {
	return async (meta, workspace) => await makeInMemorySession(attachmentRoot(meta, workspace));
}

/** serve 真正装配用的工厂（真 auth / 真 model 目录 / 真持久化 session 目录）。 */
async function makeServeFactory(): Promise<SessionFactory> {
	const authStorage = await discoverAuthStorage();
	const modelRegistry = new ModelRegistry(authStorage);
	await modelRegistry.refresh("offline");
	return createServeSessionFactory({ modelRegistry, authStorage, canUseTool: async () => true });
}

/**
 * 装配用例的取景框：serve 的工厂照原样调 `createAgentSession`（它传的 `cwd`/`agentDir`/`settings`/
 * `sessionManager` 一个都不改），只把**发现面**关掉 —— 真会话的构造成本与 MCP/LSP/扩展/技能发现无关，
 * 而 MCP 发现会去读这台机器上真实的 `~/.claude.json` 之类（`os.homedir()` 不吃 HOME 覆盖），
 * 在测试里只剩一串起不来的子进程 + 每个会话几秒等待。同时记下工厂实际传进去的选项与会话。
 */
function recordAssembly(): { calls: CreateAgentSessionOptions[]; sessions: AgentSession[] } {
	const calls: CreateAgentSessionOptions[] = [];
	const sessions: AgentSession[] = [];
	vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
		if (!options) throw new Error("serve 的装配必须给 createAgentSession 选项");
		calls.push(options);
		const result = await realCreateAgentSession({
			...options,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});
		sessions.push(result.session);
		return result;
	});
	return { calls, sessions };
}

async function declareProject(projectId: string, root: string): Promise<void> {
	await fs.mkdir(root, { recursive: true });
	await upsertProject({ projectId, root, name: projectId });
}

/** 收集 resolver 交给工厂的工作区，并把装配交给真工厂。 */
function recordingFactory(real: SessionFactory): { workspaces: ResolvedSessionWorkspace[]; factory: SessionFactory } {
	const workspaces: ResolvedSessionWorkspace[] = [];
	return {
		workspaces,
		factory: async (meta, workspace) => {
			workspaces.push(workspace);
			return await real(meta, workspace);
		},
	};
}

describe("装配：工作根 / session 目录 / 配置根", () => {
	it(
		"绑定 Project：工作根 = Project root，session 文件仍归 <agentDir>/sessions，归属写进会话头",
		async () => {
			const repoRoot = path.join(home, "repo");
			await declareProject("proj-a", repoRoot);
			const assembly = recordAssembly();
			const { workspaces, factory } = recordingFactory(await makeServeFactory());
			const registry = makeRegistry(factory);
			registry.registerMeta(hrMeta());

			const attached = await registry.attach("hr", "proj-a");
			const manager = attached.session.sessionManager;

			// 工厂拿到的是 resolver 的答案，不是这里另算的一份。
			expect(workspaces).toHaveLength(1);
			expect(workspaces[0]?.projectId).toBe("proj-a");
			expect(workspaces[0]?.projectRoot).toBe(repoRoot);
			expect(workspaces[0]?.roots[0]).toBe(repoRoot);

			// 装配那三行：工具 cwd = 工作根，配置的 project 层跟工作根，session 目录跟身份根。
			expect(assembly.calls).toHaveLength(1);
			expect(assembly.calls[0]?.cwd).toBe(repoRoot);
			expect(assembly.calls[0]?.agentDir).toBe(agentDir);
			expect(assembly.calls[0]?.settings).toBe(attached.session.settings);
			expect(manager.getCwd()).toBe(repoRoot);
			expect(attached.session.settings.getCwd()).toBe(repoRoot);
			expect(attached.session.settings.getAgentDir()).toBe(agentDir);

			// 归属是**记录下来的事实**：会话头带着 id 与来源，后续所有读方不必再猜。
			expect(manager.getHeader()?.projectId).toBe("proj-a");
			expect(manager.getHeader()?.projectSource).toBe("session");

			await manager.flush();
			const file = manager.getSessionFile();
			if (!file) throw new Error("expected the session to be persisted");
			expect(file.startsWith(path.join(agentDir, "sessions"))).toBe(true);
			expect(file.startsWith(repoRoot)).toBe(false);
		},
		SESSION_TEST_TIMEOUT,
	);

	it(
		"未指定 Project：工作根 = agentDir，session 目录与配置根都不动（与今天逐字节一致）",
		async () => {
			await declareProject("proj-a", path.join(home, "repo"));
			const assembly = recordAssembly();
			const { workspaces, factory } = recordingFactory(await makeServeFactory());
			const registry = makeRegistry(factory);
			registry.registerMeta(hrMeta());

			const attached = await registry.attach("hr");
			const manager = attached.session.sessionManager;

			expect(workspaces[0]?.projectId).toBeUndefined();
			expect(workspaces[0]?.projectSource).toBe("none");
			expect(workspaces[0]?.roots).toEqual([agentDir]);

			expect(assembly.calls[0]?.cwd).toBe(agentDir);
			expect(assembly.calls[0]?.agentDir).toBe(agentDir);
			// 未绑定的地址就是 agentId 本身 —— 今天的 key，事件路由与 getAttached(agentId) 逐字节不变。
			expect(attached.address).toBe("hr");
			expect(attached.root).toBe(agentDir);
			expect(attached.projectId).toBeUndefined();
			expect(manager.getCwd()).toBe(agentDir);
			expect(attached.session.settings.getCwd()).toBe(agentDir);
			expect(attached.session.settings.getAgentDir()).toBe(agentDir);
			// 没有 Project 就不写归属：undefined 就是「没有」，不编一个、也不写空串。
			expect(manager.getHeader()?.projectId).toBeUndefined();

			await manager.flush();
			const file = manager.getSessionFile();
			if (!file) throw new Error("expected the session to be persisted");
			expect(file.startsWith(path.join(agentDir, "sessions"))).toBe(true);
		},
		SESSION_TEST_TIMEOUT,
	);
});

describe("并存：一个 Agent 服务两个 Project", () => {
	it(
		"两个 root 各有一个会话，第二个 attach 不顶替也不 dispose 第一个",
		async () => {
			const rootA = path.join(home, "repo-a");
			const rootB = path.join(home, "repo-b");
			await declareProject("proj-a", rootA);
			await declareProject("proj-b", rootB);
			const registry = makeRegistry(rootSessionFactory());
			registry.registerMeta(hrMeta());

			const first = await registry.attach("hr", "proj-a");
			const disposeFirst = vi.spyOn(first.session, "dispose");
			const second = await registry.attach("hr", "proj-b");

			expect(second).not.toBe(first);
			expect(second.session).not.toBe(first.session);
			expect(first.session.sessionId).not.toBe(second.session.sessionId);
			expect(disposeFirst).not.toHaveBeenCalled();
			// 两个会话各自长在 resolver 给的那个根上（归属记录是工厂的活，这里用的是桩工厂，
			// 归属写头的取证在「绑定 Project」那条真工厂用例里）。
			expect(first.session.sessionManager.getCwd()).toBe(rootA);
			expect(second.session.sessionManager.getCwd()).toBe(rootB);

			// 地址是附件自己报出来的事实：绑了 Project 带工作根，条目上也带 projectId。
			expect(first.address).toBe(attachmentKey("hr", rootA));
			expect(second.address).toBe(attachmentKey("hr", rootB));
			expect(first.address).not.toBe(second.address);
			expect(first.root).toBe(rootA);
			expect(second.root).toBe(rootB);
			expect(first.projectId).toBe("proj-a");
			expect(second.projectId).toBe("proj-b");

			// 取值只按 (Agent, Project)；不带 projectId 的取值只认「这个 Agent 自己根上的附件」。
			expect(registry.getAttached("hr", "proj-a")).toBe(first);
			expect(registry.getAttached("hr", "proj-b")).toBe(second);
			expect(registry.getAttached("hr")).toBeUndefined();
			expect(registry.isAttached("hr", "proj-a")).toBe(true);
			expect(registry.listAttached()).toHaveLength(2);

			// 释放一个不影响另一个。
			await registry.detach("hr", "proj-a");
			expect(registry.getAttached("hr", "proj-a")).toBeUndefined();
			expect(registry.getAttached("hr", "proj-b")).toBe(second);
			expect(disposeFirst).toHaveBeenCalledTimes(1);
		},
		SESSION_TEST_TIMEOUT,
	);

	it(
		"重复 attach 同一个 (Agent, Project) 幂等，不新建第二个会话",
		async () => {
			await declareProject("proj-a", path.join(home, "repo-a"));
			const built: string[] = [];
			const registry = makeRegistry(async (meta, workspace) => {
				const session = await makeInMemorySession(attachmentRoot(meta, workspace));
				built.push(session.sessionId);
				return session;
			});
			registry.registerMeta(hrMeta());

			const first = await registry.attach("hr", "proj-a");
			expect(await registry.attach("hr", "proj-a")).toBe(first);
			expect(built).toHaveLength(1);
		},
		SESSION_TEST_TIMEOUT,
	);

	it(
		"并发 attach 同一地址只建一次（晚到的那次拿到同一个附件）",
		async () => {
			await declareProject("proj-a", path.join(home, "repo-a"));
			const built: string[] = [];
			const registry = makeRegistry(async (meta, workspace) => {
				const session = await makeInMemorySession(attachmentRoot(meta, workspace));
				built.push(session.sessionId);
				return session;
			});
			registry.registerMeta(hrMeta());

			const [a, b] = await Promise.all([registry.attach("hr", "proj-a"), registry.attach("hr", "proj-a")]);
			expect(a).toBe(b);
			expect(built).toHaveLength(1);
		},
		SESSION_TEST_TIMEOUT,
	);
});

describe("事件里的地址", () => {
	it(
		"attached/detached 带的是附件地址：未绑定 = agentId（今天不变），绑了 Project = 带工作根",
		async () => {
			const rootA = path.join(home, "repo-a");
			await declareProject("proj-a", rootA);
			const registry = makeRegistry(rootSessionFactory());
			registry.registerMeta(hrMeta());
			const addresses: string[] = [];
			registry.subscribe(event => {
				if (event.kind !== "snapshot") addresses.push(event.sessionId);
			});

			await registry.attach("hr");
			await registry.attach("hr", "proj-a");
			await registry.detach("hr", "proj-a");

			expect(addresses).toEqual(["hr", attachmentKey("hr", rootA), attachmentKey("hr", rootA)]);
		},
		SESSION_TEST_TIMEOUT,
	);
});

describe("失败要说真话：不建会话、不落回任何默认根", () => {
	it("未声明的 projectId：抛 resolver 的 project-unknown，工厂一次都不跑", async () => {
		await declareProject("proj-a", path.join(home, "repo-a"));
		const calls: string[] = [];
		const registry = makeRegistry(async (meta, workspace) => {
			calls.push(attachmentRoot(meta, workspace));
			return await makeInMemorySession(meta.agentDir);
		});
		registry.registerMeta(hrMeta());

		const attempt = registry.attach("hr", "ghost");
		await expect(attempt).rejects.toBeInstanceOf(SessionWorkspaceError);
		await expect(registry.attach("hr", "ghost")).rejects.toMatchObject({ failure: { kind: "project-unknown" } });

		expect(calls).toEqual([]);
		expect(registry.listAttached()).toEqual([]);
		expect(registry.isAttached("hr")).toBe(false);
	});

	it("Project 注册表读不出来：失败而不是降级成「没声明过」——未绑定的 attach 也不放行", async () => {
		await fs.mkdir(path.dirname(projectsFilePath()), { recursive: true });
		await Bun.write(projectsFilePath(), "{ this is not json");
		const calls: string[] = [];
		const registry = makeRegistry(async (meta, workspace) => {
			calls.push(attachmentRoot(meta, workspace));
			return await makeInMemorySession(meta.agentDir);
		});
		registry.registerMeta(hrMeta());

		await expect(registry.attach("hr")).rejects.toThrow(/not valid JSON/);
		expect(calls).toEqual([]);
		expect(registry.listAttached()).toEqual([]);
	});

	it(
		"归属写不进会话头：装配失败且把会话收掉，不留孤儿",
		async () => {
			await declareProject("proj-a", path.join(home, "repo-a"));
			const assembly = recordAssembly();
			const dispose = vi.spyOn(AgentSession.prototype, "dispose");
			vi.spyOn(SessionManager.prototype, "setResolvedProject").mockRejectedValue(new Error("disk full"));
			const registry = makeRegistry(await makeServeFactory());
			registry.registerMeta(hrMeta());

			await expect(registry.attach("hr", "proj-a")).rejects.toThrow(/disk full/);
			expect(assembly.sessions).toHaveLength(1);
			expect(dispose).toHaveBeenCalledTimes(1);
			expect(registry.listAttached()).toEqual([]);
			expect(registry.isAttached("hr", "proj-a")).toBe(false);
		},
		SESSION_TEST_TIMEOUT,
	);

	it("未知 agentId 照旧抛错（不因为多了 projectId 而变成另一种错）", async () => {
		const registry = makeRegistry(rootSessionFactory());
		registry.registerMeta(hrMeta());
		await expect(registry.attach("nobody")).rejects.toThrow(/unknown agent: nobody/);
	});
});

describe("agent 列表的边界", () => {
	it(
		"一行一个 Agent：绑 Project 的附件不冒充 agent 行，agent 行只报它自己根上的附件",
		async () => {
			const rootA = path.join(home, "repo-a");
			await declareProject("proj-a", rootA);
			const registry = makeRegistry(rootSessionFactory());
			registry.registerMeta(hrMeta());

			// 只绑了 Project 时，agent 行说的是它自己根上那个附件（还没建）—— 不拿绑定那个顶替。
			const projectAttachment = await registry.attach("hr", "proj-a");
			expect(registry.buildSessionList(new Set())).toEqual([
				{
					id: "hr",
					name: "hr",
					active: false,
					attached: false,
					agentDir,
					skillCount: undefined,
					dingtalk: undefined,
				},
			]);

			const ownRoot = await registry.attach("hr");
			const rows = registry.buildSessionList(new Set(["hr"]));
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({ id: "hr", attached: true, active: true });
			expect(rows[0]?.sessionFile).toBe(ownRoot.session.sessionFile);
			// 那个绑 Project 的附件仍在（只是不在 agent 行里冒充）：按域身份取得到。
			expect(registry.getAttached("hr", "proj-a")).toBe(projectAttachment);
			expect(projectAttachment.address).toBe(attachmentKey("hr", rootA));
		},
		SESSION_TEST_TIMEOUT,
	);
});
