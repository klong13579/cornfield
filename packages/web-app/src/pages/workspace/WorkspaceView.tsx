import type { TodoPhaseDto, TodoStatusDto } from "@cornfield/wire";
import { Folder, Menu, MessagesSquare, PanelRight, Smartphone } from "lucide-react";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { QueueCard } from "../../components/QueueCard";
import { AgentSwitcher } from "../../layout/AgentSwitcher";
import { DevicePreview } from "../../layout/DevicePreview";
import { ProjectSwitcher } from "../../layout/ProjectSwitcher";
import { FloatingCardHost } from "../../render/FloatingCardHost";
import { activeAgentIdOf, activeAgentOf } from "../../state/agent-context";
import type { SessionView } from "../../state/session-store";
import { useSessionStore } from "../../state/session-store";
import { getUiStore, useUiState } from "../../state/ui-store";
import { useSession } from "../../state/use-session";
import { ComposerBar } from "./ComposerBar";
import { EMPTY_NEW_SESSION_DRAFT, NewSessionForm } from "./NewSessionForm";
import { RightPanel } from "./RightPanel";
import { SessionSidebar } from "./SessionSidebar";
import { Transcript } from "./Transcript";

/**
 * 当前计划区域（T15「工作台三件」第二件）。
 *
 * 数据只有一条来源：**本会话自己的** Session Todo（快照 `todoPhases` → `view.todo`）——
 * 它已经在 store 里、已经走 `set_todos` 写回会话，会话结束即结束（§18）。所以这里只是把它画
 * 出来 + 复用现有的切换入口，**不建第二份计划存储**，也不写进 Todo 工作台或 Agent 板：
 * 那是另外两块板子（§9 / §37）。
 */
export type PlanAreaKind = "disconnected" | "waiting" | "empty" | "phases";

export interface PlanArea {
	kind: PlanAreaKind;
	/** 这一态要说的话（`phases` 时为空串）。 */
	label: string;
	phases: TodoPhaseDto[];
}

/**
 * 计划区域现在能说什么。
 *
 * 三件事必须分开：未连接（读不到）、**快照还没到**、确实没有计划。第三件才是答案——`todo`
 * 在快照到位前的缺省是 `[]`，把那个 `[]` 当成「没有计划」就是替一个还没到的答案发言。
 */
export function planAreaOf(view: Pick<SessionView, "connected" | "sessionId" | "todo">): PlanArea {
	if (!view.connected) return { kind: "disconnected", label: "未连接——读不到本会话的计划", phases: [] };
	if (view.sessionId === "") return { kind: "waiting", label: "等待会话快照——此刻还不知道本会话的计划", phases: [] };
	if (view.todo.length === 0) return { kind: "empty", label: "本次会话还没有计划", phases: [] };
	return { kind: "phases", label: "", phases: view.todo };
}

/** 计划进度：完成数 / 总数；放弃单列（放弃不是完成，两者不能相加）。 */
export function planProgressOf(phases: readonly TodoPhaseDto[]): { done: number; total: number; abandoned: number } {
	let done = 0;
	let total = 0;
	let abandoned = 0;
	for (const phase of phases) {
		for (const task of phase.tasks) {
			total += 1;
			if (task.status === "completed") done += 1;
			if (task.status === "abandoned") abandoned += 1;
		}
	}
	return { done, total, abandoned };
}

const PLAN_TASK_MARK: Record<TodoStatusDto, string> = {
	pending: "○",
	in_progress: "◐",
	completed: "✓",
	abandoned: "✕",
};

const PLAN_TASK_CLASS: Record<TodoStatusDto, string> = {
	pending: "text-ink-faint",
	in_progress: "text-warning",
	completed: "text-success",
	abandoned: "text-ink-faint",
};

/**
 * 计划条（受控、无 hook：状态由工作台持有，单测直接调用就能拿到元素树）。
 *
 * 只有 `pending` / `completed` 两态可以点：store 的 `toggleTodo` 就是把这两态来回换，
 * 点一个进行中/已放弃的任务会写出用户没要的那次改写。
 */
