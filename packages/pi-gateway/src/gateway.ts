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
import * as fs from "node:fs/promises";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
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
import { SessionManager } from "./session-manager";
import { buildAgentSessionPath, ensureAgentDir, resolveAgentDir } from "./setup";
import type { InboundMessage, OutboundMessage } from "./types";

const PID_FILE = "gateway.pid";

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
}

export async function getGatewayStatus(config?: GatewayConfig): Promise<GatewayDaemonStatus> {
	const dataDir = getDataDir(config);
	const pidPath = path.join(dataDir, PID_FILE);

	try {
		const pidText = await fs.readFile(pidPath, "utf-8");
		const pid = parseInt(pidText.trim(), 10);
		if (isNaN(pid) || pid <= 0) {
			// Clean up invalid PID file
			await fs.unlink(pidPath).catch(() => {});
			return { running: false };
		}

		// Check if process exists
		try {
			process.kill(pid, 0);
		} catch {
			// Process dead — clean up stale PID file
			await fs.unlink(pidPath).catch(() => {});
			return { running: false, stalePidFile: true };
		}

		// Get PID file mtime as started time
		let startedAt: string | undefined;
		try {
			const stat = await fs.stat(pidPath);
			startedAt = stat.mtime.toLocaleString();
		} catch {
			// Best-effort
		}

		return { running: true, pid, startedAt };
	} catch {
		return { running: false };
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

		const hasDingTalkAccounts = Boolean(getDingTalkConfig(this.#config)?.accounts && Object.keys(getDingTalkConfig(this.#config)?.accounts ?? {}).length > 0);
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
				const bridge = new AgentBridge({
					...this.#config.agent,
					timeoutMs: account.timeoutMs ?? this.#config.agent?.timeoutMs,
					cwd: agentDir,
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
				}, `dingtalk:${accountId}`);
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

		await this.#registry.disconnectAll();
		this.#stopScheduler();

		const drained = await this.#sessionManager?.waitForAllDrained(30_000);
		if (drained === false) {
			logger.warn("Gateway shutdown timed out waiting for session queues", { queues: this.#sessionManager?.getQueueStats() ?? [] });
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
		this.#running = false;
		logger.debug("Gateway stopped");

		// Remove PID file
		try {
			await fs.unlink(path.join(getDataDir(this.#config), PID_FILE));
		} catch { /* non-fatal */ }
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

	async getStatus(): Promise<{
		running: boolean;
		channels: Array<{ id: string; name: string; connected: boolean }>;
		accounts: Array<{ accountId: string; bridgeRunning: boolean; agentDir?: string }>;
		sessions: number;
		queues: ReturnType<SessionManager["getQueueStats"]>;
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
		const accounts = Array.from(this.#accountBridges.entries()).map(([accountId, bridge]) => ({
			accountId,
			bridgeRunning: bridge.isRunning,
			agentDir: this.#accountAgentDirs.get(accountId),
		}));

		return {
			running: this.#running || await checkPidFile(getDataDir(this.#config), PID_FILE),
			channels,
			sessions: sessions.length,
			accounts,
			queues: this.#sessionManager?.getQueueStats() ?? [],
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
			const accountId = msg.accountId ?? "__default__";
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
					status: "active",
				});
			} else if (session && this.#store) {
				const sessionPath = this.#buildSessionPath(msg.channelId, accountId, msg.conversationId);
				if (session.ompSessionPath !== sessionPath) {
					if (session.ompSessionPath) {
						await this.#migrateSessionPath(session.ompSessionPath, sessionPath);
					}
					await this.#store.updateSession(session.id, { ompSessionPath: sessionPath, updatedAt: now });
					session = { ...session, ompSessionPath: sessionPath };
				}
			}

			if (!session) {
				logger.error("Failed to create session", { channelId: msg.channelId, accountId, conversationId: msg.conversationId });
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
				const outbound: OutboundMessage = {
					channelId: msg.channelId,
					conversationId: msg.conversationId,
					content: { type: "text", text: response },
					sessionWebhook: msg.sessionWebhook,
					accountId: msg.accountId,
				};
				try {
					await this.#registry.sendMessage(outbound);
				} catch (err) {
					logger.error("Failed to send final response", {
						accountId,
						conversationId: msg.conversationId,
						error: err instanceof Error ? err.message : String(err),
					});
				}
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
}
