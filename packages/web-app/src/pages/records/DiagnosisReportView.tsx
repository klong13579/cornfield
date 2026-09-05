import {
	AlertTriangle,
	ChevronDown,
	ChevronRight,
	ClipboardList,
	FileText,
	MessageSquare,
	ThumbsDown,
	ThumbsUp,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";

import type { DiagnosisSummaryDto, UserCorrectionDto } from "../../lib/pi-client-api";
import { useSessionStore } from "../../state/session-store";

/**
 * 诊断报告详情页 —— 在 AppShell 内容区内渲染，左侧导航栏保留。
 * 数据源：store.getDiagnosisReport(reportId)。
 */
const DIMS = [
	["meta", "元数据检查"],
	["performance", "性能与资源"],
	["intent", "意图理解"],
	["reasoning", "推理规划"],
	["tool", "工具调用链路"],
	["output", "输出生成"],
] as const;

type DimState = "ok" | "warn" | "fail";

export function DiagnosisReportView(): React.JSX.Element {
	const location = useLocation();
	const [searchParams] = useSearchParams();
	const store = useSessionStore();

	const stateReportId = ((location.state as { reportId?: string } | null)?.reportId ?? null) as string | null;
	// 优先从 state 取，缺省从 ?reportId= 取（hash 路由直接 URL 访问降级）
	const paramsReportId = searchParams.get("reportId");
	const reportId = stateReportId ?? paramsReportId;

	const [summary, setSummary] = useState<DiagnosisSummaryDto | null>(null);
	const [markdown, setMarkdown] = useState<string>("");
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!reportId) {
			setError("缺少 reportId");
			setLoading(false);
			return;
		}
		setLoading(true);
		store
			.getDiagnosisReport(reportId)
			.then(res => {
				if (res) {
					setSummary(res.summary ?? null);
					setMarkdown(res.markdown ?? "");
				} else {
					setError("报告不存在");
				}
				setLoading(false);
			})
			.catch(err => {
				setError(err instanceof Error ? err.message : String(err));
				setLoading(false);
			});
	}, [reportId, store]);

	if (loading) {
		return (
			<div className="px-10 pt-8 pb-12">
				<div className="mx-auto page-wide">
					<div className="py-16 text-center text-[13px] text-ink-faint">加载报告中…</div>
				</div>
			</div>
		);
	}

	if (error) {
		return (
			<div className="px-10 pt-8 pb-12">
				<div className="mx-auto page-wide">
					<Link
						to="/records"
						className="mb-4 inline-flex items-center gap-1 text-[12px] text-ink-muted no-underline hover:text-ink hover:underline"
					>
						← 返回会话记录
					</Link>
					<div className="rounded-md border border-danger/40 bg-danger/5 px-4 py-3 text-[12.5px] text-danger">
						{error}
					</div>
				</div>
			</div>
		);
	}

	// No data at all
	if (!summary && !markdown) {
		return (
			<div className="px-10 pt-8 pb-12">
				<div className="mx-auto page-wide">
					<Link
						to="/records"
						className="mb-4 inline-flex items-center gap-1 text-[12px] text-ink-muted no-underline hover:text-ink hover:underline"
					>
						← 返回会话记录
					</Link>
					<div className="py-16 text-center text-[13px] text-ink-faint">没有可显示的报告内容</div>
				</div>
			</div>
		);
	}

	// Has structured summary → render structured content
	if (summary?.hasSummary !== false || summary) {
		return <StructuredReport summary={summary!} markdown={markdown} />;
	}

	// Fallback: render raw markdown
	return (
		<div className="px-10 pt-8 pb-12">
			<div className="mx-auto page-wide">
				<Link
					to="/records"
					className="mb-4 inline-flex items-center gap-1 text-[12px] text-ink-muted no-underline hover:text-ink hover:underline"
				>
					← 返回会话记录
				</Link>
				<div className="prose prose-sm max-w-none rounded-lg border border-hairline bg-surface p-6 text-ink">
					{markdown.split("\n").map((line, i) => (
						<p key={i}>{line || "\u00A0"}</p>
					))}
				</div>
			</div>
		</div>
	);
}

/* ── Structured report rendering ─────────────────────────────────────── */

