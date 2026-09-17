import { afterAll, describe, expect, it, spyOn } from "bun:test";
import type { AgentInfoDto } from "@cornfield/wire";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HomeView } from "../src/pages/home/HomeView";
import {
	AGENT_SECTION_TITLE,
	composerPlaceholder,
	envSummaryText,
	shouldSubmitOnEnter,
} from "../src/pages/home/home-logic";
import type { SessionView } from "../src/state/session-store";
import * as sessionStoreModule from "../src/state/session-store";
import * as useSessionModule from "../src/state/use-session";

/**
 * 首页「真实性」回归（T4）。
 *
 * 纯函数三件（组合态判据 / 占位文案 / 环境摘要行）直接钉死；标题与摘要行用静态渲染
 * （react-dom/server，不需要 DOM）验首页真的写的是什么字 —— 不冒充「最近活跃」、不渲染空的
 * 「—」摘要、不写死不存在的 agent 名。
 *
 * 依赖替换用 `spyOn` 打在模块对象上（bun:test 的 `mock.module` 会改全局模块注册表、跨测试文件
 * 泄漏，仓库硬约束禁用），afterAll 还原。
 */

// ── 最小 DOM 垫片（react-router-dom 求值时读 window/history）──
const noop = (): void => {};
(globalThis as { document?: unknown }).document = { defaultView: globalThis };
(globalThis as { window?: unknown }).window = globalThis;
(globalThis as { history?: unknown }).history = {
	state: { idx: 0 },
	length: 1,
	scrollRestoration: "manual",
	pushState: noop,
	replaceState: noop,
	go: noop,
	back: noop,
	forward: noop,
};
(globalThis as { location?: unknown }).location = {
	hash: "",
	pathname: "/",
	search: "",
	origin: "http://localhost",
	href: "http://localhost/",
	assign: noop,
	replace: noop,
	reload: noop,
};

const { MemoryRouter } = await import("react-router-dom");

const HR_AGENT: AgentInfoDto = {
	id: "hr",
	name: "HR 助手",
	face: "H",
	workspace: "hr",
	kind: "worker",
	status: "online",
};

let currentView: SessionView;

const useSessionSpy = spyOn(useSessionModule, "useSession").mockImplementation(() => currentView);
// 静态渲染不跑 effect、不点按钮：store 只需要存在；真被调用就显式失败（不会被静默当成「没数据」）。
const useSessionStoreSpy = spyOn(sessionStoreModule, "useSessionStore").mockImplementation(
	() =>
		({
			connect: () => Promise.reject(new Error("静态渲染不应 connect")),
			fsRead: () => Promise.reject(new Error("静态渲染不应 fsRead")),
			refreshProjects: () => Promise.reject(new Error("静态渲染不应 refreshProjects")),
			focusAgent: () => {},
			switchSession: () => {},
			prompt: () => {},
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
		sessionName: "首页冒烟",
		sessionFile: "/Users/me/.cornfield/agent/sessions/by-date/2026-09-17/143205__a1b2c3d4.jsonl",
		attachmentAddress: "hr",
		messages: [],
		messageEntryIds: {},
		isStreaming: false,
		activeToolNames: [],
		queued: 0,
		todo: [],
		flags: { autoCompaction: false, autoRetry: false },
		agents: [],
		env: null,
		activeAgentId: "hr",
		activeWorkspace: "mika",
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

function renderHome(patch: Partial<SessionView>): string {
	viewOf(patch);
	return renderToStaticMarkup(createElement(MemoryRouter, null, createElement(HomeView)));
}

// ── 输入法组合态判据 ────────────────────────────────────────────────

describe("输入法组合态判据", () => {
	it("Enter 且非组合态 → 发送", () => {
		expect(shouldSubmitOnEnter("Enter", false)).toBe(true);
	});

	it("Enter 但处于 IME 组合态（选词确认）→ 不发送", () => {
		expect(shouldSubmitOnEnter("Enter", true)).toBe(false);
	});

	it("非 Enter 键 → 不发送", () => {
		expect(shouldSubmitOnEnter("a", false)).toBe(false);
		expect(shouldSubmitOnEnter(" ", false)).toBe(false);
		expect(shouldSubmitOnEnter("Shift", false)).toBe(false);
	});
});

// ── 占位文案不写死不存在的 agent 名 ─────────────────────────────────

describe("占位文案不写死不存在的 agent 名", () => {
	it("有焦点 Agent 用其名", () => {
		expect(composerPlaceholder("HR 助手")).toBe("给 HR 助手 发一条指令…");
	});

	it("无焦点 Agent 用通用文案，不出现硬编码名字", () => {
		const placeholder = composerPlaceholder(undefined);
		expect(placeholder).toBe("发一条指令…");
		expect(placeholder).not.toContain("研发助手");
	});
});

// ── 环境摘要行无空字段 ─────────────────────────────────────────────

describe("环境摘要行无空字段", () => {
	it("字段齐全时全部拼出", () => {
		expect(envSummaryText({ repos: "cornfield", branch: "main", activeAgentCount: 2, pendingCronCount: 3 })).toBe(
			"cornfield · main · 2 agent 运行中 · 3 定时任务待执行",
		);
	});

	it("空分支被跳过，不产生空字段", () => {
		const text = envSummaryText({ repos: "cornfield", branch: "", activeAgentCount: 1, pendingCronCount: 0 });
		expect(text).toBe("cornfield · 1 agent 运行中");
		expect(text).not.toContain("· ·");
	});

	it("serve 报不出的 0 定时任务不硬编成「0 定时任务待执行」", () => {
		const text = envSummaryText({ repos: "cornfield", branch: "main", activeAgentCount: 5, pendingCronCount: 0 });
		expect(text).not.toContain("定时任务");
	});
});

// ── Agent 区块标题与摘要行（静态渲染）───────────────────────────────

describe("Agent 区块标题与摘要行", () => {
	it("标题是「Agent」而不是「最近活跃」", () => {
		expect(AGENT_SECTION_TITLE).toBe("Agent");
		const html = renderHome({ agents: [HR_AGENT] });
		expect(html).not.toContain("最近活跃");
		expect(html).toContain('uppercase">Agent</div>');
	});

	it("卡片不再渲染空的「—」摘要行（lastAction 无值时不显示占位）", () => {
		const html = renderHome({ agents: [HR_AGENT], activeWorkspace: "mika" });
		expect(html).not.toContain("—</span>");
	});

	it("无焦点 Agent 时占位文案不含硬编码名字", () => {
		const html = renderHome({ agents: [] });
		expect(html).not.toContain("研发助手");
	});
});
