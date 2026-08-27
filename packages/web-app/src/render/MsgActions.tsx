import { Check, Copy, GitFork, RefreshCw, Undo2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { copyText } from "./copy";
import "./msg-actions.css";

/**
 * MsgActions —— 消息 hover 操作条（R4）。视觉基准：v8-hermes-full.html `.msg-foot`/`.msg-actions`。
 *
 * 消费出口（W1 Transcript 替换时接入，放在每条消息 body 之后）：
 *   <MsgActions
 *     messageRole={msg.role}
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
	messageRole: "user" | "assistant";
	/** 复制目标文本（空则不提供 copy）。 */
	text?: string;
	onUndo?: () => void;
	onRegenerate?: () => void;
	onFork?: () => void;
	className?: string;
}

export function MsgActions({
	messageRole,
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

	const isAssistant = messageRole === "assistant";

	return (
		<div className={`msg-actions${className ? ` ${className}` : ""}`}>
			{isAssistant && (
				<button
					type="button"
					className="icon-btn"
					title="该功能尚未接入"
					disabled={!onUndo}
					onClick={onUndo}
					style={{ display: "inline-flex", alignItems: "center", justifyContent: "center" }}
				>
					<Undo2 size={14} strokeWidth={1.5} />
				</button>
			)}
			{isAssistant && (
				<button
					type="button"
					className="icon-btn"
					title="该功能尚未接入"
					disabled={!onRegenerate}
					onClick={onRegenerate}
					style={{ display: "inline-flex", alignItems: "center", justifyContent: "center" }}
				>
					<RefreshCw size={14} strokeWidth={1.5} />
				</button>
			)}
			<button
				type="button"
				className="icon-btn"
				title="该功能尚未接入"
				disabled={!onFork}
				onClick={onFork}
				style={{ display: "inline-flex", alignItems: "center", justifyContent: "center" }}
			>
				<GitFork size={14} strokeWidth={1.5} />
			</button>
			<div className="flex items-center justify-center">
				<button
					type="button"
					className="icon-btn"
					title={copied ? "已复制" : "复制"}
					aria-live="polite"
					disabled={!text}
					onClick={copy}
				>
					{copied ? <Check size={14} strokeWidth={1.5} /> : <Copy size={14} strokeWidth={1.5} />}
				</button>
			</div>
		</div>
	);
}
