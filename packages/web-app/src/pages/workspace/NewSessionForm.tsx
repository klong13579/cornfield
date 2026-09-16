import { Plus } from "lucide-react";
import type { ProjectRecordDto } from "../../lib/pi-client-api";
import { type AgentFocusSource, activeAgentIdOf, activeAgentOf } from "../../state/agent-context";
import type { SessionView } from "../../state/session-store";

/**
 * 新建会话表单（T15「工作台三件」第一件）。
 *
 * 这一屏只做两件事，两件都要老实：
 *   1. **收下这次新建的三个意图**：Agent / Project / 标题；
 *   2. **说清每个意图今天落到哪** —— 落得下去的发出去，落不下去的当场明说。静默丢弃等于
 *      让用户以为自己选了一个其实没生效的东西，那比不提供这个控件更糟。
 *
 * 今天的落点（都是查过实现的事实，不是猜测）：
 *   - **Agent**：**可写**。提交走 store 的 `newSession` 这一条唯一路径：先把目标 Agent 切过去
 *     并**等 serve 确认**（attach + switch_session 两半都 await），确认不了就整条命令不发；
 *     确认之后才带**显式目标**发 `new_session`（wire 的 `sessionId`）。serve 逐帧并发处理
 *     （wire-server.ts `void core.handleCommand(...)`），所以「先切后建」如果不等切换落地，
 *     就会建到**旧** Agent 上 —— 这个顺序由 store 一处保证，这一屏只负责把选中的 Agent 交出去。
 *   - **标题**：wire 有 `set_session_name`，由适配层在**创建成功之后**跟一次（落在新会话上）。
 *   - **Project**：**没有**「把会话绑到某个 Project」的命令：会话归属由工作目录按 WP4 的 root
 *     规则推导（`matchProjectForPath`），创建时不可选。
 *
 * 组件是受控的、无 hook 的（仓库既有惯例，见 layout/ProjectSwitcher.tsx 的 ProjectPanel）：状态
 * 由外壳持有，判据都是从这里导出的纯函数，单测直接调用即可覆盖。
 */

/** 表单草稿。空串一律表示「不指定」——与「选了某个值」不是一回事。 */
export interface NewSessionDraft {
	/** "" = 用当前焦点 Agent（§10 解析链第 1 级）。 */
	agentId: string;
	/** "" = 不指定 Project。 */
	projectId: string;
	/** "" = 不指定标题。 */
	title: string;
}

export const EMPTY_NEW_SESSION_DRAFT: NewSessionDraft = { agentId: "", projectId: "", title: "" };

/**
 * 提交给写入面的入参形状 —— store 的 `newSession({ agentId, projectId, title })` 收的就是这三个。
 *
 * 三个字段都可选：缺省与空串在这里不是一回事，所以空串一律不带出去，不留一个空值给服务端猜。
 */
export interface NewSessionInput {
	agentId?: string;
	projectId?: string;
	title?: string;
}

/** 草稿 → 入参（只带真的选过/写过的字段）。 */
export function newSessionInputOf(draft: NewSessionDraft): NewSessionInput {
	const input: NewSessionInput = {};
	const agentId = draft.agentId.trim();
	const projectId = draft.projectId.trim();
	const title = draft.title.trim();
	if (agentId !== "") input.agentId = agentId;
	if (projectId !== "") input.projectId = projectId;
	if (title !== "") input.title = title;
	return input;
}

/**
 * 默认 Agent 的来源 —— 只报客户端**真看得见**的那几级（§10 解析链）。
 *
 * 解析链是 `session.agentId > project.defaultAgentId > workspace.defaultAgentId >
 * user.globalDefaultAgentId > bootstrap`，wire 面上只有前两级有事实可查：
 *   - 第 1 级：本连接焦点 Agent（`view.activeAgentId`，或注册表里标了 active/attached 的那个）；
 *   - 第 2 级：当前 Project 声明的 `defaultAgentId`（`list_projects` 带出来的）。
 * 第 3/4 级与 bootstrap 没有任何命令会告诉我们，所以这一档说「看不到」——**不猜一个来源**。
 *
 * 入参是**这一屏上真正会被用的那个 Agent**：没改选就是焦点 Agent（第 1 级），改选了就是被改选的
 * 那个（那就只能靠第 2 级或看不到）。
 */
export type AgentIdentitySource =
	| { kind: "focus"; label: string }
	| { kind: "project"; label: string; projectName: string }
	| { kind: "unknown"; label: string };

export function agentIdentitySource(
	view: AgentFocusSource & Pick<SessionView, "projects" | "currentProjectId">,
	agentId: string,
): AgentIdentitySource {
	if (agentId === activeAgentIdOf(view)) {
		return { kind: "focus", label: "本会话焦点（§10 第 1 级）" };
	}
	const current = currentProjectOf(view);
	if (current?.defaultAgentId === agentId) {
		return {
			kind: "project",
			projectName: current.name,
			label: `Project「${current.name}」的默认 Agent（§10 第 2 级）`,
		};
	}
	return { kind: "unknown", label: "来源看不见：解析链第 3/4 级（Workspace / 用户全局）与 bootstrap 不在 wire 面上" };
}

