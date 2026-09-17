import { describe, expect, it } from "bun:test";
import { activeAgentIdOf, activeAgentOf } from "../src/state/agent-context";
import type { SessionView } from "../src/state/session-store";

/**
 * T8：焦点 Agent 的解析优先级。
 *
 * 这是「不同 Agent 不混入主流」的前置条件：会话树、右栏文件、首页快速会话都靠它决定
 * 「当前是谁」。它一旦回错人，界面就会把一个 Agent 的上下文挂在另一个 Agent 名下。
 *
 * T9 回归：`view.sessionId` 是**会话 id**（UUID），不是 agent 名。曾经把它当焦点兜底，
 * 结果新连接上右栏文件树拿 UUID 去调 fs_list，serve 回 `unknown agent: <uuid>`。
 */

function viewOf(patch: Partial<SessionView>): SessionView {
	return {
		connected: true,
		reconnecting: false,
		wsUrl: "ws://127.0.0.1:1/ws",
		protocolVersion: 1,
		phase: "idle",
		model: null,
		thinkingLevel: null,
		sessionId: "",
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
		...patch,
	};
}

const agents = [
	{ id: "default", name: "Default", face: "D", workspace: "root", kind: "coding" as const, status: "idle" as const },
	{ id: "hr", name: "HR", face: "H", workspace: "hr", kind: "worker" as const, status: "online" as const },
	{ id: "sw", name: "SW", face: "S", workspace: "sw", kind: "worker" as const, status: "idle" as const },
];

describe("activeAgentIdOf", () => {
	it("显式切过的焦点优先", () => {
		expect(activeAgentIdOf(viewOf({ activeAgentId: "sw", sessionId: "hr", agents }))).toBe("sw");
	});

	it("会话 id 不是 agent id：不拿它兜底（否则定向命令会发给一个不存在的 agent）", () => {
		expect(activeAgentIdOf(viewOf({ sessionId: "01a0a6c5-986c-7000-bf3f-b44f15cce6b2", agents }))).toBe("default");
		expect(activeAgentIdOf(viewOf({ sessionId: "01a0a6c5-986c-7000-bf3f-b44f15cce6b2" }))).toBeUndefined();
	});

	it("serve 焦点未到时回落到列表（active > attached > 第一个）", () => {
		expect(activeAgentIdOf(viewOf({ agents: [{ ...agents[0]!, active: true }, agents[1]!] }))).toBe("default");
		expect(activeAgentIdOf(viewOf({ agents: [{ ...agents[0]!, attached: true }, agents[1]!] }))).toBe("default");
		expect(activeAgentIdOf(viewOf({ agents }))).toBe("default");
	});

	it("没有任何 Agent 时是 undefined，不编一个出来", () => {
		expect(activeAgentIdOf(viewOf({}))).toBeUndefined();
	});

	it("activeAgentOf 返回同一个人的元数据", () => {
		expect(activeAgentOf(viewOf({ activeAgentId: "hr", agents }))?.name).toBe("HR");
		expect(activeAgentOf(viewOf({ activeAgentId: "gone", agents }))).toBeUndefined();
	});
});
