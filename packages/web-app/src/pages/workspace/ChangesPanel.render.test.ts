import { afterAll, describe, expect, it, spyOn } from "bun:test";
import type { AgentInfoDto, ChildSessionNodeDto, GitChangeDto, GitChangesDto, SessionTreeDto } from "@cornfield/wire";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionView } from "../../state/session-store";
import * as sessionStoreModule from "../../state/session-store";
import * as useSessionModule from "../../state/use-session";
import { ChangesPanel, type ChangesReadState, changeBadgesOf, changesGroupsOf, fileOpenTargetOf } from "./ChangesPanel";

/**
 * 右栏改动面板：三种「没有」不许互相顶替。
 *
 * 这个面板最容易犯的错不是画错，而是**说错**：把「读不到」渲染成「工作区没有改动」、把
 * 「还没读到」渲染成「一条都没有」，用户就会据此得出反向结论（以为 agent 什么都没改）。
 * 所以这里的断言全部盯着「屏幕上到底写了哪一句」。
 *
 * 静态渲染（react-dom/server）不跑 effect，所以子会话那几组的**读取**由 changesGroupsOf 的
 * 纯函数用例覆盖（含 pending/error/ready 三态与组来源），组件用例覆盖本会话三态 + 组头结构。
 */

const HR_AGENT: AgentInfoDto = {
	id: "hr",
	name: "HR 助手",
	face: "H",
	workspace: "hr",
	kind: "worker",
	status: "idle",
	agentDir: "/Users/me/.cornfield/agents/hr",
	active: true,
};

const CODING_AGENT: AgentInfoDto = {
	id: "coding",
	name: "编码助手",
	face: "C",
	workspace: "coding",
	kind: "worker",
	status: "idle",
	agentDir: "/Users/me/.cornfield/agents/coding",
	active: false,
};

const REPO_ROOT = "/Users/me/work/mika";

/** **会话身份**（焦点附件的地址）：绑了 Project 的会话，地址 != Agent 名 —— 这组用例的前提。 */
const SESSION_ADDRESS = "hr\u0000/Users/me/work/mika";

function change(patch: Partial<GitChangeDto> & { path: string }): GitChangeDto {
	return { index: null, worktree: "modified", ...patch };
}

const CHANGES: GitChangesDto = {
	repoRoot: REPO_ROOT,
	changes: [
		change({ path: "src/a.ts", index: "modified", worktree: "modified" }),
		change({ path: "new.txt", worktree: "untracked" }),
		change({ path: "src/renamed.ts", oldPath: "src/old.ts", index: "renamed" }),
		change({ path: "src/conflict.ts", index: "conflicted", worktree: "conflicted" }),
	],
};

const CHILD: ChildSessionNodeDto = {
	sessionId: "child-1",
	parentSessionId: "s-1",
	rootSessionId: "s-1",
	depth: 1,
	agentId: "coding",
	status: "running",
	delegationRole: "reviewer",
	objective: "审查 scope 合并",
	createdAt: 1,
	updatedAt: Date.now() - 120_000,
};

const TREE: SessionTreeDto = {
	sessionId: "s-1",
	agentId: "hr",
	agentName: "HR 助手",
	children: [CHILD],
};

let currentView: SessionView;

const useSessionSpy = spyOn(useSessionModule, "useSession").mockImplementation(() => currentView);
// 静态渲染不跑 effect（所以 fetchGitChanges 不会被调用）；真调用在这里显式失败，别静默通过。
const useSessionStoreSpy = spyOn(sessionStoreModule, "useSessionStore").mockImplementation(
	() =>
		({
			fetchGitChanges: () => Promise.reject(new Error("静态渲染不应读取子会话改动")),
			refreshGitChanges: () => Promise.reject(new Error("静态渲染不应刷新")),
			switchSession: () => undefined,
		}) as unknown as ReturnType<typeof sessionStoreModule.useSessionStore>,
);

afterAll(() => {
	useSessionSpy.mockRestore();
	useSessionStoreSpy.mockRestore();
});

