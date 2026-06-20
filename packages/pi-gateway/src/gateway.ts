/**
 * Gateway core — orchestrates channels, sessions, agent bridge, and cron scheduler.
 *
 * The gateway is the central hub that:
 * 1. Manages channel connections (DingTalk, Feishu, etc.)
 * 2. Routes inbound messages to the appropriate agent session
 * 3. Bridges agent responses back to the originating channel
 * 4. Runs the cron scheduler for periodic tasks
 * 5. Delivers scheduled task results to configured channels
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { buildAgentSessionPath, ensureAgentDir, resolveAgentDir } from "@oh-my-pi/pi-coding-agent/skeleton";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import { AgentBridge, type AgentBridgeOptions } from "./agent-bridge";
import { DingTalkChannel } from "./channels/dingtalk";
import { ChannelRegistry } from "./channels/registry";
import { getDataDir, getDingTalkConfig, getEnabledChannels } from "./config";
import { SchedulerEngine } from "./scheduler/engine";
import { executeScheduledCommand } from "./scheduler/executor";
import { appendExecutionLog } from "./scheduler/execution-log";
import { SchedulerFileStore } from "./scheduler/file-store";
import { SchedulerDbStorage } from "./scheduler/storage";
import type { ScheduledTask } from "./scheduler/types";
import { DEFAULT_SCHEDULER_CONFIG, getSchedulerDbPath, getSchedulerDir } from "./scheduler/types";
import { findAgentSessionPath } from "./scheduler";
import { createCronTaskFromMessage } from "./scheduler/from-message";
import { type BridgeStat, type QueueStat, SessionManager } from "./session-manager";
import { SQLiteSessionStore } from "./session-store";
import type { DingtalkAccountConfig, GatewayConfig, InboundMessage, MessageContent, OutboundMessage } from "./types";

export function createAccountBridgeOptions(
	agentConfig: GatewayConfig["agent"],
	account: DingtalkAccountConfig,
	agentDir: string,
): AgentBridgeOptions {
	return {
		...agentConfig,
		model: account.model ?? agentConfig?.model,
		timeoutMs: account.timeoutMs ?? agentConfig?.timeoutMs,
		cwd: agentDir,
	};
}

const PID_FILE = "gateway.pid";
const STATUS_FILE = "gateway.status.json";

/**
 * Stop the running gateway daemon by PID file.
 * Sends SIGTERM first, then SIGKILL if still alive.
 * Kills orphan RPC child processes in case of hard kill.
 */
export async function stopGatewayDaemon(): Promise<boolean> {
	const dataDir = getDataDir();
	const pidPath = path.join(dataDir, PID_FILE);

	try {
		const pidText = await fs.readFile(pidPath, "utf-8");
		const pid = parseInt(pidText.trim(), 10);
		if (isNaN(pid) || pid <= 0) {
			return false;
		}

		// Check if process exists
		try {
			process.kill(pid, 0);
		} catch {
			// Process already dead
			await fs.unlink(pidPath).catch(() => {});
			return false;
		}

		// Kill orphan RPC children that might be left from previous hard kills
		await killOrphanRpcProcesses();

		// Send SIGTERM
		process.kill(pid, "SIGTERM");

		// Wait up to 5s for graceful shutdown
		for (let i = 0; i < 5; i++) {
			await Bun.sleep(1000);
			try {
				process.kill(pid, 0);
			} catch {
				await fs.unlink(pidPath).catch(() => {});
				return true;
			}
		}

		// Force kill main process + any remaining orphan children
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
		await killOrphanRpcProcesses();
		await fs.unlink(pidPath).catch(() => {});
		return true;
	} catch {
		return false;
	}
}

/** Read PID file, return PID or null */
async function readPidFile(pidPath: string): Promise<number | null> {
	try {
		const text = await fs.readFile(pidPath, "utf-8");
		const pid = parseInt(text.trim(), 10);
		if (!isNaN(pid) && pid > 0) return pid;
	} catch {}
	return null;
}

/** Kill orphaned omp --mode rpc processes (PPID=1) left from hard kills */
async function killOrphanRpcProcesses(): Promise<void> {
	try {
		const result = Bun.spawnSync(["ps", "-eo", "pid,ppid,comm"]);
		if (result.exitCode !== 0) return;
		const lines = result.stdout.toString().trim().split("\n");
		for (const line of lines) {
			const parts = line.trim().split(/\s+/);
			if (parts.length < 3) continue;
			const pid = parseInt(parts[0], 10);
			const ppid = parseInt(parts[1], 10);
			if (!isNaN(pid) && !isNaN(ppid) && ppid === 1 && parts[2] === "omp") {
				process.kill(pid, "SIGKILL");
			}
		}
	} catch {
		// Best-effort
	}
}

export interface GatewayDaemonStatus {
	running: boolean;
	pid?: number;
	startedAt?: string;
	stalePidFile?: boolean;
	channels?: Array<{ id: string; name: string; connected: boolean }>;
	accounts?: Array<{ accountId: string; channelConnected: boolean; bridgeRunning: boolean; agentDir?: string; bridgeState?: string }>;
	scheduler?: { running: boolean; taskCount: number };
}

