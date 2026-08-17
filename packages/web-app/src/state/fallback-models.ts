import type { ModelInfoDto } from "../lib/wire-dto";

/**
 * 兜底模型列表 —— serve get_available_models 仍是 stub 期间的展示数据。
 * 替换点：pi-client-adapter.getAvailableModels() 收到真实返回后不再使用本文件。
 */
export const FALLBACK_MODELS: ModelInfoDto[] = [
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