function viewOf(patch: Partial<SessionView>): SessionView {
	currentView = {
		connected: true,
		reconnecting: false,
		wsUrl: "ws://127.0.0.1:1/ws",
		protocolVersion: 1,
		phase: "idle",
		model: null,
		thinkingLevel: null,
		sessionId: "s-1",
		sessionName: "改动面板",
		sessionFile: "/Users/me/.cornfield/agent/sessions/by-date/2026-09-16/143205__a1b2c3d4.jsonl",
		attachmentAddress: SESSION_ADDRESS,
		messages: [],
		messageEntryIds: {},
		isStreaming: false,
		activeToolNames: [],
		queued: 0,
		todo: [],
		flags: { autoCompaction: false, autoRetry: false },
		agents: [HR_AGENT, CODING_AGENT],
		env: null,
		activeAgentId: "hr",
		historyLoading: false,
		sessionTreeLoading: false,
		agentTodosPending: false,
		gitChangesPending: false,
		projects: [],
		projectsPending: false,
		...patch,
	};
	return currentView;
}

function render(patch: Partial<SessionView>): string {
	viewOf(patch);
	return renderToStaticMarkup(createElement(ChangesPanel, { onOpenFile: () => undefined }));
}

describe("ChangesPanel 本会话组的 wire 身份 = 会话身份（不是 Agent 名）", () => {
	it("读与开用的是同一个值：附件地址；agentId 只用于归属展示", () => {
		const [root] = changesGroupsOf(viewOf({}), new Map());
		// 屏幕上这个 Agent 叫 hr，但它绑了 Project：wire 定向必须是地址，不是 "hr"
		expect(root?.agentId).toBe("hr");
		expect(root?.wireTarget).toEqual({ kind: "session", address: SESSION_ADDRESS });
		expect(fileOpenTargetOf(root!, "src/a.ts").attachmentAddress).toBe(SESSION_ADDRESS);
		expect(fileOpenTargetOf(root!, "src/a.ts").attachmentAddress).not.toBe("hr");
	});

	it("点开一条改动带的 wire 目标就是这个地址，归属带动的是那个 Agent", () => {
		const [root] = changesGroupsOf(viewOf({}), new Map());
		expect(fileOpenTargetOf(root!, "src/a.ts")).toEqual({
			attachmentAddress: SESSION_ADDRESS,
			agentId: "hr",
			path: "src/a.ts",
		});
	});

	it("子会话组没有附件地址可用：继续用 Agent 名，并且类型上就说清了它不是附件地址", () => {
		const groups = changesGroupsOf(viewOf({ sessionTree: TREE }), new Map());
		const child = groups[1];
		expect(child?.agentId).toBe("coding");
		expect(child?.wireTarget).toEqual({ kind: "agent", agentName: "coding" });
		expect(fileOpenTargetOf(child!, "src/a.ts").attachmentAddress).toBe("coding");
	});

	it("还没收到快照（地址为空串）→ 不冒充任何根，说等待挂载", () => {
		const html = render({ attachmentAddress: "" });
		expect(html).toContain("等待会话挂载");
		expect(html).not.toContain("工作区没有改动");
	});
});

