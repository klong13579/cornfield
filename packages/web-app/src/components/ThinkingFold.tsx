import { Brain, ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { Markdown } from "../render/Markdown";
import { Orb } from "./Orb";

/**
 * Thinking 折叠区 —— 按 TUI `session-observer-overlay.ts` renderThinkingLines 语义实现：
 * - 折叠时预览前 200 字符（MAX_THINKING_CHARS_COLLAPSED），截断加 "… N 行" 提示
 * - 展开时渲染全文（上限 4000 字符，MAX_THINKING_CHARS_EXPANDED），按 markdown 排版
 * - thinking_delta 流式追加由上层（Transcript）驱动 thinking 文本持续变化；
 *   本组件只在流式时显示 shaping orb + 折叠预览实时跟随
 * - 交互：点击头部折叠/展开（UX 原则 4：思考不默认展开）
 */
const MAX_THINKING_CHARS_COLLAPSED = 200;
const MAX_THINKING_CHARS_EXPANDED = 4000;
const COLLAPSED_LINES = 3;

export interface ThinkingFoldProps {
	thinking: string;
	streaming?: boolean;
	className?: string;
}

export function ThinkingFold({
	thinking,
	streaming = false,
	className = "",
}: ThinkingFoldProps): React.JSX.Element | null {
	const [expanded, setExpanded] = useState(false);
	const text = thinking.trim();

	if (!text) {
		return streaming ? (
			<div className={`flex items-center gap-2 text-[12px] text-ink-faint ${className}`}>
				<Orb state="shaping" size={14} />
				Thinking…
			</div>
		) : null;
	}

	const truncatedAt = expanded ? MAX_THINKING_CHARS_EXPANDED : MAX_THINKING_CHARS_COLLAPSED;
	const display = text.length > truncatedAt ? `${text.slice(0, truncatedAt)}…` : text;
	const lineCount = display.split("\n").length;
	const showMore = text.length > truncatedAt;

	return (
		<div className={`my-2 ${className}`}>
			<button
				type="button"
				className="flex w-full cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface-2"
				onClick={() => setExpanded(v => !v)}
				aria-expanded={expanded}
			>
				{streaming ? (
					<Orb state="shaping" size={14} />
				) : (
					<Brain size={13} strokeWidth={1.5} className="text-ink-subtle" />
				)}
				<span className="text-[12px] font-medium text-ink-subtle">Thinking</span>
				{expanded ? (
					<ChevronDown size={13} strokeWidth={1.5} className="text-ink-faint" />
				) : (
					<ChevronRight size={13} strokeWidth={1.5} className="text-ink-faint" />
				)}
				{showMore && (
					<span className="ml-auto text-[11px] text-ink-faint">
						{expanded ? "收起" : `展开 ${text.length} 字`}
					</span>
				)}
			</button>
			{expanded ? (
				<div className="px-2 pb-1 text-[13px] leading-relaxed text-ink-subtle">
					<Markdown text={display} />
					{showMore && (
						<div className="pt-1 text-[11px] text-ink-faint">… 超出预览上限，截断显示（完整内容以快照为准）</div>
					)}
				</div>
			) : (
				<div className="px-2 pb-1 text-[12.5px] leading-relaxed text-ink-faint italic">
					{display
						.split("\n")
						.slice(0, COLLAPSED_LINES)
						.map((line, i) => (
							<div key={i}>{line}</div>
						))}
					{showMore && streaming && <div className="caret" />}
					{showMore && !streaming && (
						<div className="text-[11px] non-italic">
							… 共 {lineCount} 行 / {text.length} 字
						</div>
					)}
				</div>
			)}
		</div>
	);
}
