import { useMemo } from "react";
import type { DiffReview } from "../../state/file-workflow-store";
import { parseNumberedDiff, summarizeDiff } from "./diff-format";

/**
 * Diff 审阅面板：渲染服务端 `generateUnifiedDiffString` 的带行号统一 diff。
 *
 * 这里只做展示（解析在 diff-format）：前端不生成 diff、不比较文本 —— diff 的真相在
 * coding-agent 的 edit 模块，第二套实现意味着同一次修改会有两个说法。
 */

const ROW_CLASS: Record<string, string> = {
	add: "bg-success/10 text-success",
	del: "bg-danger/10 text-danger",
	context: "text-ink-muted",
};

export function DiffView({ review, onClose }: { review: DiffReview; onClose: () => void }): React.JSX.Element {
	const rows = useMemo(() => parseNumberedDiff(review.text), [review.text]);
	const stats = useMemo(() => summarizeDiff(rows), [rows]);

	return (
		<div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-hairline bg-surface">
			<div className="flex shrink-0 items-center gap-2 border-b border-hairline px-3 py-2">
				<span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink" title={review.title}>
					{review.title}
				</span>
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
			) : (
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
			)}
		</div>
	);
}
