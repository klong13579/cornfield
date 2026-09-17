import { agentTodoStatusActions, isAgentTodoTransitionAllowed } from "@cornfield/wire";
import { useEffect, useMemo, useState } from "react";
import type { AgentTodoDto, AgentTodoPriorityDto, AgentTodoStatusDto } from "../../lib/pi-client-api";
import { serveVerdictOf } from "../../lib/serve-verdict";
import { activeAgentIdOf } from "../../state/agent-context";
import { useSessionStore } from "../../state/session-store";
import { useSession } from "../../state/use-session";
import {
	type AgentTodoEditDraft,
	type AgentTodoEditPatch,
	type AgentTodoFilter,
	ALL_TODOS,
	applyTodoPatch,
	bindableProjects,
	bindingLabelOf,
	boardAgentIdOf,
	boardAgentNameOf,
	canDefer,
	countsOf,
	DEFER_PRESETS,
	deferredPatch,
	dueBadgeOf,
	dueLabel,
	editDraftOf,
	filterAgentTodos,
	filterOptionsOf,
	PRIORITY_LABELS,
	PRIORITY_VALUES,
	type ProjectRegistryView,
	patchOfDraft,
	projectRegistryOf,
	sameFilter,
	sortAgentTodos,
} from "./agent-todo-logic";

/** Agent-owned Todo 工作台；Project 仅作为筛选维度，不读取独立项目台账。 */

/** 显式标注 Agent owner 与存储来源。 */
function ScopeHeading({
	scope,
	title,
	owner,
	source,
	trailing,
}: {
	scope: string;
	title: string;
	owner: string;
	source: string;
	trailing?: React.ReactNode;
}): React.JSX.Element {
	return (
		<div className="mb-4 border-b border-hairline pb-2.5">
			<div className="flex items-baseline gap-2.5">
				<span className="badge shrink-0">{scope}</span>
				<h2 className="text-[20px] font-semibold tracking-[-0.5px] text-ink">{title}</h2>
				{trailing}
			</div>
			<div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[11.5px] text-ink-faint">
				<span>
					owner <b className="font-medium text-ink-muted">{owner}</b>
				</span>
				<span className="min-w-0 truncate font-mono" title={source}>
					{source}
				</span>
			</div>
		</div>
	);
}

// ── Agent Todo ──────────────────────────────────────────────────────────

/**
 * 绑定选择器的说明文字。
 *
 * 四种情况要说成四句话：「未约束」「已约束」「读不出来」「还没读到」—— 把它们挤成一句
 * 「没有可绑的 Project」，用户就会以为自己的 Project 丢了。
 */
function bindingPickerHint(
	registry: ProjectRegistryView,
	declaredProjectIds: readonly string[] | undefined,
	bindableCount: number,
): string {
	if (registry.state === "unreadable") return `Project registry 读不出来（${registry.error}），只能记成「通用」`;
	if (registry.state === "pending") return "Project registry 读取中…";
	if (declaredProjectIds === undefined) return "该 Agent 没有声明 Project 绑定，可绑任意已声明的 Project";
	if (bindableCount === 0) {
		return `该 Agent 声明绑定的 Project 都不在 registry 里（声明：${declaredProjectIds.join(" / ")}）`;
	}
	return `该 Agent 只声明了 ${declaredProjectIds.join(" / ")}，绑定范围以它为上界`;
}

/** status → 展示文案。终态不可重开（§37），所以「完成」只在非终态上出现。 */
const STATUS_LABEL: Record<AgentTodoStatusDto, string> = {
	open: "未开始",
	in_progress: "进行中",
	completed: "已完成",
	cancelled: "已取消",
};

/** 状态按钮文案。按钮集合由 {@link agentTodoStatusActions}（wire 的唯一词表）决定，这里只说每个目标叫什么。 */
const STATUS_ACTION_LABELS: Record<AgentTodoStatusDto, string> = {
	open: "退回",
	in_progress: "开始",
	completed: "完成",
	cancelled: "取消",
};

