import { Check, Copy, GitFork, RefreshCw, Undo2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import "./msg-actions.css";

/**
 * MsgActions —— 消息 hover 操作条（R4）。视觉基准：v8-hermes-full.html `.msg-foot`/`.msg-actions`。
 *
 * 消费出口（W1 Transcript 替换时接入，放在每条消息 body 之后）：
 *   <MsgActions
 *     role={msg.role}
 *     text={msg.text}
 *     onUndo={...}        // 未来 wire：undo exchange（assistant）
 *     onRegenerate={...}  // 未来 wire：重新生成（assistant）
 *     onFork={...}        // 未来 wire：从此处分叉
 *   />
 * 父层给每条消息的行容器加 `msg-row` class 即可触发 hover 显隐（见 msg-actions.css）。
 *
 * - copy 立即通：navigator.clipboard → execCommand fallback，成功后图标短暂切 ✓
 * - undo / regenerate / fork：先渲染 disabled 态（等 wire 命令；onXxx 传入即启用）
 */
export interface MsgActionsProps {
	role: "user" | "assistant";
	/** 复制目标文本（空则不提供 copy）。 */
	text?: string;
	onUndo?: () => void;
	onRegenerate?: () => void;
	onFork?: () => void;
	className?: string;
}

async function copyText(text: string): Promise<boolean> {
	if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
		try {
			await navigator.clipboard.writeText(text);
			return true;
		} catch {
			/* fall through to execCommand */
		}
	}
	try {
		const ta = document.createElement("textarea");
		ta.value = text;
		ta.style.position = "fixed";
		ta.style.opacity = "0";
		document.body.appendChild(ta);
		ta.focus();
		ta.select();
		const ok = document.execCommand("copy");
		ta.remove();
		return ok;
	} catch {
		return false;
	}
}

export function MsgActions({
	role,
	text,
	onUndo,
	onRegenerate,
	onFork,
	className = "",
}: MsgActionsProps): React.JSX.Element {
	const [copied, setCopied] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		return () => {
			if (timer.current) clearTimeout(timer.current);
		};
	}, []);

	const copy = async () => {
		if (!text) return;
		if (await copyText(text)) {
			setCopied(true);
			if (timer.current) clearTimeout(timer.current);
			timer.current = setTimeout(() => setCopied(false), 1500);
		}
	};

	const isAssistant = role === "assistant";

	return (
		<div className={`msg-actions${className ? ` ${className}` : ""}`}>
			{isAssistant && (
				<button type="button" className="mact" title="撤销本轮（等 wire 命令）" disabled={!onUndo} onClick={onUndo}>
					<Undo2 size={13} strokeWidth={1.5} />
				</button>
			)}
			{isAssistant && (
				<button
					type="button"
					className="mact"
					title="重新生成（等 wire 命令）"
					disabled={!onRegenerate}
					onClick={onRegenerate}
				>
					<RefreshCw size={13} strokeWidth={1.5} />
				</button>
			)}
			<button type="button" className="mact" title="从此处分叉（等 wire 命令）" disabled={!onFork} onClick={onFork}>
				<GitFork size={13} strokeWidth={1.5} />
			</button>
			<button
				type="button"
				className="mact"
				title={copied ? "已复制" : "复制"}
				aria-live="polite"
				disabled={!text}
				onClick={copy}
			>
				{copied ? <Check size={13} strokeWidth={1.5} /> : <Copy size={13} strokeWidth={1.5} />}
			</button>
		</div>
	);
}
