/**
 * CronService — decoupled cron orchestration via dependency injection.
 *
 * The gateway constructs CronService with two injected interfaces:
 * - executeAgent: runs an agent prompt and returns the result
 * - deliver: sends the result to a channel
 *
 * CronService itself knows nothing about AgentBridge, ChannelRegistry,
 * DingTalk OAuth, or any platform-specific details.
 */

import { findAgentSessionPath } from "../session-paths";
import { type CronRunDiagnostics, normalizeCronRunDiagnostics, parseAgentSessionForToolFailures } from "./diagnostics";
import { appendDeliveryFailureLog, appendExecutionLog } from "./execution-log";
import { executeScheduledCommand, SILENT_MARKER } from "./executor";
import type { ScheduledTask, SchedulerStorage, TaskExecution } from "./types";

/** Logger contract consumed by CronService. */
export interface CronLogger {
	debug: (msg: string, ctx?: unknown) => void;
	info: (msg: string, ctx?: unknown) => void;
	warn: (msg: string, ctx?: unknown) => void;
	error: (msg: string, ctx?: unknown) => void;
}

/** Execute an agent prompt and return the result. */
export type ExecuteAgentFn = (params: {
	agentDir: string;
	prompt: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	/** Toolsets to disable during execution (e.g. ['cronjob', 'messaging']) */
	disabledToolsets?: string[];
	/** Per-task model override */
	model?: string;
	/** Per-task provider override */
	provider?: string;
}) => Promise<{ output: string; error?: string }>;

/** Deliver a result to a channel (internally handles retry). */
export type DeliverFn = (params: {
	channel: string;
	accountId?: string;
	toUserId?: string;
	toConversationId?: string;
	text: string;
}) => Promise<{ ok: boolean; error?: string }>;

/**
 * Notify the user that a cron run failed in a way that the normal
 * delivery path would not surface (agent errored out, task timed out,
 * summary delivery itself failed, etc.). The notification is a short,
 * high-signal error message — not the full output. Implementations
 * should retry internally like {@link DeliverFn}; from the caller's
 * perspective this is best-effort.
 *
 * This is the user-facing safety net for "why is my cron task silent":
 * even when the regular summary delivery is misconfigured or the
 * task output is empty, the user gets a card saying "task X failed,
 * check the gateway log". Without this, a delivery-channel mismatch
 * (e.g. workspace basename ≠ accountId) makes the cron run
 * indistinguishable from "nothing happened" in the user's IM client.
 */
export type NotifyCronFailureFn = (params: {
	channel: string;
	accountId?: string;
	toUserId?: string;
	toConversationId?: string;
	taskName: string;
	taskId: string;
	reason: string;
	kind: "executeAgent_failed" | "task_failed" | "task_timed_out" | "delivery_failed";
	durationMs: number;
}) => Promise<{ ok: boolean; error?: string }>;

/** Reverse-resolve a task's `agentDir` to the registered channel
 *  `accountId`. Returns undefined if the agentDir is not mapped to a
 *  live bridge (e.g. cron test-run during a bridge restart). */
export type ResolveAccountIdFn = (agentDir: string) => string | undefined;

/** Dependencies injected by the gateway. */
export interface CronDeps {
	executeAgent: ExecuteAgentFn;
	deliver: DeliverFn;
	log: CronLogger;
	/** Optional. See {@link ResolveAccountIdFn}. */
	resolveAccountId?: ResolveAccountIdFn;
	/** Optional. See {@link NotifyCronFailureFn}. */
	notifyFailure?: NotifyCronFailureFn;
}

/** Result of a cron trigger execution. */
export interface CronTriggerResult {
	execution: TaskExecution;
	delivered: boolean;
	deliveryError?: string;
}

