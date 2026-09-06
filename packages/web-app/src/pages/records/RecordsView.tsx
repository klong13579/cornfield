import { Activity, BarChart3, ChevronRight, MessageSquare, Play, Search, Stethoscope } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { DiagnosisAggregationDto } from "../../lib/pi-client-api";
import {
	CURRENT_SESSION_ID,
	downloadJsonl,
	type RecordStatus,
	recordStatusLabel,
	type SessionRecordSummary,
} from "../../lib/records";
import { useSessionStore } from "../../state/session-store";
import { useSession } from "../../state/use-session";
import { DIMENSION_LABELS } from "../../lib/records-dimensions";

/** Severity → badge class mapping. */
const severityBadgeClass: Record<string, string> = {
	P0: "badge fail",
	P1: "badge run",
	P2: "badge done",
	P3: "badge done",
};

/** Diagnosis report cached per sessionFile. */

const QUALITY_BAR_CLASSES: Record<string, string> = {
	A: "bg-success",
	B: "bg-success/80",
	C: "bg-warning",
	D: "bg-warning/80",
	E: "bg-danger/80",
	F: "bg-danger",
};

interface DiagReport {
	reportId: string;
	sessionId: string;
	severity: string;
}

/**
 * 会话记录列表（FR-3）—— 行式列表（15px 名称 + 状态 badge）+ 筛选/搜索 + 操作列。
 * 数据源：list_sessions 真索引 +
 * 特殊行「当前会话」（get_messages 真数据）。
 */