/** 当前会话落在哪个 Project（没归属 / 没读到 / 读失败都是 undefined）。 */
function currentProjectOf(view: Pick<SessionView, "projects" | "currentProjectId">): ProjectRecordDto | undefined {
	if (!view.currentProjectId) return undefined;
	return view.projects?.find(project => project.projectId === view.currentProjectId);
}

/**
 * Project 字段的五态 —— 「读不到」和「没声明过」不是一件事（与 ProjectList 同一套判据）。
 *
 * 面板把每一态画成自己的话，因为把它折叠成「没有 Project」就是在替一个没读到的答案发言。
 */
export type ProjectFieldState =
	| { kind: "disconnected" }
	| { kind: "pending" }
	| { kind: "error"; message: string }
	| { kind: "undeclared" }
	| { kind: "declared"; projects: ProjectRecordDto[]; currentProjectId?: string };

export function projectFieldState(
	view: Pick<SessionView, "connected" | "projects" | "projectsPending" | "projectsError" | "currentProjectId">,
): ProjectFieldState {
	if (!view.connected) return { kind: "disconnected" };
	if (view.projectsError !== undefined) return { kind: "error", message: view.projectsError };
	if (view.projectsPending || view.projects === undefined) return { kind: "pending" };
	if (view.projects.length === 0) return { kind: "undeclared" };
	return {
		kind: "declared",
		projects: view.projects,
		...(view.currentProjectId === undefined ? {} : { currentProjectId: view.currentProjectId }),
	};
}

/** Project 字段今天的写入面：没有。缺的是「把新会话绑到一个 Project」这条命令。 */
export const PROJECT_FIELD_NOTE =
	"暂不支持写入：没有「把会话绑到某个 Project」的命令 —— 会话归属由工作目录按 root 规则推导";

/** 标题字段今天的写入面：创建成功后由适配层跟一次 `set_session_name`（wire 没有「创建时命名」）。 */
export const TITLE_FIELD_NOTE = "创建成功后落名：wire 没有「创建时命名」，是创建后紧跟一次 set_session_name";

export interface NewSessionSubmitState {
	canSubmit: boolean;
	/** 为什么现在提交不了（空串 = 能提交）。 */
	hint: string;
}

/**
 * 这次新建能不能提交。
 *
 * 两条都是从上面那些事实上读出来的：未连接（发不出去）、注册表里一个 Agent 都没有（新会话落在谁
 * 身上无从确定）。**不再按「选了别的 Agent」挡提交** —— 那条路今天真的能走（store 的 `newSession`
 * 先切后建，等不到确认就不建），挡它就是挡住一件已经正确的事。选中的 Agent 到底存不存在不在这里
 * 判：本地没有资格替 serve 下这个结论，serve 的原文才是权威。
 */
export function newSessionSubmitState(view: AgentFocusSource & Pick<SessionView, "connected">): NewSessionSubmitState {
	if (!view.connected) return { canSubmit: false, hint: "未连接——命令发不出去" };
	if (view.agents.length === 0) {
		return { canSubmit: false, hint: "注册表里还没有 Agent：新会话落在谁身上无从确定" };
	}
	return { canSubmit: true, hint: "" };
}

export interface NewSessionFormProps {
	view: SessionView;
	draft: NewSessionDraft;
	onChange: (draft: NewSessionDraft) => void;
	onCreate: (input: NewSessionInput) => void;
}

