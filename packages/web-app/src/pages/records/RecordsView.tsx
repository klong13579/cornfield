import { ChevronRight, MessageSquare, Play, Search, Stethoscope } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
	CURRENT_SESSION_ID,
	downloadJsonl,
	type RecordStatus,
	recordStatusLabel,
	type SessionRecordSummary,
} from "../../lib/records";
import { useSessionStore } from "../../state/session-store";
import { useSession } from "../../state/use-session";

/** Severity → badge class mapping. */
const severityBadgeClass: Record<string, string> = {
	P0: "badge fail",
	P1: "badge run",
	P2: "badge done",
	P3: "badge done",
};

/** Diagnosis report cached per sessionFile. */
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

	const agents = useMemo(() => Array.from(new Set(serveRows.map(r => r.agent))), [serveRows]);

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

				{/* 筛选栏：日期 seg + Agent/状态 select + 搜索 */}
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
								<StatusBadge status={row.status} />
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
					数据来自 serve list_sessions 真索引；「当前会话」行来自 get_messages 历史会话回放走 get_session_messages
					读取 JSONL 时间线（导出仍待 JSONL 读取命令）。
				</div>
			</div>
		</div>
	);
}

function StatusBadge({ status }: { status: RecordStatus }): React.JSX.Element {
	const cls = status === "completed" ? "badge done" : status === "aborted" ? "badge run" : "badge fail";
	return <span className={`${cls} w-[56px] shrink-0 text-center`}>{recordStatusLabel(status)}</span>;
}
