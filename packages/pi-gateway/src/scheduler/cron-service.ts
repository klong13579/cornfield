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

import { appendDeliveryFailureLog, appendExecutionLog } from "./execution-log";
import { executeScheduledCommand } from "./executor";
import type { ScheduledTask, SchedulerStorage, TaskExecution } from "./types";

/** Logger contract consumed by CronService. */
export interface CronLogger {
	debug: (msg: string, ctx?: unknown) => void;
	info: (msg: string, ctx?: unknown) => void;
	warn: (msg: string, ctx?: unknown) => void;
	error: (msg: string, ctx?: unknown) => void;
}

/** Execute an agent prompt and return the result. */
export interface ExecuteAgentFn {
	(params: {
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
	}): Promise<{ output: string; error?: string }>;
}

/** Deliver a result to a channel (internally handles retry). */
export interface DeliverFn {
	(params: {
		channel: string;
		accountId?: string;
		toUserId?: string;
		toConversationId?: string;
		text: string;
	}): Promise<{ ok: boolean; error?: string }>;
}

/** Dependencies injected by the gateway. */
export interface CronDeps {
	executeAgent: ExecuteAgentFn;
	deliver: DeliverFn;
	log: CronLogger;
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
 * This is a soft recursion guard: it tells the agent it's running as a
 * cron task and should not create new cron jobs or send messages.
 */
export function buildCronContextPrefix(task: ScheduledTask): string {
	const agentLabel = task.agentDir
		? task.agentDir.split("/").pop() ?? task.agentDir
		: task.accountId ?? "default";
	return `[CRON-CONTEXT] You are running as a scheduled task (cron). Do not create new cron jobs or send messages. Agent: ${agentLabel}.\n\n`;
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
 * Resolve the effective delivery configuration for a task, with fallback
 * to deprecated deliver/deliverUser fields.
 *
 * During the migration period, tasks may still have `deliver` + `deliverUser`
 * instead of the structured `delivery` object.
 */
export function resolveDelivery(task: ScheduledTask): {
	channel: string;
	accountId?: string;
	toUserId?: string;
	toConversationId?: string;
	mode: "announce" | "none";
} | undefined {
	if (task.delivery) {
		return task.delivery;
	}
	// Fallback: construct from deprecated fields
	if (task.deliver) {
		return {
			channel: task.deliver,
			toUserId: task.deliverUser,
			mode: "announce",
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
		const { storage, executeAgent, deliver, log, ompBinary } = this.#deps;
		const startedAt = Date.now();
		const isAgent = task.taskType === "agent";

		const agentDir = resolveAgentDir(task);
		const cronContextPrefix = buildCronContextPrefix(task);

		let exitCode = 0;
		let output = "";
		let stderr = "";
		let timedOut = false;

		// Try injected executeAgent (warm bridge path)
		if (isAgent && agentDir) {
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
		}

		const endedAt = Date.now();
		const durationMs = endedAt - startedAt;

		// Link agent session trace for agent tasks
		const agentSessionPath = task.taskType === "agent"
			? await findAgentSessionPathForCron(startedAt, endedAt)
			: undefined;

		// Record the execution result
		storage.updateExecution(executionId, {
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

		// Deliver result if configured
		const deliveryConfig = resolveDelivery(task);
		if (deliveryConfig && deliveryConfig.mode === "announce") {
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
				log.error("Cron result delivery failed", {
					taskId: task.id,
					taskName: task.name,
					channel: deliveryConfig.channel,
					error: deliverResult.error,
				});
			} else {
				// Clear delivery error on success
				storage.updateTask(task.id, { lastDeliveryError: undefined });
			}
		}

		// Throw on failure so the engine's retry loop and statistics work.
		if (exitCode !== 0 || timedOut) {
			const msg = timedOut
				? `Task "${task.name}" timed out after ${task.timeoutMs ?? 30_000}ms`
				: `Task "${task.name}" failed (exit ${exitCode})`;
			log.warn(msg, { taskId: task.id, exitCode, timedOut });
			throw new Error(msg);
		}

		log.debug("Cron task succeeded", { taskId: task.id, taskName: task.name });
	}
}

/** Lazy import to avoid circular dependency with cli-commands. */
async function findAgentSessionPathForCron(startedAt: number, endedAt: number): Promise<string | undefined> {
	const { findAgentSessionPath } = await import("./cli-commands");
	return findAgentSessionPath(startedAt, endedAt);
}