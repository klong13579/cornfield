/**
 * 会话记录数据模型 + 导出工具（无 mock——数据全部来自 serve 真命令：
 * list_sessions 索引 / get_messages 当前会话 / get_branch_messages 分支候选）。
 * 历史会话的时间线 JSONL 读取待后端文件读取命令，未接前回放页对历史 id 显示空态。
 */

export type RecordStatus = "completed" | "aborted" | "error" | "incomplete" | "unknown";

/** 会话来源（list_sessions source 字段）：cli = 本地 CLI 交互会话；agent = gateway/registry agent 会话。 */
export type SessionSource = "cli" | "agent";

export interface SessionRecordSummary {
	id: string;
	name: string;
	agent: string;
	startedAt: string;
	messageCount: number;
	status: RecordStatus;
	/** 会话 JSONL 路径（list_sessions 带出；历史回放/导出待后端读取命令）。 */
	sessionFile?: string;
	/** 会话来源（SessionSidebar 双源 tab 按此区分）。 */
	source: SessionSource;
}

export interface PlaybackToolStep {
	name: string;
	argsText: string;
	result?: string;
	state: "done" | "fail";
}

export interface PlaybackEntry {
	id: string;
	role: "user" | "assistant";
	model?: string;
	text: string;
	tools: PlaybackToolStep[];
}

/** 当前 attached session 的特殊 id：回放页走 serve get_messages 真数据。 */
export const CURRENT_SESSION_ID = "current";

/** 分支候选（get_branch_messages 返回：{entryId,text} 用户消息分支点）。 */
export interface BranchPoint {
	entryId: string;
	text: string;
}

/** 导出 JSONL：每行一个 JSON 对象，Blob + a[download] 触发下载。 */
export function downloadJsonl(filename: string, rows: unknown[]): void {
	const blob = new Blob([rows.map(r => JSON.stringify(r)).join("\n")], { type: "application/x-ndjson" });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	a.click();
	URL.revokeObjectURL(url);
}

export function recordStatusLabel(status: RecordStatus): string {
	switch (status) {
		case "completed":
			return "已完成";
		case "aborted":
			return "已中止";
		case "error":
			return "出错";
		case "incomplete":
			return "未完成";
		default:
			return "未知";
	}
}

/**
 * 会话消息（serve get_session_messages 返回的 AgentMessageDto[]，与 get_messages 完全同型）
 * → 回放时间线 PlaybackEntry[]。
 *
 * 与 pi-client-adapter 内 get_messages 的转换保持同一规则：独立 toolResult 顶层消息按
 * toolCallId 归并回对应 toolCall；错误消息补 ✗ Error 文本；空文本且无工具的消息跳过。
 */
export function toPlaybackEntries(messages: unknown[]): PlaybackEntry[] {
	// 独立 toolResult 顶层消息（role:"toolResult"，serve 快照/JSONL 形状）→ 按 toolCallId 归并，
	// 供下面渲染时挂回对应 toolCall（结果在消息自己的 content 内联形状时直接在循环内读取）。
	const standaloneResults = new Map<string, { isError?: boolean; text: string }>();
	for (const raw of messages) {
		if (!raw || typeof raw !== "object") continue;
		const m = raw as { role?: string; toolCallId?: string; isError?: boolean; content?: unknown };
		if (m.role !== "toolResult" || !m.toolCallId) continue;
		const parts = Array.isArray(m.content) ? (m.content as { type?: string; text?: string }[]) : [];
		standaloneResults.set(m.toolCallId, {
			isError: m.isError,
			text: parts
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map(c => c.text)
				.join("\n"),
		});
	}

	const result = new Map<string, { isError?: boolean; text: string }>(standaloneResults);
	const entries: PlaybackEntry[] = [];
	for (const raw of messages) {
		if (!raw || typeof raw !== "object") continue;
		const msg = raw as {
			id?: string;
			role?: string;
			model?: string;
			content?: unknown;
			errorMessage?: string;
		};
		const parts = Array.isArray(msg.content)
			? (msg.content as {
					type?: string;
					text?: string;
					thinking?: string;
					id?: string;
					name?: string;
					content?: unknown;
					isError?: boolean;
					arguments?: Record<string, unknown>;
				}[])
			: [];
		if (msg.role !== "user" && msg.role !== "assistant") continue;

		const contentByType = (type: string) => parts.filter(p => p.type === type);
		const text = [
			...contentByType("text").map(p => p.text ?? ""),
			...(msg.errorMessage ? [`✗ Error: ${msg.errorMessage}`] : []),
		].join("\n\n");
		const calls = contentByType("toolCall");
		const toolResults = contentByType("toolResult") as {
			toolCallId?: string;
			isError?: boolean;
			content?: { type: string; text?: string }[];
		}[];
		for (const tr of toolResults) {
			result.set(tr.toolCallId ?? "", {
				isError: tr.isError,
				text: (tr.content ?? [])
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map(c => c.text)
					.join("\n"),
			});
		}
		const tools: PlaybackToolStep[] = calls.map(call => {
			const r = result.get(call.id ?? "");
			return {
				name: call.name ?? "tool",
				argsText: call.arguments ? prettyArgs(call.arguments) : "",
				state: r?.isError ? "fail" : "done",
				result: r?.text,
			};
		});
		if (!text && tools.length === 0 && !msg.errorMessage) continue;
		entries.push({
			id: msg.id ?? `e${entries.length}`,
			role: msg.role === "user" ? "user" : "assistant",
			model: msg.model,
			text,
			tools,
		});
	}
	return entries;
}

function prettyArgs(args: Record<string, unknown>): string {
	return Object.entries(args)
		.map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
		.join(" · ");
}