export function RecordsView(): React.JSX.Element {
	const navigate = useNavigate();
	const openSession = (row: SessionRecordSummary) => {
		navigate(`/records/${row.id}`, { state: { sessionFile: row.sessionFile, name: row.name } });
	};
	const store = useSessionStore();
	const view = useSession();
	const [dateFilter, setDateFilter] = useState("all");
	const [agentFilter, setAgentFilter] = useState("all");
	const [statusFilter, setStatusFilter] = useState<"all" | RecordStatus>("all");
	const [query, setQuery] = useState("");
	const [diagReports, setDiagReports] = useState<Map<string, DiagReport>>(new Map());
	const [diagnosing, setDiagnosing] = useState<Set<string>>(new Set());
	const [tab, setTab] = useState<"list" | "dashboard">("list");
	const [aggregation, setAggregation] = useState<DiagnosisAggregationDto | null>(null);
	const [aggPeriod, setAggPeriod] = useState<"7d" | "30d" | "90d" | "all">("30d");
	const [aggAgent, setAggAgent] = useState("all");
	const [batchDiagnosing, setBatchDiagnosing] = useState(false);
	const [batchProgress, setBatchProgress] = useState<{ done: number; total: number } | null>(null);

	function periodSince(period: string): number | undefined {
		if (period === "all") return undefined;
		const days = period === "7d" ? 7 : period === "30d" ? 30 : 90;
		return Date.now() - days * 24 * 60 * 60 * 1000;
	}

	useEffect(() => {
		if (tab !== "dashboard" || !view.connected) return;
		let cancelled = false;
		store
			.aggregateDiagnosis({
				since: periodSince(aggPeriod),
				agentId: aggAgent !== "all" ? aggAgent : undefined,
			})
			.then(result => {
				if (!cancelled) setAggregation(result);
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [tab, aggPeriod, aggAgent, store, view.connected]);

	/** 批量诊断：诊断当前筛选条件下所有未诊断的会话。 */
	const batchDiagnose = async (): Promise<void> => {
		const since = periodSince(aggPeriod);
		const candidates = serveRows.filter(row => {
			if (aggAgent !== "all" && row.agent !== aggAgent) return false;
			if (since) {
				const day = new Date(row.startedAt).getTime();
				if (day < since) return false;
			}
			if (!row.sessionFile) return false;
			if (diagReports.has(row.sessionFile)) return false;
			return true;
		});
		if (candidates.length === 0) return;
		setBatchDiagnosing(true);
		setBatchProgress({ done: 0, total: candidates.length });
		let done = 0;
		for (const row of candidates) {
			if (!row.sessionFile) continue;
			try {
				await store.diagnoseSession(row.sessionFile);
			} catch {
				// 单条失败不影响后续
			}
			done++;
			setBatchProgress({ done, total: candidates.length });
		}
		// 刷新诊断报告列表
		try {
			const { reports } = await store.listDiagnosisReports();
			const map = new Map<string, DiagReport>();
			for (const r of reports) {
				if (r.sessionFile)
					map.set(r.sessionFile, { reportId: r.reportId, sessionId: r.sessionId, severity: r.severity });
			}
			setDiagReports(map);
		} catch {}
		// 刷新聚合统计
		try {
			const result = await store.aggregateDiagnosis({
				since: periodSince(aggPeriod),
				agentId: aggAgent !== "all" ? aggAgent : undefined,
			});
			setAggregation(result);
		} catch {}
		setBatchDiagnosing(false);
		setBatchProgress(null);
	};

	const [currentSummary, setCurrentSummary] = useState<SessionRecordSummary | null>(null);
	// serve list_sessions 真索引（连接就绪后拉取）
	const [serveRows, setServeRows] = useState<SessionRecordSummary[]>([]);

	// 当前 attached session 真数据（get_messages 已实现）：行「当前会话」；连接就绪后拉
	useEffect(() => {
		if (!view.connected) return;
		store
			.getMessages()
			.then(entries =>
				setCurrentSummary({
					id: CURRENT_SESSION_ID,
					name: "当前会话",
					agent: "attached",
					startedAt: new Date().toISOString(),
					messageCount: entries.length,
					status: "completed",
					source: "agent",
				}),
			)
			.catch(() => undefined);
	}, [store, view.connected]);

	// Load existing diagnosis reports on mount
	useEffect(() => {
		if (!view.connected) return;
		store
			.listDiagnosisReports()
			.then(({ reports }) => {
				const map = new Map<string, DiagReport>();
				for (const r of reports) {
					if (r.sessionFile) {
						map.set(r.sessionFile, {
							reportId: r.reportId,
							sessionId: r.sessionId,
							severity: r.severity,
						});
					}
				}
				setDiagReports(map);
			})
			.catch(() => undefined);
	}, [store, view.connected]);

	// list_sessions：连接就绪后拉真索引；未连接/失败时保持空列表（不造数据）
	useEffect(() => {
		if (!view.connected) return;
		store
			.listSessions()
			.then(list => {
				if (list.length > 0) setServeRows(list);
			})
			.catch(() => undefined);
	}, [store, view.connected]);

	const handleExport = (row: SessionRecordSummary) => {
		const name = `${row.name.replace(/[/\\:]/g, "-")}.jsonl`;
		if (row.id === CURRENT_SESSION_ID) {
			// 原始 serve messages 序列化（与落盘 SessionEntry 包裹格式不一致，见 getRawMessages 注释）
			store
				.getRawMessages()
				.then(raw => downloadJsonl(name, raw))
				.catch(() => undefined);
		} else {
			return; // 历史 JSONL 读取待后端文件命令，不做 mock 冒充
		}
	};

	const agents = useMemo(() => {
		const fromSessions = new Set(serveRows.map(r => r.agent));
		const fromRegistry = view.agents.map(a => a.id);
		return Array.from(new Set([...fromRegistry, ...fromSessions]));
	}, [serveRows, view.agents]);

	const formatDate = (d: Date) => {
		const pad = (n: number) => String(n).padStart(2, "0");
		return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
	};

	const rows: SessionRecordSummary[] = [...(currentSummary ? [currentSummary] : []), ...serveRows];

	const filtered = rows.filter(row => {
		if (agentFilter !== "all" && row.agent !== agentFilter) return false;
		if (statusFilter !== "all" && row.status !== statusFilter) return false;
		if (query && !row.name.toLowerCase().includes(query.toLowerCase())) return false;
		const day = new Date(row.startedAt);
		const now = new Date();
		if (dateFilter === "today" && day.toDateString() !== now.toDateString()) return false;
		if (dateFilter === "week") {
			const weekAgo = now.getTime() - 7 * 24 * 3600 * 1000;
			if (day.getTime() < weekAgo) return false;
		}
		if (dateFilter === "month") {
			const monthAgo = now.getTime() - 30 * 24 * 3600 * 1000;
			if (day.getTime() < monthAgo) return false;
		}
		return true;
	});

	return (
		<div className="px-10 pt-8 pb-12">
			<div className="mx-auto page-wide">
				<div className="mb-5 flex items-baseline gap-3.5">
					<h1 className="text-[32px] font-semibold tracking-[-0.8px] text-ink">会话记录</h1>
					<span className="text-[13px] text-ink-faint">{rows.length} 条会话</span>
				</div>

				{/* 视图切换 tab */}
				<div className="mb-6 flex gap-0.5 border-b border-hairline">
					<button
						type="button"
						className={`-mb-px cursor-pointer border-b-2 px-4 py-2.5 text-[13px] font-medium transition-colors ${tab === "list" ? "border-accent text-accent-hover" : "border-transparent text-ink-subtle hover:text-ink"}`}
						onClick={() => setTab("list")}
					>
						会话列表
					</button>
					<button
						type="button"
						className={`-mb-px cursor-pointer border-b-2 px-4 py-2.5 text-[13px] font-medium transition-colors ${tab === "dashboard" ? "border-accent text-accent-hover" : "border-transparent text-ink-subtle hover:text-ink"}`}
						onClick={() => setTab("dashboard")}
					>
						健康度大盘
					</button>
				</div>

				{tab === "list" && (
					<>
						{" "}
						{/* 筛选栏 */}
						<div className="mb-6 flex flex-wrap items-center gap-2">
							<div className="flex gap-0.5 rounded-md border border-hairline bg-surface-2 p-0.5">
								{[
									["all", "全部"],
									["today", "今天"],
									["week", "本周"],
									["month", "本月"],
								].map(([key, label]) => (
									<button
										key={key}
										type="button"
										className={`rounded px-3 py-1 text-[12px] transition-colors ${dateFilter === key ? "bg-accent-dim font-medium text-ink" : "text-ink-subtle hover:text-ink"}`}
										onClick={() => setDateFilter(key)}
									>
										{label}
									</button>
								))}
							</div>
							<select
								value={agentFilter}
								onChange={e => setAgentFilter(e.target.value)}
								className="rounded-md border border-hairline bg-surface-2 px-2.5 py-1.5 text-[12px] text-ink outline-none"
							>
								<option value="all">全部 Agent</option>
								{agents.map(a => (
									<option key={a}>{a}</option>
								))}
							</select>
							<select
								value={statusFilter}
								onChange={e => setStatusFilter(e.target.value as "all" | RecordStatus)}
								className="rounded-md border border-hairline bg-surface-2 px-2.5 py-1.5 text-[12px] text-ink outline-none"
							>
								<option value="all">全部状态</option>
								<option value="completed">已完成</option>
								<option value="aborted">已中止</option>
								<option value="error">出错</option>
							</select>
							<div className="ml-auto flex min-w-0 flex-1 items-center gap-2 rounded-md border border-hairline bg-surface-2 px-3 py-1.5 focus-within:border-hairline-strong focus-within:shadow-[0_0_0_3px_var(--color-accent-dim)]">
								<Search size={13} strokeWidth={1.5} className="shrink-0 text-ink-faint" />
								<input
									value={query}
									onChange={e => setQuery(e.target.value)}
									placeholder="搜索会话…"
									className="w-full border-none bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-faint"
								/>
							</div>
						</div>
						{/* 行式列表 */}
						<div className="divide-y divide-hairline rounded-lg border border-hairline bg-surface">
							{filtered.map(row => {
								const sf = row.sessionFile;
								const report = sf ? diagReports.get(sf) : undefined;
								return (
									<div
										key={row.id}
										className="flex items-center gap-4 px-4 py-3 transition-colors hover:bg-surface-2"
									>
										{report && (
											<button
												type="button"
												className={`${severityBadgeClass[report.severity] ?? "badge done"} mr-2 shrink-0 cursor-pointer text-[11px] font-medium`}
												onClick={e => {
													e.stopPropagation();
													navigate(`/records/${report.sessionId}/diagnosis`, {
														state: { reportId: report.reportId },
													});
												}}
											>
												{report.severity}
											</button>
										)}
										<div className="min-w-0 flex-1">
											<div className="truncate text-[15px] font-medium text-ink">{row.name}</div>
											<div className="mt-0.5 text-[12px] text-ink-subtle">
												{row.agent} · {formatDate(new Date(row.startedAt))}
											</div>
										</div>
										<span className="w-[52px] shrink-0 text-right font-mono text-[12px] text-ink-faint">
											{row.messageCount}
										</span>
										<StatusBadge
											status={row.status}
											onClick={
												row.status === "error"
													? () => {
															if (row.sessionFile) {
																navigate(`/records/${row.id}`, {
																	state: { sessionFile: row.sessionFile, name: row.name },
																});
															}
														}
													: undefined
											}
										/>
										<div className="flex w-[92px] shrink-0 justify-end gap-3 text-[12px]">
											<button
												type="button"
												className="flex items-center gap-1 text-ink-muted transition-colors hover:text-ink"
												onClick={e => {
													e.stopPropagation();
													openSession(row);
												}}
											>
												<Play size={11} strokeWidth={1.5} />
												回放
											</button>
											<button
												type="button"
												className={`flex items-center gap-1 text-ink-muted transition-colors hover:text-ink ${!sf ? "opacity-40 cursor-not-allowed" : ""}`}
												disabled={!sf || diagnosing.has(sf ?? "")}
												onClick={e => {
													e.stopPropagation();
													if (!sf) return;
													setDiagnosing(prev => new Set(prev).add(sf));
													store.diagnoseSession(sf).finally(() => {
														setDiagnosing(prev => {
															const next = new Set(prev);
															next.delete(sf);
															return next;
														});
														// Refresh reports after diagnosis completes
														store
															.listDiagnosisReports()
															.then(({ reports }) => {
																const map = new Map<string, DiagReport>();
																for (const r of reports) {
																	if (r.sessionFile) {
																		map.set(r.sessionFile, {
																			reportId: r.reportId,
																			sessionId: r.sessionId,
																			severity: r.severity,
																		});
																	}
																}
																setDiagReports(map);
															})
															.catch(() => undefined);
													});
												}}
											>
												<Stethoscope size={11} strokeWidth={1.5} />
												{diagnosing.has(sf ?? "") ? "诊断中…" : "诊断"}
											</button>
											{report && (
												<button
													type="button"
													className="flex items-center gap-0.5 text-ink-muted transition-colors hover:text-ink"
													onClick={e => {
														e.stopPropagation();
														navigate(`/records/${report.sessionId}/diagnosis`, {
															state: { reportId: report.reportId },
														});
													}}
												>
													报告 <ChevronRight size={11} strokeWidth={1.5} />
												</button>
											)}
											<button
												type="button"
												className="text-ink-faint transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
												onClick={e => {
													e.stopPropagation();
													handleExport(row);
												}}
												disabled={row.id !== CURRENT_SESSION_ID}
												title={
													row.id === CURRENT_SESSION_ID
														? "导出当前会话 JSONL"
														: "历史会话导出待后端 JSONL 读取命令"
												}
											>
												导出
											</button>
										</div>
									</div>
								);
							})}
							{filtered.length === 0 && (
								<div className="flex flex-col items-center gap-2 px-4 py-14">
									<MessageSquare className="size-8 text-ink-faint" />
									<span className="text-[13px] text-ink-faint">没有会话记录</span>
								</div>
							)}
						</div>
						<div className="mt-3 text-[11px] text-ink-faint">
							数据来自 serve list_sessions 真索引；「当前会话」行来自 get_messages 历史会话回放走
							get_session_messages 读取 JSONL 时间线（导出仍待 JSONL 读取命令）。
						</div>
					</>
				)}

				{tab === "dashboard" && (
					<div className="dashboard-view">
						{/* 筛选：时段 + Agent */}
						<div className="mb-6 flex flex-wrap items-center gap-2">
							<div className="flex gap-0.5 rounded-md border border-hairline bg-surface-2 p-0.5">
								{[
									["7d", "7天"],
									["30d", "30天"],
									["90d", "90天"],
									["all", "全部"],
								].map(([key, label]) => (
									<button
										key={key}
										type="button"
										className={`rounded px-3 py-1 text-[12px] transition-colors ${aggPeriod === key ? "bg-accent-dim font-medium text-ink" : "text-ink-subtle hover:text-ink"}`}
										onClick={() => setAggPeriod(key as typeof aggPeriod)}
									>
										{label}
									</button>
								))}
							</div>
							<select
								value={aggAgent}
								onChange={e => setAggAgent(e.target.value)}
								className="rounded-md border border-hairline bg-surface-2 px-2.5 py-1.5 text-[12px] text-ink outline-none"
							>
								<option value="all">全部 Agent</option>
								{agents.map(a => (
									<option key={a}>{a}</option>
								))}
							</select>
						</div>

						{/* 批量诊断按钮 */}
						<div className="mb-4 flex items-center gap-3">
							<button
								type="button"
								className="btn btn-sm"
								onClick={() => void batchDiagnose()}
								disabled={batchDiagnosing}
							>
								<Activity size={14} strokeWidth={1.5} />
								{batchDiagnosing
									? `诊断中 ${batchProgress?.done ?? 0}/${batchProgress?.total ?? 0}`
									: "批量诊断当前筛选会话"}
							</button>
							{batchProgress && (
								<div className="flex-1 h-1.5 rounded-full bg-surface-3 overflow-hidden">
									<div
										className="h-full rounded-full bg-accent transition-all"
										style={{ width: `${(batchProgress.done / batchProgress.total) * 100}%` }}
									/>
								</div>
							)}
						</div>

						{aggregation === null ? (
							<div className="flex items-center justify-center py-16">
								<div className="flex flex-col items-center gap-2 text-ink-faint">
									<BarChart3 className="size-8" />
									<span className="text-[13px]">加载中…</span>
								</div>
							</div>
						) : (
							<>
								{/* 概要卡片 */}
								<div className="grid grid-cols-4 gap-3 mb-6">
									<div className="rounded-lg border border-hairline bg-surface p-4">
										<div className="text-[11px] text-ink-faint">总诊断会话</div>
										<div className="mt-1 text-[24px] font-semibold text-ink">{aggregation.totalSessions}</div>
									</div>
									<div className="rounded-lg border border-hairline bg-surface p-4">
										<div className="text-[11px] text-ink-faint">P0 阻断</div>
										<div className="mt-1 text-[24px] font-semibold text-danger">
											{aggregation.severityDistribution.P0 ?? 0}
										</div>
									</div>
									<div className="rounded-lg border border-hairline bg-surface p-4">
										<div className="text-[11px] text-ink-faint">P1 严重</div>
										<div className="mt-1 text-[24px] font-semibold text-warning">
											{aggregation.severityDistribution.P1 ?? 0}
										</div>
									</div>
									<div className="rounded-lg border border-hairline bg-surface p-4">
										<div className="text-[11px] text-ink-faint">正常率 (P2+P3)</div>
										<div className="mt-1 text-[24px] font-semibold text-success">
											{aggregation.totalSessions > 0
												? (
														(((aggregation.severityDistribution.P2 ?? 0) +
															(aggregation.severityDistribution.P3 ?? 0)) /
															aggregation.totalSessions) *
														100
													).toFixed(0)
												: "-"}
											%
										</div>
									</div>
								</div>

								{/* 两列布局 */}
								<div className="grid grid-cols-2 gap-6">
									{/* 左列：6 维度失败率 + 根因 TOP 10 */}
									<div>
										<section className="mb-6">
											<h4 className="mb-2 section-title text-ink-faint">6 维度失败率</h4>
											<div className="grid grid-cols-2 gap-3">
												{Object.entries(DIMENSION_LABELS).map(([key, label]) => {
													const dim = aggregation.dimensionFailureRates[key];
													const dimReports = aggregation.dimensionReports?.[key] ?? [];
													if (!dim) return null;
													const total = dim.ok + dim.warn + dim.fail;
													return (
														<button
															type="button"
															key={key}
															disabled={dimReports.length === 0}
															className="w-full rounded-lg border border-hairline bg-surface p-3 text-left transition-colors enabled:hover:border-accent/50 enabled:hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-60"
															onClick={() => {
																const params = new URLSearchParams();
																if (aggPeriod !== "all") params.set("period", aggPeriod);
																if (aggAgent !== "all") params.set("agent", aggAgent);
																navigate(
																	`/records/dimension/${key}${params.size > 0 ? `?${params.toString()}` : ""}`,
																);
															}}
															title={
																dimReports.length > 0
																	? `查看${label}维度报告（${dimReports.length} 份）`
																	: `当前筛选范围内暂无${label}维度报告`
															}
														>
															<div className="mb-2 flex items-center justify-between">
																<span className="text-[13px] font-medium text-ink">{label}</span>
																<span
																	className={`text-[12px] font-medium ${dim.failRate > 0.3 ? "text-danger" : dim.failRate > 0.1 ? "text-warning" : "text-success"}`}
																>
																	{(dim.failRate * 100).toFixed(0)}% 失败
																</span>
															</div>
															<div className="flex h-2 overflow-hidden rounded-full bg-surface-3">
																<div
																	className="bg-success transition-all"
																	style={{ width: `${total > 0 ? (dim.ok / total) * 100 : 0}%` }}
																/>
																<div
																	className="bg-warning transition-all"
																	style={{ width: `${total > 0 ? (dim.warn / total) * 100 : 0}%` }}
																/>
																<div
																	className="bg-danger transition-all"
																	style={{ width: `${total > 0 ? (dim.fail / total) * 100 : 0}%` }}
																/>
															</div>
															<div className="mt-1.5 flex gap-3 text-[11px] text-ink-faint">
																<span>正常 {dim.ok}</span>
																<span>警告 {dim.warn}</span>
																<span>失败 {dim.fail}</span>
															</div>
														</button>
													);
												})}
											</div>
										</section>

										<section className="mb-6">
											<h4 className="mb-2 section-title text-ink-faint">最常见根因 TOP 10</h4>
											{aggregation.topIssues.length === 0 ? (
												<div className="rounded-lg border border-dashed border-hairline-strong bg-surface px-4 py-6 text-center text-[12px] text-ink-faint">
													暂无根因数据
												</div>
											) : (
												<div className="divide-y divide-hairline rounded-lg border border-hairline bg-surface">
													{aggregation.topIssues.map((issue, i) => (
														<div key={i} className="flex items-center gap-3 px-4 py-2.5">
															<span
																className={`badge ${issue.severity === "P0" ? "fail" : issue.severity === "P1" ? "run" : "done"} shrink-0`}
															>
																{issue.severity}
															</span>
															<span className="min-w-0 flex-1 text-[13px] text-ink">{issue.title}</span>
															<span className="shrink-0 text-[12px] text-ink-faint">
																{issue.count} 次
															</span>
														</div>
													))}
												</div>
											)}
										</section>
									</div>

									{/* 右列：周趋势 + 质量分布 */}
									<div>
										<section className="mb-6">
											<h4 className="mb-2 section-title text-ink-faint">周趋势</h4>
											{aggregation.weeklyTrend.length === 0 ? (
												<div className="rounded-lg border border-dashed border-hairline-strong bg-surface px-4 py-6 text-center text-[12px] text-ink-faint">
													暂无趋势数据
												</div>
											) : (
												<div className="divide-y divide-hairline rounded-lg border border-hairline bg-surface">
													{aggregation.weeklyTrend.map((week, i) => (
														<div key={i} className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
															<span className="w-28 shrink-0 text-ink">{week.weekStart}</span>
															<span className="w-12 shrink-0 text-ink-faint">{week.total} 次</span>
															<span className="flex gap-3">
																{week.p0 > 0 && <span className="text-danger">P0:{week.p0}</span>}
																{week.p1 > 0 && <span className="text-warning">P1:{week.p1}</span>}
																{week.p2 > 0 && <span className="text-ink-subtle">P2:{week.p2}</span>}
																{week.p3 > 0 && <span className="text-ink-subtle">P3:{week.p3}</span>}
															</span>
														</div>
													))}
												</div>
											)}
										</section>

										<section className="mb-6">
											<h4 className="mb-2 section-title text-ink-faint">质量分布</h4>
											<div className="grid grid-cols-2 gap-3">
												<div className="rounded-lg border border-hairline bg-surface p-3">
													<div className="text-[12px] text-ink-subtle mb-2">交付物质量</div>
													{Object.entries(aggregation.deliveryDistribution).map(([k, v]) => (
														<div key={k} className="flex items-center gap-2 py-1">
															<span className="w-6 shrink-0 text-[11px] font-mono text-ink-faint">
																{k}
															</span>
															<div className="flex-1 h-3 rounded bg-surface-3 overflow-hidden">
																<div
																	className={`h-full rounded ${QUALITY_BAR_CLASSES[k.trim().toUpperCase()] ?? "bg-accent-dim"} transition-all`}
																	style={{
																		width: `${aggregation.totalSessions > 0 ? (v / aggregation.totalSessions) * 100 : 0}%`,
																	}}
																/>
															</div>
															<span className="w-8 shrink-0 text-right text-[11px] text-ink-faint">
																{v}
															</span>
														</div>
													))}
												</div>
												<div className="rounded-lg border border-hairline bg-surface p-3">
													<div className="text-[12px] text-ink-subtle mb-2">过程质量</div>
													{Object.entries(aggregation.processDistribution).map(([k, v]) => (
														<div key={k} className="flex items-center gap-2 py-1">
															<span className="w-6 shrink-0 text-[11px] font-mono text-ink-faint">
																{k}
															</span>
															<div className="flex-1 h-3 rounded bg-surface-3 overflow-hidden">
																<div
																	className={`h-full rounded ${QUALITY_BAR_CLASSES[k.trim().toUpperCase()] ?? "bg-accent-dim"} transition-all`}
																	style={{
																		width: `${aggregation.totalSessions > 0 ? (v / aggregation.totalSessions) * 100 : 0}%`,
																	}}
																/>
															</div>
															<span className="w-8 shrink-0 text-right text-[11px] text-ink-faint">
																{v}
															</span>
														</div>
													))}
												</div>
											</div>
										</section>
									</div>
								</div>
							</>
						)}
					</div>
				)}
			</div>
		</div>
	);
}

function StatusBadge({ status, onClick }: { status: RecordStatus; onClick?: () => void }): React.JSX.Element {
	const cls = status === "completed" ? "badge done" : status === "aborted" ? "badge run" : "badge fail";
	const label = recordStatusLabel(status);
	if (onClick) {
		return (
			<button
				type="button"
				className={`${cls} w-[56px] shrink-0 cursor-pointer text-center transition-colors hover:opacity-80`}
				onClick={onClick}
			>
				{label}
			</button>
		);
	}
	return <span className={`${cls} w-[56px] shrink-0 text-center`}>{label}</span>;
}
