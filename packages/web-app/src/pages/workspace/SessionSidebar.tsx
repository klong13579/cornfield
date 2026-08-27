import { PanelLeftClose, PanelLeftOpen, Plus, Search, Star } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { SessionRecordSummary } from "../../lib/records";
import { useMediaQuery } from "../../lib/use-media-query";
import { useSessionStore } from "../../state/session-store";
import { getUiStore, useUiState } from "../../state/ui-store";
import { useSession } from "../../state/use-session";

/**
 * 会话侧栏（S3，FR-1 会话工作区）—— 300px 会话列表：
 * - 新会话按钮 + 搜索过滤
 * - 双源 tab：WebUI 会话（source=agent）/ CLI 会话（source=cli，按项目目录分组）
 * - 会话按工作区分组（session.agent → view.agents → workspace 映射）
 * - pin 收藏（localStorage 本地持久化，组内置顶）
 *
 * 数据源：当前会话（view.sessionId/sessionName）+ 历史会话（serve list_sessions 真索引，
 * 按 source 字段分源）。无 mock——任一源无数据不伪造，显示空态。
 */

type SourceId = "webui" | "cli";

const PINNED_KEY = "omp.session-sidebar.pinned";

const SOURCES: [SourceId, string][] = [
	["webui", "WebUI 会话"],
	["cli", "CLI 会话"],
];

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
interface CurrentRow {
	id: string;
	name: string;
	agent: string;
	current: true;
}

type Row = CurrentRow | SessionRecordSummary;

function isCurrent(row: Row): row is CurrentRow {
	return "current" in row;
}

/**
 * CLI 会话的项目目录（从 sessionFile 的 <sessionsRoot>/<encoded-cwd>/by-date/ 布局提取）。
 * 解析失败回退 "CLI"——不伪造数据，仅作为分组键。
 */
function cliFolderOf(row: Row): string {
	if (!("sessionFile" in row) || !row.sessionFile) return "CLI";
	const segments = row.sessionFile.replaceAll("\\", "/").split("/");
	const idx = segments.lastIndexOf("sessions");
	const enc = idx >= 0 && idx + 1 < segments.length ? segments[idx + 1] : undefined;
	if (!enc) return "CLI";
	try {
		return decodeURIComponent(enc);
	} catch {
		return enc;
	}
}

export function SessionSidebar(): React.JSX.Element {
	const view = useSession();
	const store = useSessionStore();
	const ui = useUiState();
	const isLg = useMediaQuery("(min-width: 1024px)");
	// 折叠只在桌面静态形态生效；移动抽屉（<lg）恒为完整 300px 形态。
	const collapsed = ui.sessionSidebarCollapsed && isLg;
	const [source, setSource] = useState<SourceId>("webui");
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

	// agent → workspace 映射（历史会话按工作区分组）
	const agentWorkspace = useMemo(() => {
		const byId = new Map(view.agents.map(a => [a.id, a.workspace]));
		const byName = new Map(view.agents.map(a => [a.name, a.workspace]));
		return (agent: string): string => byId.get(agent) ?? byName.get(agent) ?? "其他";
	}, [view.agents]);

	const rows = useMemo(() => {
		// 当前会话（attached）只在 WebUI 源展示
		const current: Row[] =
			source === "webui" && view.sessionId
				? [{ id: view.sessionId, name: view.sessionName ?? "当前会话", agent: "attached", current: true }]
				: [];
		// 按 list_sessions source 字段分源：webui = agent 源；cli = default agent 的本地交互会话
		const history = sessions.filter(
			s => s.id !== view.sessionId && (source === "cli" ? s.source === "cli" : s.source === "agent"),
		);
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
	}, [source, sessions, view.sessionId, view.sessionName, query, pinned]);

	// 按工作区分组（当前会话单独置顶组）；CLI 源按项目目录（sessionFile 首段）分组
	const groups = useMemo(() => {
		const order: string[] = [];
		const map = new Map<string, Row[]>();
		for (const row of rows) {
			const key = isCurrent(row) ? "当前会话" : source === "cli" ? cliFolderOf(row) : agentWorkspace(row.agent);
			if (!map.has(key)) {
				map.set(key, []);
				order.push(key);
			}
			map.get(key)?.push(row);
		}
		return order.map(k => ({ workspace: k, rows: map.get(k) ?? [] }));
	}, [rows, agentWorkspace, source]);

	return (
		<aside
			className={`fixed inset-y-0 left-0 z-50 flex flex-col border-r border-hairline bg-surface transition-[transform,width] duration-200 lg:static lg:z-auto lg:shrink-0 lg:translate-x-0 ${collapsed ? "w-[60px]" : "w-[300px]"} ${ui.mobileNavOpen ? "translate-x-0" : "-translate-x-full"}`}
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
						onClick={() => store.newSession()}
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
							onClick={() => store.newSession()}
						>
							<Plus size={14} strokeWidth={2} />
							新会话
						</button>
					</div>

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

					{/* 双源 tab */}
					<div className="flex gap-1 px-3 pb-2">
						{SOURCES.map(([id, label]) => (
							<button
								key={id}
								type="button"
								className={`rounded-full border px-3 py-1 text-[11.5px] transition-colors ${source === id ? "border-hairline-strong bg-accent-dim text-ink font-medium" : "border-hairline text-ink-subtle hover:text-ink"}`}
								onClick={() => setSource(id)}
							>
								{label}
							</button>
						))}
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
								{view.connected
									? source === "cli"
										? "暂无 CLI 会话——本地交互会话索引（list_sessions source=cli）"
										: "暂无历史会话"
									: "未连接——会话索引不可用"}
							</div>
						)}
						{groups.map(g => (
							<div key={g.workspace} className="mb-1">
								<div className="flex items-center gap-1.5 px-2 pt-3 pb-1 text-[10.5px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
									<span className="h-[7px] w-[7px] shrink-0 rounded-[3px] bg-success" />
									{g.workspace}
									<span className="ml-auto font-mono text-[10px] text-ink-faint">{g.rows.length}</span>
								</div>
								{g.rows.map(row => (
									<SessionRow
										key={row.id}
										row={row}
										pinned={pinned.has(row.id)}
										active={!isCurrent(row) && row.id === view.sessionId}
										onTogglePin={() => togglePin(row.id)}
										onClick={isCurrent(row) ? undefined : () => store.openHistorySession(row)}
									/>
								))}
							</div>
						))}
					</div>

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

function SessionRow({
	row,
	pinned,
	active,
	onTogglePin,
	onClick,
}: {
	row: Row;
	pinned: boolean;
	active: boolean;
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
				title={isCurrent(row) ? "当前会话" : "打开会话"}
			>
				<span className="block truncate text-[13px] text-ink">{row.name}</span>
				<span className="block truncate text-[11px] text-ink-faint">
					{isCurrent(row) ? "当前会话" : row.agent}
					{"messageCount" in row ? ` · ${row.messageCount} 条` : ""}
				</span>
			</button>
		</div>
	);
}
