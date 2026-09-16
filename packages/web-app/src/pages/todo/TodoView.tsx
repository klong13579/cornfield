import { useEffect, useMemo, useState } from "react";
import type { AgentTodoDto, AgentTodoStatusDto } from "../../lib/pi-client-api";
import { useSessionStore } from "../../state/session-store";
import { useSession } from "../../state/use-session";
import {
	type AgentTodoFilter,
	ALL_TODOS,
	bindableProjects,
	bindingLabelOf,
	countsOf,
	filterAgentTodos,
	filterOptionsOf,
	isTerminal,
	type ProjectRegistryView,
	projectRegistryOf,
	sameFilter,
	sortAgentTodos,
} from "./agent-todo-logic";

/**
 * Todo 工作台（T10A）。
 *
 * 三个 scope 在这里**分开显示、各自标注来源**，因为它们不是一回事（§9 / §37）：
 *
 * | scope   | owner          | 存哪                                            | 本页能做什么 |
 * |---------|----------------|-------------------------------------------------|--------------|
 * | Agent   | 某个 Agent     | `<agentDir>/.cornfield/agent-todos.json`         | 增删改（本页唯一可写的一块） |
 * | Project | 项目（不是 Agent） | `<项目根>/TODO.md`（`project-todo` skill 维护） | **只读** —— 不建第二套 Project Todo store，也不双写 |
 * | Session | 一个会话        | 会话 JSONL（`todo` 工具）                        | 沿用现有会话内能力（set_todos 写回） |
 *
 * 三种东西混在一起看，用户就会以为「项目 TODO 上的那条」和「Agent 板上的那条」是同一条。
 * 所以这里既不做跨 scope 合并，也不做「把项目 TODO 提升成 Agent Todo」这类隐式双写。
 */

/** 三个 scope 一律显式标注 owner 与来源（§9：前端必须标注 scope 和 source）。 */
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

