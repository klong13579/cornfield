/**
 * Cron scheduler lifecycle — start / stop / execute / deliver.
 *
 * Encapsulates the scheduler orchestration logic that was inline in Gateway:
 * constructing CronService + SchedulerEngine, executing cron agent prompts,
 * and delivering results to channels.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import type { AgentBridge } from "./agent-bridge";
import type { AICardTarget } from "./channels/dingtalk-card";
import { mirrorDeliveryToSession } from "./scheduler/attach-to-session";
import { type CronCardPayload, deliverCronResultAsCard } from "./scheduler/cron-card-delivery";
import { CronService } from "./scheduler/cron-service";
import { SchedulerEngine } from "./scheduler/engine";
import { computeInactivityBudgetMs } from "./scheduler/executor";
import { SchedulerFileStore } from "./scheduler/file-store";
import { JsonFileStorage } from "./scheduler/json-file-storage";
import testRunCompletionTemplate from "./scheduler/prompts/test-run-completion.md" with { type: "text" };
import type { SchedulerStorage } from "./scheduler/types";
import { DEFAULT_SCHEDULER_CONFIG, getSchedulerDir } from "./scheduler/types";
import { cronSessionPath } from "./session-paths";
import type { DingTalkConfig, GatewayConfig, OutboundMessage } from "./types";

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
	#schedulerStorage: SchedulerStorage | null = null;
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

		this.#schedulerStorage = new JsonFileStorage();
		// Migrate from existing SQLite if present
		try {
			const { getSchedulerDbPath } = await import("./scheduler/types");
			const dbPath = getSchedulerDbPath();
			if (fs.existsSync(dbPath)) {
				const { migrated, errors } = (this.#schedulerStorage as JsonFileStorage).migrateFromDb(dbPath);
				if (migrated > 0) {
					logger.info("Migrated existing SQLite tasks to jobs.json", { migrated });
				}
				if (errors.length > 0) {
					logger.warn("Migration errors", { errors });
				}
			}
		} catch {
			// No SQLite to migrate — fresh start
		}

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
			// Reverse-resolve a task's agentDir to the registered channel
			// accountId. Without this, delivery falls back to the
			// deprecated `task.accountId` (often a workspace basename
			// like `omp-atomix` rather than the registered account id
			// `algorithm`), and the registry's `get(<channel>:<id>)`
			// miss makes the user see no card at all.
			resolveAccountId: agentDir => {
				for (const [acctId, dir] of this.#deps.accountAgentDirs) {
					if (dir === agentDir) return acctId;
				}
				return undefined;
			},
			// attach_to_session: mirror the cron brief to the user's chat
			// session JSONL so a follow-up DM/IM reply lands in a session
			// that already contains the brief. See
			// `mirrorDeliveryToSession` below for the resolution rules.
			mirrorToSession: async params => {
				return await this.#mirrorDeliveryToSession(params);
			},
			// Send a short, high-signal failure card to the user's IM
			// conversation when the normal summary path is silent
			// (agent errored, task timed out, or summary delivery
			// itself failed). Independent of the summary deliver()
			// so a misconfigured channel doesn't suppress both paths.
			notifyFailure: async params => {
				const kindLabel: Record<typeof params.kind, string> = {
					executeAgent_failed: "OMP 执行失败",
					task_failed: "任务失败",
					task_timed_out: "任务超时",
					delivery_failed: "推送失败",
				};
				const text =
					`❌ 定时任务 "${params.taskName}" ${kindLabel[params.kind]}\n\n` +
					`原因：${params.reason}\n` +
					`耗时：${(params.durationMs / 1000).toFixed(1)}s\n\n` +
					`请检查 gateway 日志或重跑任务。`;
				return await this.#deliverCronResult({
					channel: params.channel,
					accountId: params.accountId,
					toUserId: params.toUserId,
					toConversationId: params.toConversationId,
					text,
					// Surface the failure reason as the card body so the
					// AI Card path also produces a useful notification
					// (not just the legacy text path). Status is
					// always "failure" here — the notify path only
					// fires for non-success cases.
					card: {
						taskName: params.taskName,
						taskId: params.taskId,
						slug: params.taskName,
						status: "failure",
						exitCode: undefined,
						durationMs: params.durationMs,
						output: text,
						error: params.reason,
					},
				});
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

		// Consume any orphan test-run restore marker from a previous
		// gateway lifecycle. If the previous gateway (or a CLI test-run)
		// died between writing the marker and clearing it in `finally`,
		// the in-memory task map and the on-disk task may both be on
		// the one-shot schedule. The recovery is idempotent and cheap
		// (single `fs.existsSync` + no-op if absent). After recovery,
		// reload the engine so it picks up the restored schedule.
		if (this.#schedulerStorage) {
			const recovered = this.#schedulerStorage.consumeOrphanTestRunMarker();
			if (recovered) {
				this.#schedulerEngine.reload();
			}
		}

		const tickMs = cronConfig.tickIntervalMs ?? 60_000;
		let tickCount = 0;
		this.#watchInterval = setInterval(() => {
			// Check for an orphan test-run marker on every tick. This
			// is the safety net for cases where the test-run process
			// (CLI or LLM session) died AFTER writing the marker but
			// BEFORE its `finally` could clear it. The CLI's own
			// `process.on("exit")` handler is the primary path; this
			// tick handler is the belt-and-suspenders for both CLI
			// and LLM paths when the gateway itself stays alive.
			if (this.#schedulerStorage?.consumeOrphanTestRunMarker()) {
				this.#schedulerEngine?.reload();
			}
			this.#schedulerFileStore?.syncToDb();
			this.#schedulerEngine?.reload();
			this.#deps.writeStatusFile();
			tickCount++;
			if (tickCount % 10 === 0 && this.#schedulerStorage) {
				this.#schedulerStorage.pruneExecutions(30);
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
	get schedulerStorage(): SchedulerStorage | null {
		return this.#schedulerStorage;
	}

	/**
	 * Reload the gateway's in-memory scheduler engine from disk. Used
	 * by the corruption guard in `runTestRun` (via the host tool's
	 * `onReload` hook) after a corrupted task's schedule is
	 * auto-healed. The reload clears all in-memory `setTimeout` /
	 * `setInterval` / cron jobs and rebuilds them from the now-clean
	 * `jobs.json`. Without this, the OLD `setTimeout` left behind by
	 * the previous failed test-run would fire one more time and
	 * deliver a stale card to the user.
	 *
	 * Idempotent; safe to call when the engine is stopped (no-op
	 * via the `?.`). Used in-process only; the CLI's `runTestRun`
	 * can't reach the gateway's engine and instead relies on the
	 * gateway's own tick (≤ 60s) to pick up the change.
	 */
	engineReload(): void {
		this.#schedulerEngine?.reload();
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
		if (!params.agentDir) {
			throw new Error("executeCronAgent: agentDir required (cron tasks must declare a per-agent sessions root)");
		}
		const bridge = this.#getBridgeByAgentDir(params.agentDir);
		if (!bridge) {
			return { output: "", error: `No warm bridge found for agentDir: ${params.agentDir}` };
		}

		const cronSessionFilePath = cronSessionPath(params.agentDir);

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
				sessionPath: cronSessionFilePath,
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
		card?: {
			taskName: string;
			taskId: string;
			slug: string;
			status: "success" | "failure" | "timed_out";
			exitCode: number | undefined;
			durationMs: number;
			output: string;
			error?: string;
		};
		/**
		 * B 方案: origin session path for the LLM `cron.test-run` host
		 * tool. Captured at the start of `onTrigger` and passed
		 * through. The notifier uses this directly instead of
		 * re-reading the marker (which may have been consumed by
		 * orphan recovery during a long agent run).
		 */
		origin?: { sessionPath: string; accountId: string };
	}): Promise<{ ok: boolean; error?: string }> {
		// Dispatch by `cron.deliveryMode` (default "card"). The text
		// path is the legacy fallback; "text" mode skips cards entirely
		// (kill switch), "card" mode tries the card first and falls
		// back to text on any card-API failure so the user always
		// gets a result.
		const mode = this.#deps.config.cron?.deliveryMode ?? "card";
		const card = params.card;

		let result: { ok: boolean; error?: string };
		if (mode === "card" && card) {
			const cardResult = await this.#deliverAsCard({
				card,
				channel: params.channel,
				accountId: params.accountId,
				toUserId: params.toUserId,
				toConversationId: params.toConversationId,
			});
			if (cardResult.ok) {
				result = cardResult;
			} else {
				logger.warn("Cron card delivery failed, falling back to text", {
					taskId: card.taskId,
					taskName: card.taskName,
					error: cardResult.error,
				});
				// Fall through to text path below.
				result = await this.#deliverAsText(params);
			}
		} else if (mode === "card" && !card) {
			logger.debug("Cron card mode requested but no card payload supplied, using text", {
				taskName: params.text.slice(0, 80),
			});
			result = await this.#deliverAsText(params);
		} else {
			result = await this.#deliverAsText(params);
		}

		// After the user-facing delivery (card or text), push a new
		// prompt to the LLM's origin IM session so the LLM sees the
		// result in its next turn. This is the B 方案 layer on top
		// of the fire-and-forget host tool: the LLM called
		// `cron.test-run`, got an immediate `{ kind: "started" }`
		// acknowledgement, told the user the test-run was scheduled,
		// and now — after the actual run + card delivery — gets a
		// follow-up turn with status / duration / preview.
		//
		// Best-effort: every failure is log + return. We never block
		// the cron delivery path on this; the notifier is
		// fire-and-forget (the `void ... .catch` pattern below).
		// The notifier does not own the marker — engine post-fire
		// restore still owns that.
		if (card) {
			this.notifyOriginSessionIfPending(card, result.ok, params.origin);
		}

		return result;
	}

	/**
	 * Card-mode deliver. Resolves the per-account DingTalk config,
	 * builds an AICardTarget from the cron task's toUserId /
	 * toConversationId, and calls the AI Card SDK. Returns
	 * `{ ok: false, error }` on any failure so the caller can fall
	 * back to the text path.
	 */
	async #deliverAsCard(params: {
		card: CronCardPayload;
		channel: string;
		accountId?: string;
		toUserId?: string;
		toConversationId?: string;
	}): Promise<{ ok: boolean; error?: string }> {
		const dtConfig = resolveDingTalkConfig(this.#deps.config, params.accountId);
		if (!dtConfig) {
			return { ok: false, error: "DingTalk config not found for the cron task's accountId" };
		}

		const target = buildCardTarget(params);
		if (!target) {
			return { ok: false, error: "Cannot build AI Card target (need toUserId or toConversationId)" };
		}

		const payload: CronCardPayload = {
			taskName: params.card.taskName,
			taskId: params.card.taskId,
			slug: params.card.slug,
			status: params.card.status,
			exitCode: params.card.exitCode,
			durationMs: params.card.durationMs,
			output: params.card.output,
			error: params.card.error,
		};

		return await deliverCronResultAsCard({
			dingtalkConfig: dtConfig,
			target,
			card: payload,
		});
	}

	/**
	 * Legacy text-mode deliver. Sends `params.text` via
	 * ChannelRegistry.sendMessage, which routes to
	 * DingTalkChannel.sendMessage (sampleText via Route 2/3).
	 */
	async #deliverAsText(params: {
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

	// attach_to_session: implementation moved to ./scheduler/attach-to-session.ts
	async #mirrorDeliveryToSession(params: {
		task: import("./scheduler/types").ScheduledTask;
		brief: string;
		delivery: { channel: string; accountId?: string; toUserId?: string; toConversationId?: string };
	}): Promise<{ ok: boolean; error?: string }> {
		const result = await mirrorDeliveryToSession(params);
		if (result.ok) {
			logger.debug("attach_to_session: mirrored cron delivery to chat session", {
				taskName: params.task.name,
				channel: params.delivery.channel,
			});
		}
		return result;
	}

	/**
	 * After the user-facing card / text delivery completes, push a new
	 * prompt to the LLM's origin IM session so the LLM sees the result
	 * in its next turn. The origin session path is captured at the
	 * START of `onTrigger` (before the agent runs) and passed in via
	 * `origin`. We do NOT re-read the marker here — orphan recovery
	 * may have consumed it during a long agent run.
	 *
	 * Best-effort. Three silent-return failure modes:
	 *   1. No origin supplied — not a test-run, or pre-B legacy.
	 *      Skip.
	 *   2. No bridge is running — nothing to dispatch on. Log + skip.
	 *   3. `bridge.executePrompt` throws — session closed, circuit
	 *      open, or transport down. Log + skip; never retry.
	 *
	 * Fire-and-forget: the call is dispatched but the function does
	 * NOT await it. Awaiting would block the cron delivery path for
	 * up to the LLM tool timeout (60s) on every test-run. The
	 * `runExclusive` queue on the bridge still serializes the call
	 * against the cron task's own `executePrompt`; we just don't
	 * wait for the result.
	 *
	 * Named without the `#` private-field prefix so tests can access
	 * it via `(lifecycle as any).notifyOriginSessionIfPending(...)`.
	 * The method is internal to the gateway lifecycle and not part
	 * of any public API; tests reach in only to exercise the
	 * notifier's silent-return paths.
	 */
	notifyOriginSessionIfPending(
		card: {
			taskName: string;
			taskId: string;
			slug: string;
			status: "success" | "failure" | "timed_out";
			exitCode: number | undefined;
			durationMs: number;
			output: string;
			error?: string;
		},
		cardOk: boolean,
		origin?: { sessionPath: string; accountId: string },
	): void {
		// No origin → not a test-run, or pre-B legacy. Silent return.
		if (!origin) {
			return;
		}

		// Pick the bridge that ran the test-run. Multi-account
		// gateways have separate bridges per account; the default
		// `bridge` may not be the one that ran the test-run (and may
		// not even be running). Use `accountId` to select the right
		// bridge from the per-account map; fall back to the default
		// bridge if the per-account one is missing.
		const bridge = origin.accountId
			? (this.#deps.getAccountBridge(origin.accountId) ?? this.#deps.bridge)
			: this.#deps.bridge;
		if (!bridge.isRunning) {
			logger.warn("[cron-notify] bridge not running; skipping origin notification", {
				taskName: card.taskName,
				accountId: origin.accountId ?? "(default)",
			});
			return;
		}

		const promptText = renderTestRunCompletionPrompt({
			taskName: card.taskName,
			status: card.status,
			exitCode: card.exitCode,
			durationMs: card.durationMs,
			output: card.output,
			error: card.error,
			cardDelivered: cardOk,
			recipientUserId: "", // not on the card payload; left blank in v1
		});

		logger.info("[cron-notify] pushing test-run completion to origin session", {
			taskName: card.taskName,
			taskId: card.taskId,
			originSessionPath: origin.sessionPath,
			status: card.status,
		});

		// Fire-and-forget. The bridge's runExclusive serializes the
		// call against the cron task's own prompt (which is already
		// done by the time we get here). We attach a catch so a
		// throw becomes a log line, not a crash.
		void bridge
			.executePrompt(promptText, {
				sessionPath: origin.sessionPath,
				timeoutMs: 60_000,
				inactivityMs: 30_000,
			})
			.then(() => {
				logger.info("[cron-notify] pushed to origin session", {
					taskName: card.taskName,
				});
			})
			.catch((err: unknown) => {
				const message = err instanceof Error ? err.message : String(err);
				logger.warn("[cron-notify] executePrompt failed; origin session may be closed or bridge down", {
					taskName: card.taskName,
					error: message,
				});
			});
	}
}

