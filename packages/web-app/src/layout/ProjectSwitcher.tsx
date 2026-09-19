import type { ProjectDeclareInput } from "@cornfield/wire";
import { FolderTree, RefreshCw } from "lucide-react";
import { useState } from "react";
import { PathField } from "../components/PathField";
import { ProjectAttributionNote, ProjectList } from "../components/ProjectContext";
import type { DirectoryPicker } from "../lib/path-picker";
import type { ProjectRecordDto } from "../lib/pi-client-api";
import { projectLabelOf, projectRegistryState } from "../lib/project-read-model";
import { loadRecentPaths, RECENT_PATH_KEYS, rememberRecentPath } from "../lib/recent-paths";
import { activeAgentIdOf } from "../state/agent-context";
import type { SessionView } from "../state/session-store";
import { useSessionStore } from "../state/session-store";

/**
 * ProjectSwitcher —— 工作台顶栏的 **Project 工作上下文选择器**（唯一实现）。
 *
 * chip 上那个短标签是**选择**，不是读数：一个显示着别的值的选择器会让人以为切换没生效。
 * 所以这里三块各说各的事，不许互相顶替：
 *   - **chip（summary）**：工作上下文 —— 下一个新会话落在哪（`projectLabelOf`）；
 *   - **顶部的选择器**：改这个选择（`store.setWorkingProject`，不重启 serve、不发命令）；
 *   - **当前会话归属**：serve 的权威读数 + 来源（会话记下的 / 按目录算出的）。
 *
 * 它还能**真的**保存 / 删除一个 Project（wire 的 `set_project` / `delete_project`，落
 * `~/.cornfield/agent/projects.json`）。写失败（root 被别的 Project 占用 / 输入不成立 /
 * 存储坏了）把 serve 的原始判决显示出来 —— 吞掉错误比没有这个动作更坏。
 *
 * root 字段用 `PathField`：有桌面壳时走壳的系统选择器，没有壳（网页直开）时走 serve 的选择框
 * （wire 的 `pick_directory`，由 `ProjectSwitcher` 把 store 那条转发接进来）—— 浏览器拿不到绝对
 * 路径，所以没有壳时只能由 serve 弹。两条通路都没有才不画那个按钮。
 * 候选里除本机用过的路径外，还包括**已声明项目的 root** —— 它们本来就是这台机器上
 * 真正当过项目根的那几个目录。
 *
 * **保存钮与 root 同排**（`PathField` 的 `trailing`，与设置页「工作目录」同一处约定）：选完目录那
 * 一眼就要看见落盘的动作。它此前在下面隔着一行说明和一个选择框 —— 用的人只会说「没有地方保存」。
 * 按钮上写「保存」（表单前面那个人要做的就是这一件事），wire 上叫 `set_project`（声明/更新语义）。
 *
 * 面板自己也受视口约束（宽度不超视口，高度不超视口并可滚动）：固定 380px + 无高度上限的绝对
 * 定位在矮窗口里会把保存钮推到屏幕外，而那时页面根本没有可滚动的地方能把它找回来。
 *
 * 写面只问 root（+ 可选默认 Agent）：`projectId` / `name` 不问用户，由 serve 从目录名推导 ——
 * 它们不是一个需要人决策的信息，让用户在手抄一遍只会在两份都“差不多对”的输入里埋一个不一致。
 *
 * 展开态用原生 <details>：深链、刷新、键盘可达都不需要额外状态，也不会在刷新后丢失。
 * 读不到 registry 与「没声明过」由 `ProjectList` 一处判定并分开显示，写面不改写它们的意思。
 *
 * 分层：`ProjectPanel` 是受控的无状态面板（只画 + 回调），`ProjectSwitcher` 是持有草稿、错误与
 * 忙碌态的壳，并把动作接到 store。面板因此可以脱离 React 渲染单独验证（测试直接调用它）。
 */

/** 保存表单的草稿。 */
export interface ProjectDraft {
	root: string;
	/** 空串表示「不指定」—— 表单里这两者就是同一件事。仅当表单真的问了这一档时才有值。 */
	defaultAgentId: string;
}

export const EMPTY_PROJECT_DRAFT: ProjectDraft = { root: "", defaultAgentId: "" };

