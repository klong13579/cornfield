import { useEffect, useMemo, useRef } from "react";
import { AssistantTurn } from "../../render/AssistantTurn";
import { MsgActions } from "../../render/MsgActions";
import type { TranscriptMessage } from "../../state/session-store";
import { useSessionStore } from "../../state/session-store";
import { useSession } from "../../state/use-session";

/**
 * 转录区（最大宽 720px 居中，Raycast 式平铺；用户消息气泡，助手消息裸排）。
 * 流式：live 消息叠加 progress 瞬态层（thinking_delta/text_delta 打字机 + caret），
 * 快照到达后权威内容替换。
 *
 * 消息级操作（UNDO-1）：每条消息挂 MsgActions，undo/retry/fork 用 entryId 定位
 * session entry——user 消息用自身 entryId（fork 分叉点），assistant 消息用
 * 上一 user 的 entryId（撤销整轮）。
 */
export function Transcript(): React.JSX.Element {
	const view = useSession();
	const scrollRef = useRef<HTMLDivElement>(null);
	const stickToBottom = useRef(true);

	const messages = view.messages;
	const live = view.live;

	const rows = useMemo(() => {
		let lastUserEntryId: string | undefined;
		return messages.map(msg => {
			const own = view.messageEntryIds[msg.id];
			if (msg.role === "user") {
				if (own) lastUserEntryId = own;
				return { msg, entryId: own };
			}
			return { msg, entryId: lastUserEntryId };
		});
	}, [messages, view.messageEntryIds]);

	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
		if (nearBottom) stickToBottom.current = true;
		if (stickToBottom.current) {
			el.scrollTop = el.scrollHeight;
		}
	}, [messages, live, view.phase]);

	const pending =
		!live && (view.phase === "streaming" || view.phase === "retrying" || view.phase === "executing_tool");
	const compacting = !live && view.phase === "compacting";

	return (
		<div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-6 pt-7 pb-3">
			<div aria-live="polite" className="mx-auto flex max-w-[1100px] flex-col gap-7">
				{rows.map(({ msg, entryId }) => (
					<MessageRow key={msg.id} msg={msg} entryId={entryId} />
				))}
				{live && <MessageRow msg={live} streaming />}
				{(pending || compacting) && (
					<div className="flex items-center gap-2 py-1 text-xs text-ink-subtle">
						<span className="spin" />
						{compacting ? "整理上下文中…" : "思考中…"}
					</div>
				)}
				{!live && !pending && !compacting && messages.length === 0 && (
					<div className="py-16 text-center text-[13px] text-ink-faint">还没有消息 —— 从下方输入第一条指令。</div>
				)}
			</div>
		</div>
	);
}

function MessageRow({
	msg,
	streaming = false,
	entryId,
}: {
	msg: TranscriptMessage;
	streaming?: boolean;
	entryId?: string;
}): React.JSX.Element {
	const sessionStore = useSessionStore();
	if (msg.role === "user") {
		return (
			<div className="msg-row flex gap-3">
				<div className="ml-auto flex max-w-[80%] flex-col items-end gap-1">
					<div className="rounded-xl border border-hairline bg-user-bg px-3.5 py-2.5 text-ink">{msg.text}</div>
					<MsgActions
						messageRole="user"
						text={msg.text}
						onFork={entryId ? () => sessionStore.forkFrom(entryId) : undefined}
					/>
				</div>
			</div>
		);
	}

	return (
		<AssistantTurn
			model={msg.model}
			thinking={msg.thinking}
			thinkingStreaming={msg.thinkingStreaming}
			text={msg.text}
			textStreaming={msg.textStreaming}
			tools={msg.tools}
			turnId={msg.id}
			streaming={streaming}
			error={msg.error}
			onRetry={() => sessionStore.abortRetry()}
			onUndo={entryId && !streaming ? () => sessionStore.undoExchange(entryId) : undefined}
			onRegenerate={entryId && !streaming ? () => sessionStore.retryFrom(entryId) : undefined}
			onFork={entryId && !streaming ? () => sessionStore.forkFrom(entryId) : undefined}
		/>
	);
}
