import { afterAll, describe, expect, it, spyOn } from "bun:test";
import type { AgentInfoDto, ProjectRecordDto } from "@cornfield/wire";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionView } from "../../state/session-store";
import * as sessionStoreModule from "../../state/session-store";
import * as useSessionModule from "../../state/use-session";
import { InsightsView } from "./InsightsView";

/**
 * 用量页的渲染冒烟测试（react-dom/server，不需要 DOM）。
 *
 * 覆盖的是「不能顶替的状态」在屏上到底写了什么：未连接 / Project 计算中 / Project 读失败 /
 * 会话不在索引里 / stats 还没到。这些分支一旦写错，用户看到的就是一句替未知答案发言的假话。
 *
 * 只做静态渲染（effect 不跑），所以依赖 effect 的数据（stats 行、技能/记忆）不在这里覆盖 ——
 * 它们由 insights-scope.test.ts 的纯函数测试与 store 的真实读面负责。
 *
 * 依赖替换用 `spyOn` 打在模块对象上（bun:test 的 `mock.module` 会改全局模块注册表、跨测试文件泄漏，
 * 仓库硬约束禁用），afterAll 还原。
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

const PROJECT: ProjectRecordDto = {
	projectId: "p-mika",
	root: "/Users/me/work/mika",
	name: "米克原子",
};

let currentView: SessionView;

const useSessionSpy = spyOn(useSessionModule, "useSession").mockImplementation(() => currentView);
// 静态渲染不跑 effect，所以只要求 store 存在且形状够用（真调用会在这里显式失败）。
const useSessionStoreSpy = spyOn(sessionStoreModule, "useSessionStore").mockImplementation(
	() =>
		({
			fetchStats: () => Promise.reject(new Error("静态渲染不应请求 stats")),
			listSessions: () => Promise.reject(new Error("静态渲染不应请求会话索引")),
			fetchSkills: () => Promise.reject(new Error("静态渲染不应请求技能")),
			fetchMemory: () => Promise.reject(new Error("静态渲染不应请求记忆")),
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
		sessionName: "修 scope 面板",
		sessionFile:
			"/Users/me/.cornfield/agent/sessions/--Users--me--work--mika/by-date/2026-09-15/143205__a1b2c3d4.jsonl",
		attachmentAddress: "hr",
		messages: [],
		messageEntryIds: {},
		isStreaming: false,
		activeToolNames: [],
		queued: 0,
		todo: [],
		flags: { autoCompaction: false, autoRetry: false },
		agents: [HR_AGENT],
		env: null,
		activeAgentId: "hr",
		historyLoading: false,
		sessionTreeLoading: false,
		agentTodosPending: false,
		gitChangesPending: false,
		projects: [PROJECT],
		currentProjectId: PROJECT.projectId,
		projectsPending: false,
		...patch,
	};
	return currentView;
}

function render(patch: Partial<SessionView>): string {
	viewOf(patch);
	return renderToStaticMarkup(createElement(InsightsView));
}

describe("InsightsView scope 锚点", () => {
	it("Agent / Project / Session 三个锚点都渲染出真值", () => {
		const html = render({});
		expect(html).toContain("HR 助手");
		expect(html).toContain("米克原子");
		expect(html).toContain(PROJECT.root);
		expect(html).toContain("修 scope 面板");
	});

	it("未连接 → 整页空态，不显示 0 也不显示 scope 区块", () => {
		const html = render({ connected: false });
		expect(html).toContain("未连接——用量统计不可用");
		expect(html).not.toContain("当前 scope");
	});

	it("没有活动 Agent 时明说没有，不拿第一个 Agent 顶替", () => {
		const html = render({ agents: [], activeAgentId: undefined, sessionId: "" });
		expect(html).toContain("无活动 Agent");
	});

	it("没有会话身份 → Session 锚点显示无活动会话", () => {
		const html = render({ sessionFile: undefined, sessionName: undefined, sessionId: "" });
		expect(html).toContain("无活动会话");
	});
});

describe("InsightsView 的未知状态不被顶替", () => {
	it("projectsPending → 「计算中」，不显示「未归属」", () => {
		const html = render({ projectsPending: true, currentProjectId: undefined, projects: undefined });
		expect(html).toContain("计算中");
		expect(html).toContain("Project 归属尚未算出来（不是「未归属」）");
		expect(html).not.toContain(">未归属<");
	});

	it("registry 还没读到（projects 缺省且不 pending）→ 「未读到」，不显示「未归属」", () => {
		const html = render({ projects: undefined, currentProjectId: undefined });
		expect(html).toContain("未读到");
		expect(html).not.toContain(">未归属<");
	});

	it("projectsError → 显示读取失败原因", () => {
		const html = render({ projectsError: "projects.json 解析失败", projects: undefined });
		expect(html).toContain("读取失败");
		expect(html).toContain("projects.json 解析失败");
	});

	it("registry 读到了但**没问过**归属 → 「未问到」，不说「未归属」（那是一个还没得到的答案）", () => {
		const html = render({ currentProjectId: undefined });
		expect(html).toContain(">未问到<");
		expect(html).not.toContain(">未归属<");
	});

	it("serve 答过「没有任何东西声明过」（source: none）→ 才显示「未归属」", () => {
		const html = render({ currentProjectId: undefined, currentProjectSource: "none" });
		expect(html).toContain(">未归属<");
		expect(html).not.toContain(">未问到<");
	});

	it("归属来源照实说：会话记录 / 按目录匹配不是一个可信度", () => {
		expect(render({ currentProjectSource: "session" })).toContain("来源：会话记录");
		expect(render({ currentProjectSource: "cwd" })).toContain("来源：按目录匹配（旧会话回落）");
	});

	it("stats 还没到 → 分区与目录级数字都说「加载中」，不冒充「没有数据」", () => {
		const html = render({});
		expect(html).toContain("用量统计加载中——分区需要 stats byFolder");
		expect(html).not.toContain("该时段没有目录级行");
		// 静态渲染不跑 effect：会话索引还没加载 → 不能说「不在索引里」（那是另一个结论）
		expect(html).toContain("会话索引未加载");
		expect(html).not.toContain("该会话不在索引里");
		expect(html).toContain("“没读到”不是“不在索引里”");
	});

	it("学习面在数据未到时说「尚未读取」，不显示 0 计数", () => {
		const html = render({});
		expect(html).toContain("学习面");
		expect(html).toContain("尚未读取");
		expect(html).not.toContain("已加载 0");
	});
});