const STATUS_ACTION_TITLES: Record<AgentTodoStatusDto, string> = {
	open: "退回未开始",
	in_progress: "标为进行中",
	completed: "标为已完成",
	cancelled: "取消这条任务（终态，不可重开）",
};

/** 同一时刻只开一个面板：行上展开的东西归那一行所有，不跨行共存。 */
type TodoPanel = { kind: "edit"; id: string; draft: AgentTodoEditDraft } | { kind: "defer"; id: string };

/**
 * 一次写入失败。
 *
 * 带 `todoId` = 属于那一条（就地显示）；没有 = 与具体某条无关（横幅）。
 * 两种位置，同一份事实 —— 不分成两套状态，否则「哪条错了」会有两个答案。
 */
interface WriteFailure {
	message: string;
	code?: string;
	todoId?: string;
}

export function AgentTodoBoard(): React.JSX.Element {
	const view = useSession();
	const store = useSessionStore();
	const [title, setTitle] = useState("");
	const [projectId, setProjectId] = useState("");
	const [filter, setFilter] = useState<AgentTodoFilter>(ALL_TODOS);
	const [panel, setPanel] = useState<TodoPanel | null>(null);
	const [failure, setFailure] = useState<WriteFailure | null>(null);
	const [busy, setBusy] = useState(false);

	const todos = view.agentTodos;
	// registry 三态（读到 / 还没读到 / 读不出来）—— 绑定标签与选择器都靠它区分「没有」与「不知道」。
	const registry = projectRegistryOf(view);
	const ownerId = boardAgentIdOf(view);
	const owner = ownerId ?? "default";
	const ownerName = boardAgentNameOf(view);
	// 「跟随焦点」的展示名：当前焦点是谁（显式 pin 了别的板子时，焦点与板子不同）。
	const focusId = activeAgentIdOf(view);
	const focusName =
		focusId === undefined ? "（无）" : (view.agents.find(agent => agent.id === focusId)?.name ?? focusId);
	// 相对文案（「已过期 3 天」）按渲染时刻取一次即可：它精确到分钟，没有谁需要它逐秒跳。
	const now = Date.now();

	const options = useMemo(() => filterOptionsOf(registry, todos ?? []), [registry, todos]);
	const visible = useMemo(() => sortAgentTodos(filterAgentTodos(todos ?? [], filter)), [todos, filter]);
	const counts = countsOf(todos ?? []);
	const bindable = bindableProjects(registry, view.agentTodoProjectIds);

	// 板子换了 owner，上一个筛选桶可能已经不存在了 —— 留着它会让列表空着却没有任何解释。
	useEffect(() => {
		if (!options.some(option => sameFilter(option.filter, filter))) setFilter(ALL_TODOS);
	}, [options, filter]);

	// 换 Agent = 换了一块板子：上一个 Agent 的写失败不属于新板子，留着会让新板子背一条与它无关的错。
	useEffect(() => {
		setFailure(null);
	}, [owner]);

	// 面板属于板上某一条。它从板上消失（换 Agent 作废 / 别处删掉 / 读回来就没有）时收起，
	// 不留一条已经不属于任何行的草稿在后台等着被下一次点击唤醒。
	useEffect(() => {
		if (panel === null) return;
		if (todos === undefined || !todos.some(todo => todo.id === panel.id)) setPanel(null);
	}, [todos, panel]);

	/** 一次写入。失败**不吞**：serve 的原话留在这条 Todo 上，板子不动。 */
	const run = async (todoId: string | undefined, action: () => Promise<unknown>): Promise<void> => {
		setBusy(true);
		setFailure(null);
		try {
			await action();
		} catch (err) {
			const verdict = serveVerdictOf(err);
			setFailure({ ...verdict, ...(todoId === undefined ? {} : { todoId }) });
		} finally {
			setBusy(false);
		}
	};

	/** 存一条补丁。**成功才收起面板**：失败时草稿必须留着，否则用户得把改过的内容重敲一遍。 */
	const savePatch = (todo: AgentTodoDto, patch: AgentTodoEditPatch): void => {
		void run(todo.id, async () => {
			await store.saveAgentTodo(applyTodoPatch(todo, patch));
			setPanel(null);
		});
	};

	const add = (): void => {
		const trimmed = title.trim();
		if (trimmed === "") return;
		const todo: AgentTodoDto = {
			id: crypto.randomUUID(),
			agentId: owner,
			title: trimmed,
			status: "open",
			priority: "medium",
			source: "user",
			sessionRefs: [],
			createdAt: 0,
			updatedAt: 0,
			...(projectId === "" ? {} : { projectId }),
		};
		void run(undefined, async () => {
			await store.saveAgentTodo(todo);
			setTitle("");
		});
	};

	const setStatus = (todo: AgentTodoDto, status: AgentTodoStatusDto): void => {
		void run(todo.id, () => store.saveAgentTodo({ ...todo, status }));
	};

	if (!view.connected) {
		return <Empty text="未连接 serve —— 连接后读取该 Agent 的 Todo 板。" />;
	}
	if (view.agentTodosError) {
		return (
			<ErrorBox
				title="Todo 板读不出来"
				detail={view.agentTodosError}
				note="读不到和「没有任务」不是一回事，这里不显示空态。"
				onRetry={() => void store.refreshAgentTodos()}
			/>
		);
	}
	if (todos === undefined) {
		return <Empty text="读取 Todo 板…" />;
	}

	// 贴在某条上的失败，只有在**那条真的渲染出来**时才贴得住。它被筛掉 / 已被删除时退回横幅，
	// 否则一次真实的写入失败会凭空消失。
	const bannerFailure = failure && !visible.some(todo => todo.id === failure.todoId) ? failure : null;

	return (
		<div>
			<div className="mb-3 flex flex-wrap items-center gap-2">
				<label className="flex items-center gap-2 text-[12px] text-ink-faint">
					<span className="shrink-0">看板 Agent</span>
					<select
						value={view.todoBoardAgentId ?? ""}
						onChange={e => store.setTodoBoardAgent(e.target.value === "" ? undefined : e.target.value)}
						disabled={!view.connected || view.agents.length === 0}
						aria-label="Todo 板子归属 Agent"
						className="rounded-md border border-hairline bg-surface px-2 py-1.5 text-[12.5px] text-ink disabled:opacity-60"
					>
						<option value="">跟随焦点（{focusName}）</option>
						{view.agents.map(agent => (
							<option key={agent.id} value={agent.id}>
								{agent.name}
							</option>
						))}
					</select>
				</label>
				<span className="flex-1" />
			</div>
			<div className="mb-3 flex flex-wrap items-center gap-1.5">
				{options.map(option => (
					<button
						key={option.label}
						type="button"
						onClick={() => setFilter(option.filter)}
						className={`badge ${sameFilter(option.filter, filter) ? "done" : ""} ${option.warning ? "text-danger" : ""}`}
						title={option.warning}
					>
						{option.label} {option.count}
					</button>
				))}
				<span className="flex-1" />
				<span className="text-[11.5px] text-ink-faint">
					{counts.open} 未完成 · {counts.completed} 已完成
					{counts.cancelled > 0 ? ` · ${counts.cancelled} 已取消` : ""}
				</span>
			</div>

			<div className="mb-4 flex flex-wrap items-center gap-2">
				<input
					value={title}
					onChange={e => setTitle(e.target.value)}
					onKeyDown={e => {
						if (e.key === "Enter") add();
					}}
					placeholder={`给 ${ownerName} 记一条长期任务…`}
					className="min-w-[240px] flex-1 rounded-md border border-hairline bg-surface px-2.5 py-1.5 text-[13.5px] text-ink outline-none placeholder:text-ink-faint"
				/>
				<select
					value={projectId}
					onChange={e => setProjectId(e.target.value)}
					// registry 读不出来时不能给一堆空的选项：只能记「通用」，并说明原因。
					disabled={registry.state !== "loaded"}
					className="rounded-md border border-hairline bg-surface px-2 py-1.5 text-[12.5px] text-ink disabled:opacity-60"
					title={bindingPickerHint(registry, view.agentTodoProjectIds, bindable.length)}
				>
					<option value="">通用（不绑 Project）</option>
					{bindable.map(project => (
						<option key={project.projectId} value={project.projectId}>
							{project.name}
						</option>
					))}
				</select>
				<button type="button" className="cbtn" disabled={busy || title.trim() === ""} onClick={add}>
					添加
				</button>
				{title.trim() === "" && (
					<span className="w-full text-[11.5px] text-ink-faint">标题为空不能添加 —— 先输入要记的任务。</span>
				)}
			</div>

			{bannerFailure && <FailureBox failure={bannerFailure} onDismiss={() => setFailure(null)} />}

			{todos.length === 0 && <Empty text={`${ownerName} 还没有长期任务。上面加一条。`} />}
			{todos.length > 0 && visible.length === 0 && <Empty text="这个筛选下没有任务。" />}

			{visible.map(todo => {
				const binding = bindingLabelOf(todo, registry);
				const due = dueLabel(todo);
				const badge = dueBadgeOf(todo, now);
				const panelFor = panel?.id === todo.id ? panel : null;
				const pinned = failure?.todoId === todo.id ? failure : null;
				// 「完成」由左侧复选框承担（列表里最顺手的位置），操作组只渲染其余合法转移 ——
				// 同一个动作不给两个按钮，否则用户会以为它们不一样。
				const actions = agentTodoStatusActions(todo.status).filter(target => target !== "completed");
				return (
					<div key={todo.id} className="border-b border-hairline first:border-t">
						<div className="group flex items-start gap-2.5 px-1 py-2.5 hover:bg-surface">
							<input
								type="checkbox"
								checked={todo.status === "completed"}
								// 终态不可重开（§37）：勾不上就是勾不上，不做「点了才被 serve 拒绝」的控件。
								disabled={busy || !isAgentTodoTransitionAllowed(todo.status, "completed")}
								onChange={() => setStatus(todo, "completed")}
								className="mt-[4px] size-4 shrink-0 accent-[var(--color-accent)]"
								aria-label={`完成 ${todo.title}`}
							/>
							<div className="min-w-0 flex-1">
								<div
									className={`text-[14px] ${todo.status === "completed" ? "text-ink-faint line-through" : todo.status === "cancelled" ? "text-ink-faint" : "text-ink"}`}
								>
									{todo.title}
								</div>
								{todo.notes && (
									<div className="mt-0.5 whitespace-pre-wrap text-[12px] text-ink-muted">{todo.notes}</div>
								)}
								<div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 text-[11.5px] text-ink-faint">
									<span>{STATUS_LABEL[todo.status]}</span>
									<span title={`优先级 ${PRIORITY_LABELS[todo.priority]}`}>
										{PRIORITY_LABELS[todo.priority]}
									</span>
									<span className={binding.warning ? "text-danger" : ""} title={binding.title}>
										{binding.label}
									</span>
									{due && (
										<span className={badge ? "text-danger" : ""} title={badge?.title}>
											{due}
											{badge ? ` · ${badge.label}` : ""}
										</span>
									)}
									<span title={`来源 ${todo.source}`}>来源 {todo.source}</span>
									{todo.sessionRefs.length > 0 && <span>{todo.sessionRefs.length} 个会话推进过</span>}
								</div>
							</div>
							<div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100 max-sm:opacity-100">
								<button
									type="button"
									className="cbtn"
									disabled={busy}
									title="编辑标题 / 备注 / 优先级 / 截止时间"
									onClick={() =>
										setPanel(
											panelFor?.kind === "edit"
												? null
												: { kind: "edit", id: todo.id, draft: editDraftOf(todo) },
										)
									}
								>
									编辑
								</button>
								{canDefer(todo) && (
									<button
										type="button"
										className="cbtn"
										disabled={busy}
										title="延期：只改截止时间，不动其余字段"
										onClick={() =>
											setPanel(panelFor?.kind === "defer" ? null : { kind: "defer", id: todo.id })
										}
									>
										延期
									</button>
								)}
								{actions.map(target => (
									<button
										key={target}
										type="button"
										className="cbtn"
										disabled={busy}
										title={STATUS_ACTION_TITLES[target]}
										onClick={() => setStatus(todo, target)}
									>
										{STATUS_ACTION_LABELS[target]}
									</button>
								))}
								<button
									type="button"
									className="cbtn text-danger"
									disabled={busy}
									onClick={() => void run(todo.id, () => store.deleteAgentTodo(todo.id))}
									aria-label={`删除 ${todo.title}`}
								>
									删除
								</button>
							</div>
						</div>

						{panelFor?.kind === "edit" && (
							<TodoEditor
								draft={panelFor.draft}
								busy={busy}
								onDraft={draft => setPanel({ kind: "edit", id: todo.id, draft })}
								onSave={patch => savePatch(todo, patch)}
								onCancel={() => setPanel(null)}
							/>
						)}

						{panelFor?.kind === "defer" && (
							<div className="mb-1 flex flex-wrap items-center gap-1.5 rounded-md border border-hairline bg-surface px-3 py-2 text-[12px] text-ink-faint">
								<span>延期到</span>
								{DEFER_PRESETS.map(preset => (
									<button
										key={preset.key}
										type="button"
										className="cbtn"
										disabled={busy}
										onClick={() => savePatch(todo, deferredPatch(todo, Date.now(), preset.days))}
									>
										{preset.label}
									</button>
								))}
								<span>只改截止时间，其余字段照原样送回</span>
								<span className="flex-1" />
								<button type="button" className="cbtn" disabled={busy} onClick={() => setPanel(null)}>
									收起
								</button>
							</div>
						)}

						{pinned && <FailureBox failure={pinned} onDismiss={() => setFailure(null)} />}
					</div>
				);
			})}
		</div>
	);
}

