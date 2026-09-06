import { AlertTriangle, ArrowLeft, FileText } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";

import type { DiagnosisAggregationDto } from "../../lib/pi-client-api";
import { DIM_STATE_BADGE, DIM_STATE_LABELS, DIMENSION_LABELS, dimensionLabel } from "../../lib/records-dimensions";
import { useSessionStore } from "../../state/session-store";
import { useSession } from "../../state/use-session";

/** Severity → badge class（与 RecordsView 大盘一致）。 */
const severityBadgeClass: Record<string, string> = {
	P0: "badge fail",
	P1: "badge run",
	P2: "badge done",
	P3: "badge done",
};

const PERIOD_LABELS: Record<string, string> = {
	all: "全部",
	"7d": "7 天",
	"30d": "30 天",
	"90d": "90 天",
};

function periodSince(period: string | null): number | undefined {
	if (!period || period === "all") return undefined;
	const days = period === "7d" ? 7 : period === "90d" ? 90 : 30;
	return Date.now() - days * 24 * 60 * 60 * 1000;
}

function formatTime(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "";
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 维度聚合页 —— 从大盘某个维度卡进入：展示该维度下（默认 fail/warn）的多份报告列表，
 * 点行进单个会话诊断详情。数据源：aggregate_diagnosis 按当前 period/agent 复算。
 */
export function DimensionReportsView(): React.JSX.Element {
	const { dim = "" } = useParams();
	const [searchParams] = useSearchParams();
	const period = searchParams.get("period") ?? "all";
	const agent = searchParams.get("agent");
	const navigate = useNavigate();
	const store = useSessionStore();
	const view = useSession();

	const [aggregation, setAggregation] = useState<DiagnosisAggregationDto | null>(null);
	const [showOk, setShowOk] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!view.connected) return;
		let cancelled = false;
		store
			.aggregateDiagnosis({ since: periodSince(period), agentId: agent ?? undefined })
			.then(result => {
				if (!cancelled) setAggregation(result);
			})
			.catch(err => {
				if (!cancelled) setError(err instanceof Error ? err.message : String(err));
			});
		return () => {
			cancelled = true;
		};
	}, [dim, period, agent, store, view.connected]);

	const reports = useMemo(() => {
		const list = aggregation?.dimensionReports?.[dim] ?? [];
		return showOk ? list : list.filter(r => r.dimState !== "ok");
	}, [aggregation, dim, showOk]);

	const label = dimensionLabel(dim);
	const total = aggregation?.dimensionReports?.[dim]?.length ?? 0;
	const abnormal = (aggregation?.dimensionReports?.[dim] ?? []).filter(r => r.dimState !== "ok").length;

	return (
		<div className="px-10 pt-8 pb-12">
			<div className="mx-auto page-wide">
				<Link
					to="/records"
					className="mb-4 inline-flex items-center gap-1 text-[12px] text-ink-muted no-underline hover:text-ink hover:underline"
				>
					<ArrowLeft size={13} strokeWidth={1.5} />
					返回会话记录
				</Link>

				<div className="mb-1 flex items-center gap-3">
					<h1 className="text-[24px] font-semibold tracking-[-0.6px] text-ink">{label}维度报告</h1>
					<span className="rounded-md bg-accent-dim px-2 py-0.5 font-mono text-[12px] text-ink-subtle">
						{PERIOD_LABELS[period] ?? period}
						{agent ? ` · ${agent}` : " · 全部 Agent"}
					</span>
				</div>
				<div className="mb-5 text-[12px] text-ink-faint">
					大盘聚合 {label} 维度共 {total} 份报告，其中异常 {abnormal} 份
				</div>

				{/* 状态过滤 */}
				<div className="mb-4 flex gap-0.5 rounded-md border border-hairline bg-surface-2 p-0.5 w-fit">
					<button
						type="button"
						className={`rounded px-3 py-1 text-[12px] transition-colors ${!showOk ? "bg-accent-dim font-medium text-ink" : "text-ink-subtle hover:text-ink"}`}
						onClick={() => setShowOk(false)}
					>
						异常报告（{abnormal}）
					</button>
					<button
						type="button"
						className={`rounded px-3 py-1 text-[12px] transition-colors ${showOk ? "bg-accent-dim font-medium text-ink" : "text-ink-subtle hover:text-ink"}`}
						onClick={() => setShowOk(true)}
					>
						全部（{total}）
					</button>
				</div>

				{error && (
					<div className="mb-4 rounded-md border border-danger/40 bg-danger/5 px-4 py-3 text-[12.5px] text-danger">
						{error}
					</div>
				)}

				{aggregation === null && !error ? (
					<div className="py-16 text-center text-[13px] text-ink-faint">加载中…</div>
				) : reports.length === 0 ? (
					<div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-hairline-strong bg-surface px-4 py-14 text-center">
						<AlertTriangle className="size-7 text-ink-faint" />
						<span className="text-[13px] text-ink-faint">当前筛选下暂无报告</span>
					</div>
				) : (
					<div className="divide-y divide-hairline rounded-lg border border-hairline bg-surface">
						{reports.map(r => (
							<button
								type="button"
								key={r.reportId}
								className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-2"
								onClick={() =>
									navigate(`/records/${r.sessionId}/diagnosis`, { state: { reportId: r.reportId } })
								}
								title={`打开 ${label}维度 ${DIM_STATE_LABELS[r.dimState]} 的报告`}
							>
								<span className={`${DIM_STATE_BADGE[r.dimState]} w-[56px] shrink-0 text-center`}>
									{DIM_STATE_LABELS[r.dimState]}
								</span>
								<span className={`${severityBadgeClass[r.severity] ?? "badge done"} shrink-0`}>
									{r.severity}
								</span>
								<span className="min-w-0 flex-1 truncate text-[13px] text-ink">{r.title}</span>
								<span className="shrink-0 font-mono text-[11px] text-ink-faint">{formatTime(r.reportAt)}</span>
								<FileText size={14} strokeWidth={1.5} className="shrink-0 text-ink-faint" />
							</button>
						))}
					</div>
				)}

				{DIMENSION_LABELS[dim] === undefined && (
					<div className="mt-4 text-[12px] text-ink-faint">未知维度：{dim}</div>
				)}
			</div>
		</div>
	);
}