describe("ChangesPanel 三种「没有」分开显示", () => {
	it("未连接 → 说未连接，不说没有改动", () => {
		const html = render({ connected: false });
		expect(html).toContain("未连接——读不到工作区改动");
		expect(html).not.toContain("工作区没有改动");
	});

	it("连接上了但没有挂载 Agent → 说等待挂载，不拿别的 Agent 的仓库顶上", () => {
		const html = render({ activeAgentId: undefined, agents: [] });
		expect(html).toContain("等待会话挂载");
		expect(html).not.toContain("工作区没有改动");
	});

	it("还没读出来（pending）→ 说读取中，不说没有改动", () => {
		const html = render({ gitChangesPending: true });
		expect(html).toContain("读取中");
		expect(html).not.toContain("工作区没有改动");
	});

	it("读取结束了但既没有清单也没有错误 → 说状态未知，不得留一张空白卡片", () => {
		// 这是 store 不该产出的组合（session-store 只在同一步里同时落 data 或 error），
		// 但类型上可表达：面板不能靠「不是 pending、不是 error」反推出一条清单。
		const html = render({ gitChangesPending: false, gitChanges: undefined, gitChangesError: undefined });
		expect(html).toContain("改动状态未知：既没有读到清单，也没有报错");
		expect(html).not.toContain("工作区没有改动");
		expect(html).not.toContain("读取中");
		expect(html).not.toContain("读不到改动");
	});

	it("读失败 → 原文照显 + 重试，不说没有改动", () => {
		const html = render({ gitChangesPending: false, gitChangesError: "not a git repository" });
		expect(html).toContain("读不到改动：not a git repository");
		expect(html).not.toContain("工作区没有改动");
	});

	it("读到了且确实没有改动 → 才说没有改动，并写明读的是哪个仓库", () => {
		const html = render({ gitChanges: { repoRoot: REPO_ROOT, changes: [] } });
		expect(html).toContain("工作区没有改动");
		expect(html).toContain(REPO_ROOT);
		expect(html).not.toContain("读不到改动");
	});

	it("降级清单（error 非空）→ 既显示改动、也说清单可能不完整", () => {
		const html = render({
			gitChanges: { ...CHANGES, changes: [change({ path: "a.ts" })], error: "未跟踪文件枚举被截断" },
		});
		expect(html).toContain("清单可能不完整：未跟踪文件枚举被截断");
		expect(html).toContain("a.ts");
		expect(html).not.toContain("工作区没有改动");
	});
});

describe("ChangesPanel 改动清单", () => {
	it("每条改动给出真实路径与两个轴的状态", () => {
		const html = render({ gitChanges: CHANGES });
		expect(html).toContain('data-change-path="src/a.ts"');
		expect(html).toContain("暂存 修改");
		expect(html).toContain("工作区 修改");
		expect(html).toContain("工作区 未跟踪");
		expect(html).toContain("暂存 重命名");
		// rename 的来源路径是另一个事实，不能只显示目标路径
		expect(html).toContain("src/old.ts");
		expect(html).toContain("冲突（需人工合并）");
	});

	it("本会话那一组写明读的是哪个 Agent 的工作区", () => {
		const html = render({ gitChanges: CHANGES });
		expect(html).toContain("本会话");
		expect(html).toContain("HR 助手");
	});
	it("子会话组带状态徽标与「切到该 Agent」，账本读不到时明说只列了本会话", () => {
		const html = render({ gitChanges: { repoRoot: REPO_ROOT, changes: [] }, sessionTree: TREE });
		expect(html).toContain("审查 scope 合并");
		expect(html).toContain("运行中");
		expect(html).toContain("切到该 Agent");
		// 静态渲染不跑 effect：子会话那一组还在读，不能说它没有改动
		expect(html).toContain("读取中");

		const failedLedger = render({ gitChanges: { repoRoot: REPO_ROOT, changes: [] }, sessionTreeError: "账本读不到" });
		expect(failedLedger).toContain("子会话账本读不到：账本读不到");
		expect(failedLedger).toContain("这里只列了本会话的改动");
	});
});

