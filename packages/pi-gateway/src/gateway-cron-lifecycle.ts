/**
 * Cron scheduler lifecycle — start / stop / execute / deliver.
 *
 * Encapsulates the scheduler orchestration logic that was inline in Gateway:
 * constructing CronService + SchedulerEngine, executing cron agent prompts,
 * and delivering results to channels.
 */
import * as path from "node:path";
import { buildAgentSessionPath } from "@oh-my-pi/pi-coding-agent/skeleton";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import { AgentBridge } from "./agent-bridge";
import { getDataDir } from "./config";
import { CronService } from "./scheduler/cron-service";
import { SchedulerEngine } from "./scheduler/engine";
import { computeInactivityBudgetMs } from "./scheduler/executor";
import { SchedulerFileStore } from "./scheduler/file-store";
import { SchedulerDbStorage } from "./scheduler/storage";
import type { ScheduledTask } from "./scheduler/types";
import { DEFAULT_SCHEDULER_CONFIG, getSchedulerDbPath, getSchedulerDir } from "./scheduler/types";
import type { GatewayConfig, OutboundMessage } from "./types";

/** Interface for the subset of Gateway that CronLifecycle needs. */
export interface CronGatewayDeps {
	config: GatewayConfig;
	bridge: AgentBridge;
	accountBridges: Map<string, AgentBridge>;
	accountAgentDirs: Map<string, string>;
	registry: { sendMessage(msg: OutboundMessage): Promise<void> };
	getAccountBridge(accountId: string): AgentBridge | undefined;
	writeStatusFile(): Promise<void>;
}

export class CronLifecycle {
	#deps: CronGatewayDeps;
	#schedulerStorage: SchedulerDbStorage | null = null;
	#schedulerEngine: SchedulerEngine | null = null;
	#schedulerFileStore: SchedulerFileStore | null = null;
	#cronService: CronService | null = null;
	#watchInterval: ReturnType<typeof setInterval> | null = null;

	constructor(deps: CronGatewayDeps) {
		this.#deps = deps;
	}

	// ═══════════════════════════════════════════════════════════════════
	// Public API
	// ═══════════════════════════════════════════════════════════════════

	async start(): Promise<void> {
		const cronConfig = this.#deps.config.cron;
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

		const ompBinary = this.#deps.config.agent?.ompPath ?? "omp";
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

		const tickMs = cronConfig.tickIntervalMs ?? 60_000;
		let tickCount = 0;
		this.#watchInterval = setInterval(() => {
			this.#schedulerFileStore?.syncToDb();
			this.#schedulerEngine?.reload();
			this.#deps.writeStatusFile();
			tickCount++;
			if (tickCount % 10 === 0 && this.#schedulerStorage) {
				this.#schedulerStorage.pruneExecutions(30, 100);
			}
		}, tickMs);

		logger.debug("Cron scheduler started", {
			taskCount: this.#schedulerEngine.getActiveTaskIds().length,
			tickMs,
		});
	}

	stop(): void {
		if (this.#watchInterval) {
			clearInterval(this.#watchInterval);
			this.#watchInterval = null;
		}
		this.#schedulerEngine?.stop();
		this.#schedulerEngine = null;
		this.#schedulerStorage?.close();
		this.#schedulerStorage = null;
		this.#schedulerFileStore = null;
	}

	get engineRunning(): boolean {
		return this.#schedulerEngine != null;
	}

	get activeTaskCount(): number {
		return this.#schedulerEngine?.getActiveTaskIds().length ?? 0;
	}

	/** Exposed for cron-from-message: createCronTaskFromMessage needs the storage. */
	get schedulerStorage(): SchedulerDbStorage | null {
		return this.#schedulerStorage;
	}

	// ═══════════════════════════════════════════════════════════════════
	// Internal
	// ═══════════════════════════════════════════════════════════════════

	async #executeCronAgent(params: {
		agentDir: string;
		prompt: string;
		timeoutMs?: number;
		signal?: AbortSignal;
		disabledToolsets?: string[];
		model?: string;
		provider?: string;
	}): Promise<{ output: string; error?: string }> {
		const bridge = this.#getBridgeByAgentDir(params.agentDir);
		if (!bridge) {
			return { output: "", error: `No warm bridge found for agentDir: ${params.agentDir}` };
		}

		const cronSessionPath = buildAgentSessionPath(params.agentDir, `cron_${Date.now()}`);

		try {
			await bridge.setDisabledToolsets(params.disabledToolsets ?? []);
		} catch {
			// Best-effort
		}

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
			try {
				await bridge.setDisabledToolsets([]);
			} catch (restoreErr) {
				logger.error("Failed to restore disabled toolsets after cron task", {
					error: restoreErr instanceof Error ? restoreErr.message : String(restoreErr),
				});
			}
			if (originalModel?.model) {
				try {
					await bridge.setModel(originalModel.provider ?? "", originalModel.model);
				} catch (restoreErr) {
					logger.error("Failed to restore original model after cron task", {
						cronModel: params.model,
						originalModel: originalModel.model,
						error: restoreErr instanceof Error ? restoreErr.message : String(restoreErr),
					});
				}
			}
		}
	}

	#getBridgeByAgentDir(agentDir: string): AgentBridge | undefined {
		for (const [acctId, dir] of this.#deps.accountAgentDirs) {
			if (dir === agentDir) {
				return this.#deps.getAccountBridge(acctId);
			}
		}
		if (this.#deps.accountBridges.size === 0 && this.#deps.bridge.isRunning) {
			return this.#deps.bridge;
		}
		return undefined;
	}

	async #deliverCronResult(params: {
		channel: string;
		accountId?: string;
		toUserId?: string;
		toConversationId?: string;
		text: string;
	}): Promise<{ ok: boolean; error?: string }> {
		// The registry's sendMessage builds the lookup key as
		// `<channelId>:<accountId>` when accountId is set (see
		// channels/registry.ts#sendMessage), so we pass the bare channel
		// id here and let the registry do the suffixing.
		const msg: OutboundMessage = {
			channelId: params.channel,
			conversationId: params.toConversationId ?? `cron:${Date.now()}`,
			content: { type: "text", text: params.text },
			accountId: params.accountId,
			toUserId: params.toUserId,
		};

		const maxAttempts = 2;
		const retryDelayMs = 5_000;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				await this.#deps.registry.sendMessage(msg);
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
}
