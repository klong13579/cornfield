import { Orb } from "../components/Orb";
import { brandKeyOfModel, ProviderLogo } from "../components/ProviderLogo";
import type { ToolView } from "../state/session-store";
import { ActivityFold } from "./ActivityFold";
import { Markdown } from "./Markdown";
import { MsgActions } from "./MsgActions";

/**
 * AssistantTurn —— 助手消息行容器（P2-W2-1）。把 R3 ActivityFold（thinking+tools 折叠）
 * + R1b Markdown（正文）+ R4 MsgActions（hover 操作条）嵌进 `.msg-row` 容器：
 * `.msg-row` 作为 hover 触发类，`.msg-row:hover .msg-actions` 显隐已在 msg-actions.css 就绪。
 *
 * W1 消费出口（替代 Transcript 里的内联 MessageRow）：
 *   <AssistantTurn
 *     model={msg.model} thinking={msg.thinking} thinkingStreaming={msg.thinkingStreaming}
 *     text={msg.text} textStreaming={msg.textStreaming} tools={msg.tools} turnId={msg.id}
 *     streaming={streaming} error={msg.error}
 *     onRetry={…} onUndo={…} onRegenerate={…} onFork={…}
 *   />
 * 纯展示：command 回调全部由父层注入（不引 session-store）。
 */
export interface AssistantTurnProps {
	model?: string;
	thinking?: string;
	thinkingStreaming?: boolean;
	text?: string;
	textStreaming?: boolean;
	tools: ToolView[];
	turnId: string;
	streaming?: boolean;
	error?: string;
	/** ActivityFold 失败工具 retry（abort_retry）。 */
	onRetry?: () => void;
	/** MsgActions 撤销本轮（assistant）。 */
	onUndo?: () => void;
	/** MsgActions 重新生成（assistant）。 */
	onRegenerate?: () => void;
	/** MsgActions 从此处分叉。 */
	onFork?: () => void;
	className?: string;
}

export function AssistantTurn({
	model,
	thinking,
	thinkingStreaming = false,
	text,
	textStreaming = false,
	tools,
	turnId,
	streaming = false,
	error,
	onRetry,
	onUndo,
	onRegenerate,
	onFork,
	className = "",
}: AssistantTurnProps): React.JSX.Element {
	// 转录头像：能识别品牌的模型显示品牌 logo，未识别保持 π（应用身份占位）。
	const brandKey = model ? brandKeyOfModel(model) : null;
	return (
		<div className={`msg-row flex gap-3${className ? ` ${className}` : ""}`}>
			<div className="avatar assistant shrink-0">
				{brandKey ? <ProviderLogo provider={brandKey} modelId={model} size={15} /> : "π"}
			</div>
			<div className="min-w-0 flex-1">
				<div className="mb-1.5 flex items-center gap-2 text-[11px] tracking-[0.02em] text-ink-faint">
					<span>{model ?? "—"}</span>
					{streaming ? (
						<span className="flex items-center gap-1.5 text-ink-subtle">
							<Orb state="composing" size={16} />
							生成中
						</span>
					) : (
						<span className="font-medium text-success">✓ 完成</span>
					)}
				</div>
				<div className="text-[14px] leading-relaxed text-ink-muted">
					<ActivityFold
						thinking={thinking}
						tools={tools}
						turnId={turnId}
						streaming={streaming && thinkingStreaming}
						onRetry={onRetry}
					/>
					{text && (
						<div>
							<Markdown text={text} />
							{streaming && textStreaming && <span className="caret" />}
						</div>
					)}
					{error && (
						<div
							className="mt-1 rounded-md border px-3 py-2 text-xs leading-relaxed text-danger"
							style={{
								backgroundColor: "color-mix(in srgb, var(--color-danger) 6%, transparent)",
								borderColor: "color-mix(in srgb, var(--color-danger) 35%, transparent)",
							}}
						>
							出错：{error}
						</div>
					)}
				</div>
				<MsgActions
					messageRole="assistant"
					text={text}
					onUndo={onUndo}
					onRegenerate={onRegenerate}
					onFork={onFork}
				/>
			</div>
		</div>
	);
}