describe("changesGroupsOf", () => {
	const ready = (data: GitChangesDto): ChangesReadState => ({ status: "ready", data });

	it("本会话一组的来源是焦点 Agent，状态按 pending → error → ready 判定", () => {
		const [group] = changesGroupsOf(viewOf({ gitChangesPending: true }), new Map());
		expect(group?.kind).toBe("root");
		expect(group?.agentId).toBe("hr");
		expect(group?.subtitle).toBe("HR 助手");
		expect(group?.state.status).toBe("pending");

		// 刷新期间：pending 压过上一个错误（那句说的是上一次读取）
		const [refreshing] = changesGroupsOf(
			viewOf({ gitChangesPending: true, gitChangesError: "上一次的错误" }),
			new Map(),
		);
		expect(refreshing?.state.status).toBe("pending");

		const [failed] = changesGroupsOf(viewOf({ gitChangesError: "boom" }), new Map());
		expect(failed?.state.status).toBe("error");
		expect(failed?.state.error).toBe("boom");

		const [ok] = changesGroupsOf(viewOf({ gitChanges: { repoRoot: REPO_ROOT, changes: [] } }), new Map());
		expect(ok?.state.status).toBe("ready");
		expect(ok?.state.data?.changes).toEqual([]);
	});

	it("未挂载 Agent 时本会话组的来源照实说是未挂载，不编一个 id", () => {
		const [group] = changesGroupsOf(viewOf({ activeAgentId: undefined, agents: [] }), new Map());
		expect(group?.agentId).toBe("");
		expect(group?.subtitle).toBe("会话未挂载");
	});

	it("新连接上没显式切过焦点（activeAgentId 缺省）→ 用与右栏其它页同一处的解析（serve 标的 active）", () => {
		// 这是运行期真实踩到的：拿 view.activeAgentId 当门会把「已经有默认 Agent 在跑」误报成「等待挂载」
		const [group] = changesGroupsOf(viewOf({ activeAgentId: undefined }), new Map());
		expect(group?.agentId).toBe("hr");
		expect(group?.subtitle).toBe("HR 助手");
	});

	it("每个子会话一组，读的是那个子会话的 Agent 工作区", () => {
		const states = new Map<string, ChangesReadState>([["child-1", ready(CHANGES)]]);
		const groups = changesGroupsOf(viewOf({ sessionTree: TREE }), states);
		expect(groups).toHaveLength(2);
		const child = groups[1];
		expect(child?.key).toBe("child-1");
		expect(child?.agentId).toBe("coding");
		expect(child?.title).toBe("审查 scope 合并");
		expect(child?.subtitle.startsWith("编码助手 · ")).toBe(true);
		expect(child?.statusLabel).toBe("运行中");
		expect(child?.state.data?.repoRoot).toBe(REPO_ROOT);
	});

	it("子会话那组没读过 → pending（不是「没有改动」）", () => {
		const groups = changesGroupsOf(viewOf({ sessionTree: TREE }), new Map());
		expect(groups[1]?.state.status).toBe("pending");
	});

	it("子会话那组读失败 → 只有它自己是 error", () => {
		const states = new Map<string, ChangesReadState>([["child-1", { status: "error", error: "git 失败" }]]);
		const groups = changesGroupsOf(
			viewOf({ sessionTree: TREE, gitChanges: { repoRoot: REPO_ROOT, changes: [] } }),
			states,
		);
		expect(groups[0]?.state.status).toBe("ready");
		expect(groups[1]?.state.status).toBe("error");
		expect(groups[1]?.state.error).toBe("git 失败");
	});

	it("子会话标题回退链与左栏会话树同源（目标 → 用途标签 → 短 id）", () => {
		const bare: ChildSessionNodeDto = { ...CHILD, objective: undefined, delegationRole: undefined };
		const groups = changesGroupsOf(viewOf({ sessionTree: { ...TREE, children: [bare] } }), new Map());
		expect(groups[1]?.title).toBe("child-1".slice(0, 8));
		expect(changesGroupsOf(viewOf({ sessionTree: undefined }), new Map())).toHaveLength(1);
	});
});

describe("changeBadgesOf", () => {
	it("两轴各自成一条（porcelain 的 X / Y 是两个事实）", () => {
		expect(changeBadgesOf(change({ path: "a.ts", index: "modified", worktree: "modified" }))).toEqual([
			{ axis: "暂存", label: "修改" },
			{ axis: "工作区", label: "修改" },
		]);
	});

	it("未跟踪只在工作区轴上有值", () => {
		expect(changeBadgesOf(change({ path: "a.ts", index: null, worktree: "untracked" }))).toEqual([
			{ axis: "工作区", label: "未跟踪" },
		]);
	});

	it("冲突两轴都报 → 只出一条「需人工合并」，不替 git 拆成索引侧/工作区侧", () => {
		expect(changeBadgesOf(change({ path: "a.ts", index: "conflicted", worktree: "conflicted" }))).toEqual([
			{ label: "冲突（需人工合并）", danger: true },
		]);
	});

	it("两轴都干净（理论上的空行）→ 不编状态，只显示路径", () => {
		expect(changeBadgesOf(change({ path: "a.ts", index: null, worktree: null }))).toEqual([]);
	});
});
