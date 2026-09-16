import { GitBranch } from "lucide-react";
import { useEffect, useState } from "react";
import type { ChildSessionNodeDto, GitChangeDto, GitChangeStateDto, GitChangesDto } from "../../lib/pi-client-api";
import { activeAgentIdOf } from "../../state/agent-context";
import type { SessionView } from "../../state/session-store";
import { useSessionStore } from "../../state/session-store";
import { useSession } from "../../state/use-session";
import { STATUS_BADGE, STATUS_LABEL, shortTime } from "./session-tree-logic";

/**
 * 右栏改动面板（工作区改动清单，wire `git_changes`）。
 *
 * ## 分组按「拿哪个会话去问的」，不按「改动属于谁」
 *
 * git 只知道「这个路径与 HEAD/index 不同」，不知道是哪次 agent 运行改的 —— 所以一条改动
 * **没有**会话归属（同一个工作区被两个会话改过时，它连唯一答案都没有）。本面板的分组因此是
 * 读的 provenance：本会话那一组是 store 按当前会话读的，每个子会话一组是按那个子会话的
 * Agent 工作区读的。组头写明是拿谁的工作区读的，子会话组给「切到该 Agent」的出口。
 *
 * ## 三种「没有」必须分开说
 *
 *   未连接   —— 读不到，且不是「没改动」
 *   读失败   —— 命令 ok:false（不是 git 仓库 / git 失败），原文照显
 *   没有改动 —— 读到了，清单确实是空的
 *
 * 把后两者混起来就是把「不知道」渲染成「什么都没改」，用户会据此得出反向的结论。
 * 成功答复里的 `error` 是**降级**通道（清单不完整），既不是读失败也不隐藏。
 *
 * ## 为什么这里不渲染每个文件的 diff
 *
 * 客户端拿不到 HEAD/index 那一份内容（wire 的 `git_changes` 只给状态清单，pi-client 没有
 * `git_diff` 入口），拿磁盘当前内容硬凑一份 diff 就是编造。所以一条改动能做的实事只有两件：
 * 在文件编辑器里打开它（真内容，走 fs_read 唯一那条路），以及切到读这份清单的会话。
 */

/**
 * 一份清单的读取状态（本会话与子会话共用同一个词表）。
 *
 * `ready` 且 `data.changes` 为空 = **读到了，确实没有改动**；`error` 才是读不到 ——
 * 这两件事在面板上是两句不同的话。
 */
export type ChangesGroupStatus = "pending" | "error" | "ready";

export interface ChangesReadState {
	status: ChangesGroupStatus;
	data?: GitChangesDto;
	error?: string;
}

/** 一组改动清单：一组 = 一次读取（本会话 / 一个子会话）。 */
export interface ChangesGroup {
	/** 身份：本会话固定 "root"，子会话用它的 sessionId。 */
	key: string;
	kind: "root" | "child";
	/** 读这份清单用的 agent —— 点条目就按它打开文件（清单里的路径相对它解析）。 */
	agentId: string;
	title: string;
	/** agent 名（+ 子会话的更新时间）。 */
	subtitle: string;
	statusLabel?: string;
	statusBadge?: string;
	state: ChangesReadState;
}

/** `git status --porcelain` 状态字母的中文（词表与 GitChangeStateDto 同一份，不增不减）。 */
export const CHANGE_STATE_LABEL: Record<GitChangeStateDto, string> = {
	modified: "修改",
	added: "新增",
	deleted: "删除",
	renamed: "重命名",
	copied: "复制",
	"type-changed": "类型变更",
	untracked: "未跟踪",
	conflicted: "冲突",
};

/** 一条改动要摆出来的轴（porcelain 的 X / Y）。 */
export interface ChangeAxisBadge {
	/** 轴名；冲突行没有轴（见下）。 */
	axis?: "暂存" | "工作区";
	label: string;
	/** 冲突：它是「需要人工合并」，不是一条普通状态，要红着显示。 */
	danger?: boolean;
}