function StructuredReport({
	summary,
	markdown,
}: {
	summary: DiagnosisSummaryDto;
	markdown?: string;
}): React.JSX.Element {
	const [expandedDims, setExpandedDims] = useState<Set<string>>(new Set());
	const [showFullReport, setShowFullReport] = useState(false);
	const _navigate = useNavigate();

	const toggleDim = (dim: string) => {
		setExpandedDims(prev => {
			const next = new Set(prev);
			next.has(dim) ? next.delete(dim) : next.add(dim);
			return next;
		});
	};

	return (
		<div className="px-10 pt-8 pb-12">
			<div className="mx-auto page-wide">
				{/* Back link */}
				<Link
					to="/records"
					className="mb-4 inline-flex items-center gap-1 text-[12px] text-ink-muted no-underline hover:text-ink hover:underline"
				>
					← 返回会话记录
				</Link>

				{/* Header row */}
				<div className="flex items-center gap-3 mb-5">
					<SevBadge sev={summary.severity} />
					<h1 className="text-[24px] font-semibold tracking-[-0.6px] text-ink">{summary.title}</h1>
				</div>

				{/* Meta line */}
				<div className="text-[11px] text-ink-subtle mb-4">
					交付 <b className="font-mono text-ink">{summary.delivery}</b> · 过程{" "}
					<b className="font-mono text-ink">{summary.process}</b>
					{summary.reportAt && <> · {summary.reportAt}</>}
				</div>

				{/* Root cause */}
				{summary.rootCause && (
					<div className="mb-5">
						<div className="text-[11px] font-semibold tracking-[0.08em] text-ink-faint uppercase mb-1">根因</div>
						<div className="text-[13px] leading-relaxed text-ink-muted">{summary.rootCause}</div>
					</div>
				)}

				{/* Top actions */}
				{summary.topActions && summary.topActions.length > 0 && (
					<div className="mb-5">
						<div className="text-[11px] font-semibold tracking-[0.08em] text-ink-faint uppercase mb-1">
							建议行动
						</div>
						<div className="flex flex-col gap-0.5">
							{summary.topActions.map((a, i) => (
								<div key={i} className="flex items-start gap-1.5 text-[12px] text-ink-muted">
									<ClipboardList size={13} strokeWidth={1.5} className="mt-0.5 shrink-0 text-ink-faint" />
									<span>{a}</span>
								</div>
							))}
						</div>
					</div>
				)}

				{/* Six-dimension grid */}
				<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
					{DIMS.map(([key, label]) => {
						const dim = summary.dimensions?.[key];
						if (!dim) return null;
						const expanded = expandedDims.has(key);
						return (
							<DimCard
								label={label}
								state={dim.state}
								summary={dim.summary}
								basis={dim.basis}
								rows={dim.rows}
								evidence={dim.evidence}
								fix={dim.fix}
								expanded={expanded}
								onToggle={() => toggleDim(key)}
								sessionId={summary.sessionId}
								sessionFile={summary.sessionFile}
							/>
						);
					})}
				</div>

				{/* User corrections section */}
				{summary.corrections && summary.corrections.length > 0 && (
					<CorrectionsSection
						corrections={summary.corrections}
						sessionId={summary.sessionId}
						sessionFile={summary.sessionFile}
					/>
				)}

				{/* Full report + session log links */}
				<div className="mt-6 flex flex-wrap gap-3">
					<button
						type="button"
						className="btn flex items-center gap-1.5 text-[12px] px-4 py-2"
						onClick={() => setShowFullReport(o => !o)}
					>
						<FileText size={13} strokeWidth={1.5} />
						{showFullReport ? "收起完整报告" : "查看完整报告"}
					</button>
					{summary.sessionFile && (
						<Link
							to={`/records/${summary.sessionId}`}
							state={{ sessionFile: summary.sessionFile }}
							className="btn flex items-center gap-1.5 text-[12px] px-4 py-2 no-underline"
						>
							<MessageSquare size={13} strokeWidth={1.5} />
							查看会话日志
						</Link>
					)}
				</div>

				{/* Full markdown report */}
				{showFullReport && markdown && (
					<div className="mt-4 rounded-lg border border-hairline bg-surface p-6">
						<div className="prose prose-sm max-w-none text-ink">
							{markdown.split("\n").map((line, i) => (
								<p key={i} className="text-[12px] leading-relaxed">
									{line || "\u00A0"}
								</p>
							))}
						</div>
					</div>
				)}
			</div>
		</div>
	);
}

