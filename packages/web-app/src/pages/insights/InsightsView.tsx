import type { DashboardStatsDto, StatsFolderRowDto, StatsPeriodDto } from "@cornfield/wire";
import { useEffect, useMemo, useState } from "react";
import type { SessionRecordSummary } from "../../lib/records";
import { useSessionStore } from "../../state/session-store";
import { useSession } from "../../state/use-session";

/**
 * 用量面板（W3 D2）—— serve get_stats 只读聚合 + list_sessions 真索引。
 * - period 切换（1d/7d/30d/90d/全部）→ get_stats(period) 时间窗口聚合
 * - 用量/费用/错误率卡（overall）
 * - 最近请求趋势条（1d 用小时桶 timeSeries；其余用日桶 costSeries 聚合）
 * - 模型成本表（byModel + priceCatalog 单价，单价来自 models.json，查不到显示 —）
 * - 按目录用量（byFolder + 由 list_sessions sessionFile 推导的 folder→agent 映射）
 *
 * 无 mock：任一数据源取不到就渲染对应空态，绝不回退假数据。
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

/**
 * list_sessions sessionFile → stats byFolder 的 folder key（与 omp-stats parser 同规则）：
 * <sessionsRoot>/<encoded-cwd>/by-date/... 取第一段，`--` 分隔符还原为 `/`。
 */
function folderKeyOf(sessionFile: string | undefined): string | null {
	if (!sessionFile) return null;
	const segments = sessionFile.replaceAll("\\", "/").split("/");
	const idx = segments.lastIndexOf("sessions");
	const enc = idx >= 0 && idx + 1 < segments.length ? segments[idx + 1] : undefined;
	if (!enc || enc.includes(".")) return null; // 扁平文件（如 gateway convId.jsonl）非目录布局
	return enc.replace(/^--/, "/").replace(/--/g, "/");
}

/** folder → agent 名集合（由 list_sessions 真索引推导；查不到的目录显示 —）。 */
function buildFolderAgentMap(sessions: SessionRecordSummary[]): Map<string, string> {
	const map = new Map<string, Set<string>>();
	for (const s of sessions) {
		const key = folderKeyOf(s.sessionFile);
		if (!key) continue;
		if (!map.has(key)) map.set(key, new Set());
		map.get(key)?.add(s.agent);
	}
	const merged = new Map<string, string>();
	for (const [folder, agents] of map) {
		merged.set(folder, [...agents].join(", "));
	}
	return merged;
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

export function InsightsView(): React.JSX.Element {
	const view = useSession();
	const store = useSessionStore();
	const [period, setPeriod] = useState<StatsPeriodDto>("7d");
	const [stats, setStats] = useState<DashboardStatsDto | null>(null);
	const [sessions, setSessions] = useState<SessionRecordSummary[]>([]);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!view.connected) return;
		setError(null);
		void store
			.fetchStats(period)
			.then(setStats)
			.catch(err => setError(err instanceof Error ? err.message : String(err)));
	}, [store, view.connected, period]);

	useEffect(() => {
		if (!view.connected) return;
		void store
			.listSessions()
			.then(setSessions)
			.catch(() => undefined);
	}, [store, view.connected]);

	const folderAgents = useMemo(() => buildFolderAgentMap(sessions), [sessions]);

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

	return (
		<div className="px-10 pt-8 pb-12">
			<div className="page-wide">
				<Header period={period} onPeriod={setPeriod} />

				{error && <div className="py-20 text-center text-[13px] text-ink-faint">用量统计不可用：{error}</div>}
				{!stats && !error && <div className="py-20 text-center text-[13px] text-ink-faint">加载用量统计…</div>}
				{stats && empty && (
					<div className="py-20 text-center text-[13px] text-ink-faint">
						暂无用量数据——运行会话后 serve 会自动同步并聚合
					</div>
				)}
				{stats && !empty && !error && (
					<div className="space-y-8">
						<KpiCards overall={stats.overall} />
						<TrendStrip points={trend} max={trendMax} period={period} />
						<ModelCostTable rows={modelRows} />
						<FolderTable rows={stats.byFolder} folderAgents={folderAgents} />
					</div>
				)}
			</div>
		</div>
	);
}

function Header({
	period,
	onPeriod,
}: {
	period: StatsPeriodDto;
	onPeriod: (p: StatsPeriodDto) => void;
}): React.JSX.Element {
	return (
		<div className="mb-7 flex items-center justify-between gap-4">
			<h1 className="text-[32px] font-semibold tracking-[-0.8px] text-ink">用量</h1>
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

function FolderTable({
	rows,
	folderAgents,
}: {
	rows: StatsFolderRowDto[];
	folderAgents: Map<string, string>;
}): React.JSX.Element {
	return (
		<div className="rounded-xl border border-hairline bg-surface">
			<div className="section-title">按目录用量（folder → agent）</div>
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
						{rows.map(r => (
							<tr key={r.folder} className="border-t border-hairline">
								<td className="px-3 py-2.5 text-right font-mono tabular-nums text-ink-subtle">
									{fmtNum(r.totalRequests)}
								</td>
								<td className="px-3 py-2.5 text-right font-mono text-ink-subtle">{fmtNum(r.totalRequests)}</td>
								<td className="px-3 py-2.5 text-right font-mono tabular-nums text-ink-subtle">
									{fmtNum(r.totalInputTokens + r.totalOutputTokens)}
								</td>
								<td className="px-3 py-2.5 text-right font-mono tabular-nums text-ink-subtle">
									{fmtMoney(r.totalCost)}
								</td>
								<td className="px-5 py-2.5 text-ink-subtle">{folderAgents.get(r.folder) ?? "—"}</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
		</div>
	);
}