export function PlanStrip({
	area,
	onToggle,
}: {
	area: PlanArea;
	onToggle: (phaseName: string, index: number) => void;
}): React.JSX.Element {
	const progress = planProgressOf(area.phases);
	return (
		<section className="mx-auto mb-1 w-full max-w-[760px] rounded-lg border border-hairline bg-surface-2 px-3 py-2">
			<div className="flex items-center gap-2">
				<span className="text-[10.5px] font-semibold tracking-[0.08em] text-ink-faint uppercase">当前计划</span>
				{area.kind === "phases" && (
					<span className="text-[11px] text-ink-faint">
						完成 {progress.done}/{progress.total}
						{progress.abandoned > 0 ? ` · 放弃 ${progress.abandoned}` : ""}
					</span>
				)}
				<span className="flex-1" />
				<span className="text-[11px] text-ink-faint">本会话的 Session Todo</span>
			</div>
			{area.kind !== "phases" ? (
				<div className="mt-1 text-[12px] text-ink-faint">{area.label}</div>
			) : (
				<div className="mt-1 max-h-[160px] overflow-y-auto">
					{area.phases.map(phase => (
						<div key={phase.name} className="mb-1 last:mb-0">
							<div className="text-[11.5px] text-ink-muted">{phase.name}</div>
							{phase.tasks.map((task, index) => {
								const toggleable = task.status === "pending" || task.status === "completed";
								return (
									<button
										key={`${phase.name}-${index}`}
										type="button"
										className="flex w-full items-start gap-1.5 rounded px-1 py-0.5 text-left text-[12px] text-ink hover:bg-surface"
										disabled={!toggleable}
										title={toggleable ? "切换完成状态" : "只有待办 / 已完成可以在这里切换"}
										onClick={() => onToggle(phase.name, index)}
									>
										<span className={PLAN_TASK_CLASS[task.status]}>{PLAN_TASK_MARK[task.status]}</span>
										<span className="min-w-0 flex-1 break-words">{task.content}</span>
									</button>
								);
							})}
						</div>
					))}
				</div>
			)}
		</section>
	);
}

/**
 * 会话工作台（FR-1）：自定义顶栏 + 转录区 + Composer（右栏已按用户决策移除，对话区占满全宽）。
 * 支持 ?q= 直达（Home Composer 跳转带话），一次性消费：自动发送后从 URL 移除 q 参数。
 */