/* ── Severity badge ──────────────────────────────────────────────────── */

function SevBadge({ sev }: { sev: string }): React.JSX.Element {
	const cls = sev === "P0" ? "badge fail" : sev === "P1" ? "badge run" : sev === "P2" ? "badge done" : "badge done";
	const label = sev === "P0" ? "P0 阻断" : sev === "P1" ? "P1 严重" : sev === "P2" ? "P2 轻微" : "P3 优化";
	return <span className={`${cls} w-[52px] shrink-0 text-center`}>{label}</span>;
}

/* ── Dimension card ──────────────────────────────────────────────────── */

function DimCard({
	label,
	state,
	summary,
	basis,
	rows,
	evidence,
	fix,
	expanded,
	onToggle,
	sessionId,
	sessionFile,
}: {
	label: string;
	state: DimState;
	summary: string;
	basis?: string;
	rows?: { label: string; value: string }[];
	evidence?: { turn: number; kind: string; quote: string }[];
	fix?: string;
	expanded: boolean;
	onToggle: () => void;
	sessionId?: string;
	sessionFile?: string;
}): React.JSX.Element {
	const navigate = useNavigate();
	const colorCls = state === "ok" ? "text-success" : state === "warn" ? "text-warning" : "text-danger";
	const mark = state === "ok" ? "✓" : state === "warn" ? "△" : "✕";
	const borderCls = state === "fail" ? "border-danger/40" : state === "warn" ? "border-warning/40" : "border-hairline";

	return (
		<div className={`rounded-lg border border-hairline bg-surface p-3.5 ${borderCls}`}>
			<button type="button" className="flex w-full items-center gap-2 text-left cursor-pointer" onClick={onToggle}>
				<span className={`flex items-center gap-1 text-[11px] ${colorCls}`}>
					<span className="font-mono">{mark}</span> {label}
				</span>
				<span className="ml-auto text-[10px] text-ink-faint">{expanded ? "收起" : "展开详情"}</span>
				{expanded ? <ChevronDown size={11} strokeWidth={1.5} /> : <ChevronRight size={11} strokeWidth={1.5} />}
			</button>

			{/* Collapsed: show summary */}
			{!expanded && <div className="mt-1.5 text-[12px] leading-relaxed text-ink-muted">{summary}</div>}

			{/* Expanded: full detail */}
			{expanded && (
				<div className="mt-2.5 space-y-2.5 border-t border-hairline pt-2.5">
					{/* Summary */}
					<div className="text-[12px] leading-relaxed text-ink-muted">{summary}</div>

					{/* Basis */}
					{basis && (
						<div className="rounded-md bg-surface-2 px-3 py-2 text-[12px] leading-relaxed text-ink">
							<span className="mr-1.5 text-[10px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
								判定依据
							</span>
							{basis}
						</div>
					)}

					{/* Rows */}
					{rows && rows.length > 0 && (
						<div className="overflow-hidden rounded-md border border-hairline">
							<div className="flex flex-col divide-y divide-hairline">
								{rows.map((r, i) => (
									<div key={i} className="flex gap-3 px-3 py-1.5 text-[11.5px]">
										<span className="w-[108px] shrink-0 truncate text-ink-faint">{r.label}</span>
										<span className="min-w-0 break-words font-mono text-ink-muted">{r.value}</span>
									</div>
								))}
							</div>
						</div>
					)}

					{/* Evidence */}
					{evidence && evidence.length > 0 && (
						<div className="space-y-1.5">
							<div className="text-[10px] font-semibold tracking-[0.08em] text-ink-faint uppercase">证据</div>
							{evidence.map((ev, i) => (
								<div
									key={i}
									className="flex items-center gap-2 rounded-md bg-surface-2 px-3 py-1.5 text-[11.5px]"
								>
									<button
										type="button"
										className="shrink-0 rounded bg-accent-dim px-1.5 py-0.5 font-mono text-[10px] text-ink-muted hover:bg-accent hover:text-on-accent transition-colors"
										title="跳转到第 {ev.turn} 步回放"
										onClick={e => {
											e.stopPropagation();
											if (sessionId) {
												navigate(`/records/${sessionId}`, { state: { sessionFile, searchText: ev.quote } });
											}
										}}
									>
										Turn {ev.turn}
									</button>
									<span className="shrink-0 rounded bg-accent-dim px-1.5 py-0.5 font-mono text-[10px] text-ink-faint">
										{ev.kind}
									</span>
									<div className="min-w-0 flex-1">
										<pre className="m-0 whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-ink-muted">
											{ev.quote}
										</pre>
									</div>
								</div>
							))}
						</div>
					)}

					{/* Fix */}
					{fix && (
						<div className="rounded-md bg-surface-2 px-3 py-2 text-[12px] leading-relaxed text-ink">
							<span className="mr-1.5 text-[10px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
								修复建议
							</span>
							{fix}
						</div>
					)}
				</div>
			)}
		</div>
	);
}