/**
 * Build the cron context prefix injected before the task prompt.
 *
 * Four rules, each spelled out so the agent does not have to guess:
 *   1. Do not invoke the `cron` host tool (cronjob toolset is disabled).
 *      Prevents accidental recursion — a cron task creating more cron tasks.
 *   2. Do not call proactive messaging tools (messaging toolset is disabled).
 *      Tools like `dws chat message send` / `chat_post` would duplicate the
 *      gateway's automatic delivery. Note: this is about tool *calls*, not
 *      about whether to write a reply at all — the reply text itself is the
 *      deliverable.
 *   3. The reply text IS the delivery. The gateway scans the response body
 *      and renders it as a DingTalk AI card to the original conversation,
 *      so the agent should just produce its final answer in the reply body
 *      and not try to push it anywhere itself. This is true even if the
 *      task wording says "发给用户" / "send to user" / "notify" / etc.
 *   4. If there is genuinely nothing new to report, respond with exactly
 *      `[SILENT]` and nothing else. The gateway detects this marker and
 *      suppresses delivery — no card is sent. Never combine `[SILENT]`
 *      with other content; either report findings normally, or output
 *      `[SILENT]` alone.
 *
 * If we ever drop the toolsets-level block in `executor.ts`, this prompt
 * remains the last line of defense — keep it precise.
 */
export function buildCronContextPrefix(task: ScheduledTask): string {
	const agentLabel = task.agentDir ? (task.agentDir.split("/").pop() ?? task.agentDir) : (task.accountId ?? "default");
	return (
		`[CRON-CONTEXT] You are running as a scheduled task (cron). Agent: ${agentLabel}.\n\n` +
		"Four rules for this run:\n" +
		"1. Do NOT call the `cron` host tool (create / list / update / delete scheduled tasks). The `cronjob` toolset is disabled for this run — calling it would either fail or recursively schedule more tasks.\n" +
		"2. Do NOT call proactive messaging tools (e.g. `dws chat message send`, `chat_post`, anything in the `messaging` toolset). The `messaging` toolset is disabled. These would create duplicate notifications on top of the gateway's own delivery.\n" +
		'3. Your reply text IS the delivery. The gateway scans the body of your final reply and renders it as a DingTalk AI card to the original conversation. So just write your answer in the reply body and stop — do not call any `send` tool, do not try to push it anywhere. This applies even if the task wording says "发给用户" / "send to user" / "notify" / "告诉用户".\n' +
		'4. If there is genuinely nothing new to report (no changes, no errors, no notable findings), respond with exactly "[SILENT]" and nothing else. The gateway detects this marker and suppresses delivery — no card is sent to the user. Never combine [SILENT] with other content; either report your findings normally, or output [SILENT] alone.\n\n'
	);
}

/**
 * Build the delivery summary string from task execution results.
 *
 * Output is truncated to 2000 characters to avoid oversized messages.
 */
export function buildDeliverySummary(
	task: ScheduledTask,
	output: string,
	exitCode: number | undefined,
	durationMs: number,
): string {
	const prefix = exitCode === 0 ? "✅" : "⏰";
	const truncatedOutput = output.slice(0, 2000);
	return `${prefix} ${task.name} (exit ${exitCode ?? "?"}, ${(durationMs / 1000).toFixed(1)}s)\n\n${truncatedOutput}`;
}

/**
 * Resolve the effective agentDir for a task, with fallback to deprecated accountId.
 *
 * During the migration period, tasks may still have `accountId` but not
 * `agentDir`. This function returns `agentDir` if present, otherwise
 * returns `accountId` (which the caller can resolve to a path via config).
 */
export function resolveAgentDir(task: ScheduledTask): string | undefined {
	return task.agentDir ?? task.accountId;
}

/**
 * Resolve the effective delivery configuration for a task.
 *
 * `resolveAccountId` is an optional gateway-side hook that maps a task's
 * `agentDir` back to the registered channel `accountId` (e.g. resolving
 * `/Users/.../OMP-workspace-test/omp-atomix` → `algorithm`). This is the
 * source of truth — the registry's multi-account channel key is
 * `<channel>:<accountId>`, and the workspace basename (e.g. `omp-atomix`)
 * is NOT the accountId. The deprecated `task.accountId` field may hold
 * a stale workspace name from before the migration; callers should
 * prefer the agentDir-based lookup.
 */
