import { useState } from "react";
import { useSessionStore } from "../../state/session-store";
import { useSession } from "../../state/use-session";

/**
 * Todo 面板（FR-5）—— 按阶段分组 + 2px 进度细条（完成变绿）+ 任务行式排列。
 * 数据即会话权威快照的 todoPhases；add/toggle/remove 走 set_todos 写回。
 */
export function TodoView(): React.JSX.Element {
	const view = useSession();
	const store = useSessionStore();
	const [newTask, setNewTask] = useState<Record<string, string>>({});

	const total = view.todo.reduce((sum, p) => sum + p.tasks.length, 0);
	const done = view.todo.reduce((sum, p) => sum + p.tasks.filter(t => t.status === "completed").length, 0);

	return (
		<div className="px-10 pt-8 pb-12">
			<div className="mx-auto max-w-[720px]">
				<div className="mb-8 flex items-baseline gap-3.5">
					<h1 className="text-[32px] font-semibold tracking-[-0.8px] text-ink">Todo</h1>
					<span className="text-[13px] text-ink-faint">
						全部会话任务汇总 · {total} 项 · {done} 已完成
					</span>
				</div>

				{view.todo.length === 0 && (
					<div className="py-16 text-center text-[13px] text-ink-faint">
						暂无任务 —— 在会话工作台让 agent 随手记几条。
					</div>
				)}

				{view.todo.map(phase => {
					const phaseDone = phase.tasks.filter(t => t.status === "completed").length;
					const ratio = phase.tasks.length === 0 ? 0 : Math.round((phaseDone / phase.tasks.length) * 100);
					return (
						<div key={phase.name} className="mb-9">
							<div className="mb-2 flex items-baseline gap-2.5">
								<h2 className="text-[17px] font-semibold tracking-[-0.3px] text-ink">{phase.name}</h2>
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
			</div>
		</div>
	);
}
