/**
 * 会话记录数据模型 + 导出工具（无 mock——数据全部来自 serve 真命令：
 * list_sessions 索引 / get_messages 当前会话 / get_branch_messages 分支候选）。
 * 历史会话的时间线 JSONL 读取待后端文件读取命令，未接前回放页对历史 id 显示空态。
 */

export type RecordStatus = "completed" | "aborted" | "error" | "incomplete" | "unknown";

export interface SessionRecordSummary {
	id: string;
	name: string;
	agent: string;
	startedAt: string;
	messageCount: number;
	status: RecordStatus;
	/** 会话 JSONL 路径（list_sessions 带出；历史回放/导出待后端读取命令）。 */
	sessionFile?: string;
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
