/**
 * 会话记录数据模型 + mock 数据源。
 *
 * 真机路径：serve 已实现 get_messages/get_session_stats/get_branch_messages（当前 attached
 * session）；历史会话索引（跨 session 的列表）待 be-dev 记录系命令补全。本模块：
 * - `MOCK_RECORDS`：列表页展示骨架（标注 TODO 接历史索引命令）
 * - `MOCK_RECORD_MESSAGES`：内置样例 timeline（回放引擎验证用，贴近 omp JSONL entry 结构）
 * - 特殊记录 id `"current"`：回放页走真数据（get_messages → 当前 session 消息）
 */

export type RecordStatus = "completed" | "aborted" | "error";

export interface SessionRecordSummary {
	id: string;
	name: string;
	agent: string;
	startedAt: string;
	messageCount: number;
	status: RecordStatus;
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

export interface RecordTimeline {
	id: string;
	summary: SessionRecordSummary;
	entries: PlaybackEntry[];
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

export const MOCK_RECORDS: SessionRecordSummary[] = [
	{
		id: "rec-gateway",
		name: "gateway 消息丢失根因分析",
		agent: "研发助手",
		startedAt: "2026-08-16T14:22:00+08:00",
		messageCount: 28,
		status: "completed",
	},
	{
		id: "rec-arch",
		name: "多端架构方案评审",
		agent: "研发助手",
		startedAt: "2026-08-16T10:05:00+08:00",
		messageCount: 12,
		status: "completed",
	},
	{
		id: "rec-alert",
		name: "日志异常告警响应",
		agent: "运维 Agent",
		startedAt: "2026-08-16T03:15:00+08:00",
		messageCount: 8,
		status: "aborted",
	},
	{
		id: "rec-onboard",
		name: "员工入职流程处理",
		agent: "HR 助手",
		startedAt: "2026-08-15T16:40:00+08:00",
		messageCount: 6,
		status: "completed",
	},
	{
		id: "rec-pr2341",
		name: "PR #2341 代码审查",
		agent: "研发助手",
		startedAt: "2026-08-15T14:00:00+08:00",
		messageCount: 20,
		status: "completed",
	},
	{
		id: "rec-slowquery",
		name: "数据库慢查询优化",
		agent: "数据分析师",
		startedAt: "2026-08-15T09:30:00+08:00",
		messageCount: 11,
		status: "error",
	},
	{
		id: "rec-weekly",
		name: "周报自动生成",
		agent: "产品助理",
		startedAt: "2026-08-14T18:00:00+08:00",
		messageCount: 5,
		status: "completed",
	},
	{
		id: "rec-vuln",
		name: "依赖漏洞扫描",
		agent: "运维 Agent",
		startedAt: "2026-08-14T10:00:00+08:00",
		messageCount: 14,
		status: "completed",
	},
];

/** 样例 timeline：gateway 排查（贴合工作台 seed 场景）+ 短模板。TODO: 真 JSONL 读取走 get_messages/get_branch_messages。 */
const MOCK_TIMELINES: Record<string, PlaybackEntry[]> = {
	"rec-gateway": [
		{
			id: "g1",
			role: "user",
			text: "帮我查一下 gateway 为什么在 00:20:30 消息丢失，然后给个修复方案。",
			tools: [],
		},
		{
			id: "g2",
			role: "assistant",
			model: "claude-opus-4-5",
			text: "根因是 service stop 超时后走了 launchctl bootout（SIGKILL），重启哨兵没写入，会话恢复被跳过。先看日志：",
			tools: [
				{
					name: "read",
					argsText: "~/.omp/gateway-data/logs/service.log",
					result: "00:20:30 [AgentBridge] bridge crashed (SIGKILL) — in-flight message lost",
					state: "done",
				},
			],
		},
		{
			id: "g3",
			role: "user",
			text: "可以，就按这个改。先看看 stop 的实现。",
			tools: [],
		},
		{
			id: "g4",
			role: "assistant",
			model: "claude-opus-4-5",
			text: "建议给 gateway.stop() 加 30s 硬超时，超时后先写重启哨兵再 escalate（bootout），避免 SIGKILL 丢消息；同步补回归测试。",
			tools: [
				{
					name: "search",
					argsText: "pattern: restart-sentinel · path: packages/omp-gateway/src",
					result: "restart-sentinel.ts · 3 matches",
					state: "done",
				},
				{ name: "edit", argsText: "packages/omp-gateway/src/gateway-daemon.ts · stop()", state: "done" },
			],
		},
	],
	"rec-arch": [
		{ id: "a1", role: "user", text: "评审多端架构方案：四端共享 wire 协议，快照权威 + 增量事件。", tools: [] },
		{
			id: "a2",
			role: "assistant",
			model: "claude-sonnet-4-5",
			text: "方案成立。关键约束是 progress 不得归约为状态、命令面集中。两个风险：多 Agent 是架构级改动、thinking 流式缺设计。",
			tools: [],
		},
		{ id: "a3", role: "user", text: "thinking 照 TUI overlay 的语义抄就行。多 Agent 我们排 P3。", tools: [] },
	],
	"rec-alert": [
		{ id: "al1", role: "user", text: "凌晨 3:15 收到网关重连异常告警，排查一下。", tools: [] },
		{
			id: "al2",
			role: "assistant",
			model: "glm-5",
			text: "告警来自心跳超时……（用户中止）",
			tools: [{ name: "grep", argsText: "pattern: heartbeat · path: packages/omp-gateway/src", state: "done" }],
		},
	],
	"rec-slowquery": [
		{ id: "s1", role: "user", text: "sessions.db 查询慢，找出瓶颈。", tools: [] },
		{
			id: "s2",
			role: "assistant",
			model: "qwen3.7-max",
			text: "瓶颈是未加索引的 ORDER BY updated_at。",
			tools: [
				{
					name: "bash",
					argsText: "sqlite3 sessions.db 'EXPLAIN QUERY PLAN SELECT …'",
					result: "SCAN … 使用临时 B-TREE（未命中索引）",
					state: "done",
				},
			],
		},
		{
			id: "s3",
			role: "assistant",
			model: "qwen3.7-max",
			text: "补 CREATE INDEX 后查询从 1.2s 降到 8ms。",
			tools: [],
		},
	],
};

const SHORT_TEMPLATE: PlaybackEntry[] = [
	{
		id: "t1",
		role: "user",
		text: "这是一个样例会话（回放引擎验证用）。真实数据待 get_messages 历史索引命令就绪。",
		tools: [],
	},
	{
		id: "t2",
		role: "assistant",
		model: "claude-sonnet-4-5",
		text: "收到。录制模式下逐步回放：速度 1x/2x/4x、快进/快退、右侧时间线跳转。",
		tools: [
			{
				name: "read",
				argsText: "docs/mock/session-playback.html",
				result: "回放控制条 · 进度球 · Step 计数",
				state: "done",
			},
		],
	},
];

export function mockTimeline(recordId: string): PlaybackEntry[] {
	return MOCK_TIMELINES[recordId] ?? SHORT_TEMPLATE;
}

export function recordStatusLabel(status: RecordStatus): string {
	switch (status) {
		case "completed":
			return "已完成";
		case "aborted":
			return "已中止";
		case "error":
			return "出错";
	}
}
