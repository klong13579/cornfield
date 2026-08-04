/**
 * Builds the realtime session instructions: the static Jarvis prompt plus a
 * bounded summary of the current text session, so voice mode opens with
 * continuity ("继续说刚才那个" works).
 *
 * Bounded by design: last MAX_TURNS user/assistant text turns, each clipped to
 * MAX_CHARS_PER_TURN, whole block clipped to MAX_TOTAL_CHARS.
 */

const MAX_TURNS = 6;
const MAX_CHARS_PER_TURN = 200;
const MAX_TOTAL_CHARS = 1_500;

interface HistoryMessage {
	role?: string;
	content?: unknown;
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((part): part is { type: string; text?: unknown } => typeof part === "object" && part !== null)
			.filter(part => part.type === "text" && typeof part.text === "string")
			.map(part => part.text as string)
			.join(" ");
	}
	return "";
}

function clip(text: string, max: number): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

export function buildVoiceInstructions(basePrompt: string, history: readonly HistoryMessage[]): string {
	const turns: string[] = [];
	for (let i = history.length - 1; i >= 0 && turns.length < MAX_TURNS; i--) {
		const message = history[i]!;
		if (message.role !== "user" && message.role !== "assistant") continue;
		const text = clip(messageText(message.content), MAX_CHARS_PER_TURN);
		if (!text) continue;
		turns.unshift(`${message.role === "user" ? "用户" : "助手"}：${text}`);
	}
	if (turns.length === 0) return basePrompt;

	let block = turns.join("\n");
	if (block.length > MAX_TOTAL_CHARS) block = `…${block.slice(block.length - MAX_TOTAL_CHARS)}`;
	return `${basePrompt}\n\n## 当前会话上下文\n\n以下是你们刚才的文字对话（最近的在最后），回答时保持连贯：\n\n${block}`;
}
