import { List, Network, PanelLeftClose, PanelLeftOpen, Plus, Search, Star } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { SessionRecordSummary } from "../../lib/records";
import { useMediaQuery } from "../../lib/use-media-query";
import { useSessionStore } from "../../state/session-store";
import { getUiStore, useUiState } from "../../state/ui-store";
import { useSession } from "../../state/use-session";
import { SessionTree } from "./SessionTree";

/**
 * 会话侧栏（S3，FR-1 会话工作区）—— 300px 会话列表：
 * - 新会话按钮 + 搜索过滤
 * - 会话按 Agent 分组（session.agent → agent 显示名映射）
 * - pin 收藏（localStorage 本地持久化，组内置顶）
 *
 * 分组只有一根轴：**谁在服务这条会话**。曾经按 `source`（cli / agent）分成两个 tab，而 serve 侧的
 * source 是按 agentId 判的（default 恒等于 cli，`wire-server.ts` 的 `list_sessions`）——于是
 * default 这个正常注册的 Agent 在「WebUI 会话」tab 里一个组头都没有，它的会话全躺在另一个 tab 里。
 * 来源是**会话的事实**，不是组织列表的方式：读它的消费者（用量页的「来源」行）继续读它，
 * 侧栏不再拿它分类。会话自己记下的归属（`projectId`）同理不是分组轴，它落在行副标题上。
 *
 * 数据源：当前会话（view.sessionId/sessionName）+ 历史会话（serve list_sessions 真索引）。
 * 无 mock——任一源无数据不伪造，显示空态。
 *
 * 两个「新会话」钮（折叠薄栏与展开态）是**同一个动作**，且与顶栏表单走**同一条创建路径**
 * （`SessionStore.newSession`：先等目标 Agent 切过去，再带显式目标建）。它们与表单的唯一区别是
 * 不选项：直建就是「当前焦点 Agent 上建一个」——所以它们传空入参，由那条路径自己解析焦点。
 */

const PINNED_KEY = "cornfield.session-sidebar.pinned";

function loadPinned(): Set<string> {
	try {
		const raw = localStorage.getItem(PINNED_KEY);
		const parsed = raw ? (JSON.parse(raw) as unknown) : [];
		return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : []);
	} catch {
		return new Set();
	}
}

/** 当前会话展示项（不落 list_sessions，单独置顶）。 */
export interface CurrentRow {
	id: string;
	name: string;
	agent: string;
	current: true;
	/**
	 * 正在回放历史会话（`view.historySessionFile` 非空）。此时这一行是**回实时的入口**，
	 * 不是一句说明 —— 侧栏必须把它画成可点的样子，否则用户切进历史之后就找不到回去的路。
	 */
	playback?: boolean;
}

/** 列表行：当前会话那一行，或 list_sessions 里的一条。 */
export type SidebarRow = CurrentRow | SessionRecordSummary;

function isCurrent(row: SidebarRow): row is CurrentRow {
	return "current" in row;
}

/**
 * 一行被点时的动作（纯函数：无 React、无 store，只是把「哪种行做哪件事」写在一处）。
 *
 * 三种行三件事，不拿一个 `onClick` 糊过去：
 *   - 历史会话 → 打开回放；
 *   - 当前会话（实时）→ **没有动作** —— 点它就是「我本来就在这」，不给白闪留口子；
 *   - 当前会话（回放中）→ 回到实时。少了这一支，用户切进历史会话之后就没有回去的路。
 */
export function sessionRowAction(
	row: SidebarRow,
	actions: {
		openHistorySession: (record: SessionRecordSummary) => unknown;
		returnToLiveSession: () => unknown;
	},
): (() => void) | undefined {
	if (!isCurrent(row)) return () => void actions.openHistorySession(row);
	if (row.playback) return () => void actions.returnToLiveSession();
	return undefined;
}

export interface SessionGroup {
	/** Map 用的稳定键（`agent:<id>` / `current`）。 */
	key: string;
	/** 组头的人读标签。 */
	label: string;
	rows: SidebarRow[];
}

