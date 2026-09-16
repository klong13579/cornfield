import type {
	AgentInfoDto,
	DashboardStatsDto,
	MemoryProjectionDto,
	SkillsResultDto,
	StatsFolderRowDto,
	StatsPeriodDto,
} from "@cornfield/wire";
import { useEffect, useMemo, useState } from "react";
import { attributionSourceLabel, projectRegistryState, sessionAttributionOf } from "../../lib/project-read-model";
import { recordStatusLabel, type SessionRecordSummary } from "../../lib/records";
import { activeAgentIdOf, activeAgentOf } from "../../state/agent-context";
import { type SessionView, useSessionStore } from "../../state/session-store";
import { useSession } from "../../state/use-session";
import {
	attributeFolders,
	type FolderAttributionIndex,
	findCurrentSession,
	type ScopeRollupRow,
	type ScopeSections,
	scopeSections,
} from "./insights-scope";

/**
 * 用量面板（W3 D2 + agent-first scope）—— serve get_stats 只读聚合 + list_sessions 真索引。
 * - period 切换（1d/7d/30d/90d/全部）→ get_stats(period) 时间窗口聚合
 * - 用量/费用/错误率卡（overall）
 * - 最近请求趋势条（1d 用小时桶 timeSeries；其余用日桶 costSeries 聚合）
 * - 模型成本表（byModel + priceCatalog 单价，单价来自 models.json，查不到显示 —）
 * - 按目录用量（byFolder + 由 list_sessions sessionFile 推导的 folder→agent 归属）
 * - Scope 区块：当前锚点（Agent / Project / Session）+ 按 Agent / 按 Project / 未归属 三个分区
 *   + Session scope 自身事实 + 学习面（技能 / 记忆按 scope 的既有投影）
 *
 * 无 mock：任一数据源取不到就渲染对应空态/错误原因，绝不回退假数据。三个 scope 轴上的
 * 「读不到」「还没算出来」「未归属」是三件不同的事，UI 分开渲染（insights-scope.ts 有推导口径）。
 * 分区里的数字一律是「把目录行求和」得来（汇总口径），不冒充服务端原生指标。
 */

const PERIODS: { id: StatsPeriodDto; label: string }[] = [
	{ id: "1d", label: "24 小时" },
	{ id: "7d", label: "7 天" },
	{ id: "30d", label: "30 天" },
	{ id: "90d", label: "90 天" },
	{ id: "all", label: "全部" },
];

function fmtNum(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}

function fmtTokens(n: number): string {
	return `${fmtNum(n)} tok`;
}

function fmtMoney(n: number): string {
	if (n === 0) return "$0.00";
	if (n < 0.01) return `$${n.toFixed(4)}`;
	if (n < 1) return `$${n.toFixed(3)}`;
	return `$${n.toFixed(2)}`;
}

function fmtPct(n: number): string {
	return `${(n * 100).toFixed(1)}%`;
}

function fmtDuration(ms: number | null): string {
	if (ms === null) return "—";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}