export async function getGatewayStatus(config?: GatewayConfig): Promise<GatewayDaemonStatus> {
	const dataDir = getDataDir(config);
	const pidPath = path.join(dataDir, PID_FILE);
	const statusPath = path.join(dataDir, STATUS_FILE);

	// Try to read cached status file for channel/account info
	let cachedStatus: Partial<GatewayDaemonStatus> = {};
	try {
		const statusText = await fs.readFile(statusPath, "utf-8");
		cachedStatus = JSON.parse(statusText);
	} catch {
		// status file not available
	}

	try {
		const pidText = await fs.readFile(pidPath, "utf-8");
		const pid = parseInt(pidText.trim(), 10);
		if (isNaN(pid) || pid <= 0) {
			await fs.unlink(pidPath).catch(() => {});
			return { running: false, ...cachedStatus };
		}

		try {
			process.kill(pid, 0);
		} catch {
			await fs.unlink(pidPath).catch(() => {});
			return { running: false, stalePidFile: true, ...cachedStatus };
		}

		let startedAt: string | undefined;
		try {
			const stat = await fs.stat(pidPath);
			startedAt = stat.mtime.toLocaleString();
		} catch {
			// Best-effort
		}

		return { running: true, pid, startedAt, ...cachedStatus };
	} catch {
		return { running: false, ...cachedStatus };
	}
}

async function checkPidFile(dataDir: string, pidFile: string): Promise<boolean> {
	try {
		const pidText = await fs.readFile(path.join(dataDir, pidFile), "utf-8");
		const pid = parseInt(pidText.trim(), 10);
		if (!isNaN(pid) && pid > 0) {
			try {
				process.kill(pid, 0); // signal 0 = existence check only
				return true;
			} catch {
				return false;
			}
		}
	} catch {
		// PID file not found
	}
	return false;
}

// ---------------------------------------------------------------------------
// Send a message through a channel
// ---------------------------------------------------------------------------

/**
 * Send a message to a DingTalk channel.
 *
 * Two modes:
 * 1. Webhook (no options): uses stored session webhook from a prior inbound message.
 * 2. OAuth API (with userId or conversationId): obtains an OAuth token from
 *    DingTalk using the account's appKey/appSecret and sends proactively.
 *
 * Channel format: `dingtalk:<accountId>` (e.g. `dingtalk:hr`, `dingtalk:test`)
 *
 * @returns true on success, false on failure
 */
export async function sendToChannel(
	channelArg: string,
	message: string,
	options?: { userId?: string; conversationId?: string },
): Promise<boolean> {
	const parts = channelArg.split(":");
	const channelId = parts[0]!;
	const accountId = parts.slice(1).join(":") || "__default__";

	// If target info provided, use OAuth API (proactive send)
	if (options?.userId || options?.conversationId) {
		return sendViaOAuth(channelId, accountId, message, options);
	}

	// Otherwise, try webhook from stored session
	return sendViaWebhook(channelId, accountId, message);
}

async function sendViaWebhook(channelId: string, accountId: string, message: string): Promise<boolean> {
	const dataDir = getDataDir();
	const store = new SQLiteSessionStore(path.join(dataDir, "sessions.db"));

	try {
		const sessions = await store.getActiveSessions(channelId);
		const matched = sessions
			.filter(s => s.accountId === accountId && s.sessionWebhook)
			.sort((a, b) => b.updatedAt - a.updatedAt);

		if (matched.length === 0) {
			console.error(`No active session with webhook for "${channelId}:${accountId}".`);
			console.error("Either send a message to the bot first, or specify --user / --conversation.");
			return false;
		}

		const session = matched[0]!;
		console.log(`Sending to ${channelId}:${accountId} (conversation: ${session.conversationId})...`);

		const res = await fetch(session.sessionWebhook!, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				msgtype: "text",
				text: { content: message },
				conversationId: session.conversationId,
			}),
		});

		if (res.ok) {
			console.log("Message sent.");
			return true;
		}

		const errText = await res.text();
		console.error(`Send failed (${res.status}): ${errText}`);
		return false;
	} finally {
		store.close();
	}
}

async function getDingTalkToken(appKey: string, appSecret: string): Promise<string | undefined> {
	try {
		const res = await fetch("https://api.dingtalk.com/v1.0/oauth2/accessToken", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ appKey, appSecret }),
		});
		if (!res.ok) {
			const err = await res.text();
			console.error(`Failed to get DingTalk token: ${res.status} ${err}`);
			return undefined;
		}
		const data = (await res.json()) as { accessToken?: string };
		return data.accessToken;
	} catch (err) {
		console.error("Failed to get DingTalk token:", String(err));
		return undefined;
	}
}

