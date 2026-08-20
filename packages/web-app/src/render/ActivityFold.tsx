import { ChevronDown, ChevronRight, FileText, type LucideIcon, Pencil, RefreshCcw, Search, Terminal, Wrench } from "lucide-react";
import { useState } from "react";
import { Orb } from "../components/Orb";
import type { ToolView } from "../state/session-store";
import "./activity-fold.css";

/**
 * ActivityFold —— assistant turn 的 activity 折叠行（R3，替代 ToolCard/ThinkingFold
 * 在转录区的铺开语义）。视觉基准：docs/mock/v8-hermes-full.html `.tool-call-group`。
 *
 * 消费出口（W1 Theme/Transcript 替换时接入）：
 *   {msg.thinking || msg.tools.length > 0 ? (
 *     <ActivityFold
 *       thinking={msg.thinking}
 *       tools={msg.tools}
 *       turnId={msg.id}
 *       streaming={streaming}
 *       onRetry={() => sessionStore.abortRetry()}
 *     />
 *   ) : null}
 *
 * - 折叠一行：`Activity: N tools`，失败数红标露出（`K 失败`）
 * - 展开：THINKING 块 + 每个工具的紧凑行（icon + name + target + ✓/✗/spinner）
 * - 展开态按 turnId 持久化 localStorage（默认折叠），刷新保持
 * - 失败工具行露出 retry（abort_retry）；单击工具行展开 args/result 审计细节
 */
export interface ActivityFoldProps {
	/** turn 的 thinking 全文（空则不渲染 thinking 块）。 */
	thinking?: string;
	/** turn 内的工具调用（空 + 无 thinking 时返回 null）。 */
	tools: ToolView[];
	/** 展开态持久化键（＝ TranscriptMessage.id）。 */
	turnId: string;
	/** 该 turn 是否仍在流式（thinking 块显示 shaping orb）。 */
	streaming?: boolean;
	/** 失败工具 retry（透传 abort_retry）。 */
	onRetry?: () => void;
	className?: string;
}

const MAX_THINKING_CHARS = 4000;
const STORAGE_PREFIX = "omp:activity-fold:";

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

function readFoldOpen(turnId: string): boolean {
	if (typeof localStorage === "undefined") return false;
	try {
		return localStorage.getItem(STORAGE_PREFIX + turnId) === "1";
	} catch {
		return false;
	}
}

function writeFoldOpen(turnId: string, open: boolean): void {
	if (typeof localStorage === "undefined") return;
	try {
		localStorage.setItem(STORAGE_PREFIX + turnId, open ? "1" : "0");
	} catch {
		/* quota / privacy mode —— 忽略，本次会话内仍可展开 */
	}
}

export function ActivityFold({
	thinking,
	tools,
	turnId,
	streaming = false,
	onRetry,
	className = "",
}: ActivityFoldProps): React.JSX.Element | null {
	const [open, setOpen] = useState(() => readFoldOpen(turnId));
	const failCount = tools.filter(t => t.state === "fail").length;
	const running = tools.some(t => t.state === "run");

	if (tools.length === 0 && !thinking?.trim()) return null;

	const toggle = () => {
		setOpen(prev => {
			writeFoldOpen(turnId, !prev);
			return !prev;
		});
	};

	return (
		<div className={`activity-fold${open ? " open" : ""}${className ? ` ${className}` : ""}`}>
			<button type="button" className="activity-fold-head" onClick={toggle} aria-expanded={open}>
				<ChevronRight size={13} strokeWidth={1.5} className="caret" />
				<span className="activity-fold-title">Activity: {tools.length} tools</span>
				{running && <span className="spin" />}
				{failCount > 0 && <span className="activity-fold-err">{failCount} 失败</span>}
			</button>
			{open && (
				<div className="activity-fold-body">
					{thinking?.trim() && <ThinkBlock text={thinking} streaming={streaming} />}
					{tools.map(tool => (
						<ToolRow key={tool.id} tool={tool} onRetry={onRetry} />
					))}
				</div>
			)}
		</div>
	);
}

function ThinkBlock({ text, streaming }: { text: string; streaming: boolean }): React.JSX.Element {
	const trimmed = text.trim();
	const capped = trimmed.length > MAX_THINKING_CHARS ? `${trimmed.slice(0, MAX_THINKING_CHARS)}…` : trimmed;
	return (
		<div className="think-block">
			<span className="think-label">
				{streaming && <Orb state="shaping" size={12} />}
				<span>THINKING</span>
			</span>
			<div className="think-text">{capped}</div>
			{trimmed.length > MAX_THINKING_CHARS && (
				<div className="think-more">… 超出 {MAX_THINKING_CHARS} 字，截断显示</div>
			)}
		</div>
	);
}

function toolTarget(tool: ToolView): string {
	if (tool.intent) return tool.intent;
	const args = tool.argsText?.trim();
	if (!args) return "";
	return args.length > 60 ? `${args.slice(0, 60)}…` : args;
}

function ToolRow({ tool, onRetry }: { tool: ToolView; onRetry?: () => void }): React.JSX.Element {
	const [detail, setDetail] = useState(false);
	const Icon = TOOL_ICONS[tool.name] ?? Wrench;
	const target = toolTarget(tool);

	return (
		<div className="toolrow">
			<div className="toolrow-top">
				<button type="button" className="toolrow-main" onClick={() => setDetail(v => !v)} aria-expanded={detail}>
					<Icon size={13} strokeWidth={1.5} className="toolrow-icon" />
					<span className="toolrow-name">{tool.name}</span>
					{target && <span className="toolrow-target">{target}</span>}
					<ChevronDown
						size={11}
						strokeWidth={1.5}
						className={`shrink-0 text-ink-faint transition-transform ${detail ? "rotate-180" : ""}`}
					/>
					{tool.state === "run" ? (
						<span className="spin" />
					) : tool.state === "fail" ? (
						<span className="toolrow-status toolrow-status--fail">✗</span>
					) : (
						<span className="toolrow-status toolrow-status--done">✓</span>
					)}
				</button>
				{tool.state === "fail" && onRetry && (
					<button type="button" className="toolrow-retry" title="中止当前失败重试流" onClick={onRetry}>
						<RefreshCcw size={11} strokeWidth={1.5} />
						retry
					</button>
				)}
			</div>
			{detail && tool.state !== "run" && (
				<div className="toolrow-detail">
					{tool.argsText && <div className="args">{tool.argsText}</div>}
					{tool.result !== undefined && (
						<div className="result">{tool.result || (tool.state === "done" ? "done" : "")}</div>
					)}
				</div>
			)}
		</div>
	);
}