export function resolveDelivery(
	task: ScheduledTask,
	resolveAccountId?: (agentDir: string) => string | undefined,
):
	| {
			channel: string;
			accountId?: string;
			toUserId?: string;
			toConversationId?: string;
			mode: "announce" | "none";
	  }
	| undefined {
	if (task.delivery) {
		// Priority: explicit delivery.accountId → reverse-resolved accountId
		// from agentDir → deprecated task.accountId (last-resort fallback
		// for tasks written before the agentDir migration).
		const accountId =
			task.delivery.accountId ?? (task.agentDir ? resolveAccountId?.(task.agentDir) : undefined) ?? task.accountId;
		return {
			...task.delivery,
			accountId,
		};
	}
	return undefined;
}

/** Additional dependencies for CronService beyond the injected interfaces. */
export interface CronServiceDeps extends CronDeps {
	storage: SchedulerStorage;
	ompBinary: string;
}

/**
 * CronService — orchestrates cron task execution via dependency injection.
 *
 * The gateway constructs CronService with two injected interfaces:
 * - executeAgent: runs an agent prompt and returns the result
 * - deliver: sends the result to a channel
 *
 * CronService itself knows nothing about AgentBridge, ChannelRegistry,
 * DingTalk OAuth, or any platform-specific details. It coordinates:
 * 1. Building the cron context prefix (soft recursion guard)
 * 2. Calling executeAgent (warm bridge or cold subprocess)
 * 3. Recording execution results in storage + JSONL logs
 * 4. Delivering results via the injected deliver function
 * 5. Updating delivery error state
 */
export class CronService {
	#deps: CronServiceDeps;

	constructor(deps: CronServiceDeps) {
		this.#deps = deps;
	}

	async onTrigger(task: ScheduledTask, executionId: string): Promise<void> {
		const { storage, executeAgent, deliver, log, ompBinary, resolveAccountId, notifyFailure } = this.#deps;
		const startedAt = Date.now();
		const isAgent = task.taskType === "agent";

		const agentDir = resolveAgentDir(task);
		const cronContextPrefix = buildCronContextPrefix(task);

		let exitCode = 0;
		let output = "";
		let stderr = "";
		let timedOut = false;
		let executeAgentFailed: { reason: string } | null = null;

		// Structured diagnostics accumulator (push at collection points,
		// normalized & flushed to JSONL before the throw/finish).
		const diagnosticsEntries: CronRunDiagnostics["entries"] = [];
		const addDiag = (
			source: CronRunDiagnostics["entries"][number]["source"],
			severity: CronRunDiagnostics["entries"][number]["severity"],
			message: string,
			opts?: { exitCode?: number | null },
		) => {
			diagnosticsEntries.push({
				ts: Date.now(),
				source,
				severity,
				message,
				...(opts?.exitCode !== undefined ? { exitCode: opts.exitCode } : {}),
			});
		};

		// Preflight diagnostics
		if (!task.command?.trim()) {
			addDiag("cron-preflight", "warn", "Task has no command configured");
		}
		if (isAgent && !agentDir) {
			addDiag("cron-preflight", "warn", "Agent task has no agentDir - will use shell fallback");
		}

		// Try injected executeAgent (warm bridge path)
		if (isAgent && agentDir) {
			addDiag("cron-setup", "info", `Warm bridge execution (agentDir: ${agentDir.split("/").pop()})`, {
				exitCode: null,
			});
			log.debug("Executing cron task via injected executeAgent", {
				taskName: task.name,
				agentDir,
				modelOverride: task.model ?? null,
			});

			const result = await executeAgent({
				agentDir,
				prompt: cronContextPrefix + task.command,
				timeoutMs: task.timeoutMs,
				disabledToolsets: ["cronjob", "messaging"],
				model: task.model,
				provider: task.provider,
			});

			if (result.error && !result.output) {
				stderr = result.error;
				executeAgentFailed = { reason: stderr };
				addDiag("agent-run", "error", `Agent RPC failed: ${stderr}`);
				exitCode = 1;
				log.warn("executeAgent failed, falling back to omp --print", {
					taskName: task.name,
					error: stderr,
				});
			} else {
				output = result.output;
			}
		}

		// Fallback: cold subprocess execution
		if (!output) {
			const setupMsg = isAgent
				? "Falling back to cold subprocess after warm bridge failure"
				: "Running task via subprocess (no agent bridge)";
			addDiag("cron-setup", "info", setupMsg);
			try {
				const execResult = await executeScheduledCommand(task.command, {
					taskType: task.taskType,
					timeoutMs: task.timeoutMs,
					ompBinary,
					skills: task.skills,
					preScript: task.preScript,
					cwd: agentDir,
					promptPrefix: isAgent ? cronContextPrefix : undefined,
				});
				exitCode = execResult.exitCode;
				output = execResult.output;
				stderr = execResult.stderr;
				timedOut = execResult.timedOut;
				if (timedOut) {
					addDiag("exec", "error", `Subprocess timed out after ${task.timeoutMs ?? 30_000}ms`, { exitCode });
				}
			} catch (fallbackErr) {
				// The fallback can throw (e.g. posix_spawn ENOENT when
				// the omp binary is missing, or Bun.spawn unable to
				// resolve the shell on a stripped-down test environment).
				// Without this catch, the exception bubbles out of
				// onTrigger and we skip the failure-card delivery below
				// — the user sees nothing. Treat the fallback throw as
				// a hard task failure and continue.
				stderr = stderr || (fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr));
				exitCode = exitCode || 1;
				addDiag("exec", "error", `Fallback threw: ${stderr}`, { exitCode });
				log.error("Cron fallback execution threw", {
					taskId: task.id,
					taskName: task.name,
					error: stderr,
				});
			}
		}

