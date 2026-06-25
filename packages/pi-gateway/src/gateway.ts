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
import {
	buildAgentSessionPath,
	ensureAgentDir,
	registerAgent,
	resolveAgentDir,
} from "@oh-my-pi/pi-coding-agent/skeleton";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import { ActionRegistry } from "./action-registry";
import { AgentBridge, type AgentBridgeOptions } from "./agent-bridge";
import { type DingTalkCardActionEvent, DingTalkChannel } from "./channels/dingtalk";
import { ChannelRegistry } from "./channels/registry";
import { getDataDir, getDingTalkConfig, getEnabledChannels } from "./config";
import { extractModelSwitchArg, fuzzyMatchModel, type MatchableModel } from "./model-switch";
import { CronService } from "./scheduler/cron-service";
import { SchedulerEngine } from "./scheduler/engine";
import { computeInactivityBudgetMs } from "./scheduler/executor";
import { SchedulerFileStore } from "./scheduler/file-store";
import { createCronTaskFromMessage } from "./scheduler/from-message";
import { SchedulerDbStorage } from "./scheduler/storage";
import type { ScheduledTask } from "./scheduler/types";
import { DEFAULT_SCHEDULER_CONFIG, getSchedulerDbPath, getSchedulerDir } from "./scheduler/types";
import { type BridgeStat, type QueueStat, SessionManager } from "./session-manager";
import { SQLiteSessionStore } from "./session-store";
import type {
	AgentResponseMeta,
	Channel,
	ChannelHealth,
	DingtalkAccountConfig,
	ForwardStreamHandlers,
	GatewayConfig,
	InboundMessage,
	MessageContent,
	OutboundMessage,
	ReplyFormatterContext,
	SessionRecord,
} from "./types";

function formatModelNumber(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
	return String(n);
}

/**
 * Build the registry key for a channel lookup. Multi-account mode
 * keys channels as `<channelId>:<accountId>` (see `registerDingTalk`
 * and the matching `sendMessage` path in `ChannelRegistry`); single-
 * account mode uses just `<channelId>`. The inbound message's
 * `accountId` is set by `parseRobotMessage` to the channel instance's
 * `accountId` at inbound time, so multi-account inbound always has it.
 */
export function buildChannelKey(channelId: string, accountId?: string): string {
	return accountId ? `${channelId}:${accountId}` : channelId;
}
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
		deniedTools: account.deniedTools,
	};
}

export const PID_FILE = "gateway.pid";
export const STATUS_FILE = "gateway.status.json";

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
		if (Number.isNaN(pid) || pid <= 0) {
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
		if (!Number.isNaN(pid) && pid > 0) return pid;
	} catch {}
	return null;
}

/** Kill orphaned omp --mode rpc processes (PPID=1) left from hard kills.
 *
 * Matches on the full command line (`args`) to ensure only `--mode rpc`
 * processes are killed — not interactive omp sessions, not omp processes
 * started by other gateways or users.
 */
