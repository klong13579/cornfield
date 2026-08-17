import { Play, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
	CURRENT_SESSION_ID,
	downloadJsonl,
	MOCK_RECORDS,
	mockTimeline,
	type RecordStatus,
	recordStatusLabel,
	type SessionRecordSummary,
} from "../../lib/records";
import { useSessionStore } from "../../state/session-store";
import { useSession } from "../../state/use-session";

/**
 * 会话记录列表（FR-3）—— 行式列表（15px 名称 + 状态 badge）+ 筛选/搜索 + 操作列。
 * 数据源：mock 骨架（历史会话索引待 be-dev 记录系命令，TODO 标注）+
 * 特殊行「当前会话」（serve get_messages 真数据：名称/消息数来自当前 attached session）。
 */
export function RecordsView(): React.JSX.Element {
	const navigate = useNavigate();
	const store = useSessionStore();
	const view = useSession();
	const [dateFilter, setDateFilter] = useState("all");
	const [agentFilter, setAgentFilter] = useState("all");
	const [statusFilter, setStatusFilter] = useState<"all" | RecordStatus>("all");
	const [query, setQuery] = useState("");

	const [currentSummary, setCurrentSummary] = useState<SessionRecordSummary | null>(null);
	// be-dev list_sessions 真索引（就绪前回退 8 行 mock 骨架）
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
				}),
			)
			.catch(() => undefined);
	}, [store, view.connected]);

	// list_sessions：连接就绪后拉真索引；未实现/失败时空数组回退骨架
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
			downloadJsonl(name, mockTimeline(row.id));
		}
	};

	const agents = useMemo(() => Array.from(new Set(MOCK_RECORDS.map(r => r.agent))), []);

	const rows: SessionRecordSummary[] = [
		...(currentSummary ? [currentSummary] : []),
		...(serveRows.length > 0 ? serveRows : MOCK_RECORDS),
	];

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
			<div className="mx-auto max-w-[960px]">
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
								className={`rounded px-3 py-1 text-[12px] transition-colors ${dateFilter === key ? "bg-surface-3 text-ink" : "text-ink-subtle hover:text-ink"}`}
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
					<div className="ml-auto flex w-[200px] items-center gap-2 rounded-md border border-hairline bg-surface-2 px-3 py-1.5 focus-within:border-hairline-strong focus-within:shadow-[0_0_0_3px_var(--color-accent-dim)]">
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
					{filtered.map(row => (
						<div key={row.id} className="flex items-center gap-4 px-4 py-3 transition-colors hover:bg-surface-2">
							<div className="min-w-0 flex-1">
								<div className="truncate text-[15px] font-medium text-ink">{row.name}</div>
								<div className="mt-0.5 text-[12px] text-ink-subtle">
									{row.agent} ·{" "}
									{new Date(row.startedAt).toLocaleString("zh-CN", {
										month: "numeric",
										day: "numeric",
										hour: "2-digit",
										minute: "2-digit",
									})}
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
										navigate(`/records/${row.id}`);
									}}
								>
									<Play size={11} strokeWidth={1.5} />
									回放
								</button>
								<button
									type="button"
									className="text-ink-faint transition-colors hover:text-ink"
									onClick={e => {
										e.stopPropagation();
										handleExport(row);
									}}
									title="导出 JSONL"
								>
									导出
								</button>
							</div>
						</div>
					))}
					{filtered.length === 0 && (
						<div className="px-4 py-14 text-center text-[13px] text-ink-faint">没有匹配的会话记录。</div>
					)}
				</div>

				<div className="mt-3 text-[11px] text-ink-faint">
					历史会话索引待 be-dev 记录系命令（get_messages/get_branch_messages 已支持当前会话）；「当前会话」行来自
					serve 真数据，其余为骨架样例。
				</div>
			</div>
		</div>
	);
}

function StatusBadge({ status }: { status: RecordStatus }): React.JSX.Element {
	const cls = status === "completed" ? "badge done" : status === "aborted" ? "badge run" : "badge fail";
	return <span className={`${cls} w-[56px] shrink-0 text-center`}>{recordStatusLabel(status)}</span>;
}
