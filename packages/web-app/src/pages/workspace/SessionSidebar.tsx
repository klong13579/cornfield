import {
	ChevronDown,
	ChevronRight,
	List,
	Network,
	PanelLeftClose,
	PanelLeftOpen,
	Plus,
	Search,
	Star,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { SessionRecordSummary } from "../../lib/records";
import { serveVerdictOf } from "../../lib/serve-verdict";
import { useMediaQuery } from "../../lib/use-media-query";
import { useSessionStore } from "../../state/session-store";
import { getUiStore, useUiState } from "../../state/ui-store";
import { useSession } from "../../state/use-session";
import { SessionTree } from "./SessionTree";

/**
 * 会话侧栏（S3，FR-1 会话工作区）—— 300px 会话列表：
 * - 新会话按钮 + 搜索过滤
 * - 会话按 Agent 分组（session.agent → agent 显示名映射），组**默认折叠**，点组头展哪一组
 * - pin 收藏（localStorage 本地持久化）→ 「置顶」组，恒展开
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

/**
 * 一行该发哪条改名命令（纯函数：无 React、无 store）。
 *
 * 判据是**这一行代表谁**，不是行的长相 —— wire 上那两条命令各自只能改一种会话：
 *   - 本连接挂着的那个会话（当前会话那一行，它的 id 就是附件地址）→ `set_session_name`；
 *   - 列表里的历史记录 → `rename_session`，按 `list_sessions` 给出的会话文件定位。
 *
 * 反过来会怎样：拿本连接挂着的那个会话的文件去 `rename_session`，serve 直接拒
 * （`session is open in this process: rename it as the active session instead`）—— 它的内存态
 * 与文件是同一份事实，绕开活跃会话改文件会让两边漂。
 */
export type RenameTarget =
	| { kind: "history"; sessionFile: string }
	| { kind: "active" }
	| { kind: "none"; reason: string };

/** 历史记录没有会话文件路径时菜单项要说的原因（不可用就得说得出为什么）。 */
const NO_SESSION_FILE_REASON = "这条记录没有会话文件路径，改不了名字";

export function renameTargetOf(row: SidebarRow, activeSessionId: string | undefined): RenameTarget {
	// 当前会话那一行：id 是附件地址，不是会话文件 —— 只能走 set_session_name
	if (isCurrent(row)) return { kind: "active" };
	// 本连接挂着的那个会话的地址：判据是身份，不是行的形状。列表今天已经把这种行滤掉了，
	// 但换一处过滤顺序就会把一条注定被拒的命令发出去，而这一条命令的拒绝理由用户没法自己修。
	if (activeSessionId !== undefined && row.id === activeSessionId) return { kind: "active" };
	const sessionFile = row.sessionFile;
	if (sessionFile === undefined || sessionFile.trim() === "") return { kind: "none", reason: NO_SESSION_FILE_REASON };
	return { kind: "history", sessionFile };
}

/** 右键菜单的一项（数据不是 JSX：可纯函数断言，也可静态渲染）。 */
export interface SessionMenuItem {
	id: "rename";
	label: string;
	/** 不可用 = 点了不会有反应的那种项；此时必须同时给出 reason。 */
	disabled: boolean;
	/** 不可用的原因（画在 title 上，不是一句“自己去猜”）。 */
	reason?: string;
}

/**
 * 菜单项列表（纯函数）。目标改不了时不弹一个空菜单：那一项在，但**不可用并说得出为什么** ——
 * 一个点了没反应的项比没有它更坏（用户会以为菜单坏了）。
 */
export function sessionMenuItems(target: RenameTarget): SessionMenuItem[] {
	if (target.kind === "none") return [{ id: "rename", label: "重命名", disabled: true, reason: target.reason }];
	return [{ id: "rename", label: "重命名", disabled: false }];
}

/**
 * 提交前把输入框里的名字过一遍（纯函数）：空 / 只有空白 → undefined（不发命令）。
 *
 * serve 也会拒空名（`Session name cannot be empty`），但那是一次网络往返之后的拒绝；先在这里
 * 挡住，输入框原地留着让人接着改。清洗（去控制字符 / 折叠空白）是 serve 的事，不在这层做第二遍。
 */
export function renameNameToSubmit(raw: string): string | undefined {
	const name = raw.trim();
	return name === "" ? undefined : name;
}

/** 菜单贴光标，但不越出视口（纯函数）：边距内收，右下角放不下就收回来贴着边。 */
export function clampMenuPosition(
	point: { x: number; y: number },
	size: { width: number; height: number },
	viewport: { width: number; height: number },
	margin = 8,
): { left: number; top: number } {
	return {
		left: Math.max(margin, Math.min(point.x, viewport.width - size.width - margin)),
		top: Math.max(margin, Math.min(point.y, viewport.height - size.height - margin)),
	};
}

export interface SessionGroup {
	/** Map 用的稳定键（`agent:<id>` / `current`）。 */
	key: string;
	/** 组头的人读标签。 */
	label: string;
	rows: SidebarRow[];
}

/** 渲染用的组：Agent 组带折叠位；当前会话（恒 1 行）与置顶恒展开。 */
export interface RenderGroup extends SessionGroup {
	collapsible: boolean;
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

/**
 * 把 pin 过的行从列表里**搬出来**（不是复制）：同一行只出现在一处。
 *
 * pin 是**视图偏好**，不是分组轴 —— 所以它不进 `groupSessions`，在渲染层单独成组。
 * 组默认折叠，pin 过的行留在各自的 Agent 组里就等于被折叠藏起来，pin 这个功能也就废了。
 *
 * 当前会话那一行不参与：它的 id 是附件地址（如 `default`），不是一个会话 id —— 不得被 pin 表里
 * 同名字符串认领走（认领走之后「当前会话」组会空掉，而那行是回实时的唯一入口）。
 */
export function splitPinned(
	rows: readonly SidebarRow[],
	pinned: ReadonlySet<string>,
): { pinned: SidebarRow[]; rest: SidebarRow[] } {
	const pinnedRows: SidebarRow[] = [];
	const rest: SidebarRow[] = [];
	for (const row of rows) {
		if (!isCurrent(row) && pinned.has(row.id)) pinnedRows.push(row);
		else rest.push(row);
	}
	return { pinned: pinnedRows, rest };
}

/**
 * 折叠态行的容器 id（`aria-controls` 要指一个真目标）。
 *
 * 直接拼 key（Map 键，本来就唯一且稳定）：**不做字符替换** —— 把 `:` 洗成 `-` 会让
 * `agent:a:b` 与 `agent:a-b` 撞成同一个 id，`aria-controls` 于是指向别人的行容器。id 里带冒号是
 * 合法的（HTML 只禁空白），这里也没人用 CSS 选择器去够它。
 */
export function groupRowsId(key: string): string {
	return `session-group-rows-${key}`;
}

/**
 * 组头此刻展开没有。三支：
 * - 没有折叠位的组（当前会话 / 置顶）恒展开；
 * - 过滤中一律展开 —— 过滤剔掉了不命中的行，命中却藏在折叠里等于没命中；
 * - 其余看用户点没点过（默认折叠：展开态是**点出来的**，不是默认值）。
 */
export function isGroupOpen(
	group: { key: string; collapsible: boolean },
	state: { expanded: ReadonlySet<string>; filtering: boolean },
): boolean {
	if (!group.collapsible) return true;
	if (state.filtering) return true;
	return state.expanded.has(group.key);
}

export interface SessionGroupHeaderProps {
	label: string;
	count: number;
	/** 这个组留了折叠位（左边那个箭头）。当前会话 / 置顶没有。 */
	collapsible: boolean;
	/** 此刻是否展开。 */
	open: boolean;
	/** 行的容器 id，给 `aria-controls` 用。 */
	rowsId: string;
	/** 有 = 组头是开关；没有 = 纯标题（不可折叠，或正过滤中一律展开）。 */
	onToggle?: (() => void) | undefined;
}

/**
 * 组头（纯展示，导出供静态渲染断言）。
 *
 * 两种画法：可点的是**开关**（`aria-expanded` + `aria-controls` 指到行的容器），不可点的只是
 * 一行标题 —— 一个点了没反应的箭头比没有它更坏。过滤中组头退回纯标题（那时点折叠没有意义），
 * 但左边的箭头照画：让它消失会把整个列表左移一档。
 */
export function SessionGroupHeader({
	label,
	count,
	collapsible,
	open,
	rowsId,
	onToggle,
}: SessionGroupHeaderProps): React.JSX.Element {
	const content = (
		<>
			{collapsible ? (
				open ? (
					<ChevronDown size={12} strokeWidth={1.5} className="shrink-0" />
				) : (
					<ChevronRight size={12} strokeWidth={1.5} className="shrink-0" />
				)
			) : null}
			<span className="h-[7px] w-[7px] shrink-0 rounded-[3px] bg-success" />
			{label}
			<span className="ml-auto font-mono text-[10px] text-ink-faint">{count}</span>
		</>
	);
	const className =
		"flex w-full items-center gap-1.5 px-2 pt-3 pb-1 text-[10.5px] font-semibold tracking-[0.08em] text-ink-faint uppercase";
	if (!onToggle) return <div className={className}>{content}</div>;
	return (
		<button
			type="button"
			className={`${className} text-left hover:text-ink`}
			aria-expanded={open}
			aria-controls={rowsId}
			title={open ? `折叠 ${label}` : `展开 ${label}`}
			onClick={onToggle}
		>
			{content}
		</button>
	);
}

/**
 * 渲染用的组列表：**当前会话（恒 1 行，永远第一）→ 置顶 → 各 Agent 组**。
 *
 * 当前会话排第一是有代价的结论：那一行是回实时的唯一入口（见 `sessionRowAction`），
 * pin 出来的东西不得把它顶下去。
 *
 * 可折叠的只有 Agent 组：当前会话与置顶不给折叠位 —— 一个点了没用的箭头比没有它更坏。
 */
export function renderGroups(groups: readonly SessionGroup[], pinnedRows: readonly SidebarRow[]): RenderGroup[] {
	const current = groups.find(group => group.key === "current");
	return [
		...(current ? [{ ...current, collapsible: false }] : []),
		...(pinnedRows.length > 0 ? [{ key: "pinned", label: "置顶", rows: [...pinnedRows], collapsible: false }] : []),
		...groups.filter(group => group.key !== "current").map(group => ({ ...group, collapsible: true })),
	];
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
	/** 展开着的组（key）。空 = 全折叠 —— 默认态是折叠，展开是用户点出来的。**不持久化**（与「当前计划」条同款约定：每次进工作台都从折叠开始）。 */
	const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
	/** 右键菜单的目标行 + 光标位置（视口坐标）；null = 没开。 */
	const [menu, setMenu] = useState<{ row: SidebarRow; x: number; y: number } | null>(null);
	/** 正在就地改名的行 id；null = 没有。 */
	const [editingRowId, setEditingRowId] = useState<string | null>(null);
	/**
	 * 改名失败的原因（serve 原文）。
	 *
	 * 落在侧栏本地而不是 `view.historyError`：那个错误位属于「回放这条读」（归一在 store 里），
	 * 而改名是侧栏自己发起的动作 —— 两者混在一起，回放一刷新就会把改名的报错抹掉。
	 */
	const [renameError, setRenameError] = useState<string | undefined>(undefined);
	const menuRef = useRef<HTMLDivElement | null>(null);

	/** 历史会话索引重读（连接建立时一次；改完名字后重跑**同一条**读，不另立一份列表状态）。 */
	const refreshSessions = useCallback((): Promise<void> => {
		return store
			.listSessions()
			.then(setSessions)
			.then(() => undefined)
			.catch(() => undefined);
	}, [store]);

	/** 历史会话索引（list_sessions 真数据）；未连接/失败保持空列表，UI 空态 */
	useEffect(() => {
		if (!view.connected) return;
		void refreshSessions();
	}, [refreshSessions, view.connected]);

	/**
	 * 菜单的三种关闭：Esc、点外部、滚动（捕获阶段 —— 列表那个滚动容器不冒泡）。
	 * 都在菜单打开时才注册，不留常驻监听。
	 */
	useEffect(() => {
		if (!menu) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") setMenu(null);
		};
		const onPointerDown = (event: PointerEvent) => {
			if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
			setMenu(null);
		};
		const onScroll = () => setMenu(null);
		document.addEventListener("keydown", onKeyDown);
		document.addEventListener("pointerdown", onPointerDown, true);
		document.addEventListener("scroll", onScroll, true);
		return () => {
			document.removeEventListener("keydown", onKeyDown);
			document.removeEventListener("pointerdown", onPointerDown, true);
			document.removeEventListener("scroll", onScroll, true);
		};
	}, [menu]);

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

	/** 行上右键 = 我们的菜单；拦掉浏览器自带那个（位置与项都不是我们要给的那个）。 */
	const openRowMenu = (row: SidebarRow, event: React.MouseEvent): void => {
		event.preventDefault();
		setMenu({ row, x: event.clientX, y: event.clientY });
	};

	/** 选「重命名」：进就地编辑。目标改不了时不进去 —— 那种项本来就不可用。 */
	const startRename = (row: SidebarRow): void => {
		const target = renameTargetOf(row, view.sessionId);
		if (target.kind === "none") {
			setRenameError(target.reason);
			return;
		}
		setRenameError(undefined);
		setEditingRowId(row.id);
	};

	/**
	 * 提交改名：按行的身份分流（当前会话走后一条，历史行走前一条），成功后重跑列表那条读。
	 *
	 * 失败把 serve 的原文落到错误条上：这些拒绝（路径越界 / 本进程挂着的会话 / 文件刚被别人改过）
	 * 都是用户能据以行动的东西，改写一句「改名失败」就把证据丢了。
	 */
	const submitRename = (row: SidebarRow, raw: string): void => {
		const name = renameNameToSubmit(raw);
		// 空名字：不发命令，输入框留在原地（SessionRow 那一层已经挡了一道，这里再兜一次）
		if (name === undefined) return;
		const target = renameTargetOf(row, view.sessionId);
		if (target.kind === "none") {
			setEditingRowId(null);
			setRenameError(target.reason);
			return;
		}
		setEditingRowId(null);
		const request =
			target.kind === "active"
				? store.renameActiveSession(name)
				: store.renameSession({ sessionFile: target.sessionFile, name });
		void request
			.then(() => refreshSessions())
			.catch((err: unknown) => {
				setRenameError(`改名失败：${serveVerdictOf(err).message}`);
			});
	};

	/** 菜单项选中（目前只有一项；仍按 id 分流，免得以后加项时悄悄接错）。 */
	const selectMenuItem = (row: SidebarRow, id: SessionMenuItem["id"]): void => {
		setMenu(null);
		if (id === "rename") startRename(row);
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

	// pin 过的行搬进「置顶」组；其余按 Agent 分组（谁在服务这条会话），组序跟着组内最新一行走
	const { pinned: pinnedRows, rest: unpinnedRows } = useMemo(() => splitPinned(rows, pinned), [rows, pinned]);
	const groups = useMemo(() => groupSessions(unpinnedRows, { agentLabel }), [unpinnedRows, agentLabel]);
	/** 过滤中：组一律展开（命中藏在折叠里等于没命中），组头也不再是开关。 */
	const filtering = query.trim().length > 0;
	const renderedGroups = useMemo(() => renderGroups(groups, pinnedRows), [groups, pinnedRows]);

	const toggleGroup = (key: string) => {
		setExpandedGroups(prev => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	};

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
							{renameError && (
								<div className="mx-3 mb-1 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-[12px] text-danger">
									{renameError}
								</div>
							)}
							{/* 会话列表 */}
							<div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
								{renderedGroups.length === 0 && (
									<div className="px-2 py-10 text-center text-[12px] text-ink-faint">
										{view.connected ? "暂无历史会话" : "未连接——会话索引不可用"}
									</div>
								)}
								{renderedGroups.map(group => {
									const open = isGroupOpen(group, { expanded: expandedGroups, filtering });
									const rowsId = groupRowsId(group.key);
									// 过滤中组头退回纯标题（那时点折叠没有意义），也不再用它当开关
									const toggle = group.collapsible && !filtering ? () => toggleGroup(group.key) : undefined;
									return (
										<div key={group.key} className="mb-1">
											<SessionGroupHeader
												label={group.label}
												count={group.rows.length}
												collapsible={group.collapsible}
												open={open}
												rowsId={rowsId}
												{...(toggle ? { onToggle: toggle } : {})}
											/>
											{open && (
												<div id={rowsId}>
													{group.rows.map(row => (
														<SessionRow
															key={row.id}
															row={row}
															pinned={pinned.has(row.id)}
															active={!isCurrent(row) && row.id === view.sessionId}
															projectLabel={isCurrent(row) ? undefined : projectNameOf(row)}
															renaming={editingRowId === row.id}
															onTogglePin={() => togglePin(row.id)}
															onClick={sessionRowAction(row, store)}
															onContextMenu={event => openRowMenu(row, event)}
															onRenameSubmit={name => submitRename(row, name)}
															onRenameCancel={() => setEditingRowId(null)}
														/>
													))}
												</div>
											)}
										</div>
									);
								})}
							</div>
						</>
					)}

					{/* 右键菜单浮层：portal 到 body —— 这一层 aside 带 transform（折叠/抽屉动画），
				    fixed 会以它为包含块，菜单就贴不到光标了 */}
					{menu &&
						createPortal(
							<SessionContextMenu
								menuRef={menuRef}
								x={menu.x}
								y={menu.y}
								items={sessionMenuItems(renameTargetOf(menu.row, view.sessionId))}
								onSelect={id => selectMenuItem(menu.row, id)}
							/>,
							document.body,
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

export interface SessionMenuPanelProps {
	left: number;
	top: number;
	items: readonly SessionMenuItem[];
	onSelect: (id: SessionMenuItem["id"]) => void;
	menuRef?: React.Ref<HTMLDivElement>;
}

/**
 * 会话右键菜单（纯展示，无 hook，导出供静态渲染断言）：`role="menu"` + 每项 `role="menuitem"`。
 *
 * 不可用的项画成 native `disabled`（不是「点了没反应」的假按钮），原因放在 `title` 上 ——
 * 一个点了没反应的项比没有它更坏：用户会以为菜单坏了，而不是「这条记录改不了」。
 */
export function SessionMenuPanel({ left, top, items, onSelect, menuRef }: SessionMenuPanelProps): React.JSX.Element {
	return (
		<div
			{...(menuRef ? { ref: menuRef } : {})}
			role="menu"
			aria-label="会话操作"
			className="fixed z-menu min-w-[150px] rounded-[10px] border border-hairline-strong bg-surface p-1 shadow-xl"
			style={{ left, top }}
		>
			{items.map(item => (
				<button
					key={item.id}
					type="button"
					role="menuitem"
					disabled={item.disabled}
					className="block w-full rounded px-2 py-1.5 text-left text-[12.5px] text-ink hover:bg-surface-2 disabled:cursor-not-allowed disabled:text-ink-faint disabled:hover:bg-transparent"
					{...(item.reason ? { title: item.reason } : {})}
					onClick={() => onSelect(item.id)}
				>
					{item.label}
				</button>
			))}
		</div>
	);
}

/**
 * 菜单浮层：先量自己的真实尺寸再夹进视口（菜单多长由项数决定，靠常量估高会在项数变时露出来）。
 *
 * 量尺寸放在 layout 阶段完成（不闪）；本件只在菜单**开着**时才存在，静态渲染碰不到它。
 * 容器带 transform，所以 `fixed` 得靠 portal 到 body 才有视口坐标（见调用点）。
 */
function SessionContextMenu({
	menuRef,
	x,
	y,
	items,
	onSelect,
}: {
	menuRef: React.RefObject<HTMLDivElement | null>;
	x: number;
	y: number;
	items: readonly SessionMenuItem[];
	onSelect: (id: SessionMenuItem["id"]) => void;
}): React.JSX.Element {
	const [pos, setPos] = useState({ left: x, top: y });
	useLayoutEffect(() => {
		const rect = menuRef.current?.getBoundingClientRect();
		setPos(
			clampMenuPosition(
				{ x, y },
				{ width: rect?.width ?? 0, height: rect?.height ?? 0 },
				{ width: window.innerWidth, height: window.innerHeight },
			),
		);
	}, [menuRef, x, y, items.length]);
	return <SessionMenuPanel menuRef={menuRef} left={pos.left} top={pos.top} items={items} onSelect={onSelect} />;
}

/**
 * 会话列表的一行（纯展示，导出供静态渲染断言）。
 *
 * `renaming` 为真时名字那格换成输入框（就地改名）：Enter 提交、Esc 取消、失焦取消。
 * 用 `defaultValue`（非受控）—— 打字这件事不需要过 React 状态，提交时从事件里读当下的值。
 */
export function SessionRow({
	row,
	pinned,
	active,
	projectLabel,
	renaming,
	onTogglePin,
	onClick,
	onContextMenu,
	onRenameSubmit,
	onRenameCancel,
}: {
	row: SidebarRow;
	pinned: boolean;
	active: boolean;
	/** 会话自己记下的 Project 显示名；未记录 = undefined（不显示，也不拿目录名冒充）。 */
	projectLabel?: string;
	/** 这一行正在就地改名（名字那格换成输入框）。 */
	renaming?: boolean;
	onTogglePin: () => void;
	onClick?: () => void;
	onContextMenu?: (event: React.MouseEvent) => void;
	onRenameSubmit?: (name: string) => void;
	onRenameCancel?: () => void;
}): React.JSX.Element {
	return (
		<div
			className={`group flex w-full items-start gap-1.5 rounded-lg px-2 py-2 transition-colors hover:bg-surface-2 ${active ? "bg-accent-dim" : ""}`}
			{...(onContextMenu ? { onContextMenu } : {})}
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
			{renaming ? (
				<input
					type="text"
					className="min-w-0 flex-1 rounded border border-hairline-strong bg-surface-2 px-1.5 py-0.5 text-[13px] text-ink outline-none"
					defaultValue={row.name}
					aria-label="会话名"
					// biome-ignore lint/a11y/noAutofocus: 就地改名是用户点出来的：输入框一出现就该能直接打字（键盘路径入口）
					autoFocus
					onKeyDown={event => {
						if (event.key === "Enter") {
							// 空名字不发命令：输入框留在原地，人可以接着改
							if (renameNameToSubmit(event.currentTarget.value) === undefined) return;
							onRenameSubmit?.(event.currentTarget.value);
							return;
						}
						if (event.key === "Escape") {
							event.stopPropagation();
							onRenameCancel?.();
						}
					}}
					onBlur={() => onRenameCancel?.()}
				/>
			) : (
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
			)}
		</div>
	);
}