/**
 * 分组（纯函数：无 React、无 store）：行的顺序就是组的顺序 —— Map 保留插入顺序，
 * 而行已经按「pin 置顶 → startedAt 倒序」排过，分组不该把它重排一遍。于是组头跟着组内最新
 * 那一行走：最近活跃的 Agent 排在前面。
 *
 * 一根轴：谁在服务这条会话（`session.agent` → 显示名）。当前会话（不落 list_sessions 的那一行）
 * 单独置顶，不并进任何 Agent 组。
 */
export function groupSessions(
	rows: readonly SidebarRow[],
	options: {
		/** Agent id/name → 显示名。 */
		agentLabel: (agent: string) => string;
	},
): SessionGroup[] {
	const map = new Map<string, SessionGroup>();
	for (const row of rows) {
		const key = isCurrent(row) ? "current" : `agent:${row.agent}`;
		const bucket = map.get(key);
		if (bucket) {
			bucket.rows.push(row);
			continue;
		}
		map.set(key, { key, label: isCurrent(row) ? "当前会话" : options.agentLabel(row.agent), rows: [row] });
	}
	return [...map.values()];
}

export function SessionSidebar({ elementRef }: { elementRef?: React.Ref<HTMLElement> } = {}): React.JSX.Element {
	const view = useSession();
	const store = useSessionStore();
	const ui = useUiState();
	const isLg = useMediaQuery("(min-width: 1024px)");
	// 折叠只在桌面静态形态生效；移动抽屉（<lg）恒为完整 300px 形态。
	const collapsed = ui.sessionSidebarCollapsed && isLg;
	const [treeView, setTreeView] = useState(false);
	const [query, setQuery] = useState("");
	const [sessions, setSessions] = useState<SessionRecordSummary[]>([]);
	const [pinned, setPinned] = useState<Set<string>>(loadPinned);

	/** 历史会话索引（list_sessions 真数据）；未连接/失败保持空列表，UI 空态 */
	useEffect(() => {
		if (!view.connected) return;
		void store
			.listSessions()
			.then(setSessions)
			.catch(() => undefined);
	}, [store, view.connected]);

	const togglePin = (id: string) => {
		setPinned(prev => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			try {
				localStorage.setItem(PINNED_KEY, JSON.stringify([...next]));
			} catch {
				// localStorage 不可用（隐私模式）——pin 态仅存于内存
			}
			return next;
		});
	};

	// 行副标题的归属：会话自己记下的 projectId（没记过 = 不显示，不拿目录名冒充一个 Project）。
	// 名字取自 Project 注册表；注册表没读到 / 里没有这个 id 就显示 id —— id 是事实，名字只是好看。
	const projectNameOf = useMemo(() => {
		const byId = new Map((view.projects ?? []).map(p => [p.projectId, p.name]));
		return (row: SessionRecordSummary): string | undefined => {
			const id = row.projectId;
			if (id === undefined) return undefined;
			return byId.get(id) ?? id;
		};
	}, [view.projects]);

	// agent → 显示名映射（组头用；id 与 name 双键兼容）
	const agentLabel = useMemo(() => {
		const byId = new Map(view.agents.map(a => [a.id, a.name]));
		const byName = new Map(view.agents.map(a => [a.name, a.name]));
		return (agent: string): string => byId.get(agent) ?? byName.get(agent) ?? (agent || "其他");
	}, [view.agents]);

	const rows = useMemo(() => {
		// 当前会话（attached）不落 list_sessions，单独置顶
		const current: SidebarRow[] = view.sessionId
			? [
					{
						id: view.sessionId,
						name: view.sessionName ?? "当前会话",
						agent: "attached",
						current: true,
						...(view.historySessionFile !== undefined ? { playback: true } : {}),
					},
				]
			: [];
		const history = sessions.filter(s => s.id !== view.sessionId);
		const q = query.trim().toLowerCase();
		const filtered = q ? history.filter(s => s.name.toLowerCase().includes(q)) : history;
		// pin 置顶：pinned 先，其余按 startedAt desc
		const sorted = [...filtered].sort((a, b) => {
			const pa = pinned.has(a.id) ? 1 : 0;
			const pb = pinned.has(b.id) ? 1 : 0;
			if (pa !== pb) return pb - pa;
			return new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime();
		});
		return [...current.filter(c => !q || c.name.toLowerCase().includes(q)), ...sorted];
	}, [sessions, view.sessionId, view.sessionName, view.historySessionFile, query, pinned]);

	// 按 Agent 分组（谁在服务这条会话）；组序跟着组内最新一行走
	const groups = useMemo(() => groupSessions(rows, { agentLabel }), [rows, agentLabel]);

	return (
		<aside
			ref={elementRef}
			className={`pane-no-drag-transition fixed inset-y-0 left-0 z-50 flex flex-col border-r border-hairline bg-surface transition-[transform,width] duration-200 lg:static lg:z-auto lg:translate-x-0 ${collapsed ? "w-[60px]" : "w-[300px] lg:w-[var(--pane-sessionSidebar-width)] lg:min-w-[var(--pane-sessionSidebar-min)]"} ${ui.mobileNavOpen ? "translate-x-0" : "-translate-x-full"}`}
		>
			{collapsed ? (
				/* 折叠态薄栏（Linear 风格）：展开 / 新会话 / 连接状态 */
				<div className="flex h-full flex-col items-center gap-1 py-3">
					<button
						type="button"
						className="nav-item"
						onClick={() => getUiStore().setSessionSidebarCollapsed(false)}
						aria-label="展开会话栏"
						title="展开会话栏"
					>
						<PanelLeftOpen size={18} strokeWidth={1.5} />
					</button>
					<button
						type="button"
						className="nav-item"
						onClick={() => void store.newSession()}
						aria-label="新会话"
						title="新会话"
					>
						<Plus size={18} strokeWidth={1.5} />
					</button>
					<div className="flex-1" />
					<span className={`conn-dot ${view.reconnecting ? "reconnecting" : ""}`} />
				</div>
			) : (
				<>
					{/* 新会话 */}
					<div className="px-3 pt-3 pb-2">
						<button
							type="button"
							className="flex w-full items-center justify-center gap-2 rounded-md border border-hairline bg-accent px-3 py-2 text-[13px] font-semibold text-on-accent transition-colors hover:bg-accent-hover"
							onClick={() => void store.newSession()}
						>
							<Plus size={14} strokeWidth={2} />
							新会话
						</button>
					</div>

					{/* 视图切换（§8：时间列表 / 会话树）*/}
					<div className="flex gap-1 px-3 pb-2">
						{[
							{ id: false, label: "列表", Icon: List },
							{ id: true, label: "树", Icon: Network },
						].map(item => (
							<button
								key={item.label}
								type="button"
								aria-pressed={treeView === item.id}
								className={`flex flex-1 items-center justify-center gap-1.5 rounded-md border px-2 py-1 text-[11.5px] transition-colors ${treeView === item.id ? "border-hairline-strong bg-accent-dim font-medium text-ink" : "border-hairline text-ink-subtle hover:text-ink"}`}
								onClick={() => setTreeView(item.id)}
							>
								<item.Icon size={12} strokeWidth={1.5} />
								{item.label}
							</button>
						))}
					</div>

					{treeView ? (
						<SessionTree />
					) : (
						<>
							{/* 搜索 */}
							<div className="px-3 pb-2">
								<div className="flex h-8 items-center gap-2 rounded-md border border-hairline bg-surface-2 px-2.5 focus-within:border-hairline-strong">
									<Search size={13} strokeWidth={1.5} className="shrink-0 text-ink-faint" />
									<input
										value={query}
										onChange={e => setQuery(e.target.value)}
										placeholder="过滤会话…"
										className="w-full border-none bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-faint"
									/>
								</div>
							</div>

							{view.historyLoading && (
								<div className="mx-3 mb-1 rounded-md bg-surface-2 px-3 py-2 text-[12px] text-ink-subtle">
									加载会话记录中…
								</div>
							)}
							{view.historyError && (
								<div className="mx-3 mb-1 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-[12px] text-danger">
									{view.historyError}
								</div>
							)}
							{/* 会话列表 */}
							<div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
								{groups.length === 0 && (
									<div className="px-2 py-10 text-center text-[12px] text-ink-faint">
										{view.connected ? "暂无历史会话" : "未连接——会话索引不可用"}
									</div>
								)}
								{groups.map(g => (
									<div key={g.key} className="mb-1">
										<div className="flex items-center gap-1.5 px-2 pt-3 pb-1 text-[10.5px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
											<span className="h-[7px] w-[7px] shrink-0 rounded-[3px] bg-success" />
											{g.label}
											<span className="ml-auto font-mono text-[10px] text-ink-faint">{g.rows.length}</span>
										</div>
										{g.rows.map(row => (
											<SessionRow
												key={row.id}
												row={row}
												pinned={pinned.has(row.id)}
												active={!isCurrent(row) && row.id === view.sessionId}
												projectLabel={isCurrent(row) ? undefined : projectNameOf(row)}
												onTogglePin={() => togglePin(row.id)}
												onClick={sessionRowAction(row, store)}
											/>
										))}
									</div>
								))}
							</div>
						</>
					)}

					{/* 底部状态 */}
					<div className="flex shrink-0 items-center gap-2 border-t border-hairline px-3 py-2.5 text-[12px] text-ink-subtle">
						<span className={`conn-dot ${view.reconnecting ? "reconnecting" : ""}`} />
						{view.connected ? `已连接 · ${view.agents.length} agents` : "未连接"}
						{isLg && (
							<button
								type="button"
								className="cbtn ml-auto"
								onClick={() => getUiStore().setSessionSidebarCollapsed(true)}
								aria-label="收起会话栏"
								title="收起会话栏"
							>
								<PanelLeftClose size={14} strokeWidth={1.5} />
							</button>
						)}
					</div>
				</>
			)}
			{!isLg && ui.mobileNavOpen && (
				<div
					aria-hidden
					className="fixed inset-0 z-menu bg-ink/20"
					onClick={() => getUiStore().setMobileNav(false)}
				/>
			)}
		</aside>
	);
}