export function AgentTodoBoard(): React.JSX.Element {
	const view = useSession();
	const store = useSessionStore();
	const [title, setTitle] = useState("");
	const [projectId, setProjectId] = useState("");
	const [filter, setFilter] = useState<AgentTodoFilter>(ALL_TODOS);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const todos = view.agentTodos;
	// registry 三态（读到 / 还没读到 / 读不出来）—— 绑定标签与选择器都靠它区分「没有」与「不知道」。
	const registry = projectRegistryOf(view);
	const owner = view.activeAgentId ?? "default";

	const options = useMemo(() => filterOptionsOf(registry, todos ?? []), [registry, todos]);
	const visible = useMemo(() => sortAgentTodos(filterAgentTodos(todos ?? [], filter)), [todos, filter]);
	const counts = countsOf(todos ?? []);
	const bindable = bindableProjects(registry, view.agentTodoProjectIds);

	// 板子换了 owner，上一个筛选桶可能已经不存在了 —— 留着它会让列表空着却没有任何解释。
	useEffect(() => {
		if (!options.some(option => sameFilter(option.filter, filter))) setFilter(ALL_TODOS);
	}, [options, filter]);

	const run = async (action: () => Promise<unknown>): Promise<void> => {
		setBusy(true);
		setError(null);
		try {
			await action();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
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
		void run(async () => {
			await store.saveAgentTodo(todo);
			setTitle("");
		});
	};

	const setStatus = (todo: AgentTodoDto, status: AgentTodoStatusDto): void => {
		void run(() => store.saveAgentTodo({ ...todo, status }));
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

	return (
		<div>
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
					placeholder={`给 ${owner} 记一条长期任务…`}
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
			</div>

			{error && (
				<div className="mb-3 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-[12px] text-danger">
					{error}
				</div>
			)}

			{todos.length === 0 && <Empty text={`${owner} 还没有长期任务。上面加一条。`} />}
			{todos.length > 0 && visible.length === 0 && <Empty text="这个筛选下没有任务。" />}

			{visible.map(todo => {
				const binding = bindingLabelOf(todo, registry);
				const done = todo.status === "completed";
				return (
					<div
						key={todo.id}
						className="group flex items-start gap-2.5 border-b border-hairline px-1 py-2.5 first:border-t hover:bg-surface"
					>
						<input
							type="checkbox"
							checked={done}
							// completed / cancelled 是终态，不可重开（§37）：能点但永远失败的选择不是选择。
							disabled={busy || isTerminal(todo.status)}
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
							{todo.notes && <div className="mt-0.5 text-[12px] text-ink-muted">{todo.notes}</div>}
							<div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 text-[11.5px] text-ink-faint">
								<span>{STATUS_LABEL[todo.status]}</span>
								<span className={binding.warning ? "text-danger" : ""} title={binding.title}>
									{binding.label}
								</span>
								<span title={`来源 ${todo.source}`}>来源 {todo.source}</span>
								{todo.sessionRefs.length > 0 && <span>{todo.sessionRefs.length} 个会话推进过</span>}
							</div>
						</div>
						<div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
							{todo.status === "open" && (
								<button
									type="button"
									className="cbtn"
									disabled={busy}
									onClick={() => setStatus(todo, "in_progress")}
								>
									开始
								</button>
							)}
							{!isTerminal(todo.status) && (
								<button
									type="button"
									className="cbtn"
									disabled={busy}
									onClick={() => setStatus(todo, "cancelled")}
								>
									取消
								</button>
							)}
							<button
								type="button"
								className="cbtn text-danger"
								disabled={busy}
								onClick={() => void run(() => store.deleteAgentTodo(todo.id))}
								aria-label={`删除 ${todo.title}`}
							>
								删除
							</button>
						</div>
					</div>
				);
			})}
		</div>
	);
}

// ── Project TODO（只读）─────────────────────────────────────────────────────

type TodoLine =
	| { kind: "heading"; depth: number; text: string }
	| { kind: "item"; done: boolean; text: string }
	| { kind: "text"; text: string };

const TODO_CHECK = /^\s*-\s*\[([x ])\]\s*(.*)$/i;
const HEADING = /^(#{1,6})\s+(.*)$/;

/** 逐行解析 TODO.md：勾选项（- [ ] / - [x]）为 item，# 开头为 heading，其余非空行为文本。 */
function parseTodoMd(text: string): TodoLine[] {
	const lines: TodoLine[] = [];
	for (const raw of text.split("\n")) {
		const line = raw.replace(/\r$/, "");
		const check = line.match(TODO_CHECK);
		if (check) {
			lines.push({ kind: "item", done: check[1].toLowerCase() === "x", text: check[2] || "" });
			continue;
		}
		const head = line.match(HEADING);
		if (head) {
			lines.push({ kind: "heading", depth: head[1].length, text: head[2] || "" });
			continue;
		}
		if (line.trim() !== "") {
			lines.push({ kind: "text", text: line });
		}
	}
	return lines;
}

type MdLoadState = "idle" | "loading" | "loaded" | "error";

/**
 * 项目台账（`<项目根>/TODO.md`）—— **只读投影**。
 *
 * 这是 `project-todo` skill 的存储（owner 是项目，不是 Agent）。工作台在这里只读它：
 * 一旦这里也能写，同一块板子就有两个写者，§9 禁止的「同一个文件两种板子」就成立了。
 */
function ProjectBoard(): React.JSX.Element {
	const view = useSession();
	const store = useSessionStore();
	const [todoMd, setTodoMd] = useState<string | null>(null);
	const [state, setState] = useState<MdLoadState>("idle");
	const [mdError, setMdError] = useState<string | null>(null);

	// default agent 的 agentDir = serve 进程 cwd（项目根），fs_read 相对该目录解析。
	const defaultAgentId = view.agents.find(a => a.id === "default")?.id ?? "default";

	useEffect(() => {
		if (!view.connected) {
			setTodoMd(null);
			setMdError(null);
			setState("idle");
			return;
		}
		let cancelled = false;
		setState("loading");
		store
			.fsRead(defaultAgentId, "todo.md")
			.then(r => {
				if (cancelled) return;
				setTodoMd(r.text);
				setMdError(null);
				setState("loaded");
			})
			.catch(err => {
				if (cancelled) return;
				setTodoMd(null);
				setMdError(err instanceof Error ? err.message : String(err));
				setState("error");
			});
		return () => {
			cancelled = true;
		};
	}, [view.connected, defaultAgentId, store]);

	const lines = useMemo(() => (todoMd === null ? [] : parseTodoMd(todoMd)), [todoMd]);
	const openCount = lines.filter(l => l.kind === "item" && !l.done).length;
	const doneCount = lines.filter(l => l.kind === "item" && l.done).length;

	if (state === "idle") return <Empty text="未连接 serve —— 连接后读取项目台账。" />;
	if (state === "loading") return <Empty text="加载 TODO.md…" />;
	if (state === "error") {
		return <ErrorBox title="项目台账未找到" detail={mdError ?? ""} note="项目根还没有 TODO.md。" />;
	}
	if (lines.length === 0) {
		return <Empty text="项目台账为空 —— 该加事项时用 project-todo skill 写。" />;
	}

	return (
		<div>
			<div className="mb-2 text-[11.5px] text-ink-faint">
				{openCount} 待办 · {doneCount} 已完成（只读）
			</div>
			{lines.map((line, i) => {
				if (line.kind === "heading") {
					const Heading = line.depth <= 2 ? "h3" : "h4";
					return (
						<Heading
							key={i}
							className={`${line.depth <= 2 ? "text-[16px]" : "text-[14px]"} mb-2 mt-5 font-semibold tracking-[-0.3px] text-ink first:mt-0`}
						>
							{line.text}
						</Heading>
					);
				}
				if (line.kind === "item") {
					return (
						<div key={i} className="flex items-start gap-2.5 border-b border-hairline px-1 py-2 first:border-t">
							<input
								type="checkbox"
								checked={line.done}
								readOnly
								tabIndex={-1}
								className="mt-[4px] size-4 shrink-0 cursor-default accent-[var(--color-accent)]"
							/>
							<div
								className={`min-w-0 flex-1 text-[14px] ${line.done ? "text-ink-faint line-through" : "text-ink"}`}
							>
								{line.text}
							</div>
						</div>
					);
				}
				return (
					<p key={i} className="py-1 text-[13px] leading-relaxed text-ink-muted">
						{line.text}
					</p>
				);
			})}
		</div>
	);
}

// ── Session Todo（现有会话内能力）───────────────────────────────────────────

/**
 * 会话任务 —— **沿用现有能力**，不在这里另起一套。
 *
 * 数据来自会话快照（`todo` 工具的结果），写回走 `set_todos`：会话结束它就结束，与 Agent 板上
 * 的长期任务没有继承关系（§38：Session Todo 原样复用）。后端不给会话 todo 换存储。
 */
function SessionTodos(): React.JSX.Element {
	const view = useSession();
	const store = useSessionStore();
	const [drafts, setDrafts] = useState<Record<string, string>>({});

	const total = view.todo.reduce((sum, phase) => sum + phase.tasks.length, 0);
	const done = view.todo.reduce((sum, phase) => sum + phase.tasks.filter(t => t.status === "completed").length, 0);

	if (view.todo.length === 0) {
		return <Empty text="当前会话还没有任务 —— 在会话工作台让 agent 随手记几条。" />;
	}

	return (
		<div>
			<div className="mb-3 text-[11.5px] text-ink-faint">
				当前会话 · {total} 项 · {done} 已完成
			</div>
			{view.todo.map(phase => {
				const phaseDone = phase.tasks.filter(t => t.status === "completed").length;
				const ratio = phase.tasks.length === 0 ? 0 : Math.round((phaseDone / phase.tasks.length) * 100);
				return (
					<div key={phase.name} className="mb-8">
						<div className="mb-2 flex items-baseline gap-2.5">
							<h3 className="text-[16px] font-semibold tracking-[-0.3px] text-ink">{phase.name}</h3>
							<span className="font-mono text-[12px] text-ink-faint">
								{phaseDone} / {phase.tasks.length}
							</span>
						</div>
						<div className="mb-3 h-0.5 overflow-hidden rounded bg-surface-3">
							<div
								className={`h-full rounded ${ratio === 100 ? "bg-success" : "bg-accent"}`}
								style={{ width: `${ratio}%` }}
							/>
						</div>
						{phase.tasks.map((task, i) => (
							<div
								key={`${phase.name}-${task.content}-${i}`}
								className="group flex items-start gap-2.5 border-b border-hairline px-1 py-2 transition-colors first:border-t hover:bg-surface"
							>
								<input
									type="checkbox"
									checked={task.status === "completed"}
									onChange={() => store.toggleTodo(phase.name, i)}
									className="mt-[4px] size-4 shrink-0 cursor-pointer accent-[var(--color-accent)]"
								/>
								<div className="min-w-0 flex-1">
									<div
										className={`text-[14px] ${task.status === "completed" ? "text-ink-faint line-through" : "text-ink"}`}
									>
										{task.content}
									</div>
									<div className="mt-0.5 text-[11px] text-ink-faint">
										{task.status === "completed"
											? "已完成"
											: task.status === "in_progress"
												? "进行中"
												: task.status}
									</div>
								</div>
								<button
									type="button"
									className="cbtn shrink-0 text-danger opacity-0 group-hover:opacity-100"
									onClick={() => store.removeTodo(phase.name, i)}
									aria-label={`删除 ${task.content}`}
								>
									删除
								</button>
							</div>
						))}
						<div className="flex cursor-text items-center gap-2 px-1 py-2">
							<span className="w-[15px] text-center text-[16px] text-ink-faint">+</span>
							<input
								value={drafts[phase.name] ?? ""}
								onChange={e => setDrafts(v => ({ ...v, [phase.name]: e.target.value }))}
								onKeyDown={e => {
									if (e.key === "Enter") {
										store.addTodo(phase.name, drafts[phase.name] ?? "");
										setDrafts(v => ({ ...v, [phase.name]: "" }));
									}
								}}
								placeholder="添加会话任务…"
								className="flex-1 border-none bg-transparent text-[14px] text-ink outline-none placeholder:text-ink-faint"
							/>
						</div>
					</div>
				);
			})}
		</div>
	);
}

// ── 页面 ────────────────────────────────────────────────────────────────────

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
	const owner = view.activeAgentId ?? "default";

	return (
		<div className="px-10 pt-8 pb-12">
			<div className="mx-auto max-w-[860px]">
				<div className="mb-8 flex items-baseline gap-3.5">
					<h1 className="text-[32px] font-semibold tracking-[-0.8px] text-ink">Todo</h1>
					<span className="text-[13px] text-ink-faint">
						Agent 长期任务 / 项目台账 / 会话任务 —— 三个 scope 分开看
					</span>
				</div>

				<section className="mb-14">
					<ScopeHeading
						scope="Agent"
						title="Agent Todo"
						owner={owner}
						source={`<agentDir>/.cornfield/agent-todos.json（agentDir 为 ${owner} 的 home）`}
					/>
					<AgentTodoBoard />
				</section>

				<section className="mb-14">
					<ScopeHeading
						scope="Project"
						title="项目台账"
						owner="项目（project-todo skill）"
						source="<项目根>/TODO.md · 只读"
					/>
					<ProjectBoard />
				</section>

				<section>
					<ScopeHeading
						scope="Session"
						title="会话任务"
						owner="当前会话"
						source="会话 JSONL · todo 工具 · set_todos 写回"
					/>
					<SessionTodos />
				</section>
			</div>
		</div>
	);
}
