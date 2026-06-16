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

import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { AgentBridge } from "./agent-bridge";
import { ChannelRegistry } from "./channels/registry";
import { getDingTalkConfig, getDataDir, type GatewayConfig, getEnabledChannels } from "./config";
import { SchedulerEngine } from "./scheduler/engine";
import { executeScheduledCommand } from "./scheduler/executor";
import { SchedulerFileStore } from "./scheduler/file-store";
import { SchedulerDbStorage } from "./scheduler/storage";
import type { ScheduledTask } from "./scheduler/types";
import { DEFAULT_SCHEDULER_CONFIG, getSchedulerDbPath, getSchedulerDir } from "./scheduler/types";
import { SQLiteSessionStore } from "./session-store";
import type { InboundMessage, OutboundMessage, SessionRecord } from "./types";

export class Gateway {
	#config: GatewayConfig;
	#registry = new ChannelRegistry();
	#store: SQLiteSessionStore | null = null;
	#running = false;
	/** Default agent bridge for single-account mode */
	#bridge: AgentBridge;
	/** Per-account agent bridges for multi-agent mode */
	#accountBridges = new Map<string, AgentBridge>();
	#schedulerEngine?: SchedulerEngine;
	#schedulerStorage?: SchedulerDbStorage;
	#schedulerFileStore?: SchedulerFileStore;
	#watchInterval?: ReturnType<typeof setInterval>;

	constructor(config: GatewayConfig) {
		this.#config = config;
		this.#bridge = new AgentBridge(config.agent ?? {});
	}