/** 面板上真正会写盘的两个动作。 */
export type ProjectWrite = "save" | "delete";

/** 面板的全部可变状态（壳持有，面板只画）。 */
export interface ProjectPanelState {
	draft: ProjectDraft;
	/** 要删的 projectId；空串 = 还没选 —— 不替用户默认挑一个再删。 */
	deleteTargetId: string;
	/**
	 * 正在进行的写动作，`null` = 空闲。
	 *
	 * 不写成 boolean：这两个动作各有各的按钮，而按钮上那句「保存中…」/「删除中…」必须是**真话** ——
	 * 一个笼统的「忙碌」会让没在跑的那个钮也这么说。
	 */
	busy: ProjectWrite | null;
	/** 上一次写入的失败文案（表单校验或 serve 的原始判决）；成功后清空。 */
	error?: string;
}

/**
 * 草稿 → 声明入参（`set_project`）。
 *
 * 这里只挡**空 root**（本地就能看出不成立的东西）：路径是不是绝对、root 有没有被别的 Project
 * 占用、目录名撞了怎么避让，全部由 serve 判决、原文回显 —— 在客户端再写一份路径规则只会造出
 * 两套迟早不一致的判据（目录名还是**那台机器**的路径语义）。
 *
 * 送出去的是 trim 过的值：去空格是**调用方**的决定（服务端不做静默改写），在这里做就是让
 * 「屏幕上看到的」与「声明出去的」一致。`defaultAgentId` 只在真的问了、真的选了才带字段：
 * 缺省 = 不声明默认 Agent，与空串不是一回事，不留一个空串给服务端猜。
 */
export function projectDraftToInput(
	draft: ProjectDraft,
): { ok: true; input: ProjectDeclareInput } | { ok: false; error: string } {
	const root = draft.root.trim();
	if (root === "") return { ok: false, error: "根路径不能为空" };

	const input: ProjectDeclareInput = { root };
	const agentId = draft.defaultAgentId.trim();
	if (agentId !== "") input.defaultAgentId = agentId;
	return { ok: true, input };
}

/**
 * 默认 Agent 这一档要不要问：当前焦点就是 `default` 时不问。
 *
 * `default` 不是一名可以被指派的员工 —— 它是 serve 进程自己的本地 agent（serve cwd 那个），
 * 解析链最后本来就会落到它。给它声明「默认 Agent = default」是把一个已经成立的缺省再声明一遍，
 * 表单里多出来的那个选择框没有任何信息量。
 *
 * 焦点用 `activeAgentIdOf` 解，不另写一份：哪个 Agent 在工作是全屏共同的前提。
 * 面板与提交路径都问这一个函数，所以「没问的东西不会被提交」也是同一条判据推出来的。
 */
export function offersDefaultAgent(view: SessionView): boolean {
	return activeAgentIdOf(view) !== "default";
}

/**
 * 保存表单里 root 字段的候选：已声明项目的 root 在前，本机用过的路径在后，**按首次出现去重**。
 *
 * 去重放在这里而不是路径控件里：同一个目录既是已声明的项目、又在用过的历史里是常态，
 * 而那个重复只对同时拿着两份清单的人看得见。顺序也是语义的一部分 —— 已声明过的项目根
 * 比「上次手打过什么」更可信，所以它先出现。
 */
export function rootCandidates(declared: readonly ProjectRecordDto[], used: readonly string[]): string[] {
	return [...new Set([...declared.map(project => project.root), ...used])];
}

/**
 * 面板本体（受控、无 hook）：工作上下文选择器 + 当前会话归属 + 清单 + 保存表单 + 删除动作 + 错误回显。
 *
 * 未连接时不画写面：一条发不出去的命令不是「保存」，ProjectList 已经在那里说明 registry 不可用。
 *
 * 表单只问 root（+ 当前焦点不是 `default` 时的那一档默认 Agent）：`projectId` / `name` 不问 ——
 * 它们由 serve 从目录名推导，屏上只留一句说明把这件事说在脸上。
 */
