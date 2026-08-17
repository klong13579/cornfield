import { PAGE_META } from "../../router";

/** 未落地页占位（P3/P4 阶段实现），展示 meta 覆盖协议。 */
export function PlaceholderView({ pageId }: { pageId: string }): React.JSX.Element {
	const meta = PAGE_META.find(p => p.id === pageId);
	return (
		<div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 px-8">
			<div className="text-[32px] font-semibold tracking-[-0.8px] text-ink">{meta?.name ?? pageId}</div>
			<p className="max-w-md text-center text-[13px] text-ink-subtle">
				页面结构随对应里程碑落地（TODO）：
				{pageId === "agents" && "P3 多 Agent 平台 — server 侧多会话 POC 稳定后接入"}
				{pageId === "records" &&
					"P4 会话记录 / 回放 — get_messages / get_session_stats / get_branch_messages 就绪后接入"}
				{pageId === "voice" && "P4 Voice / Jarvis — Web Speech API + prompt 闭环"}
			</p>
			<div className="mt-2 flex flex-wrap items-center justify-center gap-1.5">
				{meta?.protocol.map(cmd => (
					<span
						key={cmd}
						className="rounded border border-hairline bg-surface-2 px-2 py-0.5 font-mono text-[10px] text-ink-faint"
					>
						{cmd}
					</span>
				))}
			</div>
		</div>
	);
}