/* ── User corrections section ──────────────────────────────────────────── */

const DIM_LABELS: Record<string, string> = {
	intent: "意图理解",
	tool: "工具调用",
	output: "输出生成",
	reasoning: "推理规划",
	meta: "元数据",
};

const INTENT_LABELS: Record<string, string> = {
	correction: "纠错",
	clarification: "澄清",
	rejection: "拒绝",
};

function CorrectionsSection({
	corrections,
	sessionId,
	sessionFile,
}: {
	corrections: UserCorrectionDto[];
	sessionId?: string;
	sessionFile?: string;
}): React.JSX.Element {
	const navigate = useNavigate();

	return (
		<div className="mt-6">
			<div className="flex items-center gap-2 mb-3">
				<AlertTriangle size={14} strokeWidth={1.5} className="text-warning" />
				<div className="text-[11px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
					用户纠正记录 · {corrections.length} 条
				</div>
			</div>
			<div className="flex flex-col gap-2">
				{[...corrections].reverse().map((c, i) => {
					const dimLabel = DIM_LABELS[c.targetDim] ?? c.targetDim;
					const intentLabel = INTENT_LABELS[c.intent] ?? c.intent;
					const intentCls =
						c.intent === "correction"
							? "bg-danger/10 text-danger"
							: c.intent === "rejection"
								? "bg-warning/10 text-warning"
								: "bg-accent-dim text-ink";
					return (
						<div key={i} className="rounded-lg border border-hairline bg-surface p-3.5">
							<div className="flex items-center gap-2 mb-2">
								<button
									type="button"
									className="shrink-0 rounded bg-accent-dim px-1.5 py-0.5 font-mono text-[10px] text-ink-muted hover:bg-accent hover:text-on-accent transition-colors"
									title="跳转到第 {c.turn} 步回放"
									onClick={() => {
										if (sessionId) {
											navigate(`/records/${sessionId}`, {
												state: { sessionFile, searchText: c.userText },
											});
										}
									}}
								>
									Turn {c.turn}
								</button>
								<span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-ink-muted">
									{dimLabel}
								</span>
								<span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${intentCls}`}>
									{intentLabel}
								</span>
								{c.isValid ? (
									<ThumbsUp size={11} strokeWidth={1.5} className="text-success" />
								) : (
									<ThumbsDown size={11} strokeWidth={1.5} className="text-danger" />
								)}
								{c.isResolved ? (
									<span className="badge done ml-auto">已修复</span>
								) : (
									<span className="badge run ml-auto">未修复</span>
								)}
							</div>
							<div className="mb-1.5 rounded-md bg-surface-2 px-3 py-2 text-[12px] leading-relaxed text-ink-muted">
								{c.userText}
							</div>
							{c.precedingContext && (
								<div className="text-[11px] text-ink-faint">
									<span className="font-semibold tracking-[0.08em] uppercase">上下文：</span>
									{c.precedingContext}
								</div>
							)}
						</div>
					);
				})}
			</div>
		</div>
	);
}

export default DiagnosisReportView;