export async function killOrphanRpcProcesses(): Promise<void> {
	try {
		const result = Bun.spawnSync(["ps", "-eo", "pid,ppid,args"]);
		if (result.exitCode !== 0) return;
		const lines = result.stdout.toString().trim().split("\n");
		for (const line of lines) {
			const parts = line.trim().split(/\s+/);
			if (parts.length < 3) continue;
			const pid = parseInt(parts[0], 10);
			const ppid = parseInt(parts[1], 10);
			const args = parts.slice(2).join(" ");
			if (
				!Number.isNaN(pid) &&
				!Number.isNaN(ppid) &&
				ppid === 1 &&
				args.includes("omp") &&
				args.includes("--mode rpc")
			) {
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
	/** Epoch ms when the status file was last written (staleness check for doctor). */
	statusWrittenAt?: number;
	channels?: Array<{ id: string; name: string; connected: boolean }>;
	accounts?: Array<{
		accountId: string;
		channelConnected: boolean;
		bridgeRunning: boolean;
		agentDir?: string;
		bridgeState?: string;
		/** Deep channel health, present when the channel exposes getHealth(). */
		channelHealth?: ChannelHealth;
	}>;
	/** Per-account agent-bridge snapshots (circuit/crash/lifecycle). */
	bridges?: BridgeStat[];
	/** Per-account inbound queue depth/age. */
	queues?: QueueStat[];
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
		if (Number.isNaN(pid) || pid <= 0) {
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
		if (!Number.isNaN(pid) && pid > 0) {
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
// Channel message delivery is now handled by DingTalkChannel.sendMessage
// (three routes: sessionWebhook, OAuth DM, OAuth group) and CronService
// via the injected deliver function. The old sendToChannel / sendViaOAuth /
// sendViaWebhook / deliverWithRetry / getDingTalkToken functions have been
// removed as part of the cron-gateway decoupling.

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
	#cronService?: CronService;
	#watchInterval?: NodeJS.Timeout;
	/** Periodic health check: restart bridges stuck in circuit-open. */
	#healthInterval?: NodeJS.Timeout;
	/** Maps accountId → epoch ms of last circuit-open restart (anti-storm). */
	#circuitRestartCooldown = new Map<string, number>();
	/**
	 * Maps DingTalk AI Card instance IDs to the session / bridge that
	 * owns the card, so a TOPIC_CARD action callback (user clicked a
	 * button) can be routed back to the right bridge. Populated by
	 * the channel's `streamCard` (via the `registerCardAction` context
	 * callback) and consulted by `#handleCardAction`. Entries auto-expire
	 * after 30 min so a stale card action can't accidentally abort a
	 * fresh prompt.
	 */
	#actionRegistry = new ActionRegistry();

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
				logger.error(`Gateway already running (PID ${existingPid})`);
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

		// Prune expired card-action entries every 5 min so the registry
		// doesn't grow unbounded. The registry is bounded by the rate
		// of new cards (~1 per inbound message) so a 5 min cadence is
		// plenty.
	setInterval(() => this.#actionRegistry.expire(), 5 * 60_000).unref?.();

		// Health check: every 60s, if a bridge's circuit breaker has been
		// open for more than 5 minutes, restart it. Prevents a permanently
		// stuck bridge from silently swallowing all messages.
		this.#healthInterval = setInterval(() => this.#checkBridgeHealth(), 60_000).unref?.();

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
				// Register so `omp agent list` / `show` can discover gateway-created
				// agentDirs (mirrors `omp agent init`). Non-fatal: a failure here only
				// affects list visibility, not gateway operation.
				try {
					await registerAgent(accountId, agentDir);
				} catch (err) {
					logger.warn("Failed to register agentDir", { accountId, agentDir, error: String(err) });
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
				// Route card action callbacks (TOPIC_CARD) back to the
				// gateway's ActionRegistry, which looks up the card by
				// instance id and calls the right bridge's abort().
				channel.setCardActionHandler(event => this.#handleCardAction(event));
				logger.debug("Registered DingTalk account channel", { accountId });
			}
			return;
		}

		// Single-account mode (use legacy appKey/appSecret from config)
		const channel = new DingTalkChannel();
		channel.setCardActionHandler(event => this.#handleCardAction(event));
		this.#registry.register(channel, rawConfig);
	}

	async #addAccount(accountId: string, account: DingtalkAccountConfig, config: GatewayConfig): Promise<void> {
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
		// Register so `omp agent list` / `show` can discover gateway-created
		// agentDirs (mirrors `omp agent init`). Non-fatal: a failure here only
		// affects list visibility, not gateway operation.
		try {
			await registerAgent(accountId, agentDir);
		} catch (err) {
			logger.warn("Failed to register agentDir", { accountId, agentDir, error: String(err) });
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

		const warnings: string[] = [];

		// Phase 1: disconnect channels (5s grace)
		await Promise.race([
			this.#registry.disconnectAll().catch(err => {
				warnings.push(`channels: ${err instanceof Error ? err.message : String(err)}`);
			}),
			Bun.sleep(5_000).then(() => { warnings.push("channels: timeout after 5s"); }),
		]);

		// Phase 2: stop scheduler + health interval (5s grace)
		this.#stopScheduler();
		if (this.#healthInterval) {
			clearInterval(this.#healthInterval);
			this.#healthInterval = undefined;
		}

		// Phase 3: drain session queues (15s grace)
		const drained = await Promise.race([
			(this.#sessionManager?.waitForAllDrained(15_000) ?? Promise.resolve(true)),
			Bun.sleep(15_000).then(() => false),
		]);
		if (drained === false) {
			warnings.push("session-queues: timeout after 15s");
			logger.warn("Gateway shutdown timed out waiting for session queues", {
				queues: this.#sessionManager?.getQueueStats() ?? [],
			});
		}

		// Phase 4: stop all bridges (5s grace)
		await Promise.race([
			Promise.all([
				...Array.from(this.#accountBridges.values()).map(b => { try { b.stop(); } catch {} }),
				(() => { try { this.#bridge.stop(); } catch {} })(),
			]).then(() => {}),
			Bun.sleep(5_000).then(() => { warnings.push("bridges: timeout after 5s"); }),
		]);

		this.#accountBridges.clear();
		this.#accountAgentDirs.clear();
		this.#sessionManager = undefined;
		this.#store?.close();
		this.#store = null;
		this.#running = false;

		if (warnings.length > 0) {
			logger.warn("Gateway stopped with warnings", { warnings });
		} else {
			logger.debug("Gateway stopped");
		}

		// Remove PID file
		try {
			await fs.unlink(path.join(getDataDir(this.#config), PID_FILE));
		} catch {
			/* non-fatal */
		}
	}


	/**
	 * Periodic health check: if a bridge's circuit breaker has been open
	 * for more than CIRCUIT_OPEN_THRESHOLD_MS, restart the bridge to
	 * recover from a stuck state. A 10-minute cooldown per bridge prevents
	 * restart storms when the underlying problem persists.
	 */
	async #checkBridgeHealth(): Promise<void> {
		const CIRCUIT_OPEN_THRESHOLD_MS = 5 * 60_000;
		const RESTART_COOLDOWN_MS = 10 * 60_000;
		const now = Date.now();

		const checkOne = async (accountId: string, bridge: AgentBridge) => {
			const snapshot = bridge.getSnapshot();
			if (snapshot.circuitState !== "open") return;

			const openedAt = snapshot.circuitOpenedAt ?? 0;
			if (openedAt === 0 || now - openedAt < CIRCUIT_OPEN_THRESHOLD_MS) return;

			// Anti-storm: skip if we restarted this bridge recently.
			const lastRestart = this.#circuitRestartCooldown.get(accountId) ?? 0;
			if (now - lastRestart < RESTART_COOLDOWN_MS) return;

			logger.warn("Bridge circuit open too long, restarting", {
				accountId,
				circuitOpenedAt: openedAt,
				openDurationMs: now - openedAt,
			});
			this.#circuitRestartCooldown.set(accountId, now);

			try {
				bridge.stop();
				await bridge.start();
				logger.info("Bridge restarted after circuit-open recovery", { accountId });
			} catch (err) {
				logger.error("Failed to restart bridge after circuit-open", {
					accountId,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		};

		await Promise.all([
			...Array.from(this.#accountBridges.entries()).map(([id, b]) => checkOne(id, b)),
			this.#bridge.isRunning ? checkOne("__default__", this.#bridge) : Promise.resolve(),
		]);

		// Check channels for stale sockets: connected but no socket activity
		// for more than 10 minutes. The channel's own reconnect logic handles
		// disconnections; this catches 'connected but silent' states.
		const STALE_SOCKET_THRESHOLD_MS = 10 * 60_000;
		for (const channel of this.#registry.getAll()) {
			const health = channel.getHealth?.();
			if (!health || !health.connected) continue;

			const lastActivity = health.lastSocketAvailableAt || health.connectionEstablishedAt;
			if (lastActivity === 0) continue; // never connected, skip

			if (now - lastActivity > STALE_SOCKET_THRESHOLD_MS) {
				logger.warn("Channel stale socket detected", {
					channelId: channel.id,
					lastActivityMs: now - lastActivity,
					reconnectAttempts: health.reconnectAttempts,
					receivedCount: health.receivedCount,
				});
			}
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
	 *
	 * In single-account mode, routes to the default bridge.
	 * In multi-account mode, requires accountId to select the
	 * per-account bridge. If accountId is omitted in multi-account
	 * mode, returns a help string listing available accounts.
	 */
	async sendDirectMessage(text: string, accountId?: string): Promise<string | null> {
		const bridge = this.#resolveDirectBridge(accountId);
		if (!bridge) {
			if (this.#accountBridges.size > 0) {
				const ids = Array.from(this.#accountBridges.keys()).join(", ");
				return `请指定账号。可用账号: ${ids}\n用法: @账号名 消息内容 (如 @hr 你好)`;
			}
			logger.warn("Agent bridge not running");
			return null;
		}
		if (!bridge.isRunning) {
			logger.warn("Agent bridge not running", { accountId: accountId ?? "__default__" });
			return null;
		}

		const resolvedAccountId = accountId ?? "__default__";
		const agentDir = this.#accountAgentDirs.get(resolvedAccountId) ?? undefined;
		const conversationId = `cli-conv-${resolvedAccountId}`;
		const sessionPath = agentDir ? buildAgentSessionPath(agentDir, conversationId) : undefined;

		const mockSession: SessionRecord = {
			id: `cli-session-${resolvedAccountId}`,
			channelId: "cli",
			accountId: resolvedAccountId,
			userId: "cli-user",
			conversationId,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			ompSessionPath: sessionPath,
			status: "active",
		};

		const mockMessage: InboundMessage = {
			channelId: "cli",
			userId: "cli-user",
			userName: "CLI User",
			conversationId,
			isGroup: false,
			content: { type: "text", text },
			timestamp: new Date(),
		};

		return await bridge.forward(mockMessage, mockSession);
	}

	/**
	 * Resolve the correct AgentBridge for a direct (CLI) message.
	 *
	 * - accountId provided and matches an account bridge: return it.
	 * - No accountId, default bridge running: return default (single-account mode).
	 * - No accountId, multi-account mode: return null (user must specify).
	 */
	#resolveDirectBridge(accountId?: string): AgentBridge | null {
		if (accountId && this.#accountBridges.has(accountId)) {
			return this.#accountBridges.get(accountId)!;
		}
		if (!accountId && this.#accountBridges.size === 0 && this.#bridge.isRunning) {
			return this.#bridge;
		}
		return null;
	}

	/**
	 * Get an AgentBridge by accountId.
	 * Used by the cron scheduler to reuse the already-warm agent process
	 * for scheduled agent tasks instead of spawning a new omp --print.
	 */
	getAccountBridge(accountId: string): AgentBridge | undefined {
		if (this.#accountBridges.has(accountId)) {
			return this.#accountBridges.get(accountId);
		}
		// Fall back to default bridge if no per-account bridges exist
		if (this.#accountBridges.size === 0 && this.#bridge.isRunning) {
			return this.#bridge;
		}
		return undefined;
	}

	async #writeStatusFile(): Promise<void> {
		const dataDir = getDataDir(this.#config);
		const statusPath = path.join(dataDir, STATUS_FILE);
		try {
			const status = await this.getStatus();
			const data = JSON.stringify(
				{
					statusWrittenAt: Date.now(),
					channels: status.channels,
					accounts: status.accounts,
					bridges: status.bridges,
					queues: status.queues,
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
		accounts: Array<{
			accountId: string;
			channelConnected: boolean;
			bridgeRunning: boolean;
			agentDir?: string;
			bridgeState?: string;
			channelHealth?: ChannelHealth;
		}>;
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
				channelHealth: channel?.getHealth?.(),
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

		// Construct CronService with injected executeAgent + deliver
		const ompBinary = this.#config.agent?.ompPath ?? "omp";
		this.#cronService = new CronService({
			storage: this.#schedulerStorage,
			ompBinary,
			log: {
				debug: (msg: string, ctx?: unknown) => logger.debug(msg, ctx as Record<string, unknown>),
				info: (msg: string, ctx?: unknown) => logger.debug(msg, ctx as Record<string, unknown>),
				warn: (msg: string, ctx?: unknown) => logger.warn(msg, ctx as Record<string, unknown>),
				error: (msg: string, ctx?: unknown) => logger.error(msg, ctx as Record<string, unknown>),
			},
			executeAgent: async params => {
				return await this.#executeCronAgent(params);
			},
			deliver: async params => {
				return await this.#deliverCronResult(params);
			},
		});

		this.#schedulerEngine = new SchedulerEngine({
			storage: this.#schedulerStorage,
			onTrigger: this.#cronService.onTrigger.bind(this.#cronService),
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

	/**
	 * Execute a cron agent task via warm bridge (AgentBridge).
	 *
	 * This is the gateway's implementation of CronDeps.executeAgent.
	 * It handles:
	 * - Finding the warm bridge by agentDir (with accountId fallback)
	 * - setDisabledToolsets(['cronjob', 'messaging']) before execution
	 * - Model switch/restore if task specifies a different model
	 * - executePrompt with timeout + inactivity budget
	 * - finally: restore toolsets + model
	 *
	 * Returns { output, error } — on failure, error is set and output is empty,
	 * so CronService falls back to executeScheduledCommand (cold subprocess).
	 */
	async #executeCronAgent(params: {
		agentDir: string;
		prompt: string;
		timeoutMs?: number;
		signal?: AbortSignal;
		disabledToolsets?: string[];
		model?: string;
		provider?: string;
	}): Promise<{ output: string; error?: string }> {
		// Resolve the bridge: try agentDir → accountAgentDirs reverse lookup,
		// then fall back to accountId if the task still uses deprecated field.
		const bridge = this.#getBridgeByAgentDir(params.agentDir);
		if (!bridge) {
			return { output: "", error: `No warm bridge found for agentDir: ${params.agentDir}` };
		}

		const cronSessionPath = buildAgentSessionPath(params.agentDir, `cron_${Date.now()}`);

		// Lock down toolset: cron agents must not create sub-tasks or send messages
		try {
			await bridge.setDisabledToolsets(params.disabledToolsets ?? []);
		} catch {
			// Best-effort — if the RPC doesn't support this command yet, continue
		}

		// Switch model if the task specifies a different one
		let originalModel: { provider?: string; model?: string } | undefined;
		if (params.model) {
			try {
				const state = await bridge.getState();
				const d = state.data as Record<string, unknown> | undefined;
				if (d?.model) {
					originalModel = {
						provider: typeof d.provider === "string" ? d.provider : undefined,
						model: typeof d.model === "string" ? d.model : undefined,
					};
				}
				await bridge.setModel(params.provider ?? "", params.model);
			} catch (switchErr) {
				logger.warn("Failed to switch model for cron task, continuing with current model", {
					error: String(switchErr),
				});
			}
		}

		try {
			const response = await bridge.executePrompt(params.prompt, {
				timeoutMs: params.timeoutMs,
				sessionPath: cronSessionPath,
				inactivityMs: computeInactivityBudgetMs(params.timeoutMs),
			});
			return { output: response };
		} catch (err) {
			return { output: "", error: err instanceof Error ? err.message : String(err) };
		} finally {
			// Restore disabled toolsets
			try {
				await bridge.setDisabledToolsets([]);
			} catch (restoreErr) {
				logger.error(
					"Failed to restore disabled toolsets after cron task — bridge may have stale toolset restrictions",
					{ error: restoreErr instanceof Error ? restoreErr.message : String(restoreErr) },
				);
			}
			// Restore original model after execution
			if (originalModel?.model) {
				try {
					await bridge.setModel(originalModel.provider ?? "", originalModel.model);
				} catch (restoreErr) {
					logger.error(
						"Failed to restore original model after cron task — bridge will use the cron task's model until next /model command",
						{
							cronModel: params.model,
							originalModel: originalModel.model,
							error: restoreErr instanceof Error ? restoreErr.message : String(restoreErr),
						},
					);
				}
			}
		}
	}

	/**
	 * Find a warm AgentBridge by agentDir path.
	 *
	 * Reverse-looks-up the #accountAgentDirs map to find which accountId
	 * maps to the given agentDir, then returns the corresponding bridge.
	 * Falls back to the default bridge in single-account mode.
	 */
	#getBridgeByAgentDir(agentDir: string): AgentBridge | undefined {
		for (const [acctId, dir] of this.#accountAgentDirs) {
			if (dir === agentDir) {
				return this.getAccountBridge(acctId);
			}
		}
		// Single-account mode: use default bridge if running
		if (this.#accountBridges.size === 0 && this.#bridge.isRunning) {
			return this.#bridge;
		}
		return undefined;
	}

	/**
	 * Deliver a cron result to a channel via ChannelRegistry.
	 *
	 * This is the gateway's implementation of CronDeps.deliver.
	 * It constructs an OutboundMessage and sends it through the channel
	 * registry, with one retry after 5s for transient failures.
	 */
	async #deliverCronResult(params: {
		channel: string;
		accountId?: string;
		toUserId?: string;
		toConversationId?: string;
		text: string;
	}): Promise<{ ok: boolean; error?: string }> {
		const msg: OutboundMessage = {
			channelId: params.channel,
			conversationId: params.toConversationId ?? `cron:${Date.now()}`,
			content: { type: "text", text: params.text },
			accountId: params.accountId,
			toUserId: params.toUserId,
		};

		// Retry once after 5s for transient channel failures
		const maxAttempts = 2;
		const retryDelayMs = 5_000;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				await this.#registry.sendMessage(msg);
				return { ok: true };
			} catch (err) {
				if (attempt < maxAttempts) {
					await Bun.sleep(retryDelayMs);
					continue;
				}
				return { ok: false, error: err instanceof Error ? err.message : String(err) };
			}
		}
		return { ok: false, error: "unreachable" };
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

	/**
	 * Send the agent's reply through the channel-specific `formatReply` (if
	 * the channel implements one) so platforms that opt into richer visuals
	 * get status lines, tool summaries, and quote content. Channels that
	 * haven't implemented `formatReply` get the plain-text fallback.
	 */
	async #sendFormattedAgentResponse(msg: InboundMessage, meta: AgentResponseMeta, accountId: string): Promise<void> {
		const channel = this.#registry.get(buildChannelKey(msg.channelId, msg.accountId));
		const context: ReplyFormatterContext = {
			accountId,
			agentName: this.#resolveAgentName(accountId),
			// dapiCalls is wired up in a follow-up; until then pass 0 so the
			// status line renders the placeholder consistently.
			dapiCalls: 0,
		};

		const outbound = channel?.formatReply ? channel.formatReply(meta, msg, context) : null;

		if (!outbound) {
			await this.#sendAgentResponse(msg, meta.text);
			return;
		}

		try {
			await this.#registry.sendMessage(outbound);
		} catch (err) {
			logger.error("Failed to send formatted agent response", {
				accountId,
				conversationId: msg.conversationId,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	/**
	 * Try to run the agent through the channel's v2 AI Card streaming
	 * path. Returns `true` when the channel handled the reply (card
	 * created + streamed + finished, even if the agent returned a
	 * fallback string), `false` when the channel doesn't support cards
	 * or card creation failed and the caller should run the v1 markdown
	 * fallback. The card path is responsible for marking the card as
	 * FAILED when submit returns `null` (queue full), so this method
	 * only returns `false` for "could not start the card path at all".
	 */
	async #tryStreamAgentResponse(
		msg: InboundMessage,
		session: SessionRecord,
		accountId: string,
		channel: Channel | undefined,
	): Promise<boolean> {
		if (!channel?.streamCard) return false;
		if (!this.#sessionManager) return false;

		const context: ReplyFormatterContext = {
			accountId,
			agentName: this.#resolveAgentName(accountId),
			dapiCalls: 0,
			// When the channel creates a card with an interactive stop
			// block, it calls this so a later TOPIC_CARD action callback
			// can be routed back to the right session. Re-registering on
			// the same cardInstanceId with a richer toolName (when the
			// watcher fires) is idempotent — the registry keeps the
			// first `createdAt` and overwrites the rest.
			registerCardAction: info =>
				this.#actionRegistry.register(info.cardInstanceId, {
					accountId: info.accountId,
					sessionId: info.sessionId,
					toolName: info.toolName,
				}),
		};

		const submit = (handlers?: ForwardStreamHandlers): Promise<AgentResponseMeta | null> =>
			this.#sessionManager!.enqueueWithMeta(msg, session, handlers);

		try {
			const outbound = await channel.streamCard(msg, session, context, submit);
			return outbound !== null;
		} catch (err) {
			logger.error("Failed to run AI Card stream path, falling back to v1 markdown", {
				accountId,
				conversationId: msg.conversationId,
				channel: msg.channelId,
				error: err instanceof Error ? err.message : String(err),
			});
			return false;
		}
	}

	/**
	 * v1 fallback: send the "thinking..." placeholder, then enqueue the
	 * agent run, then send the formatted reply (channel `formatReply` for
	 * platforms that opt in, plain text otherwise). Used when the v2 AI
	 * Card path is unavailable (channel doesn't support cards, card
	 * creation failed, or the card stream threw).
	 */
	async #handleCardAction(event: DingTalkCardActionEvent): Promise<void> {
		// The Stream-mode action callback doesn't carry HMAC headers
		// (those are HTTP-only) but it does ride over the same
		// authenticated WebSocket the channel's Stream SDK established
		// with appKey/appSecret. The SDK rejects connections that fail
		// authentication, so an action arriving on TOPIC_CARD is
		// already authenticated. (HTTP-mode action callbacks would add
		// HMAC verification on top of this; Phase 2c territory.)
		const info = this.#actionRegistry.lookup(event.cardInstanceId);
		if (!info) {
			// Fallback for the schema's static btn_stop button: the
			// action menu fires even for cards we don't have a
			// registry entry for (e.g. the long-task watcher never
			// fired so we never patched the registry with the
			// toolName). Treat any btn_stop click as a stop request
			// and try to abort the most recent session on the user
			// who clicked. The user's intent is unambiguous: stop
			// the work.
			if (event.actionIds.includes("btn_stop")) {
				logger.warn("[Gateway] btn_stop on unknown card — aborting by user", {
					cardInstanceId: event.cardInstanceId,
					clickedBy: event.userId,
				});
				if (this.#sessionManager) {
					try {
						await this.#sessionManager.abortByUser(event.userId);
					} catch (err) {
						logger.error("[Gateway] btn_stop fallback abort failed", {
							error: err instanceof Error ? err.message : String(err),
						});
					}
				}
				return;
			}
			logger.warn("[Gateway] card action for unknown / expired card", {
				cardInstanceId: event.cardInstanceId,
				actionType: event.params.type,
				actionIds: event.actionIds,
				userId: event.userId,
			});
			return;
		}

		// Resolve action: stop can arrive via two shapes
		//   1. `params.type === "stop"` — our own btns[N] data, used when
		//      the schema's ButtonGroup is bound to blockList[N].btns
		//   2. `actionIds.includes("btn_stop")` — the schema's static
		//      top-right "中止" button (its onTap is dtActionSheet ->
		//      dtSendOutData with actionType 0 and actionId btn_stop,
		//      params = {action: "true"}). This is the only actually-
		//      clickable stop affordance in OpenClaw's 675cde2f schema;
		//      blockList[N].btns renders a fallback "当前客户端环境不
		//      支持按钮组组件" message with no button. Treat any
		//      btn_stop click as a stop request.
		const isStop = event.params.type === "stop" || event.actionIds.includes("btn_stop");
		if (isStop) {
			logger.warn("[Gateway] card stop action — aborting bridge", {
				cardInstanceId: event.cardInstanceId,
				accountId: info.accountId,
				sessionId: info.sessionId,
				toolName: info.toolName,
				clickedBy: event.userId,
				matchedBy: event.params.type === "stop" ? "params.type" : "actionIds.btn_stop",
			});
			if (!this.#sessionManager) {
				logger.warn("[Gateway] sessionManager not initialized; cannot abort");
				return;
			}
			try {
				const aborted = await this.#sessionManager.abort(info.accountId);
				if (!aborted) {
					logger.debug("[Gateway] abort() returned false (no active prompt)", {
						accountId: info.accountId,
					});
				}
			} catch (err) {
				logger.error("[Gateway] bridge abort failed", {
					accountId: info.accountId,
					error: err instanceof Error ? err.message : String(err),
				});
			}
			return;
		}

		// Unknown action type — log and ignore. Future action types
		// (retry, copy, view-detail, etc.) plug in here.
		logger.warn("[Gateway] unhandled card action type", {
			actionType: event.params.type,
			cardInstanceId: event.cardInstanceId,
			actionIds: event.actionIds,
			params: event.params,
		});
	}

	async #sendAgentResponseViaV1Markdown(
		msg: InboundMessage,
		session: SessionRecord,
		accountId: string,
	): Promise<void> {
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

		const meta = await this.#sessionManager?.enqueueWithMeta(msg, session);
		if (meta) {
			await this.#sendFormattedAgentResponse(msg, meta, accountId);
		}
	}

	/**
	 * Resolve a per-account agent name for the reply status line. v1 uses the
	 * accountId as a stable fallback; v1.1 can derive a real name from
	 * `<agentDir>/mission.md` or config.
	 */
	#resolveAgentName(accountId: string): string | null {
		if (!accountId || accountId === "__default__") return null;
		return accountId;
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Model switch — shared by /model slash command and NL interception
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Switch the bridge's active model and reply to the user.
	 * Returns true if the switch was handled (success or error reply sent).
	 */
	async #switchModelAndReply(
		bridge: AgentBridge,
		msg: InboundMessage,
		provider: string,
		modelId: string,
	): Promise<boolean> {
		try {
			const response = await bridge.setModel(provider, modelId);
			logger.info("NL model switch response", {
				requestedProvider: provider,
				requestedModelId: modelId,
				success: response.success,
				responseData: response.data,
				error: (response as Record<string, unknown>).error,
			});
			if (!response.success) {
				await this.#sendAgentResponse(msg, `切换模型失败: ${response.error ?? "未知错误"}`);
				return true;
			}
			const model = response.data as { provider: string; id: string } | undefined;
			const modelStr = model ? `${model.provider}/${model.id}` : `${provider}/${modelId}`;
			await this.#sendAgentResponse(msg, `已切换到模型: ${modelStr}`);
			return true;
		} catch (err) {
			logger.error("Failed to switch model", {
				provider,
				modelId,
				error: err instanceof Error ? err.message : String(err),
			});
			await this.#sendAgentResponse(msg, `切换模型失败: ${err instanceof Error ? err.message : String(err)}`);
			return true;
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// Natural-Language Model Switch Interception
	// ═══════════════════════════════════════════════════════════════════

	/**
	 * Intercept natural-language model switch requests (e.g. "切换模型到
	 * kimi-k2.6") before forwarding to the agent. Fuzzy-matches the model
	 * name and calls bridge.setModel() directly — no LLM round-trip.
	 * Returns true if handled, false to let the normal agent path proceed.
	 */
	async #tryNaturalLanguageModelSwitch(msg: InboundMessage, accountId: string): Promise<boolean> {
		const text = this.#extractMessageText(msg);
		const modelArg = extractModelSwitchArg(text);
		if (!modelArg) return false;

		const bridge = this.#resolveDirectBridge(accountId === "__default__" ? undefined : accountId);
		if (!bridge?.isRunning) {
			await this.#sendAgentResponse(msg, "Agent 未启动，无法切换模型。请稍后再试。");
			return true;
		}

		try {
			const response = await bridge.getAvailableModels();
			if (!response.data || typeof response.data !== "object") {
				await this.#sendAgentResponse(msg, "无法获取模型列表。");
				return true;
			}
			const { models } = response.data as { models?: MatchableModel[] };
			if (!Array.isArray(models) || models.length === 0) {
				await this.#sendAgentResponse(msg, "当前没有可用模型。");
				return true;
			}

			const match = fuzzyMatchModel(models, modelArg);
			if (!match) {
				const available = models.map(m => `\`${m.provider}/${m.id}\``).join("、");
				await this.#sendAgentResponse(msg, `未找到匹配 "${modelArg}" 的模型。可用模型：${available}`);
				return true;
			}

			return this.#switchModelAndReply(bridge, msg, match.provider, match.id);
		} catch (err) {
			logger.error("NL model switch failed", { error: err instanceof Error ? err.message : String(err) });
			await this.#sendAgentResponse(msg, `切换模型失败: ${err instanceof Error ? err.message : String(err)}`);
			return true;
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// Model Command Interception
	// ═══════════════════════════════════════════════════════════════════

	async #handleModelCommand(msg: InboundMessage, accountId: string): Promise<boolean> {
		const text = this.#extractMessageText(msg).trim();
		if (!text.startsWith("/models") && !text.startsWith("/list-models") && !text.startsWith("/model")) return false;

		// Resolve bridge for this account
		const bridge = this.#resolveDirectBridge(accountId === "__default__" ? undefined : accountId);
		if (!bridge?.isRunning) {
			await this.#sendAgentResponse(msg, "Agent 未启动，无法执行模型命令。请稍后再试。");
			return true;
		}

		// /models or /list-models — list all available models
		if (
			text === "/models" ||
			text === "/list-models" ||
			text.startsWith("/models ") ||
			text.startsWith("/list-models ")
		) {
			try {
				const response = await bridge.getAvailableModels();
				if (!response.data || typeof response.data !== "object") {
					await this.#sendAgentResponse(msg, "无法获取模型列表。");
					return true;
				}
				const { models } = response.data as {
					models: Array<{
						provider: string;
						id: string;
						contextWindow?: number;
						reasoning?: boolean;
						thinking?: unknown;
					}>;
				};
				if (!Array.isArray(models) || models.length === 0) {
					await this.#sendAgentResponse(msg, "当前没有可用的模型。请检查 API key 配置。");
					return true;
				}

				// Filter by search pattern if provided
				const searchPattern = text.startsWith("/models ")
					? text.slice(8).trim()
					: text.startsWith("/list-models ")
						? text.slice(13).trim()
						: undefined;
				let filtered = models;
				if (searchPattern) {
					const pattern = searchPattern.toLowerCase();
					filtered = models.filter(
						m => m.provider.toLowerCase().includes(pattern) || m.id.toLowerCase().includes(pattern),
					);
					if (filtered.length === 0) {
						await this.#sendAgentResponse(msg, `没有匹配 "${searchPattern}" 的模型。`);
						return true;
					}
				}

				// Build markdown table
				filtered.sort((a, b) => {
					const providerCmp = a.provider.localeCompare(b.provider);
					if (providerCmp !== 0) return providerCmp;
					return a.id.localeCompare(b.id);
				});

				const rows = filtered.map(m => {
					const ctx = m.contextWindow ? formatModelNumber(m.contextWindow) : "-";
					const think = m.reasoning ? "yes" : "-";
					return `| ${m.provider} | ${m.id} | ${ctx} | ${think} |`;
				});
				const table = `| provider | model | context | reasoning |
|---|---|---|---|
${rows.join("\n")}`;
				const count =
					filtered.length === models.length ? `${models.length}` : `${filtered.length}/${models.length}`;
				await this.#sendAgentResponse(
					msg,
					`可用模型 (${count}):

${table}

切换模型: /model <provider>/<modelId>`,
				);
				return true;
			} catch (err) {
				logger.error("Failed to list models", { error: err instanceof Error ? err.message : String(err) });
				await this.#sendAgentResponse(msg, `获取模型列表失败: ${err instanceof Error ? err.message : String(err)}`);
				return true;
			}
		}

		// /model with no args — show current model
		if (text === "/model") {
			try {
				const response = await bridge.getState();
				if (!response.data || typeof response.data !== "object") {
					await this.#sendAgentResponse(msg, "无法获取当前模型信息。");
					return true;
				}
				const state = response.data as { model?: { provider: string; id: string }; thinkingLevel?: string };
				if (!state.model) {
					await this.#sendAgentResponse(msg, "当前没有选中模型。");
					return true;
				}
				const modelStr = `${state.model.provider}/${state.model.id}`;
				const thinking = state.thinkingLevel ? ` (推理级别: ${state.thinkingLevel})` : "";
				await this.#sendAgentResponse(msg, `当前模型: ${modelStr}${thinking}`);
				return true;
			} catch (err) {
				logger.error("Failed to get current model", { error: err instanceof Error ? err.message : String(err) });
				await this.#sendAgentResponse(msg, `获取当前模型失败: ${err instanceof Error ? err.message : String(err)}`);
				return true;
			}
		}

		// /model <provider>/<modelId> — switch model
		const modelArg = text.startsWith("/model ") ? text.slice(7).trim() : undefined;
		if (!modelArg) return false; // not a /model command with args

		// Parse provider/modelId from argument
		// Accept formats: "provider/modelId", "provider:modelId", "modelId" (uses current provider)
		let provider: string | undefined;
		let modelId: string;
		if (modelArg.includes("/")) {
			const [p, m] = modelArg.split("/", 2);
			provider = p;
			modelId = m;
		} else if (modelArg.includes(":")) {
			const [p, m] = modelArg.split(":", 2);
			provider = p;
			modelId = m;
		} else {
			// No provider prefix — try to resolve using current model's provider
			try {
				const stateResponse = await bridge.getState();
				const stateData = stateResponse.data as { model?: { provider: string } } | undefined;
				provider = stateData?.model?.provider;
				modelId = modelArg;
			} catch {
				await this.#sendAgentResponse(msg, `无法确定当前 provider。请使用完整格式: /model <provider>/<modelId>`);
				return true;
			}
		}

		if (!provider) {
			await this.#sendAgentResponse(msg, `无法确定 provider。请使用完整格式: /model <provider>/<modelId>`);
			return true;
		}

		return this.#switchModelAndReply(bridge, msg, provider, modelId);
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
			if (await this.#handleModelCommand(msg, accountId)) return;
			if (await this.#tryNaturalLanguageModelSwitch(msg, accountId)) return;
			let session = await this.#store?.getSession(msg.channelId, accountId, msg.conversationId);
			const now = Date.now();

			// Session rotation: check if the existing session has expired
			// per the configured reset policy (idle timeout / daily boundary).
			// Must happen BEFORE the session's updatedAt is refreshed below,
			// otherwise the check always sees "just now" and never triggers.
			if (session && this.#shouldResetSession(session)) {
				session = await this.#resetSession(session, accountId, msg);
			}
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
					await this.#store.updateSession(session.id, {
						ompSessionPath: sessionPath,
						updatedAt: now,
						sessionWebhook: msg.sessionWebhook,
					});
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

			// Try the v2 AI Card path first (DingTalk only). The card
			// replaces the "thinking..." placeholder: it starts in
			// PROCESSING state, transitions to INPUTING on text deltas,
			// and finishes with the full v1-formatted chrome (quote
			// content / tool summary / status line) on agent_end. If the
			// channel doesn't support cards or card creation fails, the
			// v1 markdown path runs instead.
			const channel = this.#registry.get(buildChannelKey(msg.channelId, msg.accountId));
			const usedCard = await this.#tryStreamAgentResponse(msg, session, accountId, channel);
			if (!usedCard) {
				await this.#sendAgentResponseViaV1Markdown(msg, session, accountId);
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

	/**
	 * Check if a session should be reset based on the configured policy.
	 *
	 * - `none`: never reset
	 * - `idle`: reset after `idleTimeoutMinutes` of inactivity
	 * - `daily`: reset when `updatedAt` is before today's `dailyResetHour`
	 * - `both`: whichever triggers first (idle or daily)
	 */
	#shouldResetSession(session: SessionRecord): boolean {
		const policy = this.#config.session?.resetPolicy ?? "both";
		if (policy === "none") return false;

		const now = Date.now();
		const updatedAt = session.updatedAt;

		if (policy === "idle" || policy === "both") {
			const idleMs = (this.#config.session?.idleTimeoutMinutes ?? 240) * 60_000;
			if (now - updatedAt > idleMs) return true;
		}

		if (policy === "daily" || policy === "both") {
			const resetHour = this.#config.session?.dailyResetHour ?? 2;
			const today = new Date(now);
			const todayReset = new Date(today.getFullYear(), today.getMonth(), today.getDate(), resetHour, 0, 0, 0);
			// If we haven't passed today's reset hour yet, the boundary is yesterday's
			const boundary = now < todayReset.getTime() ? todayReset.getTime() - 86_400_000 : todayReset.getTime();
			if (updatedAt < boundary) return true;
		}

		return false;
	}

	/**
	 * Reset a session: delete the old jsonl file, close the old SQLite
	 * record, create a fresh session, reset the bridge's cached session
	 * path, and inject a system note into the message so the agent knows
	 * this is a fresh conversation.
	 *
	 * Returns the new SessionRecord.
	 */
	async #resetSession(session: SessionRecord, accountId: string, msg: InboundMessage): Promise<SessionRecord> {
		logger.warn("Session rotation triggered", {
			channelId: session.channelId,
			conversationId: session.conversationId,
			accountId,
			updatedAt: new Date(session.updatedAt).toISOString(),
		});

		// 1. Archive the old jsonl file (rename with timestamp suffix).
		//    The original path is left vacant so omp creates a fresh session
		//    file on the next switch_session.  Archived files preserve full
		//    conversation history for audit / retrieval.
		if (session.ompSessionPath) {
			try {
				const archivePath = this.#archiveSessionPath(session.ompSessionPath);
				await fs.rename(session.ompSessionPath, archivePath);
				logger.debug("Archived old session file", { from: session.ompSessionPath, to: archivePath });
			} catch (err) {
				if (!isEnoent(err)) {
					logger.warn("Failed to archive old session file", {
						path: session.ompSessionPath,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			}
		}

		// 2. Refresh the session record in place (same row, fresh timestamp).
		//    We can't close+create because the UNIQUE(channel_id, account_id,
		//    conversation_id) constraint would reject the new row.  The SQLite
		//    record is just metadata — the actual context reset is the archived
		//    jsonl file + bridge.resetActiveSession().
		const now = Date.now();
		await this.#store?.updateSession(session.id, {
			updatedAt: now,
			sessionWebhook: msg.sessionWebhook,
		});
		const newSession: SessionRecord = {
			...session,
			updatedAt: now,
			sessionWebhook: msg.sessionWebhook,
		};

		// 4. Reset the bridge so the next forward re-switches to the
		//    (now deleted) file — omp will start a fresh session at that path.
		const bridge = accountId === "__default__" ? this.#bridge : this.#accountBridges.get(accountId);
		bridge?.resetActiveSession();

		// 5. Inject system note into the message so the agent knows
		//    this is a fresh conversation with no prior context.
		const note = "[System note: This is a fresh conversation with no prior context.]\n\n";
		if (msg.content.type === "text") {
			msg.content = { type: "text", text: note + msg.content.text };
		} else if (msg.content.type === "markdown") {
			msg.content = { type: "markdown", markdown: note + msg.content.markdown };
		}

		return newSession;
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

	/**
	 * Build an archive path for a session file by inserting a timestamp
	 * before the .jsonl extension: `cid_xxx.jsonl` → `cid_xxx.20260624_140000.jsonl`.
	 */
	#archiveSessionPath(sessionPath: string): string {
		const ts = new Date()
			.toISOString()
			.replace(/[-:T]/g, "")
			.slice(0, 14)
			.replace(/(\d{8})(\d{6})/, "$1_$2");
		const dot = sessionPath.lastIndexOf(".");
		if (dot === -1) return `${sessionPath}.${ts}`;
		return `${sessionPath.slice(0, dot)}.${ts}${sessionPath.slice(dot)}`;
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
		// Resolve agentDir from the message's account
		const acctId = msg.accountId ?? accountId;
		const agentDir = this.#accountAgentDirs.get(acctId);
		return createCronTaskFromMessage(text, agentDir, this.#schedulerStorage);
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