async function sendViaOAuth(
	channelId: string,
	accountId: string,
	message: string,
	options: { userId?: string; conversationId?: string },
): Promise<boolean> {
	// Load config to get app credentials
	const { loadConfig } = await import("./config");
	const config = await loadConfig();
	const dtConfig = config.channels.dingtalk as
		| { accounts?: Record<string, { appKey: string; appSecret: string; robotCode?: string }>; appKey?: string; appSecret?: string; robotCode?: string }
		| undefined;

	if (!dtConfig) {
		console.error("DingTalk not configured.");
		return false;
	}

	// Resolve account credentials
	let appKey: string | undefined;
	let appSecret: string | undefined;
	let robotCode: string | undefined;

	if (dtConfig.accounts && dtConfig.accounts[accountId]) {
		const acct = dtConfig.accounts[accountId]!;
		appKey = acct.appKey;
		appSecret = acct.appSecret;
		robotCode = acct.robotCode ?? acct.appKey;
	} else {
		appKey = dtConfig.appKey;
		appSecret = dtConfig.appSecret;
		robotCode = dtConfig.robotCode ?? dtConfig.appKey;
	}

	if (!appKey || !appSecret) {
		console.error(`No credentials found for account "${accountId}".`);
		return false;
	}

	// Resolve secret references (e.g. $ALIBABA_API_KEY)
	if (appSecret.startsWith("$")) {
		const envVal = Bun.env[appSecret.slice(1)];
		if (envVal) appSecret = envVal;
	}

	console.log("Getting DingTalk access token...");
	const token = await getDingTalkToken(appKey, appSecret);
	if (!token) return false;

	const msgParam = JSON.stringify({ content: message });

	if (options.userId) {
		// Send to single chat
		console.log(`Sending to user "${options.userId}" via ${channelId}:${accountId}...`);
		const res = await fetch("https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-acs-dingtalk-access-token": token,
			},
			body: JSON.stringify({
				robotCode,
				userIds: [options.userId],
				msgKey: "sampleText",
				msgParam,
			}),
		});
		if (res.ok) {
			console.log("Message sent.");
			return true;
		}
		const err = await res.text();
		console.error(`Send failed (${res.status}): ${err}`);
		return false;
	}

	if (options.conversationId) {
		// Send to group
		console.log(`Sending to conversation "${options.conversationId}"...`);
		const res = await fetch("https://api.dingtalk.com/v1.0/robot/groupMessages/send", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-acs-dingtalk-access-token": token,
			},
			body: JSON.stringify({
				robotCode,
				openConversationId: options.conversationId,
				msgKey: "sampleText",
				msgParam,
			}),
		});
		if (res.ok) {
			console.log("Message sent.");
			return true;
		}
		const err = await res.text();
		console.error(`Send failed (${res.status}): ${err}`);
		return false;
	}

	return false;
}

export class Gateway {
	#config: GatewayConfig;
	#registry = new ChannelRegistry();
	#store: SQLiteSessionStore | null = null;
	#running = false;
	/** Default agent bridge for single-account mode */
	#bridge: AgentBridge;
	/** Per-account agent bridges for multi-agent mode */
	#accountBridges = new Map<string, AgentBridge>();
	#accountAgentDirs = new Map<string, string>();
	#sessionManager?: SessionManager;
	#schedulerEngine?: SchedulerEngine;
	#schedulerStorage?: SchedulerDbStorage;
	#schedulerFileStore?: SchedulerFileStore;
	#watchInterval?: NodeJS.Timeout;

	constructor(config: GatewayConfig) {
		this.#config = config;
		this.#bridge = new AgentBridge(config.agent ?? {});
	}

