import { FolderTree, RefreshCw } from "lucide-react";
import { useState } from "react";
import { ProjectList, projectLabelOf } from "../components/ProjectContext";
import type { ProjectRecordDto } from "../lib/pi-client-api";
import type { SessionView } from "../state/session-store";
import { useSessionStore } from "../state/session-store";

/**
 * ProjectSwitcher —— 工作台顶栏的 Project 上下文控件（唯一实现）。
 *
 * 它能做什么，老实说清楚：看当前会话的归属、看已声明的清单、重读，以及**真的**声明 / 删除一个
 * Project（wire 的 `set_project` / `delete_project`，落 `~/.cornfield/agent/projects.json`）。
 * 写失败（root 被别的 Project 占用 / 输入不成立 / 存储坏了）把 serve 的原始判决显示出来 ——
 * 吞掉错误比没有这个动作更坏。
 *
 * 展开态用原生 <details>：深链、刷新、键盘可达都不需要额外状态，也不会在刷新后丢失。
 * 三个「没有」（读不到 / 空集 / 不属于这条会话）由 projectLabelOf + ProjectList 一处判定，
 * 写面不改写它们的意思：清单照旧是只读读数，写动作另外摆，并且只在有东西可写时才画。
 *
 * 分层：`ProjectPanel` 是受控的无状态面板（只画 + 回调），`ProjectSwitcher` 是持有草稿、错误与
 * 忙碌态的壳，并把动作接到 store。面板因此可以脱离 React 渲染单独验证（测试直接调用它）。
 */

/** 声明表单的草稿。`defaultAgentId` 用空串表示「不指定」—— 表单里这两者就是同一件事。 */
export interface ProjectDraft {
	projectId: string;
	name: string;
	root: string;
	defaultAgentId: string;
}

export const EMPTY_PROJECT_DRAFT: ProjectDraft = { projectId: "", name: "", root: "", defaultAgentId: "" };

/** 面板的全部可变状态（壳持有，面板只画）。 */
export interface ProjectPanelState {
	draft: ProjectDraft;
	/** 要删的 projectId；空串 = 还没选 —— 不替用户默认挑一个再删。 */
	deleteTargetId: string;
	busy: boolean;
	/** 上一次写入的失败文案（表单校验或 serve 的原始判决）；成功后清空。 */
	error?: string;
}

/**
 * 草稿 → 待声明的记录。
 *
 * 这里只挡**空字段**（本地就能看出不成立的东西）：路径是不是绝对、root 有没有被别的 Project
 * 占用、存储能不能写进去，全部由 serve 判决、原文回显 —— 在客户端再写一份路径规则只会造出
 * 两套迟早不一致的判据。
 *
 * 送出去的是 trim 过的值：去空格是**调用方**的决定（服务端不做静默改写），在这里做就是让
 * 「屏幕上看到的」与「声明出去的」一致。`defaultAgentId` 只在真的选了才带字段：缺省 = 不声明
 * 默认 Agent，与空串不是一回事，不留一个空串给服务端猜。
 */
export function projectDraftToRecord(
	draft: ProjectDraft,
): { ok: true; record: ProjectRecordDto } | { ok: false; error: string } {
	const projectId = draft.projectId.trim();
	if (projectId === "") return { ok: false, error: "projectId 不能为空" };
	const name = draft.name.trim();
	if (name === "") return { ok: false, error: "名称不能为空" };
	const root = draft.root.trim();
	if (root === "") return { ok: false, error: "root 不能为空" };

	const record: ProjectRecordDto = { projectId, name, root };
	const agentId = draft.defaultAgentId.trim();
	if (agentId !== "") record.defaultAgentId = agentId;
	return { ok: true, record };
}

/**
 * 面板本体（受控、无 hook）：清单 + 声明表单 + 删除动作 + 错误回显。
 *
 * 未连接时不画写面：一条发不出去的命令不是「声明」，ProjectList 已经在那里说明 registry 不可用。
 */
