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
	deniedTools: z.array(z.string()).optional(),
	/** Legacy fallback only — prefer `<agentDir>/.omp/config.yml`. */
	hideThinkingBlock: z.boolean().default(false),
	enabled: z.boolean().default(true),
});

const permissionPolicySchema = z.enum(["open", "allowlist", "closed"]).default("allowlist");

export const dingtalkConfigSchema = channelConfigSchema.extend({
	appKey: z.string().min(1).optional(),
	appSecret: z.string().min(1).optional(),
	robotCode: z.string().optional(),
	accounts: z.record(z.string(), dingtalkAccountConfigSchema).optional(),
	dmPolicy: permissionPolicySchema.optional(),
	groupPolicy: permissionPolicySchema.optional(),
});

const agentConfigSchema = z.object({
	ompPath: z.string().optional(),
	maxConcurrentSessions: z.number().int().positive().optional(),
	maxCrashRetries: z.number().int().positive().optional(),
	crashBackoffMs: z.number().int().positive().optional(),
	/** Long-running tool threshold (ms): first onLongTask fire at this
	 *  point, plus a "停止" stop button pushed to the DingTalk AI Card.
	 *  0 disables. Default 50_000 (5x margin over the 10s streaming poll
	 *  and well below the 120s inactivity default). */
	longTaskThresholdMs: z.number().int().nonnegative().optional(),
	/** Long-running tool progress ping (ms): how often the gateway pushes
	 *  a "⏳ Xm Ys" progress block to the DingTalk card after the
	 *  threshold fires. Each ping also resets the inactivity watchdog
	 *  so the prompt isn't killed mid-pip-install. Default 60_000
	 *  (2x margin over the inactivity watchdog — see prompt-queue.ts). */
	progressPingIntervalMs: z.number().int().positive().optional(),
});

const sessionConfigSchema = z.object({
	idleTimeoutMinutes: z.number().int().positive().optional(),
	resetPolicy: z.enum(["none", "daily", "idle", "both"]).optional(),
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
	// Channels are intentionally typed `z.record(z.string(), z.any())` so that
	// `loadConfig` can read configs that contain unknown / older channel keys
	// without dropping user data on parse failure (loadConfig's catch falls
	// back to DEFAULT_CONFIG — the gateway must still boot). Per-channel
	// strictness is applied at WRITE time by the setup wizard via
	// `validateAndNormalizeConfig` (which calls `dingtalkConfigSchema.parse`
	// separately on the merged payload before saving). Don't tighten this
	// schema's channel rule without coordinating with loadConfig's error
	// handling.
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
		idleTimeoutMinutes: 240,
		resetPolicy: "both",
		dailyResetHour: 2,
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
 * Validate an in-memory config object and return the normalized form.
 *
 * Throws ZodError on schema violation — the caller is expected to surface
 * the issue (e.g. setup wizard: refuse to write a config that the gateway
 * would refuse to load). The default-merge mirrors {@link loadConfig} so
 * both paths return the same shape.
 *
 * Per-channel strictness (e.g. dingtalk `accounts.<id>.appKey` non-empty) is
 * applied here even though {@link loadConfig} is intentionally loose on
 * `channels` — loadConfig must read user-edited configs without dropping
 * data, but the wizard's WRITE path should refuse to produce invalid
 * payloads. See the comment on `gatewayConfigSchema.channels` for the
 * reasoning.
 *
 * Exists so callers that build a config programmatically (e.g. the
 * `omp gateway setup` wizard) can validate before writing to disk.
 */
export function validateAndNormalizeConfig(raw: unknown): GatewayConfig {
	const validated = gatewayConfigSchema.parse(raw);

	// Strict per-channel validation at write time. The top-level
	// `gatewayConfigSchema` keeps `channels` as `z.any()` for forward
	// compatibility (loadConfig's read path), but anything we generate
	// here must be a well-typed DingTalkConfig if it's labeled "dingtalk".
	const channels = validated.channels as Record<string, unknown> | undefined;
	const dt = channels?.dingtalk;
	if (dt !== undefined) {
		dingtalkConfigSchema.parse(dt);
	}

	return {
		...DEFAULT_CONFIG,
		...validated,
		agent: { ...DEFAULT_CONFIG.agent, ...validated.agent },
		session: { ...DEFAULT_CONFIG.session, ...validated.session },
		cron: { ...DEFAULT_CONFIG.cron, ...validated.cron },
	};
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

export async function validateConfig(configPath?: string): Promise<ConfigValidation>;
export async function validateConfig(_configPath: undefined, preloaded: GatewayConfig): Promise<ConfigValidation>;
export async function validateConfig(configPath?: string, preloaded?: GatewayConfig): Promise<ConfigValidation> {
	if (preloaded) {
		// Caller already has a parsed config (test fixtures, runDoctorWithConfig
		// when the config was constructed in-memory). Skip filesystem and run
		// the same schema + defaults merge the on-disk path performs.
		const result = gatewayConfigSchema.safeParse(preloaded);
		if (!result.success) {
			return {
				status: "schema-error",
				path: "<in-memory>",
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
		return { status: "ok", path: "<in-memory>", config };
	}
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
