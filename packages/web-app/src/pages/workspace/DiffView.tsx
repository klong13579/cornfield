import { useMemo, useState } from "react";
import type { DiffReview } from "../../state/file-workflow-store";
import { pairForSplit, parseNumberedDiff, type SplitCell, summarizeDiff } from "./diff-format";

/**
 * Diff 审阅面板：渲染服务端 `generateUnifiedDiffString` 的带行号统一 diff。
 *
 * 这里只做展示（解析在 diff-format）：前端不生成 diff、不比较文本 —— diff 的真相在
 * coding-agent 的 edit 模块，第二套实现意味着同一次修改会有两个说法。
 *
 * 两种视图（统一 / 并列）是**同一份** diff 的两种摆法：并列只是把每行按新旧两侧对齐，
 * 不改内容、不重算 diff。切换是视图偏好，不是第二份数据。
 */

const ROW_CLASS: Record<string, string> = {
	add: "bg-success/10 text-success",
	del: "bg-danger/10 text-danger",
	context: "text-ink-muted",
};

/** 这份 diff 属于哪个会话的工作区。跨会话打开的文件（右栏改动页 / 遗留草稿）才需要它。 */
export interface DiffSource {
	/** diff 的来源 agent（file-workflow 的 open.agentId，打开时就固定，不随后续切会话漂移）。 */
	agentId: string;
	/** 展示名（查不到就是 id 本身）。 */
	label: string;
	/** 它是否就是本连接当前的焦点会话。false 时才提供「回到来源会话」。 */
	isCurrent: boolean;
}

type DiffMode = "unified" | "split";

const MODE_LABEL: Record<DiffMode, string> = { unified: "统一", split: "并列" };

export function DiffView({
	review,
	onClose,
	source,
	onReturnToSource,
}: {
	review: DiffReview;
	onClose: () => void;
	/** 缺省 = 这份 diff 就属于当前会话（不需要来源归属）。 */
	source?: DiffSource;
	/** 切回来源会话；缺省 = 不提供这个动作（同一会话内看 diff 时没有可去的地方）。 */
	onReturnToSource?: () => void;
}): React.JSX.Element {
	const [mode, setMode] = useState<DiffMode>("unified");
	const rows = useMemo(() => parseNumberedDiff(review.text), [review.text]);
	const splitRows = useMemo(() => pairForSplit(rows), [rows]);
	const stats = useMemo(() => summarizeDiff(rows), [rows]);
	// 来源不是当前会话时才给出口：同一个会话里看 diff 时，按钮指向的地方就是脚下。
	const canReturn = Boolean(source && !source.isCurrent && onReturnToSource);

	return (
		<div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-hairline bg-surface">
			<div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-hairline px-3 py-2">
				<span className="min-w-[120px] flex-1 truncate font-mono text-[12px] text-ink" title={review.title}>
					{review.title}
				</span>
				{source && (
					<span
						className="shrink-0 font-mono text-[10px] text-ink-faint"
						title={`这份 diff 来自 ${source.label} 的工作区（不是按当前会话算的）`}
					>
						来源 · {source.label}
					</span>
				)}
				{canReturn && (
					<button type="button" className="link shrink-0" onClick={onReturnToSource}>
						回到来源会话
					</button>
				)}
				{!review.loading && !review.error && (
					<div className="flex shrink-0 overflow-hidden rounded border border-hairline">
						{(Object.keys(MODE_LABEL) as DiffMode[]).map(id => (
							<button
								key={id}
								type="button"
								aria-pressed={mode === id}
								aria-label={`${MODE_LABEL[id]}视图`}
								className={`px-2 py-[2px] text-[11px] transition-colors ${mode === id ? "bg-surface-2 text-ink" : "text-ink-subtle hover:text-ink"}`}
								onClick={() => setMode(id)}
							>
								{MODE_LABEL[id]}
							</button>
						))}
					</div>
				)}
				{!review.loading && !review.error && (
					<span className="shrink-0 font-mono text-[11px]">
						<span className="text-success">+{stats.added}</span>{" "}
						<span className="text-danger">-{stats.removed}</span>
					</span>
				)}
				<button type="button" className="link shrink-0" onClick={onClose}>
					返回
				</button>
			</div>

			{review.loading ? (
				<div className="flex flex-col gap-2 p-3">
					{[0, 1, 2, 3, 4].map(i => (
						<div key={i} className="skeleton h-4 w-full" style={{ width: `${92 - i * 11}%` }} />
					))}
				</div>
			) : review.error ? (
				<div className="px-3 py-3 text-[12px] text-danger">{review.error}</div>
			) : rows.length === 0 ? (
				<div className="px-3 py-6 text-center text-[12px] text-ink-faint">无差异</div>
			) : mode === "unified" ? (
				<div className="min-h-0 flex-1 overflow-auto py-1">
					{rows.map((row, index) => {
						// 行号是 diff 的一部分（服务端给的 add 行号在新文件、del 行号在旧文件），
						// 所以 key 用序号：同一次审阅里两行可以带同一个行号，行号做不了身份。
						const key = `${index}-${row.kind}`;
						if (row.kind === "hunk") {
							return (
								<div
									key={key}
									className="whitespace-pre bg-surface-2 px-3 py-[2px] font-mono text-[11px] text-ink-faint"
								>
									{row.text}
								</div>
							);
						}
						return (
							<div
								key={key}
								data-diff-kind={row.kind}
								className={`flex gap-2 px-3 py-[1px] ${ROW_CLASS[row.kind] ?? ""}`}
							>
								<span className="w-9 shrink-0 select-none text-right font-mono text-[10px] text-ink-faint">
									{row.lineNo}
								</span>
								<span className="whitespace-pre font-mono text-[11px] leading-[1.55]">{row.text || " "}</span>
							</div>
						);
					})}
				</div>
			) : (
				<div className="min-h-0 flex-1 overflow-auto py-1">
					{splitRows.map((row, index) => {
						const key = `${index}-${row.kind}`;
						if (row.kind === "marker") {
							return (
								<div
									key={key}
									className="whitespace-pre bg-surface-2 px-3 py-[2px] font-mono text-[11px] text-ink-faint"
								>
									{row.text}
								</div>
							);
						}
						return (
							<div key={key} className="flex">
								<SplitCellView cell={row.left} side="old" />
								<SplitCellView cell={row.right} side="new" />
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}

/** 并列视图的一格：行号 + 内容；对侧没有对应行时空着（不补假内容，也不缩掉）。 */
function SplitCellView({ cell, side }: { cell: SplitCell | null; side: "old" | "new" }): React.JSX.Element {
	return (
		<div
			data-split-side={side}
			data-split-kind={cell?.kind ?? "empty"}
			className={`flex w-1/2 min-w-0 gap-2 px-2 py-[1px] ${side === "old" ? "border-r border-hairline" : ""} ${cell ? (ROW_CLASS[cell.kind] ?? "") : ""}`}
		>
			<span className="w-9 shrink-0 select-none text-right font-mono text-[10px] text-ink-faint">
				{cell?.lineNo ?? ""}
			</span>
			<span className="whitespace-pre font-mono text-[11px] leading-[1.55]">{cell ? cell.text || " " : ""}</span>
		</div>
	);
}