/**
 * 一条改动的两个轴：`暂存`（HEAD → index）与 `工作区`（index → worktree）。
 *
 * 两轴而不是一个状态：porcelain 的 `MM` 同时是「暂存区改了」和「工作区又改了」，合成一格
 * 必然丢掉一个。冲突时两轴都报 conflicted —— wire 明确不把冲突拆成「索引侧 / 工作区侧」，
 * 这里就不替它编一个拆分，只报一条「需人工合并」。
 */
export function changeBadgesOf(change: GitChangeDto): ChangeAxisBadge[] {
	if (change.index === "conflicted" || change.worktree === "conflicted") {
		return [{ label: `${CHANGE_STATE_LABEL.conflicted}（需人工合并）`, danger: true }];
	}
	const badges: ChangeAxisBadge[] = [];
	if (change.index !== null) badges.push({ axis: "暂存", label: CHANGE_STATE_LABEL[change.index] });
	if (change.worktree !== null) badges.push({ axis: "工作区", label: CHANGE_STATE_LABEL[change.worktree] });
	return badges;
}

/** agent 展示名（registry 名；查不到就照抄 id —— 不编一个名字）。 */
function agentLabelOf(view: SessionView, agentId: string | undefined): string {
	if (agentId === undefined) return "会话未挂载";
	return view.agents.find(agent => agent.id === agentId)?.name ?? agentId;
}

/** 子会话一行的标题（与左栏会话树同一套回退：目标 → 用途标签 → 短 id）。 */
function childTitleOf(child: ChildSessionNodeDto): string {
	return child.objective ?? child.delegationRole ?? child.sessionId.slice(0, 8);
}

/**
 * 把会话视图 + 子会话的读取结果摆成面板要显示的分组。
 *
 * 纯函数（不碰 React、不发请求）：面板渲染的状态机是「哪一组、什么状态、显示什么」这件事本
 * 身，与谁来驱动读取无关 —— 这样它在没有 DOM 的测试里也能整份验证。
 */
export function changesGroupsOf(view: SessionView, childStates: ReadonlyMap<string, ChangesReadState>): ChangesGroup[] {
	// 本会话那一组的 agent 用**与右栏其它页同一处解析**（activeAgentIdOf：显式焦点 → serve 标的
	// active → 已 attach → 第一个）。新连接上 view.activeAgentId 往往还没被切过，拿它当门就是
	// 把「已经有默认 Agent 在跑」误报成「等待挂载」。
	const rootAgentId = activeAgentIdOf(view);
	const groups: ChangesGroup[] = [
		{
			key: "root",
			kind: "root",
			agentId: rootAgentId ?? "",
			title: "本会话",
			subtitle: agentLabelOf(view, rootAgentId),
			state: {
				// pending 优先：刷新期间上一个错误已经不作数了（那说的是上一次读取）。
				status: view.gitChangesPending ? "pending" : view.gitChangesError !== undefined ? "error" : "ready",
				...(view.gitChanges ? { data: view.gitChanges } : {}),
				...(view.gitChangesError !== undefined ? { error: view.gitChangesError } : {}),
			},
		},
	];
	for (const child of view.sessionTree?.children ?? []) {
		groups.push({
			key: child.sessionId,
			kind: "child",
			agentId: child.agentId,
			title: childTitleOf(child),
			subtitle: `${agentLabelOf(view, child.agentId)} · ${shortTime(child.updatedAt)}`,
			statusLabel: STATUS_LABEL[child.status],
			statusBadge: STATUS_BADGE[child.status],
			state: childStates.get(child.sessionId) ?? { status: "pending" },
		});
	}
	return groups;
}

interface ChangesPanelProps {
	/** 打开一条改动（在文件编辑器里看真内容）；去哪个 tab / 面板由调用方决定。 */
	onOpenFile: (agentId: string, path: string) => void;
}