export function WorkspaceView({ compact = false }: { compact?: boolean }): React.JSX.Element {
	const view = useSession();
	const store = useSessionStore();
	const ui = useUiState();
	const [searchParams, setSearchParams] = useSearchParams();
	const initialQuery = (searchParams.get("q") ?? "").trim();
	// 新建会话表单：顶栏那个入口把它打开（不再直接发 new_session——那会跳过「这次要建在哪」）
	const [newSessionOpen, setNewSessionOpen] = useState(false);
	const [newSessionDraft, setNewSessionDraft] = useState(EMPTY_NEW_SESSION_DRAFT);
	const planArea = planAreaOf(view);

	// 顶栏工作区：跟随当前焦点会话/agent 的工作目录短名（cli 会话 = 其打开目录；agent = agentDir）；
	// 未点击/未识别时回落进程仓库（env.repos）
	const activeAgent = activeAgentOf(view);
	const workspaceLabel =
		view.activeWorkspace ??
		(activeAgent?.agentDir
			? activeAgent.agentDir.replace(/\/+$/, "").split("/").pop() || activeAgent.agentDir
			: undefined) ??
		view.env?.repos ??
		"未连接";

	useEffect(() => {
		if (!initialQuery) return;
		// Home ?q= 直达：输入区为空则先放入种子文本（用户可随时改写）；
		// 等待快照就绪后自动发送（仅当用户未改动输入时），随后消费 URL 参数——
		// 防止刷新/回退重复触发，也防止种子文本在清空输入后反复恢复。
		if (!getUiStore().getSnapshot().draft) getUiStore().setDraft(initialQuery);
		const t = setTimeout(() => {
			const draft = getUiStore().getSnapshot().draft;
			if (draft === initialQuery) {
				store.prompt(initialQuery);
				getUiStore().setDraft("");
			}
			setSearchParams(
				prev => {
					const next = new URLSearchParams(prev);
					next.delete("q");
					return next;
				},
				{ replace: true },
			);
		}, 400);
		return () => clearTimeout(t);
	}, [initialQuery, store, setSearchParams]);

	return (
		<div className="flex h-full min-h-0">
			{!compact && <SessionSidebar />}
			<div className="flex min-w-0 flex-1 flex-col">
				{view.commandError && (
					<div className="flex items-center gap-2 border-b border-danger/40 bg-danger/5 px-4 py-1.5 text-[12px] text-danger">
						<span className="flex-1 truncate">{view.commandError}</span>
						<button type="button" className="link" onClick={() => store.clearCommandError()}>
							清除
						</button>
					</div>
				)}
				<header className="flex h-12 shrink-0 items-center gap-3 border-b border-hairline bg-surface px-4.5">
					<button
						type="button"
						className="cbtn shrink-0 lg:hidden"
						onClick={() => getUiStore().setMobileNav(!ui.mobileNavOpen)}
						aria-label="切换会话栏"
					>
						<Menu size={16} strokeWidth={1.5} />
					</button>
					<span className="flex shrink-0 items-center gap-1.5 text-[12px] text-success whitespace-nowrap">
						<span className={`conn-dot ${view.reconnecting ? "reconnecting" : ""}`} />
						{view.reconnecting ? `重连中${view.connectionId ? ` · ${view.connectionId}` : ""}` : "已连接"}
					</span>
					<span className="h-[18px] w-px bg-hairline" />
					{/* 上下文条：Agent / 工作区 / Project / 会话 —— 四者的权威各不同（Agent 是服务这个会话的人，
				    工作区是它落的目录，Project 是会话归属，会话是正在做的事），拼成一个字符串就丢掉了来源。
				    Agent 与 Project 是可交互的上下文控件（见 layout/ 下两个 Switcher），工作区与会话是只读读数。 */}
					<AgentSwitcher view={view} onSelect={id => store.focusAgent(id)} />
					<span className="text-[12px] text-ink-faint">/</span>
					<span className="chip min-w-0" title={activeAgent?.agentDir ?? view.env?.repos ?? undefined}>
						<Folder size={13} strokeWidth={1.5} />
						<b className="chip-truncate">
							{workspaceLabel}
							{view.env ? ` · ${view.env.branch}` : ""}
						</b>
					</span>
					<span className="text-[12px] text-ink-faint">/</span>
					<ProjectSwitcher view={view} onRefresh={() => void store.refreshProjects(activeAgentIdOf(view))} />
					<span className="text-[12px] text-ink-faint">/</span>
					<span className="chip min-w-0" title={view.sessionFile ?? undefined}>
						<MessagesSquare size={13} strokeWidth={1.5} />
						<b className="chip-truncate">{view.sessionName ?? view.sessionId ?? "未命名会话"}</b>
					</span>
					<span className="flex-1" />
					{!compact && (
						<>
							<button
								type="button"
								className="cbtn hidden shrink-0 lg:inline-flex"
								onClick={() => getUiStore().setPhonePreview(true)}
								title="手机预览"
								aria-label="手机预览"
							>
								<Smartphone size={16} strokeWidth={1.5} />
							</button>
							<button
								type="button"
								className="cbtn hidden shrink-0 lg:inline-flex"
								onClick={() => getUiStore().setRightPanel(!ui.rightPanelOpen)}
								aria-label={ui.rightPanelOpen ? "收起右栏" : "展开右栏"}
								title={ui.rightPanelOpen ? "收起右栏" : "展开右栏"}
							>
								<PanelRight size={16} strokeWidth={1.5} />
							</button>
							<button type="button" className="cbtn shrink-0" onClick={() => store.compact()}>
								compact
							</button>
							<button type="button" className="cbtn shrink-0" onClick={() => setNewSessionOpen(open => !open)}>
								新会话
							</button>
						</>
					)}
				</header>

				<Transcript />

				{newSessionOpen && (
					<NewSessionForm
						view={view}
						draft={newSessionDraft}
						onChange={setNewSessionDraft}
						onCreate={async input => {
							// 提交顺序在 store 那一条唯一路径里：await 目标 Agent 的 attach / switch_session →
							// 看结果 → 确认后才带显式目标发 new_session（见 SessionStore.newSession）。
							// 没建成（或说不准）就不关表单：错误已由 store 写进命令错误提示条（serve 的原文），
							// 用户可以改选重提 —— 这正是「失败不能看着像成功」。
							const outcome = await store.newSession(input);
							if (outcome.kind !== "created") return;
							setNewSessionDraft(EMPTY_NEW_SESSION_DRAFT);
							setNewSessionOpen(false);
						}}
					/>
				)}

				{/* 当前计划：本会话自己的 Session Todo（不新建存储，也不写进别的板子） */}
				<PlanStrip area={planArea} onToggle={(phaseName, index) => store.toggleTodo(phaseName, index)} />

				<QueueCard
					count={view.queued}
					onCancel={view.queued > 0 ? () => void store.cancelQueued() : undefined}
					className="mx-auto mb-1 max-w-[760px]"
				/>

				{/* 输入区：单一实例（CSS 自适应桌面/移动），避免模型列表/草稿逻辑双份执行 */}
				{/* 审批/澄清浮层卡：position:relative 锚点，卡从 composer 上方滑入 */}
				<FloatingCardHost />
				<ComposerBar autoFocusDraft={initialQuery} />
			</div>
			{!compact && <RightPanel collapsed={!ui.rightPanelOpen} />}
			{!compact && <DevicePreview />}
		</div>
	);
}
