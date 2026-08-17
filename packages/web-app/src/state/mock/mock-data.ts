import type { AgentInfoDto, EnvironmentSummaryDto, ModelInfoDto, SessionSnapshotDto } from "../../lib/wire-dto";

/**
 * mock 种子数据 —— 仅在 `@oh-my-pi/pi-client` 就绪前驱动 UI。
 * 场景对应 mock 视觉稿（gateway 00:20:30 消息丢失排查），替换点见 `state/client.ts`。
 */

export const MOCK_ENV: EnvironmentSummaryDto = {
	repos: "oh-my-pi",
	branch: "main",
	activeAgentCount: 4,
	pendingCronCount: 2,
};

export const MOCK_AGENTS: AgentInfoDto[] = [
	{
		id: "dev-assistant",
		name: "研发助手",
		face: "研",
		workspace: "研发工作区",
		kind: "coding",
		status: "online",
		lastAction: "分析了 gateway 消息丢失",
		model: "claude-opus-4-5",
		skillsCount: 12,
		cronCount: 3,
		dingtalkBound: true,
	},
	{
		id: "qa-agent",
		name: "测试 Agent",
		face: "测",
		workspace: "研发工作区",
		kind: "coding",
		status: "idle",
		lastAction: "执行每日代码审查",
		model: "claude-sonnet-4-5",
		skillsCount: 6,
		cronCount: 1,
	},
	{
		id: "ops-agent",
		name: "运维 Agent",
		face: "运",
		workspace: "运营工作区",
		kind: "worker",
		status: "busy",
		lastAction: "撰写 PRD 初稿",
		model: "qwen3.7-max",
		skillsCount: 8,
		cronCount: 5,
		dingtalkBound: true,
	},
	{
		id: "hr-agent",
		name: "HR 助手",
		face: "HR",
		workspace: "运营工作区",
		kind: "worker",
		status: "online",
		lastAction: "整理本周入离职汇总",
		model: "minimax-m3",
		skillsCount: 4,
		cronCount: 2,
		dingtalkBound: true,
	},
];

export const MOCK_MODELS: ModelInfoDto[] = [
	{
		id: "claude-opus-4-5",
		provider: "anthropic",
		contextWindow: "200K",
		price: "¥0.09/K",
		latency: "中",
		description: "旗舰推理模型，工具调用与长程任务首选",
		supportsThinking: true,
	},
	{
		id: "claude-sonnet-4-5",
		provider: "anthropic",
		contextWindow: "200K",
		price: "¥0.02/K",
		latency: "中",
		description: "平衡成本与推理质量",
		supportsThinking: true,
	},
	{
		id: "qwen3.7-max",
		provider: "narwal-plan",
		contextWindow: "128K",
		price: "¥0.02/K",
		latency: "快速",
		description: "高吞吐、低延迟，日常任务友好",
		supportsThinking: true,
	},
	{
		id: "minimax-m3",
		provider: "narwal-plan",
		contextWindow: "256K",
		price: "¥0.025/K",
		latency: "中",
		description: "超长上下文，适合大文档分析",
		supportsThinking: true,
	},
	{
		id: "gemini-2.5-pro",
		provider: "google",
		contextWindow: "1M",
		price: "¥0.05/K",
		latency: "慢",
		description: "百万级上下文窗口",
		supportsThinking: true,
	},
	{
		id: "gemini-2.5-flash",
		provider: "google",
		contextWindow: "1M",
		price: "¥0.005/K",
		latency: "快速",
		description: "低成本高吞吐",
		supportsThinking: false,
	},
];

/** 起始快照：沿用 mock 视觉稿的排查会话（已完成的对话 + 4 项 todo）。 */
export function seedSnapshot(): SessionSnapshotDto {
	return {
		seq: 0,
		sessionId: "01a00b13bc4981",
		sessionName: "gateway 消息丢失排查",
		sessionFile: "~/.omp/agents/dev/sessions/01a00b13bc4981.jsonl",
		model: { id: "claude-opus-4-5", provider: "anthropic" },
		thinkingLevel: "high",
		scopedModels: [
			{ model: { id: "claude-opus-4-5", provider: "anthropic" }, thinkingLevel: "high" },
			{ model: { id: "qwen3.7-max", provider: "narwal-plan" }, thinkingLevel: "medium" },
			{ model: { id: "minimax-m3", provider: "narwal-plan" }, thinkingLevel: "low" },
		],
		messages: [
			{
				id: "m1",
				role: "user",
				content: [{ type: "text", text: "帮我查一下 gateway 为什么在 00:20:30 消息丢失，然后给个修复方案。" }],
			},
			{
				id: "m2",
				role: "assistant",
				model: "claude-opus-4-5",
				content: [
					{
						type: "thinking",
						thinking:
							"用户报告 gateway 在 00:20:30 消息丢失。先确认重启路径：omp-gateway service stop 走 gateway.stop() 优雅退出并写重启哨兵；超时后才 escalate 到 launchctl bootout（SIGKILL）。SIGKILL 下哨兵写不进，会话恢复被跳过，in-flight IM 消息丢失。需要核对 stop() 的实现确认超时边界。",
					},
					{
						type: "text",
						text: "根因是 service stop 超时后走了 launchctl bootout（SIGKILL），重启哨兵没写入，会话恢复被跳过。先看日志确认：\n\n`~/.omp/gateway-data/logs/service.log` 00:20:30 附近。\n\n再确认哨兵写入路径。",
					},
					{
						type: "toolCall",
						id: "t1",
						name: "read",
						arguments: { path: "~/.omp/gateway-data/logs/service.log" },
					},
					{
						type: "toolResult",
						toolCallId: "t1",
						content: [
							{ type: "text", text: "00:20:30 [AgentBridge] bridge crashed (SIGKILL) — in-flight message lost" },
						],
					},
					{
						type: "toolCall",
						id: "t2",
						name: "search",
						arguments: { pattern: "restart-sentinel", path: "packages/omp-gateway/src" },
					},
					{
						type: "toolResult",
						toolCallId: "t2",
						content: [{ type: "text", text: "restart-sentinel.ts · 3 matches" }],
					},
					{
						type: "text",
						text: "建议：给 gateway.stop() 加 30s 硬超时，超时后写哨兵再 escalate，避免直接 SIGKILL 丢消息；同步补回归测试。",
					},
				],
			},
		],
		todoPhases: [
			{
				name: "Investigation",
				tasks: [
					{ content: "复现 00:20:30 消息丢失", status: "completed" },
					{ content: "确认 SIGKILL 路径与哨兵关系", status: "completed" },
					{ content: "定位 gateway.stop() 超时边界", status: "in_progress" },
				],
			},
			{
				name: "Implementation",
				tasks: [
					{ content: "给 stop 加 30s 硬超时", status: "pending" },
					{ content: "回归验证重启恢复", status: "pending" },
				],
			},
		],
		activeToolNames: [],
		queuedMessageCount: 0,
		phase: "idle",
		retryAttempt: 0,
		isCompacting: false,
		isStreaming: false,
		autoCompactionEnabled: true,
		autoRetryEnabled: true,
		context: { usedTokens: 124_000, totalTokens: 200_000, lastCompaction: null },
	};
}
