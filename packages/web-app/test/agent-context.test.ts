import { describe, expect, it } from "bun:test";
import { activeAgentIdOf, activeAgentOf } from "../src/state/agent-context";
import type { SessionView } from "../src/state/session-store";

/**
 * T8：焦点 Agent 的解析优先级。
 *
 * 这是「不同 Agent 不混入主流」的前置条件：会话树、右栏文件、首页快速会话都靠它决定
 * 「当前是谁」。它一旦回错人，界面就会把一个 Agent 的上下文挂在另一个 Agent 名下。
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

	it("没有显式焦点时用 serve 推来的焦点（sessionId 就是 agent 注册名）", () => {
		expect(activeAgentIdOf(viewOf({ sessionId: "hr", agents }))).toBe("hr");
	});

	it("serve 焦点未到时才回落到列表猜测（active > attached > 第一个）", () => {
		expect(activeAgentIdOf(viewOf({ agents: [{ ...agents[0]!, active: true }, agents[1]!] }))).toBe("default");
		expect(activeAgentIdOf(viewOf({ agents: [{ ...agents[0]!, attached: true }, agents[1]!] }))).toBe("default");
		expect(activeAgentIdOf(viewOf({ agents }))).toBe("default");
	});

	it("没有任何 Agent 时是 undefined，不编一个出来", () => {
		expect(activeAgentIdOf(viewOf({}))).toBeUndefined();
	});

	it("activeAgentOf 返回同一个人的元数据", () => {
		expect(activeAgentOf(viewOf({ sessionId: "hr", agents }))?.name).toBe("HR");
		expect(activeAgentOf(viewOf({ sessionId: "gone", agents }))).toBeUndefined();
	});
});
