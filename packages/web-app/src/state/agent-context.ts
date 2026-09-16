import type { AgentInfoDto } from "@cornfield/wire";
import type { SessionView } from "./session-store";

/**
 * 当前焦点 Agent 的解析（会话工作台、右栏、首页共用一处）。
 *
 * 优先级：本连接显式切过的焦点 > 列表里 serve 标为 active 的那个 > 已 attach 的 > 第一个。
 *
 * **`view.sessionId` 不在其中**：它是**会话 id**（serve 快照 payload 的 `session.sessionId`，
 * 一串 UUID），不是 agent 名。把它当 agent 去调 fs_list/fs_read/config 定向命令，serve 只会回
 * `unknown agent: <uuid>` —— 工作台右栏的文件树在新连接上曾经因此整片报错。
 *
 * 放在一个函数里而不是各处手写，是因为「哪个 Agent 在工作」是这一屏所有面板的共同前提：
 * 两处解析不一致时，会话树会读一个 Agent、转录区显示另一个。
 */

/**
 * 解析焦点 Agent 所需的最小视图面。
 *
 * 声明成「真正读到的字段」而不是 SessionView：调用方不必为了问一句「现在是谁」
 * 去造一份完整会话视图（测试里的假视图源也一样）。SessionView 结构上满足它。
 */
export type AgentFocusSource = Pick<SessionView, "activeAgentId" | "agents">;

export function activeAgentIdOf(view: AgentFocusSource): string | undefined {
	return (
		view.activeAgentId ??
		view.agents.find(a => a.active)?.id ??
		view.agents.find(a => a.attached)?.id ??
		view.agents[0]?.id
	);
}

/** 当前焦点 Agent 的元数据（未连接 / 无注册 Agent 时 undefined）。 */
export function activeAgentOf(view: AgentFocusSource): AgentInfoDto | undefined {
	const id = activeAgentIdOf(view);
	return id === undefined ? undefined : view.agents.find(a => a.id === id);
}
