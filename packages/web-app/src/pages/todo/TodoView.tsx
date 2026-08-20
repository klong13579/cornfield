import { useEffect, useMemo, useState } from "react";
import { useSessionStore } from "../../state/session-store";
import { useSession } from "../../state/use-session";

/**
 * Todo 面板（FR-5）—— 主内容渲染项目根 TODO.md：
 * connected 时 client.fsRead(sessionId, "todo.md")（serve cwd=仓库根，fs_read 相对路径）
 * 读文件，解析 '- [ ]' / '- [x]' 渲染待办与已完成列表，保留标题等文本结构。
 * 读失败/不存在 -> 空态提示不崩溃。下方次级区块保留会话 agent todos 的
 * add/toggle/remove 交互（set_todos 写回会话权威快照）。
 */

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

export function TodoView(): React.JSX.Element {
	const view = useSession();
	const store = useSessionStore();
	const [newTask, setNewTask] = useState<Record<string, string>>({});
	const [todoMd, setTodoMd] = useState<string | null>(null);
	const [mdState, setMdState] = useState<MdLoadState>("idle");
	const [mdError, setMdError] = useState<string | null>(null);

	// 会话 agent todos（次要区块：add/toggle/remove 走 set_todos 写回）
	const total = view.todo.reduce((sum, p) => sum + p.tasks.length, 0);
	const done = view.todo.reduce((sum, p) => sum + p.tasks.filter(t => t.status === "completed").length, 0);

	// default agent 的 agentDir = serve 进程 cwd（仓库根），fs_read 相对该目录解析 ——
	// 项目根 TODO.md 由此读取（view.sessionId 是会话 id，不是 agent registry id）。
	const defaultAgentId = view.agents.find(a => a.id === "default")?.id ?? "default";

	useEffect(() => {
		if (!view.connected) {
			setTodoMd(null);
			setMdError(null);
			setMdState("idle");
			return;
		}
		let cancelled = false;
		setMdState("loading");
		store
			.fsRead(defaultAgentId, "todo.md")
			.then(r => {
				if (cancelled) return;
				setTodoMd(r.text);
				setMdError(null);
				setMdState("loaded");
			})
			.catch(err => {
				if (cancelled) return;
				setTodoMd(null);
				setMdError(err instanceof Error ? err.message : String(err));
				setMdState("error");
			});
		return () => {
			cancelled = true;
		};
	}, [view.connected, defaultAgentId, store]);

	const mdLines = useMemo(() => (todoMd === null ? [] : parseTodoMd(todoMd)), [todoMd]);
	const openCount = mdLines.filter(l => l.kind === "item" && !l.done).length;
	const doneCount = mdLines.filter(l => l.kind === "item" && l.done).length;

	const renderMdLine = (line: TodoLine, i: number): React.JSX.Element => {
		if (line.kind === "heading") {
			const Heading = line.depth <= 2 ? "h2" : "h3";
			return (
				<Heading
					key={i}
					className={`${line.depth <= 2 ? "text-[19px]" : "text-[15px]"} mb-2 mt-6 font-semibold tracking-[-0.3px] text-ink first:mt-0`}
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
						className="mt-[4px] h-[15px] w-[15px] shrink-0 cursor-default accent-[var(--color-accent)]"
					/>
					<div className={`min-w-0 flex-1 text-[14px] ${line.done ? "text-ink-faint line-through" : "text-ink"}`}>
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
	};

	const renderMd = (): React.JSX.Element => {
		switch (mdState) {
			case "idle":
				return (
					<div className="py-16 text-center text-[13px] text-ink-faint">
						未连接 serve —— 连接后读取项目根 TODO.md。
					</div>
				);
			case "loading":
				return <div className="py-16 text-center text-[13px] text-ink-faint">加载 TODO.md…</div>;
			case "error":
				return (
					<div className="py-16 text-center text-[13px] text-ink-faint">
						<div>项目根 TODO.md 未找到</div>
						{mdError && <div className="mt-1 text-[12px] text-ink-muted">{mdError}</div>}
					</div>
				);
			case "loaded":
				if (mdLines.length === 0) {
					return <div className="py-16 text-center text-[13px] text-ink-faint">项目根 TODO.md 为空。</div>;
				}
				return <div>{mdLines.map(renderMdLine)}</div>;
		}
	};

	return (
		<div className="px-10 pt-8 pb-12">
			<div className="mx-auto max-w-[720px]">
				<div className="mb-8 flex items-baseline gap-3.5">
					<h1 className="text-[32px] font-semibold tracking-[-0.8px] text-ink">Todo</h1>
					<span className="text-[13px] text-ink-faint">
						项目根 TODO.md · {openCount} 待办 · {doneCount} 已完成
					</span>
				</div>

				{renderMd()}

				{/* 会话 agent todos（原 FR-5 交互区块 —— add/toggle/remove 走 set_todos 写回） */}
				<section className="mt-14">
					<div className="mb-6 flex items-baseline gap-3.5">
						<h2 className="text-[20px] font-semibold tracking-[-0.5px] text-ink">会话任务</h2>
						<span className="text-[13px] text-ink-faint">
							全部会话任务汇总 · {total} 项 · {done} 已完成
						</span>
					</div>

					{view.todo.length === 0 && (
						<div className="py-10 text-center text-[13px] text-ink-faint">
							暂无任务 —— 在会话工作台让 agent 随手记几条。
						</div>
					)}

					{view.todo.map(phase => {
						const phaseDone = phase.tasks.filter(t => t.status === "completed").length;
						const ratio = phase.tasks.length === 0 ? 0 : Math.round((phaseDone / phase.tasks.length) * 100);
						return (
							<div key={phase.name} className="mb-9">
								<div className="mb-2 flex items-baseline gap-2.5">
									<h3 className="text-[17px] font-semibold tracking-[-0.3px] text-ink">{phase.name}</h3>
									<span className="font-mono text-[12px] text-ink-faint">
										{phaseDone} / {phase.tasks.length}
									</span>
								</div>
								<div className="mb-3.5 h-0.5 overflow-hidden rounded bg-surface-3">
									<div
										className={`h-full rounded ${ratio === 100 ? "bg-success" : "bg-accent"}`}
										style={{ width: `${ratio}%` }}
									/>
								</div>

								{phase.tasks.map((task, i) => (
									<div
										key={`${phase.name}-${task.content}-${i}`}
										className="group flex items-start gap-2.5 border-b border-hairline px-1 py-2.25 transition-colors first:border-t hover:bg-surface"
									>
										<input
											type="checkbox"
											checked={task.status === "completed"}
											onChange={() => store.toggleTodo(phase.name, i)}
											className="mt-[4px] h-[15px] w-[15px] shrink-0 cursor-pointer accent-[var(--color-accent)]"
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
											className="shrink-0 rounded px-1 py-0.5 text-[12px] text-ink-faint opacity-0 transition-all group-hover:opacity-100 hover:bg-surface-2 hover:text-danger"
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
										value={newTask[phase.name] ?? ""}
										onChange={e => setNewTask(v => ({ ...v, [phase.name]: e.target.value }))}
										onKeyDown={e => {
											if (e.key === "Enter") {
												store.addTodo(phase.name, newTask[phase.name] ?? "");
												setNewTask(v => ({ ...v, [phase.name]: "" }));
											}
										}}
										placeholder="添加任务…"
										className="flex-1 border-none bg-transparent text-[14px] text-ink outline-none placeholder:text-ink-faint"
									/>
								</div>
							</div>
						);
					})}
				</section>
			</div>
		</div>
	);
}