export function ChangesPanel({ onOpenFile }: ChangesPanelProps): React.JSX.Element {
	const view = useSession();
	const store = useSessionStore();
	const [refreshToken, setRefreshToken] = useState(0);
	const children = view.sessionTree?.children ?? [];
	const childStates = useChildChanges(children, view.connected, refreshToken);
	const rootAgentId = activeAgentIdOf(view);

	// 刷新是**一次动作**：本会话那一份跟着 store 重读（它会作废在途响应），子会话那几份由
	// refreshToken 触发重读。两处入口（面板头 / 某组的重试）走的是同一个动作。
	const refresh = (): void => {
		void store.refreshGitChanges();
		setRefreshToken(token => token + 1);
	};

	if (!view.connected) {
		return (
			<div className="flex h-full flex-col items-center justify-center gap-2 rounded-lg border border-hairline bg-surface px-4 py-10 text-center">
				<GitBranch size={24} strokeWidth={1.25} className="text-ink-faint" />
				<div className="text-[12px] text-ink-faint">未连接——读不到工作区改动</div>
				<div className="px-2 text-[11px] leading-relaxed text-ink-subtle">
					连上 serve 后这里会列出各会话所在仓库的改动
				</div>
			</div>
		);
	}

	if (rootAgentId === undefined) {
		// 不知道读谁的工作区：既不能说「没改动」，也不能拿别的 Agent 的仓库顶上。
		return <div className="py-10 text-center text-[12px] text-ink-faint">等待会话挂载…</div>;
	}
	const groups = changesGroupsOf(view, childStates);

	return (
		<div className="flex h-full min-h-0 flex-col gap-2">
			<div className="flex shrink-0 items-center justify-between gap-2">
				<span className="text-[11px] text-ink-subtle">改动按读取它的会话分组</span>
				<button type="button" className="btn-ghost" onClick={refresh}>
					刷新
				</button>
			</div>

			<div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
				{/* 子会话列表本身的读取状态：读不到子树 != 没有子会话，这句话必须说在脸上 */}
				{view.sessionTreeError !== undefined && (
					<div className="px-1 text-[11px] text-danger">
						子会话账本读不到：{view.sessionTreeError}（这里只列了本会话的改动）
					</div>
				)}
				{view.sessionTreeError === undefined && view.sessionTreeLoading && (
					<div className="px-1 text-[11px] text-ink-faint">子会话账本读取中…</div>
				)}

				{groups.map(group => (
					<ChangesGroupCard
						key={group.key}
						group={group}
						onOpenFile={onOpenFile}
						onSwitchSession={agentId => store.switchSession(agentId)}
						onRetry={refresh}
					/>
				))}
			</div>
		</div>
	);
}

