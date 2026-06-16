/**
 * Gateway configuration loading and validation.
 *
 * Loads from ~/.pi/gateway.json with sensible defaults.
 * Extended with cron scheduler and heartbeat configuration
 * for the unified gateway architecture.
 */

import * as os from "node:os";
import * as path from "node:path";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import { z } from "zod";
import type { GatewayConfig } from "./types";

// ═══════════════════════════════════════════════════════════════════════
// Schema
// ═══════════════════════════════════════════════════════════════════════

const channelConfigSchema = z.object({
	enabled: z.boolean().default(false),
	allowedUsers: z.array(z.string()).optional(),
	allowedGroups: z.array(z.string()).optional(),
});

const dingtalkAccountConfigSchema = z.object({
	appKey: z.string().min(1),
	appSecret: z.string().min(1),
	robotCode: z.string().optional(),
	agentDir: z.string().optional(),
	model: z.string().optional(),
});

const permissionPolicySchema = z.enum(["open", "allowlist", "closed"]).default("allowlist");

const dingtalkConfigSchema = channelConfigSchema.extend({
	appKey: z.string().min(1),
	appSecret: z.string().min(1),
	robotCode: z.string().optional(),
	accounts: z.array(dingtalkAccountConfigSchema).optional(),
	dmPolicy: permissionPolicySchema.optional(),
	groupPolicy: permissionPolicySchema.optional(),
});

const agentConfigSchema = z.object({
	ompPath: z.string().optional(),
	model: z.string().optional(),
	maxConcurrentSessions: z.number().int().positive().optional(),
	maxCrashRetries: z.number().int().positive().optional(),
	crashBackoffMs: z.number().int().positive().optional(),
});

const sessionConfigSchema = z.object({
	idleTimeoutMinutes: z.number().int().positive().optional(),
	resetPolicy: z.enum(["none", "daily", "idle"]).optional(),
	dailyResetHour: z.number().int().min(0).max(23).optional(),
});

const heartbeatConfigSchema = z.object({
	enabled: z.boolean().default(true),
	every: z.string().default("30m"),
	prompt: z.string().default("Check what's new and report any important updates."),
	deliver: z.string().optional(),
});

const cronConfigSchema = z.object({
	enabled: z.boolean().default(true),
	tickIntervalMs: z.number().int().positive().default(60_000),
	maxConcurrentRuns: z.number().int().positive().default(3),
	heartbeat: heartbeatConfigSchema.optional(),
});

const gatewayConfigSchema = z.object({
	channels: z.record(z.string(), z.any()).default({}),
	agent: agentConfigSchema.optional(),
	session: sessionConfigSchema.optional(),
	cron: cronConfigSchema.optional(),
	dataDir: z.string().optional(),
});

// ═══════════════════════════════════════════════════════════════════════
// Defaults
// ═══════════════════════════════════════════════════════════════════════

const DEFAULT_CONFIG: GatewayConfig = {
	channels: {},
	agent: {
		ompPath: "omp",
		maxConcurrentSessions: 3,
	},
	session: {
		idleTimeoutMinutes: 60,
		resetPolicy: "idle",
	},
	cron: {
		enabled: true,
		tickIntervalMs: 60_000,
		maxConcurrentRuns: 3,
	},
};

// ═══════════════════════════════════════════════════════════════════════
// Config Path Resolution
// ═══════════════════════════════════════════════════════════════════════

export function getConfigPath(): string {
	return path.join(os.homedir(), ".omp", "gateway.json");
}

export function getDataDir(config?: GatewayConfig): string {
	if (config?.dataDir) return config.dataDir;
	return path.join(os.homedir(), ".omp", "gateway-data");
}

// ═══════════════════════════════════════════════════════════════════════
// Config Loading
// ═══════════════════════════════════════════════════════════════════════

export async function loadConfig(configPath?: string): Promise<GatewayConfig> {
	const filePath = configPath ?? getConfigPath();

	try {
		const raw = await Bun.file(filePath).text();
		const parsed = Bun.JSON5.parse(raw);
		const validated = gatewayConfigSchema.parse(parsed);

		return {
			...DEFAULT_CONFIG,
			...validated,
			agent: { ...DEFAULT_CONFIG.agent, ...validated.agent },
			session: { ...DEFAULT_CONFIG.session, ...validated.session },
			cron: { ...DEFAULT_CONFIG.cron, ...validated.cron },
		};
	} catch (err) {
		if (isEnoent(err)) {
			logger.debug("No gateway config found, using defaults", { path: filePath });
			return DEFAULT_CONFIG;
		}
		if (err instanceof Error) {
			logger.error("Failed to parse gateway config", { path: filePath, error: err.message });
		}
		return DEFAULT_CONFIG;
	}
}

// ═══════════════════════════════════════════════════════════════════════
// Channel Config Helpers
// ═══════════════════════════════════════════════════════════════════════

export function getDingTalkConfig(config: GatewayConfig): import("./types").DingTalkConfig | null {
	const raw = config.channels.dingtalk;
	if (!raw) return null;

	try {
		const parsed = dingtalkConfigSchema.parse(raw);
		if (parsed.accounts && parsed.accounts.length > 0) {
			for (const account of parsed.accounts) {
				if (!account.appKey || !account.appSecret) {
					logger.warn("Invalid DingTalk account config: missing appKey or appSecret");
					return null;
				}
			}
		}
		return parsed as import("./types").DingTalkConfig;
	} catch (err) {
		logger.warn("Invalid DingTalk config, skipping");
		if (err instanceof z.ZodError) {
			logger.debug("Validation errors", { issues: err.issues });
		}
		return null;
	}
}

export function getEnabledChannels(
	config: GatewayConfig,
): Array<{ id: string; config: import("./types").ChannelConfig }> {
	const result: Array<{ id: string; config: import("./types").ChannelConfig }> = [];

	for (const [id, raw] of Object.entries(config.channels)) {
		try {
			const parsed = channelConfigSchema.parse(raw);
			if (parsed.enabled) {
				result.push({ id, config: parsed });
			}
		} catch {
			logger.warn(`Invalid channel config for "${id}", skipping`);
		}
	}

	return result;
}

export type { GatewayConfig } from "./types";