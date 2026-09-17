import { afterAll, describe, expect, it, spyOn } from "bun:test";
import type { AgentInfoDto } from "@cornfield/wire";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { GatewayStatusDto } from "../src/lib/pi-client-api";
import { AgentDetailView, DingtalkView } from "../src/pages/agents/AgentDetailView";
import { AgentsView } from "../src/pages/agents/AgentsView";
import { agentStatusDisplay, isAccountStopped } from "../src/pages/agents/agent-status";
import type { SessionView } from "../src/state/session-store";
import * as sessionStoreModule from "../src/state/session-store";
import * as useSessionModule from "../src/state/use-session";

/**
 * 票 08 的「一致结论」回归：列表与详情共用 `agentStatusDisplay`，同一 agent 两处同词同色；
 * 筛选桶与卡片同一套词；未知深链不借焦点模型徽标；钉钉开关有无障碍态（aria-label + aria-checked）。
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

// ── 共享状态判定（票 08 判据 ①②）──
describe("agentStatusDisplay / isAccountStopped", () => {
	const GATEWAY_RUNNING: GatewayStatusDto = { stale: false, accounts: [{ accountId: "hr" }] };
	const STOPPED_MCODE: AgentInfoDto = {
		id: "mcode",
		name: "mcode",
		face: "m",
		workspace: "coding",
		kind: "worker",
		status: "idle",
		dingtalk: { enabled: false },
	};

	it("gateway 账号停用优先覆盖 serve 快照：mcode（serve idle）→ 已停用/红点", () => {
		const d = agentStatusDisplay(STOPPED_MCODE, GATEWAY_RUNNING);
		expect(d.key).toBe("disabled");
		expect(d.label).toBe("已停用");
		expect(d.dotClass).toBe("bg-danger");
	});

	it("gateway 未运行 / 状态陈旧 → 不覆盖，按 serve 快照", () => {
		expect(agentStatusDisplay(STOPPED_MCODE, null)).toMatchObject({ key: "idle", label: "空闲" });
		expect(agentStatusDisplay(STOPPED_MCODE, { stale: true, accounts: [] })).toMatchObject({
			key: "idle",
			label: "空闲",
		});
	});

	it("serve 四态翻译：online/busy/idle/stopped 各一词", () => {
		const base: AgentInfoDto = { id: "a", name: "a", face: "a", workspace: "x", kind: "worker", status: "idle" };
		expect(agentStatusDisplay({ ...base, status: "online" }, null).label).toBe("运行中");
		expect(agentStatusDisplay({ ...base, status: "busy" }, null).label).toBe("执行中");
		expect(agentStatusDisplay({ ...base, status: "idle" }, null).label).toBe("空闲");
		expect(agentStatusDisplay({ ...base, status: "stopped" }, null)).toMatchObject({
			key: "unmounted",
			label: "未挂载",
		});
	});

	it("isAccountStopped：未绑钉钉 / 账号在表 / 账号不在表 / null 状态", () => {
		const local: AgentInfoDto = {
			id: "default",
			name: "default",
			face: "d",
			workspace: "default",
			kind: "worker",
			status: "idle",
		};
		expect(isAccountStopped(local, GATEWAY_RUNNING)).toBe(false);
		expect(isAccountStopped(STOPPED_MCODE, GATEWAY_RUNNING)).toBe(true);
		expect(isAccountStopped(STOPPED_MCODE, { stale: false, accounts: [{ accountId: "mcode" }] })).toBe(false);
		expect(isAccountStopped(STOPPED_MCODE, null)).toBe(false);
	});
});

// ── 静态渲染（不跑 effect，只验渲染层写的是什么字）──
let currentView: SessionView;

const useSessionSpy = spyOn(useSessionModule, "useSession").mockImplementation(() => currentView);
const useSessionStoreSpy = spyOn(sessionStoreModule, "useSessionStore").mockImplementation(
	() =>
		({
			fetchAgents: () => Promise.reject(new Error("静态渲染不应拉 agent 列表")),
			gatewayStatus: () => Promise.reject(new Error("静态渲染不应拉 gateway 状态")),
			focusAgent: () => {},
			getHostTools: () => [],
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
		sessionId: "",
		attachmentAddress: "default",
		messages: [],
		messageEntryIds: {},
		isStreaming: false,
		activeToolNames: [],
		queued: 0,
		todo: [],
		flags: { autoCompaction: false, autoRetry: false },
		agents: [],
		env: null,
		historyLoading: false,
		sessionTreeLoading: false,
		agentTodosPending: false,
		gitChangesPending: false,
		projectsPending: false,
		...patch,
	};
	return currentView;
}

describe("筛选桶与卡片文案同词（判据 ②）", () => {
	it("serve 未挂载（stopped）的卡片与「未挂载」筛选桶同词，不再被写成「已停用」", () => {
		const unmounted: AgentInfoDto = {
			id: "x",
			name: "x",
			face: "x",
			workspace: "x",
			kind: "worker",
			status: "stopped",
		};
		viewOf({ agents: [unmounted] });
		const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(AgentsView)));
		// 「未挂载」出现两处：筛选桶 + 卡片状态；「已停用」只出现在筛选桶，卡片不写。
		expect(html.match(/未挂载/g)?.length).toBe(2);
		expect(html.match(/已停用/g)?.length).toBe(1);
	});
});

describe("未知 agent 深链不借用焦点模型徽标（判据 ④）", () => {
	it("未知 agent 的模型徽标是「—」，不回落焦点 agent 的模型", () => {
		viewOf({
			agents: [
				{
					id: "default",
					name: "default",
					face: "d",
					workspace: "default",
					kind: "worker",
					status: "idle",
					model: "deepseek-v4-flash",
				},
			],
			model: "deepseek-v4-flash",
		});
		const html = renderToStaticMarkup(
			createElement(AgentDetailView, { agentId: "does-not-exist", onClose: () => {} }),
		);
		expect(html).toContain("未知 Agent");
		expect(html).toContain('data-testid="agent-model-badge"');
		expect(html).toContain("—");
		expect(html).not.toContain("deepseek-v4-flash");
	});
});

describe("钉钉开关有无障碍态（判据 ⑤）", () => {
	it("「启用」与「隐藏思考块」开关带 aria-label，不靠色块区分", () => {
		viewOf({
			agents: [
				{
					id: "mcode",
					name: "mcode",
					face: "m",
					workspace: "coding",
					kind: "worker",
					status: "idle",
					dingtalk: { enabled: false },
				},
			],
		});
		const html = renderToStaticMarkup(createElement(DingtalkView, { agentId: "mcode" }));
		expect(html).toContain('aria-label="启用钉钉账号：关"');
		expect(html).toContain('aria-label="隐藏思考块：关"');
		expect(html).toContain('role="switch"');
	});
});