// ═══════════════════════════════════════════════════════════════════════
// Module-level helpers (no instance state)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Resolve the per-account DingTalk config for a cron task. Multi-account
 * gateways keep credentials under `config.channels.dingtalk.accounts[accountId]`;
 * single-account gateways keep them at `config.channels.dingtalk.appKey/appSecret`.
 *
 * Returns `null` if no usable credentials are found — the caller should
 * fall back to the text path in that case.
 */
function resolveDingTalkConfig(gatewayConfig: GatewayConfig, accountId: string | undefined): DingTalkConfig | null {
	const dt: DingTalkConfig | undefined = gatewayConfig.channels.dingtalk;
	if (!dt) return null;

	if (accountId && dt.accounts) {
		const account = dt.accounts[accountId];
		if (account?.appKey && account.appSecret) {
			return {
				...dt,
				appKey: account.appKey,
				appSecret: account.appSecret,
				robotCode: account.robotCode ?? dt.robotCode,
			};
		}
	}

	// Single-account / legacy mode: credentials at the top level.
	if (dt.appKey && dt.appSecret) {
		return dt;
	}

	return null;
}

/**
 * Build an AICardTarget from the cron task's `toUserId` /
 * `toConversationId`. The AI Card SDK accepts either a user (DM) or
 * a group target. Most cron tasks are DMs (`toUserId` is the staff
 * id of the user who scheduled the task); group delivery is rare and
 * v1 routes via `toConversationId` as a group openConversationId when
 * `toUserId` is missing.
 */
