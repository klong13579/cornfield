import { useEffect, useRef } from "react";
import { MarkdownLite } from "../../components/MarkdownLite";
import { Orb } from "../../components/Orb";
import { ThinkingFold } from "../../components/ThinkingFold";
import { ToolCard } from "../../components/ToolCard";
import type { TranscriptMessage } from "../../state/session-store";
import { useSession } from "../../state/use-session";

/**
 * 转录区（最大宽 720px 居中，Raycast 式平铺；用户消息气泡，助手消息裸排）。
 * 流式：live 消息叠加 progress 瞬态层（thinking_delta/text_delta 打字机 + caret），
 * 快照到达后权威内容替换。
 */
export function Transcript(): React.JSX.Element {
	const view = useSession();
	const scrollRef = useRef<HTMLDivElement>(null);
	const stickToBottom = useRef(true);

	const messages = view.messages;
	const live = view.live;

	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
		if (nearBottom) stickToBottom.current = true;
		if (stickToBottom.current) {
			el.scrollTop = el.scrollHeight;
		}
	}, [messages, live, view.phase]);

	return (
		<div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-6 pt-7 pb-3">
			<div className="mx-auto flex max-w-[720px] flex-col gap-7">
				{messages.map(msg => (
					<MessageRow key={msg.id} msg={msg} />
				))}
				{live && <MessageRow msg={live} streaming />}
				{!live && messages.length === 0 && (
					<div className="py-16 text-center text-[13px] text-ink-faint">还没有消息 —— 从下方输入第一条指令。</div>
				)}
			</div>
		</div>
	);
}

function MessageRow({ msg, streaming = false }: { msg: TranscriptMessage; streaming?: boolean }): React.JSX.Element {
	if (msg.role === "user") {
		return (
			<div className="flex gap-3">
				<div className="ml-auto flex max-w-[80%] flex-col items-end gap-1">
					<div className="rounded-xl border border-hairline bg-user-bg px-3.5 py-2.5 text-ink">{msg.text}</div>
				</div>
			</div>
		);
	}

	return (
		<div className="flex gap-3">
			<div className="avatar assistant shrink-0">π</div>
			<div className="min-w-0 flex-1">
				<div className="mb-1.5 flex items-center gap-2 text-[11px] tracking-[0.02em] text-ink-faint">
					<span>{msg.model ?? "assistant"}</span>
					{streaming ? (
						<span className="flex items-center gap-1.5 text-warning">
							<Orb state="composing" size={16} />
							streaming
						</span>
					) : (
						<span className="font-medium text-success">✓ 已完成</span>
					)}
				</div>
				<div className="text-[14px] leading-relaxed text-ink-muted">
					{msg.thinking && <ThinkingFold thinking={msg.thinking} streaming={streaming && msg.thinkingStreaming} />}
					{msg.text && (
						<div>
							<MarkdownLite text={msg.text} className="[&_p]:mb-2 [&_p:last-child]:mb-0" />
							{streaming && msg.textStreaming && <span className="caret" />}
						</div>
					)}
					{msg.tools.map(tool => (
						<ToolCard key={tool.id} tool={tool} />
					))}
					{msg.error && (
						<div className="mt-1 rounded-md border border-danger/40 bg-danger/5 px-3 py-2 text-[12.5px] leading-relaxed text-danger">
							✗ Error: {msg.error}
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