		const endedAt = Date.now();
		const durationMs = endedAt - startedAt;

		// Link agent session trace for agent tasks. We use the per-agent
		// finder from session-paths (single source of truth) rather than
		// the legacy cross-tree walk. Pass `agentDir` directly when we
		// have it; fall back to a (deprecated) accountId-based lookup
		// when the task is unbound to an agentDir.
		const agentSessionPath =
			task.taskType === "agent" && agentDir ? findAgentSessionPath(agentDir, startedAt, endedAt) : undefined;

		// Parse agent session for tool failures (if session file exists).
		const toolDiagnostics = parseAgentSessionForToolFailures(agentSessionPath);
		if (toolDiagnostics) {
			for (const entry of toolDiagnostics.entries) {
				diagnosticsEntries.push(entry);
			}
		}

		// Record the execution result
		storage.updateExecution(executionId, {
			status: exitCode === 0 ? "success" : "failure",
			exitCode,
			output: timedOut ? `[TIMED OUT after ${task.timeoutMs ?? 30_000}ms]\n${output}` : output,
			stderr: timedOut ? `[TIMED OUT]\n${stderr}` : stderr,
			endedAt,
			...(agentSessionPath ? { agentSessionPath } : {}),
		});

		// If the agent (or pre-script) signaled silence, skip delivery entirely.
		// The LLM outputs [SILENT] when there's genuinely nothing to report;
		// the pre-script path uses the same marker. Either way, no card is sent.
		// Only suppress on success (exit 0) — a non-zero exit with [SILENT] is
		// likely a malformed response and the user should see it.
		const isSilent = exitCode === 0 && output.trim() === SILENT_MARKER;
		if (isSilent) {
			addDiag("delivery", "info", "Output is [SILENT] — suppressing delivery");
		}

