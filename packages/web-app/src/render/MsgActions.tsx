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
 *     onUndo={...}        // 撤销本轮（wire: undo_exchange）
 *     onRegenerate={...}  // 重新生成（wire: retry_from）
 *     onFork={...}        // 从此处分叉（wire: fork_from）
 *     disabledReasons={...}
 *   />
 * 父层给每条消息的行容器加 `msg-row` class 即可触发 hover 显隐（见 msg-actions.css）。
 *
 * - copy 立即通：navigator.clipboard → execCommand fallback，成功后图标短暂切 ✓
 * - undo / regenerate / fork：三条 wire 命令服务端均已实现
 *   （wire-server.ts 的 fork_from / undo_exchange / retry_from），web-app 侧的调用链也都在。
 *
 * **不可用时按钮照旧出现，但要灰、而且必须说清为什么。** 一个灰着、title 只说「尚未接入」的
 * 按钮是假承诺 —— 用户最初报上来的就是这个。原因是**父层传下来的**（`disabledReasons`）：
 * 只有父层同时知道「内容是不是还在生成」与「这条消息拿不拿得到 entryId」，
 * MsgActions 只负责显示，不在这里猜。父层没说原因时只说「暂不可用」—— 不编原因，也不假装能用。
 * 角色门控与灰显无关：撤销 / 重新生成只出现在 assistant 行，user 行本来就没这两个按钮。
 */

/** 操作条上的三个动作键（与 disabledReasons 一一对应）。 */
export type MsgActionKey = "undo" | "regenerate" | "fork";

/** 父层没说原因时的兼容 title：只说「不可用」这个事实，不编一个原因。 */
export const UNAVAILABLE_REASON_FALLBACK = "暂不可用";

export interface MsgActionsProps {
	messageRole: "user" | "assistant";
	/** 复制目标文本（空则不提供 copy）。 */
	text?: string;
	/** 撤销本轮（wire: undo_exchange）。不传 = 灰显，title 取 disabledReasons.undo。 */
	onUndo?: () => void;
	/** 重新生成（wire: retry_from）。不传 = 灰显，title 取 disabledReasons.regenerate。 */
	onRegenerate?: () => void;
	/** 从此处分叉（wire: fork_from）。不传 = 灰显，title 取 disabledReasons.fork。 */
	onFork?: () => void;
	/**
	 * 动作不可用时显示的原因（**真实原因，由父层给**；只在对应 handler 缺席时被读）。
	 * 例：`{ undo: "生成中，暂不可用" }`、`{ fork: "不在当前会话，无法分叉" }`。
	 * 缺省（父层没说）：只说「暂不可用」。
	 */
	disabledReasons?: Partial<Record<MsgActionKey, string>>;
	className?: string;
}

export function MsgActions({
	messageRole,
	text,
	onUndo,
	onRegenerate,
	onFork,
	disabledReasons,
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

	// 能用 → 动作名；不能用 → 父层给的真实原因（父层没说就只有「暂不可用」）。
	const titleOf = (key: MsgActionKey, name: string, handler?: () => void): string =>
		handler ? name : (disabledReasons?.[key] ?? UNAVAILABLE_REASON_FALLBACK);

	return (
		<div className={`msg-actions${className ? ` ${className}` : ""}`}>
			{isAssistant && (
				<button
					type="button"
					className="icon-btn"
					title={titleOf("undo", "撤销本轮", onUndo)}
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
					title={titleOf("regenerate", "重新生成", onRegenerate)}
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
				title={titleOf("fork", "从此处分叉", onFork)}
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