function buildCardTarget(params: { toUserId?: string; toConversationId?: string }): AICardTarget | null {
	if (params.toUserId) {
		return { type: "user", userId: params.toUserId };
	}
	if (params.toConversationId) {
		// Treat as group target when no toUserId. Group openConversationId
		// format is opaque to us; the SDK will reject malformed values.
		return { type: "group", openConversationId: params.toConversationId };
	}
	return null;
}

/**
 * Render the test-run-completion prompt (candidate 2 — summary + card
 * pointer). Called from `#maybeNotifyOriginSession` after the user-facing
 * card / text delivery completes. The output becomes a new user
 * message in the LLM's origin IM session.
 *
 * The `outputPreview` is the first 200 chars of the task output, with
 * newlines collapsed to spaces (so the preview stays on one line in
 * the rendered prompt). The full output is in the card the user
 * already received; the preview is a fingerprint the LLM can use to
 * recognize the run if the user references it.
 */
function renderTestRunCompletionPrompt(input: {
	taskName: string;
	status: "success" | "failure" | "timed_out";
	exitCode: number | undefined;
	durationMs: number;
	output: string;
	error: string | undefined;
	cardDelivered: boolean;
	recipientUserId: string;
}): string {
	const durationSeconds = (input.durationMs / 1000).toFixed(1);
	const rawPreview = (input.output ?? "").replace(/\s+/g, " ").trim();
	const outputPreview = rawPreview.length > 200 ? `${rawPreview.slice(0, 200)}…` : rawPreview;
	return prompt.render(testRunCompletionTemplate, {
		taskName: input.taskName,
		status: input.status,
		exitCode: input.exitCode,
		durationSeconds,
		outputPreview: outputPreview || undefined,
		error: input.error,
		cardDelivered: input.cardDelivered,
		recipientUserId: input.recipientUserId || "用户",
	});
}
