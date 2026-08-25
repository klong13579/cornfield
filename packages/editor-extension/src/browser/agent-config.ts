// omp agent 注册 + 自定义主题的共享常量与解析逻辑。
//
// 这里只用「正规偏好配置」（非 spike 的 DefaultACPConfigProvider provider patch）：
//   - ai.native.agent.defaultType   → 默认 agent 类型（omp）
//   - ai.native.agent.configs        → agent 目录（getDefaultAgentType 据此识别 omp 可用）
//   - ai-native.acp.agents           → per-agent spawn 覆盖（command/args/env）
// 三者配合即可让 OpenSumi 在 Agentic Layout 里 spawn `omp acp` 并设为默认，无需改 node_modules。

export const OMP_AGENT_ID = "omp";
export const OMP_THEME_ID = "omp-web-app-light";

export type AgentProcessRegistration = {
	command: string;
	args: string[];
};

/**
 * 从构建期注入的环境变量（webpack DefinePlugin）解析 omp ACP agent 的可执行命令。
 * dev 默认 `bun <coding-agent>/src/cli.ts acp`；生产用 OMP_ACP_COMMAND=omp + OMP_ACP_ARGS='["acp"]' 覆盖。
 */
export function resolveOmpAgent(): AgentProcessRegistration {
	const command = process.env.OMP_ACP_COMMAND || "omp";
	const args = process.env.OMP_ACP_ARGS ? JSON.parse(process.env.OMP_ACP_ARGS) : ["acp"];
	return { command, args };
}