function ChangesGroupCard({
	group,
	onOpenFile,
	onSwitchSession,
	onRetry,
}: {
	group: ChangesGroup;
	onOpenFile: (agentId: string, path: string) => void;
	onSwitchSession: (agentId: string) => void;
	onRetry: () => void;
}): React.JSX.Element {
	const { status, data, error } = group.state;

	return (
		<div className="overflow-hidden rounded-lg border border-hairline bg-surface">
			<div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-hairline px-3 py-1.5">
				<span className="min-w-0 flex-1 truncate text-[12px] text-ink" title={group.title}>
					{group.title}
				</span>
				{group.statusLabel && group.statusBadge && <span className={group.statusBadge}>{group.statusLabel}</span>}
				{group.kind === "child" && (
					<button
						type="button"
						className="link shrink-0"
						title={`把本连接焦点切到 ${group.subtitle} 用的 Agent（这份清单是按它的工作区读的）`}
						onClick={() => onSwitchSession(group.agentId)}
					>
						切到该 Agent
					</button>
				)}
			</div>

			<div className="px-3 py-1 text-[11px] text-ink-faint">
				{group.subtitle}
				{data && <span className="ml-1 font-mono" title={data.repoRoot}>{`· ${data.repoRoot}`}</span>}
			</div>

			{status === "pending" && <div className="px-3 py-3 text-[12px] text-ink-faint">读取中…</div>}

			{status === "error" && (
				<div className="flex items-start gap-2 px-3 py-2 text-[12px] text-danger">
					<span className="min-w-0 flex-1">{`读不到改动：${error ?? "未知错误"}`}</span>
					<button type="button" className="link shrink-0" onClick={onRetry}>
						重试
					</button>
				</div>
			)}

			{status === "ready" && data && data.changes.length === 0 && (
				<div className="px-3 py-3 text-[12px] text-ink-faint">工作区没有改动</div>
			)}

			{status === "ready" && data && data.changes.length > 0 && (
				<>
					{data.error !== undefined && (
						<div className="border-b border-hairline bg-warning/5 px-3 py-1.5 text-[11px] text-warning">
							{`清单可能不完整：${data.error}`}
						</div>
					)}
					<ul className="divide-y divide-hairline">
						{data.changes.map(change => (
							<li key={change.path}>
								<button
									type="button"
									data-change-path={change.path}
									className="flex w-full items-start gap-2 px-3 py-1.5 text-left transition-colors hover:bg-surface-2"
									title="在文件编辑器里打开（内容以磁盘为准）"
									onClick={() => onOpenFile(group.agentId, change.path)}
								>
									<span className="min-w-0 flex-1">
										<span className="block truncate font-mono text-[12px] text-ink">{change.path}</span>
										{change.oldPath !== undefined && (
											<span className="block truncate font-mono text-[10px] text-ink-faint">
												{`← ${change.oldPath}`}
											</span>
										)}
									</span>
									<span className="flex shrink-0 flex-wrap items-center justify-end gap-1 pt-0.5">
										{changeBadgesOf(change).map(badge => (
											<span
												key={`${badge.axis ?? "conflict"}-${badge.label}`}
												className={badge.danger ? "badge fail" : "badge"}
											>
												{badge.axis ? `${badge.axis} ${badge.label}` : badge.label}
											</span>
										))}
									</span>
								</button>
							</li>
						))}
					</ul>
				</>
			)}
		</div>
	);
}

/**
 * 每个子会话读一次它自己 Agent 工作区的改动。
 *
 * 依赖是**树的形状**（sessionId + agentId 拼出来的 key）而不是那个数组引用：会话快照每次
 * 通知都会换一个新对象，用引用当依赖就是每帧重读一遍。
 *
 * 失败各自成一组（一组读不到只影响那一组）：把它们混成本会话的错误会让用户以为整个工作区
 * 都读不到。未连接不发请求（连接上了会重新跑一遍）。
 */
function useChildChanges(
	children: readonly ChildSessionNodeDto[],
	connected: boolean,
	refreshToken: number,
): Map<string, ChangesReadState> {
	const store = useSessionStore();
	const [states, setStates] = useState<Map<string, ChangesReadState>>(() => new Map());
	const key = children.map(child => `${child.sessionId}:${child.agentId}`).join("|");

	useEffect(() => {
		if (!connected || key === "") {
			setStates(prev => (prev.size === 0 ? prev : new Map()));
			return;
		}
		let cancelled = false;
		setStates(new Map(children.map(child => [child.sessionId, { status: "pending" as const }])));
		// 同一个 Agent 被两个子会话共用时只读一次：那份清单本来就是同一个仓库的同一份事实。
		const byAgent = new Map<string, Promise<GitChangesDto>>();
		const readOnce = (agentId: string): Promise<GitChangesDto> => {
			const hit = byAgent.get(agentId);
			if (hit) return hit;
			const request = store.fetchGitChanges(agentId);
			byAgent.set(agentId, request);
			return request;
		};
		void Promise.all(
			children.map(async (child): Promise<[string, ChangesReadState]> => {
				try {
					return [child.sessionId, { status: "ready", data: await readOnce(child.agentId) }];
				} catch (err) {
					return [child.sessionId, { status: "error", error: errorMessageOf(err) }];
				}
			}),
		).then(results => {
			if (cancelled) return;
			setStates(new Map(results));
		});
		return () => {
			cancelled = true;
		};
	}, [key, connected, refreshToken, store]);

	return states;
}

function errorMessageOf(err: unknown): string {
	if (typeof err === "string") return err;
	if (err instanceof Error) return err.message;
	if (typeof err === "object" && err !== null && typeof (err as { message?: unknown }).message === "string") {
		return (err as { message: string }).message;
	}
	return String(err);
}