		// Deliver result if configured (skip when silent)
		const deliveryConfig = resolveDelivery(task, resolveAccountId);
		if (deliveryConfig && deliveryConfig.mode === "announce" && !isSilent) {
			const prefix = exitCode === 0 ? "✅" : timedOut ? "⏰" : "❌";
			const summary = `${prefix} Task "${task.name}" completed (exit ${exitCode}, ${durationMs}ms)\n\n${output.slice(0, 2000)}`;

			const deliverResult = await deliver({
				channel: deliveryConfig.channel,
				accountId: deliveryConfig.accountId,
				toUserId: deliveryConfig.toUserId,
				toConversationId: deliveryConfig.toConversationId,
				text: summary,
			});

			if (!deliverResult.ok) {
				storage.updateTask(task.id, { lastDeliveryError: deliverResult.error });
				appendDeliveryFailureLog({
					ts: Date.now(),
					taskId: task.id,
					taskName: task.name,
					channel: deliveryConfig.channel,
					userId: deliveryConfig.toUserId,
					reason: deliverResult.error ?? "unknown",
					attempts: 0,
					exitCode,
				});
				addDiag("delivery", "error", `Delivery failed: ${deliverResult.error ?? "unknown"}`);
				log.error("Cron result delivery failed", {
					taskId: task.id,
					taskName: task.name,
					channel: deliveryConfig.channel,
					error: deliverResult.error,
				});
				// Best-effort user-facing notification. Independent of the
				// summary delivery above so a misconfigured channel
				// (Unknown channel) doesn't also suppress the
				// failure card. notifyFailure implementations retry
				// internally; here we just log the result.
				if (notifyFailure) {
					try {
						const notifyResult = await notifyFailure({
							channel: deliveryConfig.channel,
							accountId: deliveryConfig.accountId,
							toUserId: deliveryConfig.toUserId,
							toConversationId: deliveryConfig.toConversationId,
							taskName: task.name,
							taskId: task.id,
							reason: deliverResult.error ?? "unknown",
							kind: "delivery_failed",
							durationMs,
						});
						if (!notifyResult.ok) {
							log.error("Cron failure notification also failed", {
								taskId: task.id,
								taskName: task.name,
								error: notifyResult.error,
							});
						}
					} catch (notifyErr) {
						log.error("Cron failure notification threw", {
							taskId: task.id,
							taskName: task.name,
							error: notifyErr instanceof Error ? notifyErr.message : String(notifyErr),
						});
					}
				}
			} else {
				// Clear delivery error on success
				storage.updateTask(task.id, { lastDeliveryError: undefined });
			}
		}

		// Write full stdout/stderr to JSONL log with structured diagnostics.
		// This runs for both success and failure paths BEFORE the throw
		// so failures also produce a diagnostics trace in JSONL.

		const logDiagnostics = normalizeCronRunDiagnostics({ entries: diagnosticsEntries });
		appendExecutionLog(task.name, {
			id: executionId,
			ts: endedAt,
			exitCode,
			status: exitCode === 0 ? "success" : "failure",
			durationMs,
			output,
			stderr,
			...(logDiagnostics ? { diagnostics: logDiagnostics } : {}),
		});

		// Throw on failure so the engine's retry loop and statistics work.
		if (exitCode !== 0 || timedOut) {
			const msg = timedOut
				? `Task "${task.name}" timed out after ${task.timeoutMs ?? 30_000}ms`
				: `Task "${task.name}" failed (exit ${exitCode})`;
			log.warn(msg, { taskId: task.id, exitCode, timedOut });

			// User-facing notification: the regular summary above may or
			// may not have reached the user (if delivery itself
			// failed, the summary was lost). For pure agent failures
			// (executeAgent errored) and hard timeouts, send a short
			// failure card independently of the delivery path. The
			// notification is best-effort and does not affect the
			// throw — the engine's retry + stats still run.
			if (notifyFailure && deliveryConfig?.mode === "announce") {
				const reason =
					executeAgentFailed?.reason ??
					(timedOut ? `任务超时 (${task.timeoutMs ?? 30_000}ms)` : `exit code ${exitCode}`);
				const kind: "executeAgent_failed" | "task_failed" | "task_timed_out" = timedOut
					? "task_timed_out"
					: executeAgentFailed
						? "executeAgent_failed"
						: "task_failed";
				try {
					await notifyFailure({
						channel: deliveryConfig.channel,
						accountId: deliveryConfig.accountId,
						toUserId: deliveryConfig.toUserId,
						toConversationId: deliveryConfig.toConversationId,
						taskName: task.name,
						taskId: task.id,
						reason,
						kind,
						durationMs,
					});
				} catch (notifyErr) {
					log.error("Cron failure notification threw", {
						taskId: task.id,
						taskName: task.name,
						error: notifyErr instanceof Error ? notifyErr.message : String(notifyErr),
					});
				}
			}

			throw new Error(msg);
		}

		log.debug("Cron task succeeded", { taskId: task.id, taskName: task.name });
	}
}