/**
 * 一条 Todo 的编辑面。
 *
 * 校验在**这里**做（{@link patchOfDraft}），因为它只依赖草稿：放到保存回调和保存按钮上的
 * 「问题提示」会变成两份状态，其中一份迟早过期。本地能判的只有空标题与解析不出的时间，
 * 其余留给 serve —— 它的判决由父级原样显示。
 */
function TodoEditor({
	draft,
	busy,
	onDraft,
	onSave,
	onCancel,
}: {
	draft: AgentTodoEditDraft;
	busy: boolean;
	onDraft: (draft: AgentTodoEditDraft) => void;
	onSave: (patch: AgentTodoEditPatch) => void;
	onCancel: () => void;
}): React.JSX.Element {
	const checked = patchOfDraft(draft);
	const patch = checked.kind === "ok" ? checked.patch : undefined;
	return (
		<div className="mb-1 rounded-md border border-hairline bg-surface px-3 py-2.5">
			<div className="flex flex-col gap-2">
				<label className="flex items-center gap-2 text-[12px] text-ink-faint">
					<span className="w-12 shrink-0">标题</span>
					<input
						value={draft.title}
						onChange={e => onDraft({ ...draft, title: e.target.value })}
						className="min-w-0 flex-1 rounded-md border border-hairline bg-surface px-2 py-1 text-[13px] text-ink outline-none"
					/>
				</label>
				<label className="flex items-start gap-2 text-[12px] text-ink-faint">
					<span className="w-12 shrink-0 pt-1">备注</span>
					<textarea
						value={draft.notes}
						rows={2}
						onChange={e => onDraft({ ...draft, notes: e.target.value })}
						placeholder="留空 = 没有备注"
						className="min-w-0 flex-1 resize-y rounded-md border border-hairline bg-surface px-2 py-1 text-[12.5px] text-ink outline-none placeholder:text-ink-faint"
					/>
				</label>
				<label className="flex items-center gap-2 text-[12px] text-ink-faint">
					<span className="w-12 shrink-0">优先级</span>
					<select
						value={draft.priority}
						onChange={e => onDraft({ ...draft, priority: e.target.value as AgentTodoPriorityDto })}
						className="rounded-md border border-hairline bg-surface px-2 py-1 text-[12.5px] text-ink"
					>
						{PRIORITY_VALUES.map(value => (
							<option key={value} value={value}>
								{PRIORITY_LABELS[value]}
							</option>
						))}
					</select>
				</label>
				<div className="flex items-center gap-2 text-[12px] text-ink-faint">
					<span className="w-12 shrink-0">截止</span>
					<input
						type="datetime-local"
						value={draft.dueText}
						onChange={e => onDraft({ ...draft, dueText: e.target.value })}
						className="rounded-md border border-hairline bg-surface px-2 py-1 text-[12.5px] text-ink outline-none"
					/>
					{draft.dueText !== "" && (
						<button type="button" className="cbtn" onClick={() => onDraft({ ...draft, dueText: "" })}>
							清除
						</button>
					)}
					<span>按本地时间</span>
				</div>
			</div>

			<div className="mt-2 flex items-center gap-2">
				<button
					type="button"
					className="cbtn"
					disabled={busy || patch === undefined}
					onClick={() => patch && onSave(patch)}
				>
					保存
				</button>
				<button type="button" className="cbtn" disabled={busy} onClick={onCancel}>
					取消
				</button>
				{patch === undefined && (
					<span className="text-[11.5px] text-danger">{checked.kind === "invalid" ? checked.problem : ""}</span>
				)}
			</div>
		</div>
	);
}

