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
import type { ChannelConfig, DingTalkConfig, GatewayConfig } from "./types";

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
	timeoutMs: z.number().int().positive().optional(),
});

const permissionPolicySchema = z.enum(["open", "allowlist", "closed"]).default("allowlist");

const dingtalkConfigSchema = channelConfigSchema.extend({
	appKey: z.string().min(1).optional(),
	appSecret: z.string().min(1).optional(),
	robotCode: z.string().optional(),
	accounts: z.record(z.string(), dingtalkAccountConfigSchema).optional(),
	dmPolicy: permissionPolicySchema.optional(),
	groupPolicy: permissionPolicySchema.optional(),
});

const agentConfigSchema = z.object({
	ompPath: z.string().optional(),
	timeoutMs: z.number().int().positive().optional(),
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

/**
 * Validate the gateway config file and report findings WITHOUT swallowing
 * errors the way {@link loadConfig} does. `loadConfig` deliberately falls back
 * to DEFAULT_CONFIG on any parse/validation failure so the gateway can still
 * boot; that is the right behavior for the daemon but it hides real problems
 * from the operator. `gateway doctor` calls this instead to surface the truth:
 * a missing file, malformed JSON5, or a schema violation each produce a
 * distinct, actionable result.
 */
export type ConfigValidation =
	| { status: "missing"; path: string }
	| { status: "parse-error"; path: string; error: string }
	| { status: "schema-error"; path: string; issues: Array<{ path: string; message: string }> }
	| { status: "ok"; path: string; config: GatewayConfig };

export async function validateConfig(configPath?: string): Promise<ConfigValidation> {
	const filePath = configPath ?? getConfigPath();
	let raw: string;
	try {
		raw = await Bun.file(filePath).text();
	} catch (err) {
		if (isEnoent(err)) return { status: "missing", path: filePath };
		return { status: "parse-error", path: filePath, error: err instanceof Error ? err.message : String(err) };
	}

	let parsed: unknown;
	try {
		parsed = Bun.JSON5.parse(raw);
	} catch (err) {
		return { status: "parse-error", path: filePath, error: err instanceof Error ? err.message : String(err) };
	}

	const result = gatewayConfigSchema.safeParse(parsed);
	if (!result.success) {
		return {
			status: "schema-error",
			path: filePath,
			issues: result.error.issues.map(i => ({ path: i.path.join(".") || "(root)", message: i.message })),
		};
	}

	const config: GatewayConfig = {
		...DEFAULT_CONFIG,
		...result.data,
		agent: { ...DEFAULT_CONFIG.agent, ...result.data.agent },
		session: { ...DEFAULT_CONFIG.session, ...result.data.session },
		cron: { ...DEFAULT_CONFIG.cron, ...result.data.cron },
	};
	return { status: "ok", path: filePath, config };
}

// ═══════════════════════════════════════════════════════════════════════
// Channel Config Helpers
// ═══════════════════════════════════════════════════════════════════════

function resolveSecret(value: string, label: string): string | null {
	if (!value.startsWith("$")) return value;
	const envName = value.slice(1);
	const resolved = process.env[envName];
	if (!resolved) {
		logger.warn("DingTalk secret env var is not set", { secret: value, label });
		return null;
	}
	return resolved;
}

function resolveDingTalkSecrets(config: DingTalkConfig): DingTalkConfig | null {
	const resolved: DingTalkConfig = { ...config };
	if (resolved.appSecret) {
		const secret = resolveSecret(resolved.appSecret, "dingtalk.appSecret");
		if (!secret) return null;
		resolved.appSecret = secret;
	}
	if (resolved.accounts) {
		resolved.accounts = { ...resolved.accounts };
		for (const [accountId, account] of Object.entries(resolved.accounts)) {
			const secret = resolveSecret(account.appSecret, `dingtalk.accounts.${accountId}.appSecret`);
			if (!secret) return null;
			resolved.accounts[accountId] = { ...account, appSecret: secret };
		}
	}
	return resolved;
}

export function getDingTalkConfig(config: GatewayConfig): DingTalkConfig | null {
	const raw = config.channels.dingtalk;
	if (!raw) return null;

	try {
		const parsed = dingtalkConfigSchema.parse(raw) as DingTalkConfig;
		const resolved = resolveDingTalkSecrets(parsed);
		if (!resolved) return null;
		if (resolved.accounts && Object.keys(resolved.accounts).length > 0) {
			for (const [accountId, account] of Object.entries(resolved.accounts)) {
				if (!account.appKey || !account.appSecret) {
					logger.warn("Invalid DingTalk account config", { accountId, error: "missing appKey or appSecret" });
					return null;
				}
			}
		}
		return resolved;
	} catch (err) {
		logger.warn("Invalid DingTalk config, skipping");
		if (err instanceof z.ZodError) {
			logger.debug("Validation errors", { issues: err.issues });
		}
		return null;
	}
}

export function getEnabledChannels(config: GatewayConfig): Array<{ id: string; config: ChannelConfig }> {
	const result: Array<{ id: string; config: ChannelConfig }> = [];

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