export function ProjectPanel({
	view,
	state,
	onRefresh,
	onChange,
	onDeclare,
	onDelete,
}: {
	view: SessionView;
	state: ProjectPanelState;
	/** 重读 registry（含当前会话归属）；缺省时不显示刷新钮。 */
	onRefresh?: () => void;
	/** 改草稿 / 改删除目标 / 清错（一次一处，仍然是同一个受控状态）。 */
	onChange: (patch: Partial<ProjectPanelState>) => void;
	onDeclare: () => void;
	onDelete: () => void;
}): React.JSX.Element {
	const { draft } = state;
	const declared = view.projects ?? [];
	const field =
		"min-w-0 rounded-md border border-hairline bg-surface px-2 py-1 text-[12px] text-ink outline-none placeholder:text-ink-faint";

	return (
		<div className="absolute right-0 z-menu mt-1 w-[380px] rounded-[12px] border border-hairline-strong bg-surface p-3 shadow-xl">
			<div className="mb-2 flex items-center gap-2">
				<span className="text-[10.5px] font-semibold tracking-[0.08em] text-ink-faint uppercase">项目</span>
				<span className="flex-1" />
				{onRefresh && (
					<button
						type="button"
						className="cbtn"
						onClick={onRefresh}
						aria-label="重新读取项目列表"
						title="重新读取项目列表"
					>
						<RefreshCw size={13} strokeWidth={1.5} />
					</button>
				)}
			</div>

			<ProjectList view={view} />

			{view.connected && (
				<div className="mt-3 border-t border-hairline pt-2.5">
					<div className="mb-1.5 text-[10.5px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
						声明 / 更新
					</div>
					<div className="flex items-center gap-1.5">
						<input
							value={draft.projectId}
							onChange={e => onChange({ draft: { ...draft, projectId: e.target.value } })}
							onKeyDown={e => {
								if (e.key === "Enter") onDeclare();
							}}
							placeholder="project id"
							aria-label="project id"
							className={`${field} w-[110px] flex-1 font-mono`}
						/>
						<input
							value={draft.name}
							onChange={e => onChange({ draft: { ...draft, name: e.target.value } })}
							onKeyDown={e => {
								if (e.key === "Enter") onDeclare();
							}}
							placeholder="名称"
							aria-label="名称"
							className={`${field} flex-1`}
						/>
					</div>
					<input
						value={draft.root}
						onChange={e => onChange({ draft: { ...draft, root: e.target.value } })}
						onKeyDown={e => {
							if (e.key === "Enter") onDeclare();
						}}
						placeholder="/绝对/项目/根路径"
						aria-label="项目根路径"
						className={`${field} mt-1.5 w-full font-mono`}
					/>
					<div className="mt-1.5 flex items-center gap-1.5">
						<select
							value={draft.defaultAgentId}
							onChange={e => onChange({ draft: { ...draft, defaultAgentId: e.target.value } })}
							aria-label="默认 Agent"
							title="该 Project 的默认 Agent（§10 解析链第 2 级）；不指定 = 不声明"
							className={`${field} flex-1`}
						>
							<option value="">不指定默认 Agent</option>
							{view.agents.map(agent => (
								<option key={agent.id} value={agent.id}>
									{agent.name}（{agent.id}）
								</option>
							))}
						</select>
						<button type="button" className="cbtn shrink-0" disabled={state.busy} onClick={onDeclare}>
							声明
						</button>
					</div>

					{declared.length > 0 && (
						<div className="mt-2 flex items-center gap-1.5 border-t border-hairline pt-2">
							<select
								value={state.deleteTargetId}
								onChange={e => onChange({ deleteTargetId: e.target.value })}
								aria-label="要删除的 Project"
								className={`${field} flex-1`}
							>
								<option value="">选择要删除的 Project</option>
								{declared.map(project => (
									<option key={project.projectId} value={project.projectId}>
										{project.name}
									</option>
								))}
							</select>
							<button
								type="button"
								className="cbtn shrink-0 text-danger"
								disabled={state.busy || state.deleteTargetId === ""}
								onClick={onDelete}
							>
								删除
							</button>
						</div>
					)}
				</div>
			)}

			{state.error && (
				<div className="mt-2 rounded-md border border-danger/30 bg-danger/5 px-2.5 py-1.5 text-[11.5px] break-all text-danger">
					{state.error}
				</div>
			)}
		</div>
	);
}

export function ProjectSwitcher({
	view,
	onRefresh,
}: {
	view: SessionView;
	/** 重读 registry（含当前会话归属）；缺省时不显示刷新钮。 */
	onRefresh?: () => void;
}): React.JSX.Element {
	const store = useSessionStore();
	const { label, title } = projectLabelOf(view);
	const [state, setState] = useState<ProjectPanelState>({
		draft: EMPTY_PROJECT_DRAFT,
		deleteTargetId: "",
		busy: false,
	});

	/** 合并式更新：一次异步动作会先后改忙碌态与错误，逐次 setState 会让它们互相覆盖。 */
	const patch = (next: Partial<ProjectPanelState>): void => setState(prev => ({ ...prev, ...next }));

	const run = async (action: () => Promise<unknown>, after?: () => void): Promise<void> => {
		patch({ busy: true, error: undefined });
		try {
			await action();
			after?.();
		} catch (err) {
			// serve 的原始判决原样显示：这里换一句自造的话就是让用户去猜真正发生了什么。
			patch({ error: err instanceof Error ? err.message : String(err) });
		} finally {
			patch({ busy: false });
		}
	};

	/** 声明/更新：本地能看出的不成立先挡下来，其余交给 serve 判决（并把它的原文显示出来）。 */
	const declare = (): void => {
		const parsed = projectDraftToRecord(state.draft);
		if (!parsed.ok) {
			patch({ error: parsed.error });
			return;
		}
		void run(() => store.setProject(parsed.record));
	};

	/** 删除：没选目标就不发命令（一条删空名字的命令不是删除），选了才真的删。 */
	const remove = (): void => {
		const target = state.deleteTargetId;
		if (target === "") {
			patch({ error: "先选一个要删除的 Project" });
			return;
		}
		void run(
			() => store.deleteProject(target),
			() => patch({ deleteTargetId: "" }),
		);
	};

	return (
		<details className="relative shrink-0">
			<summary className="chip whitespace-nowrap" title={title}>
				<FolderTree size={13} strokeWidth={1.5} />
				<b>{label}</b>
			</summary>
			<ProjectPanel
				view={view}
				state={state}
				{...(onRefresh ? { onRefresh } : {})}
				onChange={patch}
				onDeclare={declare}
				onDelete={remove}
			/>
		</details>
	);
}
