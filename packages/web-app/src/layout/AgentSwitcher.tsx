import { Bot } from "lucide-react";
import { activeAgentIdOf, activeAgentOf } from "../state/agent-context";
import type { SessionView } from "../state/session-store";

/**
 * AgentSwitcher —— 「本连接现在由哪个 Agent 服务」的选择器（唯一实现）。
 *
 * 切 Agent 不是前端滤镜：attach + switch_session 要一起做（store.focusAgent），
 * serve 侧焦点真的跟着切，随后推来那个 Agent 的权威快照。所以这里只报「选了谁」，
 * 切换语义留在 store 一处 —— 之前首页内联一个 <select>、工作台摆一个只读 chip，
 * 两个入口迟早对「屏幕上写着谁」给出不同答案。
 *
 * 四种「没有」分开渲染，它们不是一回事：
 *   未连接（没有服务可切）/ 注册表里一个 Agent 都没有（去 Agent 管理建）/
 *   焦点不在注册表里（serve 的焦点不是注册名，或 agent 被删）/ 都有。
 * 最后一种原样摆出 id 是错的：serve 的焦点可能是 36 字符的会话 uuid，当选项文字会把
 * 顶栏挤爆（实测 summary 被压成 75px 高的竖排）。占位文案 + title 里的原样 id。
 *
 * 布局上 shrink-0 + whitespace-nowrap：顶栏是 flex 行，控件被挤窄时会变成竖排字。
 */
export function AgentSwitcher({
	view,
	onSelect,
}: {
	view: SessionView;
	/** 选中某个 Agent（调用方接 store.focusAgent）。 */
	onSelect: (agentId: string) => void;
}): React.JSX.Element {
	const current = activeAgentIdOf(view);
	const focused = activeAgentOf(view);
	const registered = current !== undefined && focused !== undefined;

	/** 没有可选中的当前项时的说明（undefined = 当前项就是注册表里的某个 Agent）。 */
	const placeholder = !view.connected
		? "未连接"
		: view.agents.length === 0
			? "未注册 Agent"
			: registered
				? undefined
				: "焦点未注册";

	const title =
		current !== undefined && !registered
			? `当前焦点不在 Agent 注册表里：${current}`
			: focused
				? `服务当前会话的 Agent · ${focused.agentDir ?? focused.id}`
				: "服务当前会话的 Agent";

	return (
		<label className="chip shrink-0 whitespace-nowrap" title={title}>
			<Bot size={13} strokeWidth={1.5} />
			<select
				aria-label="切换 Agent"
				value={placeholder === undefined ? (current ?? "") : ""}
				disabled={!view.connected || view.agents.length === 0}
				onChange={e => {
					if (e.target.value) onSelect(e.target.value);
				}}
			>
				{placeholder !== undefined && <option value="">{placeholder}</option>}
				{view.agents.map(agent => (
					<option key={agent.id} value={agent.id}>
						{agent.name}
						{agent.status === "online" ? "" : `（${agent.status}）`}
					</option>
				))}
			</select>
		</label>
	);
}
