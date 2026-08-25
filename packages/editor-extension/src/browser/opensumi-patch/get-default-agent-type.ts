/**
 * omp ACP agent 解析兜底（webpack alias 覆盖 @opensumi/ide-ai-native 的同名模块）。
 *
 * 背景：OpenSumi ai-native 的 `getDefaultAgentType` 在偏好解析失败时回退到内置
 * DEFAULT_AGENT_TYPE（qwen/claude-agent-acp），IDE 会尝试 spawn 不存在的可执行文件。
 * 本文件与原模块逻辑一致，但把兜底改为恒为 omp——偏好正常时走 defaultPreferences
 * 注册的 omp（三者齐备），偏好异常（用户存储/时序/scope 覆盖问题）时兜底仍指向 omp。
 */
import type { PreferenceService } from "@opensumi/ide-core-browser";
import { type ACPAgentType, type AgentConfig, DEFAULT_AGENT_TYPE } from "@opensumi/ide-core-common";
import { AINativeSettingSectionsId } from "@opensumi/ide-core-common/lib/settings/ai-native";

import { OMP_AGENT_ID, resolveOmpAgent } from "../agent-config";

const OMP_REGISTRATION = resolveOmpAgent();

export const DEFAULT_AGENT_CONFIGS: Record<string, AgentConfig> = {
	qwen: {
		command: "qwen",
		args: ["--acp", "--channel=ACP", "--input-format=stream-json", "--output-format=stream-json"],
		streaming: true,
		description: "Qwen CLI Agent",
	},
	"claude-agent-acp": {
		command: "claude-agent-acp",
		args: [],
		streaming: true,
		description: "Claude Code ACP Agent",
	},
	// omp 恒可用：与 defaultPreferences 注册的 configs 同源（构建期注入 command/args）。
	[OMP_AGENT_ID]: {
		command: OMP_REGISTRATION.command,
		args: OMP_REGISTRATION.args,
		streaming: true,
		description: "OMP Agent (oh-my-pi)",
	},
};

function getUserAgentConfigs(preferenceService: PreferenceService): Record<string, AgentConfig> {
	const configs = preferenceService.get<Record<string, AgentConfig>>(AINativeSettingSectionsId.AgentConfigs, {});
	return configs && typeof configs === "object" && !Array.isArray(configs) ? configs : {};
}

function hasCommand(config: AgentConfig | undefined): config is AgentConfig {
	return typeof config?.command === "string" && config.command.trim().length > 0;
}

export function getConfiguredAgentConfigs(preferenceService: PreferenceService): Record<string, AgentConfig> {
	return Object.fromEntries(
		Object.entries(getUserAgentConfigs(preferenceService)).filter(([, config]) => hasCommand(config)),
	);
}

export function getAvailableAgentConfigs(preferenceService: PreferenceService): Record<string, AgentConfig> {
	const userConfigs = getUserAgentConfigs(preferenceService);
	const mergedConfigs: Record<string, AgentConfig> = {};

	for (const [agentType, defaultConfig] of Object.entries(DEFAULT_AGENT_CONFIGS)) {
		const mergedConfig = {
			...defaultConfig,
			...(userConfigs[agentType] || {}),
		};
		mergedConfigs[agentType] = hasCommand(mergedConfig) ? mergedConfig : defaultConfig;
	}

	for (const [agentType, config] of Object.entries(userConfigs)) {
		if (!mergedConfigs[agentType] && hasCommand(config)) {
			mergedConfigs[agentType] = config;
		}
	}

	return mergedConfigs;
}

/**
 * 默认 agent 类型：偏好指定且可用 → 用偏好值；否则兜底 omp（原实现兜底
 * DEFAULT_AGENT_TYPE=qwen/claude-agent-acp，那些可执行文件在本环境不存在）。
 */
export function getDefaultAgentType(preferenceService: PreferenceService): ACPAgentType {
	const agentType = preferenceService.get<ACPAgentType>(
		AINativeSettingSectionsId.DefaultAgentType,
		DEFAULT_AGENT_TYPE,
	);
	const configs = getAvailableAgentConfigs(preferenceService);
	return configs[agentType] ? agentType : OMP_AGENT_ID;
}

export function getAgentConfig(preferenceService: PreferenceService, agentType: ACPAgentType): AgentConfig {
	const configs = getAvailableAgentConfigs(preferenceService);
	return configs[agentType] || DEFAULT_AGENT_CONFIGS[OMP_AGENT_ID];
}
