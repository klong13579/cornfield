import {
	ChevronDown,
	ChevronRight,
	FileText,
	type LucideIcon,
	Pencil,
	RefreshCcw,
	Search,
	Terminal,
	Wrench,
} from "lucide-react";
import { useState } from "react";
import { useIsMobile } from "../lib/use-media-query";
import type { ToolView } from "../state/session-store";

/**
 * 工具卡三态（run/done/fail）—— 用户审计轨迹。
 * - run：旋转 spinner + amber badge，参数区可见
 * - done：green badge ✓ + 参数/结果展开（默认展开，头部点击折叠）
 * - fail：红边 + ✗ 错误 + retry（abort_retry 命令）
 * 参数区 mono 深色底；结果区 ✓/✗ 前缀（语义色）
 */
const TOOL_ICONS: Record<string, LucideIcon> = {
	read: FileText,
	write: Pencil,
	edit: Pencil,
	search: Search,
	grep: Terminal,
	bash: Terminal,
	python: Terminal,
	ast_grep: Search,
};

export function ToolCard({
	tool,
	className = "",
	onRetry,
}: {
	tool: ToolView;
	className?: string;
	onRetry?: () => void;
}): React.JSX.Element {
	// 移动端工具卡默认折叠（FR-8：触控优先，点击展开参数/结果）；桌面默认展开（审计轨迹）。
	const isMobile = useIsMobile();
	const [expanded, setExpanded] = useState(!isMobile);
	const Icon = TOOL_ICONS[tool.name] ?? Wrench;

	return (
		<div className={`toolcard${tool.state === "fail" ? " error" : ""} ${className}`}>
			<div className="head">
				<button
					type="button"
					className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
					onClick={() => setExpanded(v => !v)}
					aria-expanded={expanded}
				>
					<Icon size={13} strokeWidth={1.5} className="shrink-0 text-ink-subtle" />
					<span className="tname">{tool.name}</span>
					{tool.intent && <span className="truncate text-[11px] text-ink-faint">{tool.intent}</span>}
					{expanded ? (
						<ChevronDown size={13} strokeWidth={1.5} className="ml-auto shrink-0 text-ink-faint" />
					) : (
						<ChevronRight size={13} strokeWidth={1.5} className="ml-auto shrink-0 text-ink-faint" />
					)}
				</button>
				<span className="state">
					{tool.state === "run" && (
						<>
							<span className="spin" />
							<span className="badge run">运行中</span>
						</>
					)}
					{tool.state === "done" && <span className="badge done">完成</span>}
					{tool.state === "fail" && (
						<>
							<span className="badge fail">失败</span>
							<button
								type="button"
								className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-ink-muted hover:bg-surface-2 hover:text-ink"
								title="重试：abort_retry（中止当前失败重试流）"
								onClick={e => {
									e.stopPropagation();
									onRetry?.();
								}}
							>
								<RefreshCcw size={11} strokeWidth={1.5} />
								retry
							</button>
						</>
					)}
				</span>
			</div>
			{expanded && tool.argsText && <div className="args">{tool.argsText}</div>}
			{expanded && tool.state !== "run" && tool.result !== undefined && (
				<div className="result">{tool.result || (tool.state === "done" ? "done" : "")}</div>
			)}
		</div>
	);
}
