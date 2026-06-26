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
import { DingTalkChannel } from "./channels/dingtalk";
import { ChannelRegistry } from "./channels/registry";
import { getDataDir, getDingTalkConfig, getEnabledChannels } from "./config";
import { CronLifecycle } from "./gateway-cron-lifecycle";
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
import { checkPidFile, PID_FILE, readPidFile, STATUS_FILE } from "./gateway-daemon";
import { ModelSwitch } from "./gateway-model-switch";
import { ResponseHandler } from "./gateway-response";
import { MessageHandler } from "./gateway-message";

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
	#cronLifecycle: CronLifecycle;
	#modelSwitch: ModelSwitch;
	#responseHandler: ResponseHandler;
	#messageHandler: MessageHandler;
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
		this.#cronLifecycle = new CronLifecycle({
			config,
			bridge: this.#bridge,
			accountBridges: this.#accountBridges,
			accountAgentDirs: this.#accountAgentDirs,
			registry: this.#registry,
			getAccountBridge: id => this.getAccountBridge(id),
			writeStatusFile: () => this.#writeStatusFile(),
		});
		this.#modelSwitch = new ModelSwitch({
			resolveDirectBridge: id => this.#resolveDirectBridge(id),
			sendAgentResponse: (msg, text) => this.#responseHandler.sendAgentResponse(msg, text),
			extractMessageText: msg => msg.content.type === "text" ? msg.content.text : "",
		});
		this.#responseHandler = new ResponseHandler({
			registry: this.#registry,
			sessionManager: this.#sessionManager,
			actionRegistry: this.#actionRegistry,
			resolveAgentName: id => this.#responseHandler.resolveAgentName(id),
		});
		this.#messageHandler = new MessageHandler({
			config,
			store: this.#store,
			registry: this.#registry,
			bridge: this.#bridge,
			accountBridges: this.#accountBridges,
			accountAgentDirs: this.#accountAgentDirs,
			cronLifecycle: this.#cronLifecycle,
			modelSwitch: this.#modelSwitch,
			responseHandler: this.#responseHandler,
			extractMessageText: msg => {
				const c = msg.content;
				if (c.type === "text") return c.text;
				if (c.type === "markdown") return c.markdown;
				if (c.type === "voice") return c.text ?? "";
				return "";
			},
		});
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

		await this.#registry.connectAll(async msg => this.#messageHandler.handleInboundMessage(msg));

		// Start cron scheduler
		await this.#cronLifecycle.start();

		// Prune expired card-action entries every 5 min so the registry
		// doesn't grow unbounded. The registry is bounded by the rate
		// of new cards (~1 per inbound message) so a 5 min cadence is
		// plenty.
	setInterval(() => this.#actionRegistry.expire(), 5 * 60_000).unref?.();

		// Health check: every 60s, if a bridge's circuit breaker has been
		// open for more than 5 minutes, restart it. Prevents a permanently
		// stuck bridge from silently swallowing all messages.
		this.#healthInterval = setInterval(() => this.checkBridgeHealth(), 60_000).unref?.();

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
				channel.setCardActionHandler(event => this.#responseHandler.handleCardAction(event));
				logger.debug("Registered DingTalk account channel", { accountId });
			}
			return;
		}

		// Single-account mode (use legacy appKey/appSecret from config)
		const channel = new DingTalkChannel();
		channel.setCardActionHandler(event => this.#responseHandler.handleCardAction(event));
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
			channel.onMessage(async msg => this.#messageHandler.handleInboundMessage(msg));
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
		this.#cronLifecycle.stop();
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
	 * for more than the threshold, restart the bridge to recover from a
	 * stuck state. A cooldown per bridge prevents restart storms when the
	 * underlying problem persists.
	 *
	 * Exposed as public (not #private) so tests and external health
	 * monitors can trigger it on demand. Thresholds are overridable via
	 * GATEWAY_CIRCUIT_OPEN_MS and GATEWAY_CIRCUIT_COOLDOWN_MS env vars.
	 */
	async checkBridgeHealth(): Promise<void> {
		const CIRCUIT_OPEN_THRESHOLD_MS =
			Number(process.env.GATEWAY_CIRCUIT_OPEN_MS) || 5 * 60_000;
		const RESTART_COOLDOWN_MS =
			Number(process.env.GATEWAY_CIRCUIT_COOLDOWN_MS) || 10 * 60_000;
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
		const oldCronConfig = this.#config.cron;

		const newDtConfig = getDingTalkConfig(config);
		const newAccounts = newDtConfig?.accounts ? new Map(Object.entries(newDtConfig.accounts)) : new Map();
		const newCronConfig = config.cron;

		// Build reload plan: what actually changed?
		const plan = {
			cronChanged: JSON.stringify(oldCronConfig) !== JSON.stringify(newCronConfig),
			accountsToAdd: [] as string[],
			accountsToRemove: [] as string[],
			accountsToUpdate: [] as string[],
		};

		for (const [accountId] of oldAccounts) {
			if (!newAccounts.has(accountId)) plan.accountsToRemove.push(accountId);
		}
		for (const [accountId, account] of newAccounts) {
			if (!oldAccounts.has(accountId)) {
				plan.accountsToAdd.push(accountId);
			} else {
				const oldAccount = oldAccounts.get(accountId)!;
				if (
					oldAccount.appKey !== account.appKey ||
					oldAccount.appSecret !== account.appSecret ||
					oldAccount.robotCode !== account.robotCode ||
					oldAccount.agentDir !== account.agentDir
				) {
					plan.accountsToUpdate.push(accountId);
				}
			}
		}

		const hasChanges = plan.cronChanged || plan.accountsToAdd.length > 0 || plan.accountsToRemove.length > 0 || plan.accountsToUpdate.length > 0;
		this.#config = config;
		if (!hasChanges) {
			logger.debug("Gateway config reloaded (no changes detected)");
			await this.#writeStatusFile();
			return;
		}

		logger.debug("Gateway config reload plan", plan);

		// Execute plan: only restart what changed
		if (plan.cronChanged) {
			this.#cronLifecycle.stop();
			await this.#cronLifecycle.start();
		}

		for (const accountId of plan.accountsToRemove) {
			this.#removeAccount(accountId);
		}
		for (const accountId of plan.accountsToAdd) {
			await this.#addAccount(accountId, newAccounts.get(accountId)!, config);
		}
		for (const accountId of plan.accountsToUpdate) {
			this.#removeAccount(accountId);
			await this.#addAccount(accountId, newAccounts.get(accountId)!, config);
		}

		// Only rebuild SessionManager if bridges changed
		if (plan.accountsToAdd.length > 0 || plan.accountsToRemove.length > 0 || plan.accountsToUpdate.length > 0) {
			const hasDingTalkAccounts = newAccounts.size > 0;
			this.#sessionManager = new SessionManager({
				bridges: this.#accountBridges,
				defaultBridge: hasDingTalkAccounts ? undefined : this.#bridge,
			});
		}

		await this.#writeStatusFile();

		logger.debug("Gateway config reloaded");
	}


	get isRunning(): boolean {
		return this.#running;
	}

	/** Returns the default (non-account) bridge, if any. */
	getDefaultBridge(): AgentBridge {
		return this.#bridge;
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
				running: this.#cronLifecycle.engineRunning,
				taskCount: this.#cronLifecycle.activeTaskCount,
			},
		};
	}


}