function fmtDay(ts: number): string {
	const d = new Date(ts);
	return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function fmtHour(ts: number): string {
	const d = new Date(ts);
	return `${String(d.getHours()).padStart(2, "0")}:00`;
}

function fmtTimestamp(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(
		d.getHours(),
	).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** 日桶趋势（costSeries 按天聚合请求数，用于非 1d period 的趋势条）。 */
function dailyRequestBuckets(
	stats: DashboardStatsDto,
	period: StatsPeriodDto,
): { timestamp: number; requests: number }[] {
	if (period === "1d") return [];
	const cutoff = Date.now() - periodDays(period) * 24 * 60 * 60 * 1000;
	const byDay = new Map<number, number>();
	for (const p of stats.costSeries) {
		if (p.timestamp < cutoff) continue;
		byDay.set(p.timestamp, (byDay.get(p.timestamp) ?? 0) + p.requests);
	}
	return [...byDay.entries()]
		.map(([timestamp, requests]) => ({ timestamp, requests }))
		.sort((a, b) => a.timestamp - b.timestamp);
}

function periodDays(period: StatsPeriodDto): number {
	switch (period) {
		case "7d":
			return 7;
		case "30d":
			return 30;
		case "90d":
			return 90;
		default:
			return 0;
	}
}

/** 一个 scope 锚点的显示值（tone 决定配色；detail 是「为什么是这个值」）。 */
interface AnchorValue {
	value: string;
	detail?: string;
	tone: "ok" | "muted" | "pending" | "error";
}

const ANCHOR_TONE: Record<AnchorValue["tone"], string> = {
	ok: "text-ink",
	muted: "text-ink-subtle",
	pending: "text-warning",
	error: "text-danger",
};

function agentAnchorOf(agent: AgentInfoDto | undefined): AnchorValue {
	if (!agent) return { value: "无活动 Agent", detail: "registry 未列出任何 Agent", tone: "muted" };
	return { value: agent.name, detail: agent.agentDir ?? `${agent.id} · agentDir 未提供`, tone: "ok" };
}

/**
 * Project 锚点 —— 当前**会话**的归属读数（serve 的权威 `currentProjectId` + 它的来源）。
 *
 * 四态互不可顶替：读不到（未连接 / 读失败 / 还没读到）/ 归属未知（还没问过）/ 未归属（serve
 * 说没有任何东西声明过）/ 已归属。渲染成「未归属」就是替一个尚未得到的答案发言；而把「没问过」
 * 说成「未归属」，则是把一个没发生的事实当成结论。判据只有一份，在 `lib/project-read-model`。
 */
function projectAnchorOf(view: SessionView): AnchorValue {
	// 归属正在重算（切会话后的窗口期）不是「未归属」：这是**归属**这一侧的 pending，
	// 与名单读到哪一步是两件事（名单可能早就读到了）。
	if (view.projectsPending) {
		return { value: "计算中", detail: "Project 归属尚未算出来（不是「未归属」）", tone: "pending" };
	}
	const registry = projectRegistryState(view);
	if (registry.kind === "disconnected") {
		return { value: "未连接", detail: "Project registry 不可用（未连接）", tone: "muted" };
	}
	if (registry.kind === "error") return { value: "读取失败", detail: registry.message, tone: "error" };
	if (registry.kind === "unread") {
		return { value: "未读到", detail: "Project registry 尚未读取", tone: "muted" };
	}
	const attribution = sessionAttributionOf(view);
	switch (attribution.kind) {
		case "unknown":
			return {
				value: "未问到",
				detail: "serve 还没被问过这个会话的归属 —— 不是「未归属」",
				tone: "muted",
			};
		case "none":
			return {
				value: "未归属",
				detail: "serve 查过：没有任何东西声明过这个会话的归属（source: none）",
				tone: "muted",
			};
		case "unlisted":
			return { value: attribution.projectId, detail: "registry 里找不到这个 projectId", tone: "muted" };
		case "attributed":
			return {
				value: attribution.project.name,
				detail: `${attribution.projectId} · ${attribution.project.root} · 来源：${attributionSourceLabel(attribution.from)}`,
				tone: "ok",
			};
	}
}

function sessionAnchorOf(view: SessionView): AnchorValue {
	if (!view.sessionFile && !view.sessionId) {
		return { value: "无活动会话", detail: "serve 快照没有会话身份", tone: "muted" };
	}
	return {
		value: view.sessionName ?? view.sessionId,
		detail: view.sessionFile ?? "快照未带 sessionFile",
		tone: "ok",
	};
}

export function InsightsView(): React.JSX.Element {
	const view = useSession();
	const store = useSessionStore();
	const [period, setPeriod] = useState<StatsPeriodDto>("7d");
	const [stats, setStats] = useState<DashboardStatsDto | null>(null);
	// undefined = 索引未加载/读失败（与「加载了但里面没有这条会话」是两件事：
	// 前者不能判未归属，也不能说会话不在索引里）。
	const [sessions, setSessions] = useState<SessionRecordSummary[] | undefined>(undefined);
	const [sessionsError, setSessionsError] = useState<string | null>(null);
	const [fetching, setFetching] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [skills, setSkills] = useState<SkillsResultDto | null>(null);
	const [skillsError, setSkillsError] = useState<string | null>(null);
	const [memory, setMemory] = useState<MemoryProjectionDto | null>(null);
	const [memoryError, setMemoryError] = useState<string | null>(null);
	const [learningLoading, setLearningLoading] = useState(false);

	const activeAgent = activeAgentOf(view);
	const activeAgentId = activeAgentIdOf(view);

	// stale-while-revalidate：切 period 时旧 stats 保持显示直到新数据到达，
	// 只在无任何历史数据时才展示整页 loading；请求失败保留旧数据 + 提示。
	useEffect(() => {
		if (!view.connected) return;
		setError(null);
		setFetching(true);
		void store
			.fetchStats(period)
			.then(s => {
				setStats(s);
				setFetching(false);
			})
			.catch(err => {
				setError(errorText(err));
				setFetching(false);
			});
	}, [store, view.connected, period]);

	// 会话索引：拉取失败必须留下原因——「索引里没有这条会话」与「索引没读到」不能顶替。
	useEffect(() => {
		if (!view.connected) return;
		void store
			.listSessions()
			.then(rows => {
				setSessions(rows);
				setSessionsError(null);
			})
			.catch(err => {
				// 读失败保持 undefined：空数组会被下游当成「确实没有会话」。
				setSessions(undefined);
				setSessionsError(errorText(err));
			});
	}, [store, view.connected]);

	// 学习面（技能 / 记忆）：锚在当前焦点 Agent 上，换 Agent 重读；旧 Agent 的迟到响应整份丢弃
	// （两个 Agent 的上下文混在一屏就是替另一个 Agent 发言）。
	useEffect(() => {
		if (!view.connected || !activeAgentId) {
			setSkills(null);
			setMemory(null);
			setSkillsError(null);
			setMemoryError(null);
			return;
		}
		let stale = false;
		setLearningLoading(true);
		setSkillsError(null);
		setMemoryError(null);
		const load = async (): Promise<void> => {
			try {
				const result = await store.fetchSkills(activeAgentId);
				if (!stale) setSkills(result);
			} catch (err) {
				if (!stale) {
					setSkills(null);
					setSkillsError(errorText(err));
				}
			}
			try {
				const result = await store.fetchMemory(activeAgentId);
				if (!stale) setMemory(result);
			} catch (err) {
				if (!stale) {
					setMemory(null);
					setMemoryError(errorText(err));
				}
			}
			if (!stale) setLearningLoading(false);
		};
		void load();
		return () => {
			stale = true;
		};
	}, [store, view.connected, activeAgentId]);

	// 目录行 → 归属索引（会话索引只扫一遍）。
	// 两个来源各自三态：`view.projects === undefined`（没读到）与 `sessions === undefined`（会话索引没加载）
	// 都交给 attributeFolders 当 **unknown**（不是未归属）—— UI 再把 unknown 分区单独渲染出来。
	const attribution = useMemo(
		() =>
			attributeFolders(
				(stats?.byFolder ?? []).map(row => row.folder),
				{ sessions, projects: view.projects, agents: view.agents },
			),
		[stats, sessions, view.projects, view.agents],
	);

	const currentSession = useMemo(
		() => findCurrentSession(sessions, { sessionFile: view.sessionFile, sessionId: view.sessionId }),
		[sessions, view.sessionFile, view.sessionId],
	);

	const sections = useMemo(
		() =>
			scopeSections({
				rows: stats?.byFolder ?? [],
				attribution,
				projects: view.projects,
				sessionFolderKey: currentSession.state === "indexed" ? currentSession.folderKey : null,
			}),
		[stats, attribution, view.projects, currentSession],
	);

	const trend = useMemo(() => {
		if (!stats) return [];
		return period === "1d"
			? stats.timeSeries.map(p => ({ timestamp: p.timestamp, requests: p.requests }))
			: dailyRequestBuckets(stats, period);
	}, [stats, period]);
	const trendMax = trend.reduce((m, p) => Math.max(m, p.requests), 0);

	const modelRows = useMemo(() => {
		if (!stats) return [];
		const priceByModel = new Map(stats.priceCatalog.map(p => [`${p.provider}/${p.model}`, p.price.input]));
		return [...stats.byModel]
			.sort((a, b) => b.totalCost - a.totalCost)
			.map(m => ({
				...m,
				priceInput: priceByModel.get(`${m.provider}/${m.model}`),
			}));
	}, [stats]);

	if (!view.connected) {
		return (
			<div className="px-10 pt-8 pb-12">
				<div className="page-wide">
					<Header period={period} onPeriod={setPeriod} />
					<div className="py-20 text-center text-[13px] text-ink-faint">未连接——用量统计不可用</div>
				</div>
			</div>
		);
	}

	const empty = stats && stats.overall.totalRequests === 0 && stats.byModel.length === 0;
	const sessionsNote =
		sessionsError !== null
			? "会话索引读取失败"
			: sessions === undefined
				? "会话索引未加载"
				: `会话索引 ${sessions.length} 条`;
	// 分区依赖 stats.byFolder：还没到 / 拉失败 / 就绪 三态分开渲染。
	// stats 未到时把分区画成「该时段没有目录级行」就是把「还没读到」说成「确实没有」。
	const statsState: StatsState = stats
		? { kind: "ready" }
		: error
			? { kind: "error", message: error }
			: { kind: "loading" };

	return (
		<div className="px-10 pt-8 pb-12">
			<div className="page-wide">
				<Header period={period} onPeriod={setPeriod} refreshing={fetching && stats !== null} />

				{error && !stats && (
					<div className="py-20 text-center text-[13px] text-ink-faint">用量统计不可用：{error}</div>
				)}
				{!stats && !error && <div className="py-20 text-center text-[13px] text-ink-faint">加载用量统计…</div>}
				{stats && error && (
					<div className="mb-4 rounded-lg border border-hairline bg-surface px-3 py-2 text-[12px] text-ink-subtle">
						用量统计刷新失败（显示上次数据）：{error}
					</div>
				)}
				{stats && empty && (
					<div className="py-20 text-center text-[13px] text-ink-faint">
						暂无用量数据——运行会话后 serve 会自动同步并聚合
					</div>
				)}
				{stats && !empty && (
					<div className="space-y-8">
						<KpiCards overall={stats.overall} />
						<TrendStrip points={trend} max={trendMax} period={period} />
						<ModelCostTable rows={modelRows} />
						<FolderTable rows={stats.byFolder} attribution={attribution} sessionsNote={sessionsNote} />
					</div>
				)}

				<div className="mt-8 space-y-8">
					<ScopeAnchors
						agent={agentAnchorOf(activeAgent)}
						project={projectAnchorOf(view)}
						session={sessionAnchorOf(view)}
					/>
					<ScopeBreakdown
						sections={sections}
						period={period}
						statsState={statsState}
						sessionsNote={sessionsNote}
						sessionsError={sessionsError}
						projectState={
							view.projectsError
								? { kind: "error", message: view.projectsError }
								: view.projectsPending
									? { kind: "pending" }
									: view.projects === undefined
										? { kind: "unread" }
										: { kind: "ready" }
						}
					/>
					<SessionScopeCard
						view={view}
						current={currentSession}
						sessionRows={sections.sessionRows}
						statsState={statsState}
						period={period}
					/>
					<LearningSurfaceCard
						agent={activeAgent}
						skills={skills}
						skillsError={skillsError}
						memory={memory}
						memoryError={memoryError}
						loading={learningLoading}
					/>
				</div>
			</div>
		</div>
	);
}

function Header({
	period,
	onPeriod,
	refreshing = false,
}: {
	period: StatsPeriodDto;
	onPeriod: (p: StatsPeriodDto) => void;
	refreshing?: boolean;
}): React.JSX.Element {
	return (
		<div className="mb-7 flex items-center justify-between gap-4">
			<h1 className="text-[32px] font-semibold tracking-[-0.8px] text-ink">用量</h1>
			<div className="flex items-center gap-3">
				{refreshing && (
					<div className="flex items-center gap-2 text-[12px] text-ink-faint">
						<span className="h-3 w-3 animate-spin rounded-full border-2 border-ink-faint/30 border-t-ink-faint" />
						更新中…
					</div>
				)}
				<div className="flex items-center gap-0.5 rounded-lg border border-hairline bg-surface p-0.5">
					{PERIODS.map(p => (
						<button
							key={p.id}
							type="button"
							onClick={() => onPeriod(p.id)}
							className={`rounded-md px-3 py-1.5 text-[12.5px] transition-colors ${
								period === p.id ? "bg-accent text-on-accent" : "text-ink-subtle hover:text-ink"
							}`}
						>
							{p.label}
						</button>
					))}
				</div>
			</div>
		</div>
	);
}

interface Kpi {
	label: string;
	value: string;
	sub?: string;
}

function KpiCards({ overall }: { overall: DashboardStatsDto["overall"] }): React.JSX.Element {
	const cards: Kpi[] = [
		{
			label: "请求数",
			value: fmtNum(overall.totalRequests),
			sub: `${fmtNum(overall.successfulRequests)} 成功 / ${fmtNum(overall.failedRequests)} 失败`,
		},
		{
			label: "用量",
			value: fmtTokens(overall.totalInputTokens + overall.totalOutputTokens),
			sub: `输入 ${fmtTokens(overall.totalInputTokens)} · 输出 ${fmtTokens(overall.totalOutputTokens)}`,
		},
		{
			label: "费用",
			value: fmtMoney(overall.totalCost),
			sub: `缓存命中 ${fmtPct(overall.cacheRate)}`,
		},
		{
			label: "错误率",
			value: fmtPct(overall.errorRate),
			sub: `平均 ${fmtDuration(overall.avgDuration)} / 次`,
		},
	];
	return (
		<div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
			{cards.map(c => (
				<div key={c.label} className="rounded-xl border border-hairline bg-surface px-5 py-4">
					<div className="text-[11px] font-semibold tracking-[0.08em] text-ink-faint uppercase">{c.label}</div>
					<div className="mt-1.5 font-mono text-2xl font-semibold tabular-nums text-ink">{c.value}</div>
					<div className="mt-1 truncate text-[11.5px] text-ink-subtle">{c.sub}</div>
				</div>
			))}
		</div>
	);
}

function TrendStrip({
	points,
	max,
	period,
}: {
	points: { timestamp: number; requests: number }[];
	max: number;
	period: StatsPeriodDto;
}): React.JSX.Element {
	const fmt = period === "1d" ? fmtHour : fmtDay;
	return (
		<div className="rounded-xl border border-hairline bg-surface px-5 py-4">
			<div className="mb-3 flex items-baseline justify-between">
				<div className="section-title">请求趋势</div>
				<div className="font-mono text-[11px] text-ink-faint">{points.length} 个时段</div>
			</div>
			{points.length === 0 ? (
				<div className="py-8 text-center text-[12px] text-ink-faint">该时段无请求数据</div>
			) : (
				<div className="flex h-16 items-end gap-px">
					{points.map(p => (
						<div
							key={p.timestamp}
							title={`${fmt(p.timestamp)} · ${p.requests} 请求`}
							className="min-w-0 flex-1 rounded-t-sm bg-ink-faint/50"
							style={{ height: `${max > 0 ? Math.max(3, (p.requests / max) * 100) : 3}%` }}
						/>
					))}
				</div>
			)}
		</div>
	);
}

function ModelCostTable({
	rows,
}: {
	rows: {
		model: string;
		provider: string;
		totalRequests: number;
		totalInputTokens: number;
		totalOutputTokens: number;
		totalCacheReadTokens: number;
		totalCost: number;
		errorRate: number;
		priceInput?: number;
	}[];
}): React.JSX.Element {
	return (
		<div className="rounded-xl border border-hairline bg-surface">
			<div className="section-title">模型成本表</div>
			<table className="w-full border-collapse text-[12.5px]">
				<thead>
					<tr className="section-title">
						<th className="px-5 py-2 font-semibold">模型</th>
						<th className="px-3 py-2 text-right font-semibold">请求</th>
						<th className="px-3 py-2 text-right font-semibold">输入 tok</th>
						<th className="px-3 py-2 text-right font-semibold">输出 tok</th>
						<th className="px-3 py-2 text-right font-semibold">缓存读 tok</th>
						<th className="px-3 py-2 text-right font-semibold">单价 $/1M</th>
						<th className="px-3 py-2 text-right font-semibold">费用</th>
						<th className="px-5 py-2 text-right font-semibold">错误率</th>
					</tr>
				</thead>
				<tbody>
					{rows.map(r => (
						<tr key={`${r.provider}/${r.model}`} className="border-t border-hairline">
							<td className="px-5 py-2.5">
								<div className="font-mono text-[12.5px] text-ink">{r.model}</div>
								<div className="text-[11px] text-ink-faint">{r.provider}</div>
							</td>
							<td className="px-3 py-2.5 text-right font-mono tabular-nums text-ink-subtle">
								{fmtNum(r.totalRequests)}
							</td>
							<td className="px-3 py-2.5 text-right font-mono tabular-nums text-ink-subtle">
								{fmtNum(r.totalInputTokens)}
							</td>
							<td className="px-3 py-2.5 text-right font-mono tabular-nums text-ink-subtle">
								{fmtNum(r.totalOutputTokens)}
							</td>
							<td className="px-3 py-2.5 text-right font-mono tabular-nums text-ink-subtle">
								{fmtNum(r.totalCacheReadTokens)}
							</td>
							<td className="px-3 py-2.5 text-right font-mono tabular-nums text-ink-subtle">
								{r.priceInput !== undefined ? `$${r.priceInput}` : "—"}
							</td>
							<td className="px-3 py-2.5 text-right font-mono tabular-nums text-ink">{fmtMoney(r.totalCost)}</td>
							<td className="px-5 py-2.5 text-right font-mono tabular-nums text-ink-subtle">
								{fmtPct(r.errorRate)}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

/**
 * 按目录用量（folder → agent）。目录列显示的是 stats `byFolder[].folder`（omp-stats 已解码的
 * 绝对路径）；Agent 列来自 list_sessions 真索引，查不到显示 —（= 索引里没有会话，不是「没有 Agent」）。
 */
function FolderTable({
	rows,
	attribution,
	sessionsNote,
}: {
	rows: StatsFolderRowDto[];
	attribution: FolderAttributionIndex;
	sessionsNote: string;
}): React.JSX.Element {
	return (
		<div className="rounded-xl border border-hairline bg-surface">
			<div className="flex items-baseline justify-between gap-4 px-5 pt-4 pb-2">
				<div className="section-title">按目录用量（folder → agent）</div>
				<div className="font-mono text-[11px] text-ink-faint">{sessionsNote}</div>
			</div>
			{rows.length === 0 ? (
				<div className="px-5 pb-6 text-[12px] text-ink-faint">该时段无目录级数据</div>
			) : (
				<table className="w-full border-collapse text-[12.5px]">
					<thead>
						<tr className="section-title">
							<th className="px-5 py-2 font-semibold">目录</th>
							<th className="px-3 py-2 text-right font-semibold">请求</th>
							<th className="px-3 py-2 text-right font-semibold">Tokens</th>
							<th className="px-3 py-2 text-right font-semibold">费用</th>
							<th className="px-5 py-2 font-semibold">Agent</th>
						</tr>
					</thead>
					<tbody>
						{rows.map(r => {
							const agents = attribution.get(r.folder)?.agents;
							const agentText =
								!agents || agents.state === "unknown"
									? "未知（索引未加载）"
									: agents.state === "unassigned"
										? "—"
										: agents.value.names.join(" + ");
							return (
								<tr key={r.folder} className="border-t border-hairline">
									<td className="max-w-[360px] px-5 py-2.5 font-mono text-[11.5px] text-ink-subtle">
										<div className="truncate" title={r.folder}>
											{r.folder}
										</div>
									</td>
									<td className="px-3 py-2.5 text-right font-mono tabular-nums text-ink-subtle">
										{fmtNum(r.totalRequests)}
									</td>
									<td className="px-3 py-2.5 text-right font-mono tabular-nums text-ink-subtle">
										{fmtNum(r.totalInputTokens + r.totalOutputTokens)}
									</td>
									<td className="px-3 py-2.5 text-right font-mono tabular-nums text-ink-subtle">
										{fmtMoney(r.totalCost)}
									</td>
									<td className="px-5 py-2.5 text-ink-subtle">{agentText}</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			)}
		</div>
	);
}

/** 当前 scope 锚点：这一屏显示的所有分区都锚在这三者上。 */
function ScopeAnchors({
	agent,
	project,
	session,
}: {
	agent: AnchorValue;
	project: AnchorValue;
	session: AnchorValue;
}): React.JSX.Element {
	const items: { label: string; value: AnchorValue }[] = [
		{ label: "Agent", value: agent },
		{ label: "Project", value: project },
		{ label: "Session", value: session },
	];
	return (
		<div className="rounded-xl border border-hairline bg-surface px-5 py-4">
			<div className="mb-3 flex items-baseline justify-between">
				<div className="section-title">当前 scope</div>
				<div className="font-mono text-[11px] text-ink-faint">
					锚点来自 serve 快照与 list_agents / list_projects
				</div>
			</div>
			<div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
				{items.map(item => (
					<div key={item.label} className="min-w-0">
						<div className="text-[11px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
							{item.label}
						</div>
						<div className={`mt-1 truncate text-[13px] font-semibold ${ANCHOR_TONE[item.value.tone]}`}>
							{item.value.value}
						</div>
						{item.value.detail && (
							<div className="mt-0.5 truncate font-mono text-[11px] text-ink-faint" title={item.value.detail}>
								{item.value.detail}
							</div>
						)}
					</div>
				))}
			</div>
		</div>
	);
}

/**
 * Project 分区的前置状态：读失败 / 还没算出来 / registry 没读到 / 就绪。
 * 四态不能互相顶替：把「没读到」渲染成「未归属」是拿一个没读过的名单下结论。
 */
type ProjectState = { kind: "ready" } | { kind: "pending" } | { kind: "unread" } | { kind: "error"; message: string };

/** 分区数据源（stats.byFolder）的前置状态：加载中 / 读失败 / 就绪。 */
type StatsState = { kind: "ready" } | { kind: "loading" } | { kind: "error"; message: string };

function RollupTable({ groups, emptyText }: { groups: ScopeRollupRow[]; emptyText: string }): React.JSX.Element {
	if (groups.length === 0) {
		return <div className="px-5 pb-5 text-[12px] text-ink-faint">{emptyText}</div>;
	}
	return (
		<table className="w-full border-collapse text-[12.5px]">
			<thead>
				<tr className="section-title">
					<th className="px-5 py-2 font-semibold">分组</th>
					<th className="px-3 py-2 text-right font-semibold">目录行</th>
					<th className="px-3 py-2 text-right font-semibold">请求</th>
					<th className="px-3 py-2 text-right font-semibold">输入 tok</th>
					<th className="px-3 py-2 text-right font-semibold">输出 tok</th>
					<th className="px-3 py-2 text-right font-semibold">费用</th>
					<th className="px-5 py-2 text-right font-semibold">错误率</th>
				</tr>
			</thead>
			<tbody>
				{groups.map(group => (
					<tr key={group.key} className="border-t border-hairline">
						<td className="max-w-[320px] px-5 py-2.5">
							<div className="truncate text-ink" title={group.label}>
								{group.label}
							</div>
						</td>
						<td className="px-3 py-2.5 text-right font-mono tabular-nums text-ink-subtle">{group.folderCount}</td>
						<td className="px-3 py-2.5 text-right font-mono tabular-nums text-ink-subtle">
							{fmtNum(group.totalRequests)}
						</td>
						<td className="px-3 py-2.5 text-right font-mono tabular-nums text-ink-subtle">
							{fmtNum(group.totalInputTokens)}
						</td>
						<td className="px-3 py-2.5 text-right font-mono tabular-nums text-ink-subtle">
							{fmtNum(group.totalOutputTokens)}
						</td>
						<td className="px-3 py-2.5 text-right font-mono tabular-nums text-ink">
							{fmtMoney(group.totalCost)}
						</td>
						<td
							className="px-5 py-2.5 text-right font-mono tabular-nums text-ink-subtle"
							title={group.totalRequests === 0 ? "该组无请求，错误率不可计算" : "Σ失败 / Σ请求（加权重算）"}
						>
							{group.totalRequests === 0 ? "—" : fmtPct(group.errorRate)}
						</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}

/** 三个 scope 分区：按 Agent / 按 Project / 未归属。分区数字都是目录行求和（汇总口径）。 */
function ScopeBreakdown({
	sections,
	period,
	statsState,
	sessionsNote,
	sessionsError,
	projectState,
}: {
	sections: ScopeSections;
	period: StatsPeriodDto;
	statsState: StatsState;
	sessionsNote: string;
	sessionsError: string | null;
	projectState: ProjectState;
}): React.JSX.Element {
	const windowLabel = PERIODS.find(p => p.id === period)?.label ?? period;
	const sumNote = `按目录行求和 · ${windowLabel}`;
	const hasRows = sections.byAgent.length + sections.unassignedAgent.length + sections.unknownAgent.length > 0;
	return (
		<div className="rounded-xl border border-hairline bg-surface">
			<div className="flex items-baseline justify-between gap-4 px-5 pt-4 pb-2">
				<div className="section-title">Scope 分区</div>
				<div className="font-mono text-[11px] text-ink-faint">
					{sumNote} · {sessionsNote}
				</div>
			</div>
			{sessionsError !== null && (
				<div className="mx-5 mb-3 rounded-lg border border-hairline bg-surface-2 px-3 py-2 text-[12px] text-danger">
					会话索引读取失败，Agent 归属不可用：{sessionsError}
				</div>
			)}
			{statsState.kind === "loading" && (
				<div className="px-5 pb-5 text-[12px] text-ink-faint">用量统计加载中——分区需要 stats byFolder</div>
			)}
			{statsState.kind === "error" && (
				<div className="px-5 pb-5 text-[12px] text-danger">用量统计不可用，分区无法计算：{statsState.message}</div>
			)}
			{statsState.kind === "ready" && !hasRows && (
				<div className="px-5 pb-5 text-[12px] text-ink-faint">该时段没有目录级行（stats byFolder 为空）</div>
			)}
			{statsState.kind === "ready" && hasRows && (
				<div className="space-y-6 pb-5">
					<div>
						<div className="flex items-baseline justify-between gap-4 px-5 py-2">
							<div className="section-title text-[12.5px]">按 Agent 汇总</div>
							<div className="text-[11px] text-ink-faint">由目录行求和得出，非服务端原生指标</div>
						</div>
						<RollupTable
							groups={sections.byAgent}
							emptyText="没有归属于单一 Agent 的目录行（见下方未归属 / 多 Agent / 归属未知）"
						/>
					</div>
					<div>
						<div className="flex items-baseline justify-between gap-4 px-5 py-2">
							<div className="section-title text-[12.5px]">按 Project 汇总</div>
							<div className="text-[11px] text-ink-faint">按目录路径命中最深祖先 root，再对目录行求和</div>
						</div>
						{projectState.kind === "error" ? (
							<div className="px-5 pb-1 text-[12px] text-danger">
								Project registry 读取失败，归属不可用：{projectState.message}
							</div>
						) : projectState.kind === "pending" ? (
							<div className="px-5 pb-1 text-[12px] text-ink-faint">
								Project 归属计算中——此期间不判定「未归属」
							</div>
						) : (
							<>
								<RollupTable
									groups={sections.byProject}
									emptyText="没有落在已声明 Project 下的目录行（见下方未归属 / 归属未知）"
								/>
								{sections.unknownProject.length > 0 && (
									<RollupTable groups={sections.unknownProject} emptyText="" />
								)}
							</>
						)}
					</div>
					<div>
						<div className="flex items-baseline justify-between gap-4 px-5 py-2">
							<div className="section-title text-[12.5px]">未归属 / 多 Agent / 归属未知目录</div>
							<div className="text-[11px] text-ink-faint">
								都不并入任何 Agent（多 Agent 目录整份计给每个 Agent
								就是重复计数；未知当成未归属是拿没读过的名单下结论）
							</div>
						</div>
						<RollupTable groups={sections.unassignedAgent} emptyText="无未归属目录行" />
						{sections.unknownAgent.length > 0 && <RollupTable groups={sections.unknownAgent} emptyText="" />}
						<div className="px-5 pt-3 pb-2 text-[11px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
							Project 未归属 / 归属未知
						</div>
						<RollupTable groups={sections.unassignedProject} emptyText="所有目录行都落在已声明 Project 下" />
					</div>
				</div>
			)}
		</div>
	);
}

/**
 * Session scope：只显示当前会话自身可确认的事实（list_sessions 索引里的那一条）。
 * 索引里没有这条会话就明说「不在索引里」——目录级数字不冒充会话级指标；
 * 真的要给目录级数字（所在目录），必须标注「非会话级」。
 */
function SessionScopeCard({
	view,
	current,
	sessionRows,
	statsState,
	period,
}: {
	view: SessionView;
	current: ReturnType<typeof findCurrentSession>;
	sessionRows: StatsFolderRowDto[];
	statsState: StatsState;
	period: StatsPeriodDto;
}): React.JSX.Element {
	const windowLabel = PERIODS.find(p => p.id === period)?.label ?? period;
	return (
		<div className="rounded-xl border border-hairline bg-surface">
			<div className="flex items-baseline justify-between gap-4 px-5 pt-4 pb-2">
				<div className="section-title">Session scope</div>
				<div className="font-mono text-[11px] text-ink-faint">会话级事实来自 list_sessions 索引</div>
			</div>
			{current.state === "indexed" ? (
				<div className="px-5 pb-5">
					<div className="grid grid-cols-1 gap-x-6 gap-y-2 text-[12.5px] xl:grid-cols-3">
						<FactRow label="会话" value={`${current.session.name} · ${current.session.id}`} />
						<FactRow label="Agent" value={current.session.agent} />
						<FactRow label="开始时间" value={fmtTimestamp(current.session.startedAt)} />
						<FactRow label="消息数" value={String(current.session.messageCount)} />
						<FactRow label="状态" value={recordStatusLabel(current.session.status)} />
						<FactRow label="来源" value={current.session.source === "agent" ? "agent 会话" : "cli 会话"} />
						<FactRow label="cwd" value={current.session.cwd ?? "索引未提供"} mono />
						<FactRow label="会话文件" value={current.session.sessionFile ?? "索引未提供"} mono span2 />
					</div>
					<div className="mt-4 border-t border-hairline pt-3">
						<div className="mb-2 flex items-baseline justify-between gap-4">
							<div className="section-title text-[12.5px]">所在目录（非会话级）</div>
							<div className="font-mono text-[11px] text-ink-faint">
								{current.folderKey ?? "该会话是扁平文件，不落在任何目录行下"} · {windowLabel}
							</div>
						</div>
						{statsState.kind !== "ready" ? (
							<div className="text-[12px] text-ink-faint">
								{statsState.kind === "loading"
									? "用量统计加载中——目录级数字暂缺"
									: `用量统计不可用，目录级数字暂缺：${statsState.message}`}
							</div>
						) : sessionRows.length === 0 ? (
							<div className="text-[12px] text-ink-faint">
								{current.folderKey === null
									? "无目录级数据可显示（gateway 扁平会话文件不参与 byFolder 聚合）"
									: "该目录在本时段没有 stats 行——不代表该会话没有用量"}
							</div>
						) : (
							<div className="space-y-1.5">
								{sessionRows.map(row => (
									<div
										key={row.folder}
										className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[12.5px]"
									>
										<span className="font-mono text-[11.5px] text-ink-subtle">{row.folder}</span>
										<span className="text-ink">{fmtNum(row.totalRequests)} 请求</span>
										<span className="text-ink-subtle">
											{fmtTokens(row.totalInputTokens + row.totalOutputTokens)}
										</span>
										<span className="text-ink-subtle">{fmtMoney(row.totalCost)}</span>
										<span className="text-ink-faint">
											错误率 {row.totalRequests === 0 ? "—" : fmtPct(row.errorRate)}
										</span>
									</div>
								))}
								<div className="text-[11px] text-ink-faint">
									以上是「目录」口径（同目录全部会话合计），不是这一个会话的用量
								</div>
							</div>
						)}
					</div>
				</div>
			) : (
				<div className="px-5 pb-5 text-[12.5px] text-ink-subtle">
					{current.state === "unknown" ? (
						<>
							<div>会话索引未加载——现在无法确认这条会话在不在索引里。</div>
							<div className="mt-1 text-[11px] text-ink-faint">
								“没读到”不是“不在索引里”，这里不把两者合着说。
							</div>
						</>
					) : current.state === "unindexed" ? (
						<>
							<div>该会话不在索引里——list_sessions 没返回这条会话，因此没有可确认的会话级数字。</div>
							<div className="mt-1 font-mono text-[11px] text-ink-faint">
								{current.sessionFile ?? current.sessionId}
							</div>
							<div className="mt-1 text-[11px] text-ink-faint">
								目录级数字不能冒充会话级指标，这里不做任何替代推导。
							</div>
						</>
					) : (
						<div>无活动会话（快照没有会话身份：{view.sessionId || "sessionId 为空"}）</div>
					)}
				</div>
			)}
		</div>
	);
}

function FactRow({
	label,
	value,
	mono = false,
	span2 = false,
}: {
	label: string;
	value: string;
	mono?: boolean;
	span2?: boolean;
}): React.JSX.Element {
	return (
		<div className={`min-w-0 ${span2 ? "xl:col-span-2" : ""}`}>
			<div className="text-[11px] text-ink-faint">{label}</div>
			<div className={`truncate ${mono ? "font-mono text-[11.5px]" : ""} text-ink-subtle`} title={value}>
				{value}
			</div>
		</div>
	);
}

/**
 * 学习面：复用 self-evolution 既有投影（get_skills / get_memory），不新建读面。
 * 计数字段直接来自 DTO；DTO 里没有的计数不显示（不编一个数字出来）。
 */
function LearningSurfaceCard({
	agent,
	skills,
	skillsError,
	memory,
	memoryError,
	loading,
}: {
	agent: AgentInfoDto | undefined;
	skills: SkillsResultDto | null;
	skillsError: string | null;
	memory: MemoryProjectionDto | null;
	memoryError: string | null;
	loading: boolean;
}): React.JSX.Element {
	return (
		<div className="rounded-xl border border-hairline bg-surface">
			<div className="flex items-baseline justify-between gap-4 px-5 pt-4 pb-2">
				<div className="section-title">学习面</div>
				<div className="font-mono text-[11px] text-ink-faint">
					{loading ? "读取中…" : `锚在 ${agent?.name ?? "当前 Agent"}（get_skills / get_memory）`}
				</div>
			</div>
			<div className="grid grid-cols-1 gap-4 px-5 pb-5 xl:grid-cols-2">
				<div className="min-w-0">
					<div className="text-[11px] font-semibold tracking-[0.08em] text-ink-faint uppercase">技能</div>
					{skillsError !== null ? (
						<div className="mt-1 text-[12px] text-danger">技能读取失败：{skillsError}</div>
					) : skills === null ? (
						<div className="mt-1 text-[12px] text-ink-faint">{loading ? "读取中…" : "尚未读取"}</div>
					) : (
						<>
							<div className="mt-1 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[12.5px]">
								<span className="text-ink">已加载 {skills.skills.length}</span>
								<span className="text-ink-subtle">停用 {skills.disabled.length}</span>
								<span className="text-ink-subtle">受阻 {skills.blocked.length}</span>
								<span className="text-ink-subtle">发现错误 {skills.errors.length}</span>
							</div>
							<div className="mt-1 font-mono text-[11px] text-ink-faint">
								锚点 agent={skills.scope.agentId} · project=
								{skills.scope.projectRoot ?? "未归属"}
							</div>
							{skills.errors.length > 0 && (
								<ul className="mt-1.5 space-y-0.5 text-[11px] text-danger">
									{skills.errors.slice(0, 3).map(err => (
										<li
											key={`${err.path}:${err.message}`}
											className="truncate"
											title={`${err.path} ${err.message}`}
										>
											{err.path || "（扫描级）"}：{err.message}
										</li>
									))}
									{skills.errors.length > 3 && <li>…还有 {skills.errors.length - 3} 项</li>}
								</ul>
							)}
						</>
					)}
				</div>
				<div className="min-w-0">
					<div className="text-[11px] font-semibold tracking-[0.08em] text-ink-faint uppercase">记忆库</div>
					{memoryError !== null ? (
						<div className="mt-1 text-[12px] text-danger">记忆读取失败：{memoryError}</div>
					) : memory === null ? (
						<div className="mt-1 text-[12px] text-ink-faint">{loading ? "读取中…" : "尚未读取"}</div>
					) : memory.memoryStore.error ? (
						<div className="mt-1 text-[12px] text-danger">记忆库读取失败：{memory.memoryStore.error}</div>
					) : (
						<>
							<div className="mt-1 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[12.5px]">
								<span className="text-ink">条目 {memory.memoryStore.totalEntries}</span>
								<span className="text-ink-subtle">分区 {memory.memoryStore.sections.length}</span>
								<span className="text-ink-subtle">scope {memory.memoryStore.scope}</span>
							</div>
							<div
								className="mt-1 truncate font-mono text-[11px] text-ink-faint"
								title={memory.memoryStore.dbPath}
							>
								{memory.memoryStore.dbPath}
							</div>
						</>
					)}
				</div>
			</div>
		</div>
	);
}
