import { ArrowRight } from "lucide-react";
import { Link } from "react-router-dom";
import { useSessionStore } from "../../state/session-store";
import { useUiState } from "../../state/ui-store";
import { useSession } from "../../state/use-session";
import { ContentPreview } from "./ContentPreview";

/**
 * 右栏：会话概览 / 上下文 / 会话 Todo（+ 内容预览置顶）。
 * 移动端（<lg）隐藏 —— 走 /m 或 DevicePreview 的浮层形态（P5 完善）。
 */
export function SidePanel(): React.JSX.Element {
	const view = useSession();
	const store = useSessionStore();
	const ui = useUiState();

	const phaseLabel = view.phase === "idle" ? "idle" : view.phase;
	// W5：真实 agent（快照 sessionId 对应注册表项；未匹配则取列表首个）
	const activeAgent = view.agents.find(a => a.id === view.sessionId) ?? view.agents[0];
	const todoTotal = view.todo.reduce((sum, p) => sum + p.tasks.length, 0);

	return (
		<aside className="flex min-h-0 w-full flex-col overflow-y-auto border-l border-hairline bg-surface">
			{ui.contentPreview && <ContentPreview preview={ui.contentPreview} />}

			<section className="border-b border-hairline px-4 py-3.5">
				<h3 className="mb-2.5 text-[11px] font-semibold tracking-[0.08em] text-ink-faint uppercase">会话概览</h3>
				<div className="flex flex-col gap-1.5">
					<OverviewRow k="阶段" v={phaseLabel} active />
					<OverviewRow
						k="Agent"
						v={activeAgent?.name ?? "未连接"}
						tag={activeAgent ? (activeAgent.kind === "coding" ? "CODING" : "WORKER") : undefined}
					/>
					<OverviewRow k="模型" v={view.model ?? "—"} mono />
					<OverviewRow k="thinking" v={view.thinkingLevel ?? "off"} mono />
					<OverviewRow k="会话" v={shortId(view.sessionId)} mono />
				</div>
			</section>

			{view.context && (
				<section className="border-b border-hairline px-4 py-3.5">
					<h3 className="mb-2.5 text-[11px] font-semibold tracking-[0.08em] text-ink-faint uppercase">上下文</h3>{" "}
					<div className="h-[3px] overflow-hidden rounded bg-surface-3">
						<div className="h-full rounded bg-accent" style={{ width: `${view.context.percent}%` }} />
					</div>
					<div className="mt-1 flex justify-between text-[12px] text-ink-subtle">
						<span>
							{fmtTokens(view.context.usedTokens)} / {fmtTokens(view.context.totalTokens)} tokens
						</span>
						<span>{view.context.percent}%</span>
					</div>
					<div className="mt-0.5 flex justify-between text-[11px] text-ink-faint">
						<span>{view.messages.length} 条消息</span>
						<span>{view.context.lastCompaction ? `上次压缩 ${view.context.lastCompaction}` : "上次压缩 —"}</span>
					</div>
				</section>
			)}

			<section className="border-b border-hairline px-4 py-3.5">
				<h3 className="mb-2.5 text-[11px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
					会话 Todo · {todoTotal}
				</h3>
				{view.todo.flatMap(phase =>
					phase.tasks.map((task, i) => (
						<button
							key={`${phase.name}-${task.content}`}
							type="button"
							className={`flex w-full items-start gap-2 px-0.5 py-1 text-left text-[13px] ${task.status === "completed" ? "text-ink-faint line-through" : "text-ink-muted"}`}
							onClick={() => store.toggleTodo(phase.name, i)}
						>
							<input
								type="checkbox"
								checked={task.status === "completed"}
								readOnly
								className="mt-[3px] h-3.5 w-3.5 shrink-0 cursor-pointer accent-[var(--color-accent)]"
							/>
							<span className="break-all">{task.content}</span>
						</button>
					)),
				)}
				<Link
					to="/todo"
					className="mt-2.5 inline-flex items-center gap-1.5 text-[12px] text-accent no-underline hover:underline"
				>
					查看全局任务板
					<ArrowRight size={11} strokeWidth={1.5} />
				</Link>
			</section>
		</aside>
	);
}

function OverviewRow({
	k,
	v,
	tag,
	mono,
	active = false,
}: {
	k: string;
	v: string;
	tag?: string;
	mono?: boolean;
	active?: boolean;
}): React.JSX.Element {
	return (
		<div className="flex items-center gap-2 text-[13px]">
			<span className="w-[62px] shrink-0 text-[12px] text-ink-subtle">{k}</span>
			{active && <span className="spin ml-auto" />}
			<span
				className={`ml-auto flex items-center gap-1.5 text-right text-ink ${mono ? "font-mono text-[11px]" : ""}`}
			>
				{v}
				{tag && <span className="font-mono text-[9px] tracking-wide text-ink-faint">{tag}</span>}
			</span>
		</div>
	);
}

function shortId(id: string): string {
	if (!id) return "—";
	return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id;
}

function fmtTokens(n: number): string {
	if (n >= 1000) return `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}K`;
	return String(n);
}