export function ProjectPanel({
	view,
	state,
	workingProjectId,
	onSelectProject,
	onRefresh,
	onChange,
	onDeclare,
	onDelete,
	rootSuggestions = [],
	servePicker,
}: {
	view: SessionView;
	state: ProjectPanelState;
	/** 工作上下文当前选中的 id（空串 = 不指定）；它由 store 持有，不是面板的草稿状态。 */
	workingProjectId: string;
	/** 改工作上下文（接 store.setWorkingProject）；空串 = 不指定。 */
	onSelectProject: (projectId: string) => void;
	/** 重读 registry（含当前会话归属）；缺省时不显示刷新钮。 */
	onRefresh?: () => void;
	/** 改草稿 / 改删除目标 / 清错（一次一处，仍然是同一个受控状态）。 */
	onChange: (patch: Partial<ProjectPanelState>) => void;
	/** 保存这条草稿（表单里那个钮；wire 的 `set_project`）。 */
	onDeclare: () => void;
	onDelete: () => void;
	/** 本机用过的 root（壳持有，落 localStorage）；候选里排在已声明项目的 root 之后。 */
	rootSuggestions?: readonly string[];
	/** 没有桌面壳时的目录选择通路（serve 的 `pick_directory`）；缺省 = 这条通路现在不可用。 */
	servePicker?: DirectoryPicker;
}): React.JSX.Element {
	const { draft } = state;
	const registry = projectRegistryState(view);
	const declared = registry.kind === "ready" ? registry.projects : [];
	/** 选过、但已声明清单里没有它：得给它一个选项，否则 <select> 会把 value 画成空白。 */
	const staleId =
		workingProjectId !== "" && !declared.some(project => project.projectId === workingProjectId)
			? workingProjectId
			: undefined;
	const field =
		"min-w-0 rounded-md border border-hairline bg-surface px-2 py-1 text-[12px] text-ink outline-none placeholder:text-ink-faint";

	return (
		<div className="absolute right-0 z-menu mt-1 max-h-[calc(100vh-3.5rem)] w-[380px] max-w-[calc(100vw-1rem)] overflow-y-auto overscroll-contain rounded-[12px] border border-hairline-strong bg-surface p-3 shadow-xl">
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

			<div className="mb-2.5">
				<div className="mb-1.5 text-[10.5px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
					工作上下文
				</div>
				<select
					value={workingProjectId}
					onChange={e => onSelectProject(e.target.value)}
					aria-label="工作上下文"
					disabled={!view.connected}
					title="下一个新会话落在哪个 Project 的根上；切换不重启 serve"
					className={`${field} w-full`}
				>
					<option value="">不指定（新会话不声明归属）</option>
					{declared.map(project => (
						<option key={project.projectId} value={project.projectId}>
							{project.name}
						</option>
					))}
					{staleId !== undefined && <option value={staleId}>{staleId}（已不在注册表）</option>}
				</select>
				<div className="mt-1 text-[11px] text-ink-faint">
					切它不重启 serve：只在建**新**会话时带上去，已经在跑的会话不动。
				</div>
			</div>

			<ProjectAttributionNote view={view} />

			<ProjectList view={view} />

			{view.connected && (
				<div className="mt-3 border-t border-hairline pt-2.5">
					<div className="mb-1.5 text-[10.5px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
						保存项目
					</div>
					{/* 保存钮与 root 同排（`PathField` 的 `trailing`，与设置页「工作目录」同一处约定）：
					    选完目录那一眼就要看见落盘的动作。它此前在下面隔着一行说明和一个选择框，
					    用的人只会说「没有地方保存」。 */}
					<PathField
						id="project-root"
						value={draft.root}
						onChange={value => onChange({ draft: { ...draft, root: value }, error: undefined })}
						onEnter={onDeclare}
						onPickError={message => onChange({ error: message })}
						ariaLabel="项目根路径"
						placeholder="/绝对/项目/根路径"
						inputClassName={`${field} min-w-0 flex-1 font-mono`}
						suggestions={rootCandidates(declared, rootSuggestions)}
						trailing={
							<button
								type="button"
								className="btn btn-sm shrink-0"
								disabled={state.busy !== null}
								onClick={onDeclare}
							>
								{state.busy === "save" ? "保存中…" : "保存"}
							</button>
						}
						{...(servePicker ? { servePicker } : {})}
					/>
					<div className="mt-1 text-[11px] text-ink-faint">
						id 与名称取目录名，由 serve 定：同一个目录再保存一次是更新，与已有 Project 撞名就加 -2。
					</div>
					{offersDefaultAgent(view) && (
						<select
							value={draft.defaultAgentId}
							onChange={e => onChange({ draft: { ...draft, defaultAgentId: e.target.value } })}
							aria-label="默认 Agent"
							title="该 Project 的默认 Agent（§10 解析链第 2 级）；不指定 = 不声明"
							className={`${field} mt-1.5 w-full`}
						>
							<option value="">不指定默认 Agent</option>
							{view.agents.map(agent => (
								<option key={agent.id} value={agent.id}>
									{agent.name}（{agent.id}）
								</option>
							))}
						</select>
					)}

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
								disabled={state.busy !== null || state.deleteTargetId === ""}
								onClick={onDelete}
							>
								{state.busy === "delete" ? "删除中…" : "删除"}
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
		busy: null,
	});
	/** 本机用过的 root（localStorage）—— 保存成功后才记，它不是「打过字的路径」，是「用成的路径」。 */
	const [rootSuggestions, setRootSuggestions] = useState<string[]>(() =>
		loadRecentPaths(RECENT_PATH_KEYS.projectRoot),
	);

	/** 合并式更新：一次异步动作会先后改忙碌态与错误，逐次 setState 会让它们互相覆盖。 */
	const patch = (next: Partial<ProjectPanelState>): void => setState(prev => ({ ...prev, ...next }));

	/**
	 * 跑一个写动作。
	 *
	 * `write` 指明是哪一个：两个写钮各自只认自己那一格，忙碌文案不会出现在没在跑的那个钮上。
	 * `after` 拿得到动作的返回值："保存成功之后要记什么" 取决于存储真正落盘的那一份，不是我们发出去的那份。
	 */
	const run = async <T,>(
		write: ProjectWrite,
		action: () => Promise<T>,
		after?: (result: T) => void,
	): Promise<void> => {
		patch({ busy: write, error: undefined });
		try {
			const result = await action();
			after?.(result);
		} catch (err) {
			// serve 的原始判决原样显示：这里换一句自造的话就是让用户去猜真正发生了什么。
			patch({ error: err instanceof Error ? err.message : String(err) });
		} finally {
			patch({ busy: null });
		}
	};

	/**
	 * 保存（wire 上叫 `set_project`）：本地能看出的不成立先挡下来，其余交给 serve 判决
	 * （并把它的原文显示出来）。
	 *
	 * 表单没问的那一档（焦点是 `default` 时的默认 Agent）在这里一并清掉：没问过的东西不提交，
	 * 否则焦点在别处时选过的值会在用户看不见的地方被带上去。
	 */
	const declare = (): void => {
		const draft = offersDefaultAgent(view) ? state.draft : { ...state.draft, defaultAgentId: "" };
		const parsed = projectDraftToInput(draft);
		if (!parsed.ok) {
			patch({ error: parsed.error });
			return;
		}
		void run(
			"save",
			() => store.setProject(parsed.input),
			// 记的是 serve 回的那一份（root 已经 `path.resolve` 过；id / 名称也是它推的），不是输入框里那段原文。
			stored => setRootSuggestions(rememberRecentPath(RECENT_PATH_KEYS.projectRoot, stored.root)),
		);
	};

	/** 删除：没选目标就不发命令（一条删空名字的命令不是删除），选了才真的删。 */
	const remove = (): void => {
		const target = state.deleteTargetId;
		if (target === "") {
			patch({ error: "先选一个要删除的 Project" });
			return;
		}
		void run(
			"delete",
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
				workingProjectId={view.workingProjectId ?? ""}
				onSelectProject={projectId => store.setWorkingProject(projectId)}
				{...(onRefresh ? { onRefresh } : {})}
				onChange={patch}
				onDeclare={declare}
				onDelete={remove}
				rootSuggestions={rootSuggestions}
				servePicker={defaultPath => store.pickDirectory(defaultPath)}
			/>
		</details>
	);
}
