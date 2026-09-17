import { useEffect, useMemo, useRef } from "react";
import { AssistantTurn } from "../../render/AssistantTurn";
import { type MsgActionKey, MsgActions } from "../../render/MsgActions";
import type { TranscriptMessage } from "../../state/session-store";
import { useSessionStore } from "../../state/session-store";
import { useSession } from "../../state/use-session";

/**
 * 转录区（最大宽 1100px 居中，Raycast 式平铺；用户消息气泡，助手消息裸排）。
 * 流式：live 消息叠加 progress 瞬态层（thinking_delta/text_delta 打字机 + caret），
 * 快照到达后权威内容替换。
 *
 * 消息级操作（UNDO-1）：每条消息挂 MsgActions，undo/retry/fork 用 entryId 定位
 * session entry——user 消息用自身 entryId（fork 分叉点），assistant 消息用
 * 上一 user 的 entryId（撤销整轮）。
 */

/** 距底部这个距离以内算「在底部」——贴底跟随的唯一阈值。 */
export const TRANSCRIPT_FOLLOW_THRESHOLD_PX = 120;

/** 滚动容器的最小度量面（DOM 元素天然满足；测试用假盒子）。 */
export interface ScrollBox {
	scrollHeight: number;
	scrollTop: number;
	clientHeight: number;
}

/**
 * 转录区贴底跟随。
 *
 * 唯一真相来源是**用户的滚动事件**：`userScrolled`（onScroll，唯一写入口）每次重新判定
 * 「是否在底部」；`contentChanged`（新消息 / 流式 delta / phase 变化）只读取它、从不改写。
 * 早先的写法只在判定为底部时置 true、从不置回 false，于是用户往上翻之后任何一次
 * re-render 都会把他拉回底部 —— 状态必须能被用户滚上去这件事本身置回 false。
 */
export class TranscriptFollow {
	#stuck = true;

	/** 用户滚动：距底部超过阈值即退出跟随；滚回底部重新跟随。 */
	userScrolled(box: ScrollBox): void {
		this.#stuck = box.scrollHeight - box.scrollTop - box.clientHeight < TRANSCRIPT_FOLLOW_THRESHOLD_PX;
	}

	/** 内容变化：仍贴底就跟随到底，已退出则原地不动。 */
	contentChanged(box: ScrollBox): void {
		if (this.#stuck) box.scrollTop = box.scrollHeight;
	}
}

export function Transcript(): React.JSX.Element {
	const view = useSession();
	const scrollRef = useRef<HTMLDivElement>(null);
	// 贴底状态整个挂载期只有一份；初始 true = 首次进入贴底（行为与改动前一致）。
	const followRef = useRef<TranscriptFollow | null>(null);
	if (followRef.current === null) followRef.current = new TranscriptFollow();
	const follow = followRef.current;

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

	// 内容变化（新消息 / 流式 delta / phase 变化）：只按当前跟随状态决定要不要贴底，
	// 不在这里判定「是否在底部」——那是 onScroll 的事。
	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		follow.contentChanged(el);
	}, [messages, live, view.phase, follow]);

	const pending =
		!live && (view.phase === "streaming" || view.phase === "retrying" || view.phase === "executing_tool");
	const compacting = !live && view.phase === "compacting";

	return (
		<div
			ref={scrollRef}
			onScroll={event => follow.userScrolled(event.currentTarget)}
			className="min-h-0 flex-1 overflow-y-auto px-6 pt-5 pb-3"
		>
			<div aria-live="polite" className="mx-auto flex max-w-[1100px] flex-col gap-3">
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

/**
 * 三条动作拿不到 entryId（历史回放就是这种：`view.messageEntryIds` 里没有这些消息）时，
 * 按动作说清到底是哪一条不能用。文案与 `MsgActions` 的动作名对齐。
 */
const NOT_IN_SESSION_REASON: Record<MsgActionKey, string> = {
	undo: "不在当前会话，无法撤销",
	regenerate: "不在当前会话，无法重新生成",
	fork: "不在当前会话，无法分叉",
};

/** 内容还在生成：三条动作都不可用，原因与动作无关。 */
const GENERATING_REASON = "生成中，暂不可用";

/**
 * 传给 `MsgActions` 的「为什么不能用」。判定门与 handler 的门是同一个（`!streaming && entryId`）：
 * 生成中优先说生成中，其次是拿不到 entryId；都能用就不传原因（title 用动作名）。
 *
 * 两条路径共用一份 map：user 行只渲染 fork，map 里 undo/regenerate 那两条不会被读（角色门挡掉了）。
 * handler 与原因出自同一个条件，不会出现「按钮能点却写着不可用」。
 */
function unavailableReasonsOf(
	streaming: boolean,
	entryId: string | undefined,
): Partial<Record<MsgActionKey, string>> | undefined {
	if (streaming) {
		return { undo: GENERATING_REASON, regenerate: GENERATING_REASON, fork: GENERATING_REASON };
	}
	if (!entryId) return NOT_IN_SESSION_REASON;
	return undefined;
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
	const unavailableReasons = unavailableReasonsOf(streaming, entryId);
	if (msg.role === "user") {
		return (
			<div className="msg-row flex gap-3">
				<div className="ml-auto flex max-w-[80%] flex-col items-end gap-1">
					<div className="rounded-xl border border-hairline bg-user-bg px-3.5 py-2.5 text-ink">{msg.text}</div>
					<MsgActions
						messageRole="user"
						text={msg.text}
						onFork={entryId ? () => sessionStore.forkFrom(entryId) : undefined}
						disabledReasons={unavailableReasons}
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
			disabledReasons={unavailableReasons}
		/>
	);
}