/**
 * 历史行的副标题：会话记下的 Project 显示名（没记过就不写）+ 条数。
 *
 * 不再写 Agent 名 —— 它就是这条记录所在组的**组头**，行里再写一遍是把同一个事实说两次。
 * 归属则相反：它没有别的入口（侧栏不再按它分组），退到这一行才不丢。
 */
function rowSubtitle(row: SessionRecordSummary, projectLabel: string | undefined): string {
	return [projectLabel, `${row.messageCount} 条`].filter((part): part is string => part !== undefined).join(" · ");
}

/**
 * 会话列表的一行（纯展示，导出供静态渲染断言）。
 */
export function SessionRow({
	row,
	pinned,
	active,
	projectLabel,
	onTogglePin,
	onClick,
}: {
	row: SidebarRow;
	pinned: boolean;
	active: boolean;
	/** 会话自己记下的 Project 显示名；未记录 = undefined（不显示，也不拿目录名冒充）。 */
	projectLabel?: string;
	onTogglePin: () => void;
	onClick?: () => void;
}): React.JSX.Element {
	return (
		<div
			className={`group flex w-full items-start gap-1.5 rounded-lg px-2 py-2 transition-colors hover:bg-surface-2 ${active ? "bg-accent-dim" : ""}`}
		>
			<button
				type="button"
				className={`mt-0.5 shrink-0 transition-colors transition-opacity duration-150 ${
					pinned ? "text-accent" : "text-ink-faint opacity-0 group-hover:opacity-100"
				}`}
				title={pinned ? "取消 pin" : "pin 置顶"}
				aria-label={pinned ? "取消 pin" : "pin 置顶"}
				onClick={onTogglePin}
			>
				<Star size={12} strokeWidth={1.5} />
			</button>
			<button
				type="button"
				className="min-w-0 flex-1 text-left"
				onClick={onClick}
				title={isCurrent(row) ? (row.playback ? "回到实时会话" : "当前会话") : "打开会话"}
			>
				<span className="block truncate text-[13px] text-ink">{row.name}</span>
				<span className="block truncate text-[11px] text-ink-faint">
					{isCurrent(row)
						? row.playback
							? "回放中 · 点这里回到实时"
							: "当前会话"
						: rowSubtitle(row, projectLabel)}
				</span>
			</button>
		</div>
	);
}