	async start(): Promise<void> {
		if (this.#running) {
			logger.warn("Gateway already running");
			return;
		}

		logger.debug("Starting gateway...");

		// Initialize session store
		const dataDir = getDataDir(this.#config);
		this.#store = new SQLiteSessionStore(`${dataDir}/sessions.db`);

		// Register channels (handle multi-account DingTalk)
		const enabled = getEnabledChannels(this.#config);
		for (const { id } of enabled) {
			if (id === "dingtalk") {
				await this.#registerDingTalkChannels();
			}
			// Future: feishu, wechat, etc.
		}

		// Start default agent bridge (RPC process)
		try {
			await this.#bridge.start();
			logger.debug("Agent bridge started");
		} catch (err) {
			logger.error("Failed to start agent bridge", { error: String(err) });
		}

		await this.#registry.connectAll(async msg => this.#handleInboundMessage(msg));

		// Start cron scheduler
		await this.#startScheduler();

		this.#running = true;
		logger.debug("Gateway started");
	}

	/**
	 * Register DingTalk channel(s). In multi-account mode, each account gets
	 * its own DingTalkChannel instance and account-specific AgentBridge.
	 */
	async #registerDingTalkChannels(): Promise<void> {
		const { DingTalkChannel } = await import("./channels/dingtalk");
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

				// Create per-account agent bridge with account-specific config
				const bridge = new AgentBridge({
					...this.#config.agent,
					model: account.model ?? this.#config.agent?.model,
					cwd: account.agentDir,
				});
				this.#accountBridges.set(accountId, bridge);

				// Start per-account bridge
				try {
					await bridge.start();
				} catch (err) {
					logger.error("Failed to start account bridge", { accountId, error: String(err) });
				}

				this.#registry.register(channel, {
					...rawConfig,
					appKey: account.appKey,
					appSecret: account.appSecret,
					robotCode: account.robotCode,
				});
				logger.debug("Registered DingTalk account channel", { accountId });
			}
			return;
		}

		// Single-account mode (use legacy appKey/appSecret from config)
		const channel = new DingTalkChannel();
		this.#registry.register(channel, rawConfig);
	}

	async stop(): Promise<void> {
		if (!this.#running) return;

		logger.debug("Stopping gateway...");

		this.#stopScheduler();

		// Stop all per-account bridges
		for (const bridge of this.#accountBridges.values()) {
			bridge.stop();
		}
		this.#accountBridges.clear();

		// Stop default bridge
		this.#bridge.stop();

		await this.#registry.disconnectAll();
		this.#store?.close();
		this.#running = false;
		logger.debug("Gateway stopped");
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

	async getStatus(): Promise<{
		running: boolean;
		channels: Array<{ id: string; name: string; connected: boolean }>;
		sessions: number;
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

		return {
			running: this.#running,
			channels,
			sessions: sessions.length,
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
		this.#watchInterval = setInterval(() => {
			this.#schedulerFileStore?.syncToDb();
			this.#schedulerEngine?.reload();
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

		const ompBinary = this.#config.agent?.ompPath ?? "omp";
		const { exitCode, output, stderr, timedOut } = await executeScheduledCommand(task.command, {
			taskType: task.taskType,
			timeoutMs: task.timeoutMs,
			ompBinary,
			skills: task.skills,
			preScript: task.preScript,
		});
		const endedAt = Date.now();

		this.#schedulerStorage.updateExecution(executionId, {
			status: exitCode === 0 ? "success" : "failure",
			exitCode,
			output: timedOut ? `[TIMED OUT after ${task.timeoutMs ?? 30_000}ms]\n${output}` : output,
			stderr: timedOut ? `[TIMED OUT]\n${stderr}` : stderr,
			endedAt,
		});

		if (exitCode !== 0 || timedOut) {
			logger.warn("Cron task failed", { taskId: task.id, taskName: task.name, exitCode, timedOut });
		} else {
			logger.debug("Cron task succeeded", { taskId: task.id, taskName: task.name });
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// Message Handling
	// ═══════════════════════════════════════════════════════════════════

	async #handleInboundMessage(msg: InboundMessage): Promise<void> {
		logger.debug("Received message", {
			channel: msg.channelId,
			user: msg.userId,
			group: msg.isGroup ? msg.conversationTitle : "DM",
		});

		try {
			// Find or create session
			let session = await this.#store?.getSession(msg.channelId, msg.conversationId);
			const now = Date.now();
			if (!session && this.#store) {
				const sessionPath = this.#buildSessionPath(msg.channelId, msg.conversationId);
				session = await this.#store.createSession({
					channelId: msg.channelId,
					userId: msg.userId,
					conversationId: msg.conversationId,
					createdAt: now,
					updatedAt: now,
					ompSessionPath: sessionPath,
					status: "active",
				});
			} else if (session && !session.ompSessionPath && this.#store) {
				const sessionPath = this.#buildSessionPath(msg.channelId, msg.conversationId);
				await this.#store.updateSession(session.id, { ompSessionPath: sessionPath, updatedAt: now });
				session = { ...session, ompSessionPath: sessionPath };
			}

			if (!session) {
				logger.error("Failed to create session", { channelId: msg.channelId, conversationId: msg.conversationId });
				return;
			}

			// Send "processing" placeholder first
			const placeholder: OutboundMessage = {
				channelId: msg.channelId,
				conversationId: msg.conversationId,
				content: { type: "markdown", markdown: "thinking..." },
				sessionWebhook: msg.sessionWebhook,
			};
			await this.#registry.sendMessage(placeholder);

			// Forward to agent bridge
			const response = await this.#forwardToAgent(msg, session);

			// Send final response
			if (response) {
				const outbound: OutboundMessage = {
					channelId: msg.channelId,
					conversationId: msg.conversationId,
					content: { type: "text", text: response },
					sessionWebhook: msg.sessionWebhook,
				};
				await this.#registry.sendMessage(outbound);
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

	async #forwardToAgent(msg: InboundMessage, session: SessionRecord): Promise<string | null> {
		// Multi-account routing: if the message has an accountId, route to
		// the matching per-account bridge
		if (msg.accountId && this.#accountBridges.has(msg.accountId)) {
			const bridge = this.#accountBridges.get(msg.accountId)!;
			if (bridge.isRunning) {
				return bridge.forward(msg, session);
			}
			logger.warn("Account bridge not running, falling back to default", { accountId: msg.accountId });
		}

		// Fall through to default bridge
		return this.#bridge.forward(msg, session);
	}

	#buildSessionPath(channelId: string, conversationId: string): string {
		const dataDir = getDataDir(this.#config);
		const safeId = conversationId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
		return `${dataDir}/sessions/${channelId}/${safeId}.jsonl`;
	}
}