/**
 * 写入失败的展示 —— serve 的**原话**。
 *
 * 不做「翻译成友好文案」：它拒这条写入的理由（owner 不对、Project 没声明过、状态非法）
 * 是用户唯一能据以修的东西，改写成一句「保存失败」就把它丢了。
 */
function FailureBox({ failure, onDismiss }: { failure: WriteFailure; onDismiss: () => void }): React.JSX.Element {
	return (
		<div className="mb-2 mt-1 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-[12px] text-danger">
			<div className="flex items-start gap-2">
				<div className="min-w-0 flex-1">
					<span className="break-all">{failure.message}</span>
					{failure.code && <span className="ml-2 font-mono text-[11px] text-ink-muted">{failure.code}</span>}
				</div>
				<button type="button" className="cbtn shrink-0" onClick={onDismiss}>
					知道了
				</button>
			</div>
		</div>
	);
}

function Empty({ text }: { text: string }): React.JSX.Element {
	return <div className="py-10 text-center text-[13px] text-ink-faint">{text}</div>;
}

function ErrorBox({
	title,
	detail,
	note,
	onRetry,
}: {
	title: string;
	detail: string;
	note: string;
	onRetry?: () => void;
}): React.JSX.Element {
	return (
		<div className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2.5 text-[12.5px] text-danger">
			<div className="flex items-center gap-2">
				<b>{title}</b>
				{onRetry && (
					<button type="button" className="cbtn" onClick={onRetry}>
						重试
					</button>
				)}
			</div>
			{detail && <div className="mt-0.5 break-all text-[11.5px] text-ink-muted">{detail}</div>}
			<div className="mt-0.5 text-[11px] text-ink-subtle">{note}</div>
		</div>
	);
}

export function TodoView(): React.JSX.Element {
	const view = useSession();
	const ownerId = boardAgentIdOf(view) ?? "default";
	const ownerName = boardAgentNameOf(view);

	return (
		<div className="px-10 pt-8 pb-12">
			<div className="mx-auto max-w-[860px]">
				<div className="mb-8 flex items-baseline gap-3.5">
					<h1 className="text-[32px] font-semibold tracking-[-0.8px] text-ink">Todo</h1>
					<span className="text-[13px] text-ink-faint">Agent 长期任务 · Project 筛选</span>
				</div>

				<section className="mb-14">
					<ScopeHeading
						scope="Agent"
						title="Agent Todo"
						owner={ownerName}
						source={`<agentDir>/.cornfield/agent-todos.json（agentDir 为 ${ownerId} 的 home）`}
					/>
					<AgentTodoBoard />
				</section>
			</div>
		</div>
	);
}