export function NewSessionForm({ view, draft, onChange, onCreate }: NewSessionFormProps): React.JSX.Element {
	const agents = view.agents;
	const focusId = activeAgentIdOf(view);
	const focusAgent = activeAgentOf(view);
	const project = projectFieldState(view);
	const currentProject = currentProjectOf(view);
	const submit = newSessionSubmitState(view);
	const picked = draft.agentId.trim();
	const overridden = picked !== "" && picked !== focusId;
	// 这一屏真正会被用的那个 Agent：改选了就是被改选的那个，否则是焦点 Agent。
	const effectiveAgentId = overridden ? picked : focusId;
	const effectiveAgent = overridden ? agents.find(agent => agent.id === picked) : focusAgent;
	const identity = effectiveAgentId === undefined ? undefined : agentIdentitySource(view, effectiveAgentId);

	return (
		<form
			className="mx-auto mb-1 max-w-[760px] rounded-lg border border-hairline bg-surface-2 px-3 py-2"
			onSubmit={event => {
				event.preventDefault();
				if (submit.canSubmit) onCreate(newSessionInputOf(draft));
			}}
		>
			<div className="mb-1.5 flex items-center gap-2">
				<span className="text-[10.5px] font-semibold tracking-[0.08em] text-ink-faint uppercase">新建会话</span>
				<span className="flex-1" />
				{/* 落不下去的字段一律在提交前就写在这里，不在提交时静默丢掉 */}
				<span className="text-[11px] text-ink-faint">Agent 可写（先切过去再建）· Project 今天写不进去</span>
			</div>

			<div className="flex flex-wrap items-end gap-2">
				<label className="flex min-w-0 flex-col gap-0.5" title="新会话由哪个 Agent 服务">
					<span className="text-[11px] text-ink-faint">Agent</span>
					<select
						value={picked}
						onChange={e => onChange({ ...draft, agentId: e.target.value })}
						aria-label="Agent"
						disabled={!view.connected || agents.length === 0}
						className="min-w-0 rounded-md border border-hairline bg-surface px-2 py-1 text-[12px] text-ink outline-none focus:border-accent"
					>
						<option value="">
							{focusAgent ? `默认：${focusAgent.name}（${focusAgent.id}）` : "默认：当前焦点"}
						</option>
						{agents.map(agent => (
							<option key={agent.id} value={agent.id}>
								{agent.name}（{agent.id}）
							</option>
						))}
					</select>
				</label>

				<label className="flex min-w-0 flex-1 flex-col gap-0.5" title={PROJECT_FIELD_NOTE}>
					<span className="text-[11px] text-ink-faint">Project</span>
					<select
						value={draft.projectId}
						onChange={e => onChange({ ...draft, projectId: e.target.value })}
						aria-label="Project"
						className="min-w-0 rounded-md border border-hairline bg-surface px-2 py-1 text-[12px] text-ink outline-none focus:border-accent"
					>
						<option value="">不指定</option>
						{project.kind === "declared" &&
							project.projects.map(item => (
								<option key={item.projectId} value={item.projectId}>
									{item.name}
									{item.projectId === project.currentProjectId ? "（当前）" : ""}
								</option>
							))}
					</select>
				</label>

				<label className="flex min-w-0 flex-1 flex-col gap-0.5" title={TITLE_FIELD_NOTE}>
					<span className="text-[11px] text-ink-faint">标题</span>
					<input
						value={draft.title}
						onChange={e => onChange({ ...draft, title: e.target.value })}
						aria-label="标题"
						placeholder="给这次会话起个名字"
						spellCheck={false}
						className="min-w-0 rounded-md border border-hairline bg-surface px-2 py-1 text-[12px] text-ink outline-none placeholder:text-ink-faint focus:border-accent"
					/>
				</label>

				<button
					type="submit"
					className="btn-secondary cbtn"
					disabled={!submit.canSubmit}
					title={submit.canSubmit ? "在下方 Agent 上新建会话" : submit.hint}
				>
					<Plus size={12} strokeWidth={1.5} />
					新建会话
				</button>
			</div>

			{/* 身份读数：新会话将由谁服务（或你改选了谁）、它的权威是从哪一级来的 */}
			<div className="mt-1.5 text-[11px] text-ink-subtle">
				{effectiveAgentId !== undefined ? (
					<>
						{overridden ? "已改选 " : "新会话将由 "}
						<span className="text-ink-muted">{effectiveAgent?.name ?? effectiveAgentId}</span>
						<span className="font-mono">（{effectiveAgentId}）</span>
						{!overridden && " 服务"}
						{identity && <span> · 来源：{identity.label}</span>}
					</>
				) : (
					<span>
						{view.connected ? "注册表里还没有 Agent——新会话落在谁身上无从确定" : "未连接——读不到 Agent 注册表"}
					</span>
				)}
				{currentProject?.defaultAgentId && (
					<span className="block">
						本 Project 声明了默认 Agent <span className="font-mono">{currentProject.defaultAgentId}</span>
						（§10 第 2 级）
						{currentProject.defaultAgentId === focusId
							? " · 与当前焦点一致"
							: " · 与当前焦点不同：不改选时仍按当前焦点（§10 第 1 级优先）"}
					</span>
				)}
			</div>

			{/* 三个字段各自的去向，逐条明说：不写进去的字段不许只靠一个点不动的控件暗示 */}
			<div className="mt-1 space-y-0.5 text-[11px] text-ink-faint">
				<div>
					Agent：
					{overridden
						? "已改选 —— 提交时先切到它并等 serve 确认，确认不了就不建；确认之后才在它上面建会话"
						: "新建时用当前焦点的 Agent（它已经是本连接的焦点，不再多切一次）"}
				</div>
				<div>
					Project：
					{project.kind === "disconnected"
						? "未连接 —— Project registry 不可用"
						: project.kind === "pending"
							? "读取中 —— 此刻还不知道声明过哪些 Project"
							: project.kind === "error"
								? `读取失败：${project.message}`
								: project.kind === "undeclared"
									? "还没声明过任何 Project（~/.cornfield/agent/projects.json）"
									: `已声明 ${project.projects.length} 个（只作参考）`}
					{" · "}
					{PROJECT_FIELD_NOTE}
				</div>
				<div>标题：{TITLE_FIELD_NOTE}</div>
			</div>

			{!submit.canSubmit && <div className="mt-1 text-[11px] text-warning">{submit.hint}</div>}
		</form>
	);
}
