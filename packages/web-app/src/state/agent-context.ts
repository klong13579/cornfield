import type { AgentInfoDto } from "@cornfield/wire";
import type { SessionView } from "./session-store";

/**
 * 当前焦点 Agent 的解析（会话工作台、右栏、首页共用一处）。
 *
 * 优先级：本连接显式切过的焦点 > serve 推来的焦点（`sessionId` 就是 agent 注册名）>
 * 列表里标了 active / 已 attach 的 > 第一个。把 serve 推来的焦点排在列表猜测前面，是
 * 因为「屏幕上写着哪个 Agent」必须与「serve 会把这条消息发给谁」一致：猜错就是替另一个
 * Agent 发言。
 *
 * 放在一个函数里而不是各处手写，是因为「哪个 Agent 在工作」是这一屏所有面板的共同前提：
 * 两处解析不一致时，会话树会读一个 Agent、转录区显示另一个。
 */
export function activeAgentIdOf(view: SessionView): string | undefined {
	return (
		view.activeAgentId ??
		(view.sessionId || undefined) ??
		view.agents.find(a => a.active)?.id ??
		view.agents.find(a => a.attached)?.id ??
		view.agents[0]?.id
	);
}

/** 当前焦点 Agent 的元数据（未连接 / 无注册 Agent 时 undefined）。 */
export function activeAgentOf(view: SessionView): AgentInfoDto | undefined {
	const id = activeAgentIdOf(view);
	return id === undefined ? undefined : view.agents.find(a => a.id === id);
}