	async start(): Promise<void> {
		if (this.#running) {
			logger.warn("Gateway already running");
			return;
		}

		// Cross-process dedup: check PID file
		const dataDir = getDataDir(this.#config);
		const existingPid = await readPidFile(path.join(dataDir, PID_FILE));
		if (existingPid) {
			try {
				process.kill(existingPid, 0);
				logger.error("Gateway already running (PID " + existingPid + ")");
				return;
			} catch {
				// Stale PID file — will overwrite
			}
		}

		logger.debug("Starting gateway...");

		// Initialize session store
		this.#store = new SQLiteSessionStore(`${dataDir}/sessions.db`);

		// Register channels (handle multi-account DingTalk)
		const enabled = getEnabledChannels(this.#config);
		for (const { id } of enabled) {
			if (id === "dingtalk") {
				await this.#registerDingTalkChannels();
			}
			// Future: feishu, wechat, etc.
		}

		const hasDingTalkAccounts = Boolean(
			getDingTalkConfig(this.#config)?.accounts &&
				Object.keys(getDingTalkConfig(this.#config)?.accounts ?? {}).length > 0,
		);
		// Start default agent bridge only outside multi-account mode.
		if (!hasDingTalkAccounts) {
			try {
				await this.#bridge.start();
				logger.debug("Agent bridge started");
			} catch (err) {
				logger.error("Failed to start agent bridge", { error: String(err) });
			}
		}

		this.#sessionManager = new SessionManager({
			bridges: this.#accountBridges,
			defaultBridge: hasDingTalkAccounts ? undefined : this.#bridge,
		});

		await this.#registry.connectAll(async msg => this.#handleInboundMessage(msg));

		// Start cron scheduler
		await this.#startScheduler();

		this.#running = true;
		logger.debug("Gateway started");

		// Write PID file for cross-process status detection
		try {
			await fs.writeFile(path.join(getDataDir(this.#config), PID_FILE), String(process.pid));
			logger.debug("PID file written", { path: path.join(getDataDir(this.#config), PID_FILE), pid: process.pid });
		} catch (e) {
			logger.warn("Failed to write PID file", { error: String(e) });
		}

		await this.#writeStatusFile();
	}

	/**
	 * Register DingTalk channel(s). In multi-account mode, each account gets
	 * its own DingTalkChannel instance and account-specific AgentBridge.
	 */
	async #registerDingTalkChannels(): Promise<void> {
		const rawConfig = this.#config.channels.dingtalk;
		const dtConfig = getDingTalkConfig(this.#config);

		if (!dtConfig) {
			logger.warn("DingTalk config invalid, skipping");
			return;
		}

		// Multi-account mode
		if (dtConfig.accounts && Object.keys(dtConfig.accounts).length > 0) {
			for (const [accountId, account] of Object.entries(dtConfig.accounts)) {
				const channel = new DingTalkChannel();
				channel.setAccountId(accountId);

				const agentDir = resolveAgentDir(accountId, account.agentDir);
				this.#accountAgentDirs.set(accountId, agentDir);
				try {
					await ensureAgentDir(agentDir);
				} catch (err) {
					logger.error("Failed to initialize account agentDir", { accountId, agentDir, error: String(err) });
					continue;
				}

				// Create per-account agent bridge with account-specific config
				// Model is loaded from agentDir/.omp/config.yml by omp itself
				const bridge = new AgentBridge(createAccountBridgeOptions(this.#config.agent, account, agentDir));
				this.#accountBridges.set(accountId, bridge);

				// Start per-account bridge
				try {
					await bridge.start();
				} catch (err) {
					logger.error("Failed to start account bridge", { accountId, error: String(err) });
				}

				this.#registry.register(
					channel,
					{
						...rawConfig,
						appKey: account.appKey,
						appSecret: account.appSecret,
						robotCode: account.robotCode,
					},
					`dingtalk:${accountId}`,
				);
				logger.debug("Registered DingTalk account channel", { accountId });
			}
			return;
		}

		// Single-account mode (use legacy appKey/appSecret from config)
		const channel = new DingTalkChannel();
		this.#registry.register(channel, rawConfig);
	}

	async #addAccount(
		accountId: string,
		account: DingtalkAccountConfig,
		config: GatewayConfig,
	): Promise<void> {
		const rawConfig = config.channels.dingtalk;
		const channel = new DingTalkChannel();
		channel.setAccountId(accountId);

		const agentDir = resolveAgentDir(accountId, account.agentDir);
		this.#accountAgentDirs.set(accountId, agentDir);
		try {
			await ensureAgentDir(agentDir);
		} catch (err) {
			logger.error("Failed to initialize account agentDir", { accountId, agentDir, error: String(err) });
			return;
		}

		const bridge = new AgentBridge(createAccountBridgeOptions(config.agent, account, agentDir));
		this.#accountBridges.set(accountId, bridge);
		try {
			await bridge.start();
		} catch (err) {
			logger.error("Failed to start account bridge", { accountId, error: String(err) });
		}

		this.#registry.register(
			channel,
			{
				...rawConfig,
				appKey: account.appKey,
				appSecret: account.appSecret,
				robotCode: account.robotCode,
			},
			`dingtalk:${accountId}`,
		);
		logger.debug("Registered DingTalk account channel", { accountId });

		// Connect the new channel
		try {
			channel.onMessage(async msg => this.#handleInboundMessage(msg));
			await channel.connect({
				...rawConfig,
				appKey: account.appKey,
				appSecret: account.appSecret,
				robotCode: account.robotCode,
			});
			logger.debug("DingTalk account channel connected", { accountId });
		} catch (err) {
			logger.error("Failed to connect DingTalk account channel", { accountId, error: String(err) });
		}
	}

	#removeAccount(accountId: string): void {
		const channelKey = `dingtalk:${accountId}`;
		const channel = this.#registry.get(channelKey);
		if (channel) {
			channel.disconnect().catch(() => {});
		}
		this.#registry.unregister(channelKey);

		const bridge = this.#accountBridges.get(accountId);
		if (bridge) {
			bridge.stop();
		}
		this.#accountBridges.delete(accountId);
		this.#accountAgentDirs.delete(accountId);
		logger.debug("Removed DingTalk account", { accountId });
	}

	async stop(): Promise<void> {
		if (!this.#running) return;

		logger.debug("Stopping gateway...");

		await this.#registry.disconnectAll();
		this.#stopScheduler();

		const drained = await this.#sessionManager?.waitForAllDrained(30_000);
		if (drained === false) {
			logger.warn("Gateway shutdown timed out waiting for session queues", {
				queues: this.#sessionManager?.getQueueStats() ?? [],
			});
		}

		// Stop all per-account bridges
		for (const bridge of this.#accountBridges.values()) {
			bridge.stop();
		}
		this.#accountBridges.clear();

		// Stop default bridge
		this.#bridge.stop();

		this.#accountAgentDirs.clear();
		this.#sessionManager = undefined;
		this.#store?.close();
		this.#store = null;
		this.#running = false;
		logger.debug("Gateway stopped");

		// Remove PID file
		try {
			await fs.unlink(path.join(getDataDir(this.#config), PID_FILE));
		} catch {
			/* non-fatal */
		}
	}

	async reload(config: GatewayConfig): Promise<void> {
		// Snapshot old config for diff
		const oldDtConfig = getDingTalkConfig(this.#config);
		const oldAccounts = oldDtConfig?.accounts ? new Map(Object.entries(oldDtConfig.accounts)) : new Map();

		this.#config = config;

		// Reload scheduler config without full restart
		this.#stopScheduler();
		await this.#startScheduler();

		// Diff DingTalk accounts: add, remove, or update per-account channels
		const newDtConfig = getDingTalkConfig(config);
		const newAccounts = newDtConfig?.accounts ? new Map(Object.entries(newDtConfig.accounts)) : new Map();

		// Remove accounts no longer in config
		for (const [accountId] of oldAccounts) {
			if (!newAccounts.has(accountId)) {
				this.#removeAccount(accountId);
			}
		}

		// Add or update accounts
		for (const [accountId, account] of newAccounts) {
			if (!oldAccounts.has(accountId)) {
				await this.#addAccount(accountId, account, config);
			} else {
				// Account exists — update bridge options if changed
				const oldAccount = oldAccounts.get(accountId)!;
				if (
					oldAccount.appKey !== account.appKey ||
					oldAccount.appSecret !== account.appSecret ||
					oldAccount.robotCode !== account.robotCode ||
					oldAccount.agentDir !== account.agentDir
				) {
					this.#removeAccount(accountId);
					await this.#addAccount(accountId, account, config);
				}
			}
		}

		// Rebuild SessionManager with updated bridges
		const hasDingTalkAccounts = newAccounts.size > 0;
		if (hasDingTalkAccounts) {
			if (!hasDingTalkAccounts) {
				this.#bridge.stop();
			}
		}

		// Refresh session manager with current bridges
		this.#sessionManager = new SessionManager({
			bridges: this.#accountBridges,
			defaultBridge: hasDingTalkAccounts ? undefined : this.#bridge,
		});

		await this.#writeStatusFile();

		logger.debug("Gateway config reloaded");
	}

	get isRunning(): boolean {
		return this.#running;
	}

	/**
	 * Direct message for CLI interactive mode.
	 */
	async sendDirectMessage(text: string): Promise<string | null> {
		if (!this.#bridge.isRunning) {
			logger.warn("Agent bridge not running");
			return null;
		}

		const mockSession = {
			id: "cli-session",
			channelId: "cli",
			accountId: "__default__",
			userId: "cli-user",
			conversationId: "cli-conv",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			status: "active" as const,
		};

		const mockMessage = {
			channelId: "cli",
			userId: "cli-user",
			userName: "CLI User",
			conversationId: "cli-conv",
			isGroup: false,
			content: { type: "text" as const, text },
			timestamp: new Date(),
		};

		return await this.#bridge.forward(mockMessage, mockSession);
	}

	async #writeStatusFile(): Promise<void> {
		const dataDir = getDataDir(this.#config);
		const statusPath = path.join(dataDir, STATUS_FILE);
		try {
			const status = await this.getStatus();
			const data = JSON.stringify(
				{
					channels: status.channels,
					accounts: status.accounts,
					scheduler: status.scheduler,
				},
				null,
				2,
			);
			await fs.writeFile(statusPath, data);
		} catch {
			// non-fatal
		}
	}

	async getStatus(): Promise<{
		running: boolean;
		channels: Array<{ id: string; name: string; connected: boolean }>;
		accounts: Array<{ accountId: string; channelConnected: boolean; bridgeRunning: boolean; agentDir?: string; bridgeState?: string }>;
		sessions: number;
		queues: QueueStat[];
		bridges: BridgeStat[];
		scheduler: {
			running: boolean;
			taskCount: number;
		};
	}> {
		const channels = this.#registry.getAll().map(c => ({
			id: c.id,
			name: c.name,
			connected: c.isConnected(),
		}));

		const sessions = (await this.#store?.getActiveSessions()) ?? [];
		const bridgeStats = this.#sessionManager?.getBridgeStats() ?? [];
		const bridgeStatsByAccount = new Map(bridgeStats.map(stat => [stat.accountId, stat]));
		const accounts = Array.from(this.#accountBridges.entries()).map(([accountId, bridge]) => {
			const channel = this.#registry.get(`dingtalk:${accountId}`);
			return {
				accountId,
				channelConnected: channel?.isConnected() ?? false,
				bridgeRunning: bridge.isRunning,
				agentDir: this.#accountAgentDirs.get(accountId),
				bridgeState: bridgeStatsByAccount.get(accountId)?.state,
			};
		});

		return {
			running: this.#running || (await checkPidFile(getDataDir(this.#config), PID_FILE)),
			channels,
			sessions: sessions.length,
			accounts,
			queues: this.#sessionManager?.getQueueStats() ?? [],
			bridges: bridgeStats,
			scheduler: {
				running: this.#schedulerEngine != null,
				taskCount: this.#schedulerEngine?.getActiveTaskIds().length ?? 0,
			},
		};
	}

	// ═══════════════════════════════════════════════════════════════════
	// Scheduler
	// ═══════════════════════════════════════════════════════════════════

	async #startScheduler(): Promise<void> {
		const cronConfig = this.#config.cron;
		if (!cronConfig?.enabled) {
			logger.debug("Cron scheduler disabled in config");
			return;
		}

		const dbPath = getSchedulerDbPath();
		this.#schedulerStorage = new SchedulerDbStorage(dbPath);

		const taskDir = path.join(getSchedulerDir(), "tasks");
		this.#schedulerFileStore = new SchedulerFileStore(taskDir, this.#schedulerStorage);
		const syncResult = this.#schedulerFileStore.syncToDb();
		if (syncResult.added > 0 || syncResult.removed > 0 || syncResult.updated > 0) {
			logger.debug("File store initial sync", syncResult);
		}

		this.#schedulerEngine = new SchedulerEngine({
			storage: this.#schedulerStorage,
			onTrigger: this.#onCronTrigger.bind(this),
			config: {
				...DEFAULT_SCHEDULER_CONFIG,
				maxConcurrentRuns: cronConfig.maxConcurrentRuns ?? 3,
				taskDir,
			},
		});

		this.#schedulerEngine.start();

		// Reload tasks periodically to pick up file changes
		const tickMs = cronConfig.tickIntervalMs ?? 60_000;
		let tickCount = 0;
		this.#watchInterval = setInterval(() => {
			this.#schedulerFileStore?.syncToDb();
			this.#schedulerEngine?.reload();

			// Update status file so channel connection state is reflected
			this.#writeStatusFile();

			// Prune old executions every 10th tick (~10 min at default 60s)
			tickCount++;
			if (tickCount % 10 === 0 && this.#schedulerStorage) {
				this.#schedulerStorage.pruneExecutions(30, 100);
			}
		}, tickMs);

		logger.debug("Cron scheduler started", { taskCount: this.#schedulerEngine.getActiveTaskIds().length, tickMs });
	}

	#stopScheduler(): void {
		if (this.#watchInterval) {
			clearInterval(this.#watchInterval);
			this.#watchInterval = undefined;
		}
		this.#schedulerEngine?.stop();
		this.#schedulerEngine = undefined;
		this.#schedulerStorage?.close();
		this.#schedulerStorage = undefined;
		this.#schedulerFileStore = undefined;
	}

	async #onCronTrigger(task: ScheduledTask, executionId: string): Promise<void> {
		if (!this.#schedulerStorage) return;

		const startedAt = Date.now();
		const ompBinary = this.#config.agent?.ompPath ?? "omp";
		const { exitCode, output, stderr, timedOut } = await executeScheduledCommand(task.command, {
			taskType: task.taskType,
			timeoutMs: task.timeoutMs,
			ompBinary,
			skills: task.skills,
			preScript: task.preScript,
		});
		const endedAt = Date.now();
		const durationMs = endedAt - startedAt;

		// Link agent session trace for agent tasks
		const agentSessionPath =
			task.taskType === "agent" ? findAgentSessionPath(startedAt, endedAt) : undefined;

		// Record the execution result with full metadata
		this.#schedulerStorage.updateExecution(executionId, {
			status: exitCode === 0 ? "success" : "failure",
			exitCode,
			output: timedOut ? `[TIMED OUT after ${task.timeoutMs ?? 30_000}ms]\n${output}` : output,
			stderr: timedOut ? `[TIMED OUT]\n${stderr}` : stderr,
			endedAt,
			...(agentSessionPath ? { agentSessionPath } : {}),
		});

		// Write full stdout/stderr to JSONL log
		appendExecutionLog(task.name, {
			id: executionId,
			ts: endedAt,
			exitCode,
			status: exitCode === 0 ? "success" : "failure",
			durationMs,
			output,
			stderr,
		});

		// Deliver result to user if configured
		if (task.deliver && task.deliverUser) {
			const prefix = exitCode === 0 ? "✅" : timedOut ? "⏰" : "❌";
			const summary = `${prefix} Task "${task.name}" completed (exit ${exitCode}, ${durationMs}ms)\n\n${output.slice(0, 2000)}`;
			sendToChannel(task.deliver, summary, { userId: task.deliverUser }).catch(err =>
				logger.error("Failed to deliver cron result", { taskId: task.id, error: String(err) }),
			);
		}

		// Throw on failure so the engine's retry loop and statistics work.
		// The engine will overwrite status to "failure" again in its catch
		// block — that's harmless because the richer metadata is preserved.
		if (exitCode !== 0 || timedOut) {
			const msg = timedOut
				? `Task "${task.name}" timed out after ${task.timeoutMs ?? 30_000}ms`
				: `Task "${task.name}" failed (exit ${exitCode})`;
			logger.warn(msg, { taskId: task.id, exitCode, timedOut });
			throw new Error(msg);
		}

		logger.debug("Cron task succeeded", { taskId: task.id, taskName: task.name });
	}

	// ═══════════════════════════════════════════════════════════════════
	// Message Handling
	// ═══════════════════════════════════════════════════════════════════

	async #handleAbortMessage(msg: InboundMessage, accountId: string): Promise<boolean> {
		if (!this.#isAbortContent(msg.content)) return false;
		let aborted = false;
		try {
			aborted = (await this.#sessionManager?.abort(accountId)) ?? false;
		} catch (err) {
			logger.warn("Failed to abort agent turn", {
				accountId,
				conversationId: msg.conversationId,
				error: err instanceof Error ? err.message : String(err),
			});
		}
		await this.#sendAgentResponse(msg, aborted ? "已请求停止当前任务。" : "当前没有正在运行的任务。");
		return true;
	}

	#isAbortContent(content: MessageContent): boolean {
		const text =
			content.type === "text"
				? content.text
				: content.type === "markdown"
					? content.markdown
					: content.type === "voice"
						? (content.text ?? "")
						: "";
		const normalized = text.trim().toLowerCase();
		return (
			normalized === "停止" ||
			normalized === "取消" ||
			normalized === "中止" ||
			normalized === "abort" ||
			normalized === "cancel" ||
			normalized === "stop"
		);
	}

	async #sendAgentResponse(msg: InboundMessage, text: string): Promise<void> {
		const outbound: OutboundMessage = {
			channelId: msg.channelId,
			conversationId: msg.conversationId,
			content: { type: "text", text },
			sessionWebhook: msg.sessionWebhook,
			accountId: msg.accountId,
		};
		try {
			await this.#registry.sendMessage(outbound);
		} catch (err) {
			logger.error("Failed to send agent response", {
				accountId: msg.accountId,
				conversationId: msg.conversationId,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	async #handleInboundMessage(msg: InboundMessage): Promise<void> {
		logger.debug("Received message", {
			channel: msg.channelId,
			user: msg.userId,
			group: msg.isGroup ? msg.conversationTitle : "DM",
		});

		try {
			// Find or create session
			const accountId = msg.accountId ?? "__default__";
			if (await this.#handleAbortMessage(msg, accountId)) return;
			let session = await this.#store?.getSession(msg.channelId, accountId, msg.conversationId);
			const now = Date.now();
			if (!session && this.#store) {
				const sessionPath = this.#buildSessionPath(msg.channelId, accountId, msg.conversationId);
				session = await this.#store.createSession({
					channelId: msg.channelId,
					accountId,
					userId: msg.userId,
					conversationId: msg.conversationId,
					createdAt: now,
					updatedAt: now,
					ompSessionPath: sessionPath,
					sessionWebhook: msg.sessionWebhook,
					status: "active",
				});
			} else if (session && this.#store) {
				const sessionPath = this.#buildSessionPath(msg.channelId, accountId, msg.conversationId);
				if (session.ompSessionPath !== sessionPath) {
					if (session.ompSessionPath) {
						await this.#migrateSessionPath(session.ompSessionPath, sessionPath);
					}
					await this.#store.updateSession(session.id, { ompSessionPath: sessionPath, updatedAt: now, sessionWebhook: msg.sessionWebhook });
					session = { ...session, ompSessionPath: sessionPath, sessionWebhook: msg.sessionWebhook };
				} else {
					// Always update webhook so it stays fresh
					await this.#store.updateSession(session.id, { updatedAt: now, sessionWebhook: msg.sessionWebhook });
					session = { ...session, sessionWebhook: msg.sessionWebhook };
				}
			}

			if (!session) {
				logger.error("Failed to create session", {
					channelId: msg.channelId,
					accountId,
					conversationId: msg.conversationId,
				});
				return;
			}

			// Cron-creation intent: if the message is a /cron create
			// command, create the task in the owning account's
			// <agentDir>/cron/tasks/ directory and the global scheduler
			// DB, then reply with a confirmation. Skips the LLM agent
			// path entirely — cron creation is a deterministic operation
			// that doesn't need an LLM round-trip.
			const cronOutcome = this.#tryCreateCronFromMessage(msg, accountId);
			if (cronOutcome) {
				await this.#sendCronOutcomeReply(msg, cronOutcome);
				if (this.#store && session) {
					await this.#store.updateSession(session.id, { updatedAt: Date.now() });
				}
				return;
			}

			// Send "processing" placeholder first. Failure here should not prevent agent processing.
			const placeholder: OutboundMessage = {
				channelId: msg.channelId,
				conversationId: msg.conversationId,
				content: { type: "markdown", markdown: "thinking..." },
				sessionWebhook: msg.sessionWebhook,
				accountId: msg.accountId,
			};
			try {
				await this.#registry.sendMessage(placeholder);
			} catch (err) {
				logger.warn("Failed to send processing placeholder", {
					accountId,
					conversationId: msg.conversationId,
					error: err instanceof Error ? err.message : String(err),
				});
			}

			// Queue and forward to the account bridge
			const response = await this.#sessionManager?.enqueue(msg, session);

			// Send final response
			if (response) {
				await this.#sendAgentResponse(msg, response);
			}

			// Update session timestamp
			if (this.#store && session) {
				await this.#store.updateSession(session.id, { updatedAt: Date.now() });
			}
		} catch (err) {
			logger.error("Failed to handle message", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	#buildSessionPath(channelId: string, accountId: string, conversationId: string): string {
		const safeId = conversationId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
		const agentDir = this.#accountAgentDirs.get(accountId);
		if (agentDir) {
			return buildAgentSessionPath(agentDir, conversationId);
		}
		const dataDir = getDataDir(this.#config);
		return path.join(dataDir, "sessions", channelId, accountId, `${safeId}.jsonl`);
	}

	async #migrateSessionPath(fromPath: string, toPath: string): Promise<void> {
		if (fromPath === toPath) return;
		try {
			await fs.mkdir(path.dirname(toPath), { recursive: true });
			await fs.rename(fromPath, toPath);
			logger.debug("Migrated gateway session path", { fromPath, toPath });
		} catch (err) {
			if (isEnoent(err)) {
				logger.debug("Session path migration skipped because old path is missing", { fromPath, toPath });
				return;
			}
			throw err;
		}
	}

	/**
	 * Extract plain text from an inbound message's content union.
	 * Returns the empty string for non-text content types (image,
	 * etc.) so the cron-intent parser sees a clean signal.
	 */
	#extractMessageText(msg: InboundMessage): string {
		const c = msg.content;
		if (c.type === "text") return c.text;
		if (c.type === "markdown") return c.markdown;
		if (c.type === "voice") return c.text ?? "";
		return "";
	}

	/**
	 * Try to create a cron task from the inbound message text.
	 * Returns the outcome (success or error) so the caller can
	 * decide how to reply. Non-cron messages return undefined so
	 * the normal LLM path takes over.
	 */
	#tryCreateCronFromMessage(
		msg: InboundMessage,
		accountId: string,
	): ReturnType<typeof createCronTaskFromMessage> | undefined {
		const text = this.#extractMessageText(msg);
		// Fast path: if the message doesn't even start with the
		// /cron create prefix, skip the parse + storage work entirely.
		if (!text.trimStart().startsWith("/cron create")) return undefined;
		if (!this.#schedulerStorage) {
			logger.warn("Cron creation requested but scheduler storage is not initialised");
			return {
				ok: false,
				error: { reason: "db-failed", detail: "scheduler storage not initialised" },
			};
		}
		return createCronTaskFromMessage(text, msg.accountId ?? accountId, this.#config, this.#schedulerStorage);
	}

	/**
	 * Reply to the user with the outcome of a cron-creation attempt.
	 * Uses the same sessionWebhook the channel registered, so the
	 * reply lands in the right DingTalk conversation.
	 */
	async #sendCronOutcomeReply(
		msg: InboundMessage,
		outcome: ReturnType<typeof createCronTaskFromMessage>,
	): Promise<void> {
		if (!outcome) return;
		const lines: string[] = [];
		if (outcome.ok) {
			const r = outcome.result;
			lines.push(`Task "${r.name}" created.`);
			lines.push(`  Schedule: ${r.schedule}`);
			lines.push(`  Command: ${r.command}`);
			lines.push(`  Type: ${r.type}`);
			lines.push(`  File: ${r.filePath}`);
		} else {
			const e = outcome.error;
			lines.push(`Failed to create task: ${e.reason}`);
			if (e.detail) lines.push(`  ${e.detail}`);
			if (e.reason === "not-cron-intent") {
				// Don't surface a confusing error for ordinary chat messages;
				// the LLM path will handle them.
				return;
			}
		}
		const outbound: OutboundMessage = {
			channelId: msg.channelId,
			conversationId: msg.conversationId,
			content: { type: "markdown", markdown: lines.join("\n") },
			sessionWebhook: msg.sessionWebhook,
			accountId: msg.accountId,
		};
		try {
			await this.#registry.sendMessage(outbound);
		} catch (err) {
			logger.error("Failed to send cron-creation reply", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
}
