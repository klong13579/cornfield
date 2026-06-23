/**
 * Scheduling engine that manages active cron jobs using croner.
 */
import { logger } from "@oh-my-pi/pi-utils";
import { Cron } from "croner";
import type { EngineOptions, ScheduledTask, SchedulerStorage } from "./types";
import { getNextRun, getNextRuns, parseSchedule } from "./types";

const MAX_RETRY_DELAY_MS = 300_000; // 5 min cap

function getRetryDelay(backoffMs: number[], attemptIndex: number): number {
	if (attemptIndex < backoffMs.length) {
		return Math.min(backoffMs[attemptIndex]!, MAX_RETRY_DELAY_MS);
	}
	return Math.min(backoffMs[backoffMs.length - 1]! * 2, MAX_RETRY_DELAY_MS);
}

const MIN_GRACE_SEC = 120;
const MAX_GRACE_SEC = 7200;

function computeGraceSeconds(task: ScheduledTask): number {
	const parsed = parseSchedule(task.cron);
	const scheduleType = task.scheduleType ?? parsed.type ?? "cron";

	if (scheduleType === "interval" && parsed.intervalMs) {
		return Math.min(MAX_GRACE_SEC, Math.max(MIN_GRACE_SEC, Math.floor(parsed.intervalMs / 2000)));
	}
	if (scheduleType === "cron") {
		const runs = getNextRuns(task.cron, 2);
		if (runs.length >= 2) {
			const gapSec = Math.floor((runs[1]!.getTime() - runs[0]!.getTime()) / 1000 / 2);
			return Math.min(MAX_GRACE_SEC, Math.max(MIN_GRACE_SEC, gapSec));
		}
	}
	return MIN_GRACE_SEC;
}

function advanceNextRun(task: ScheduledTask): number | undefined {
	const parsed = parseSchedule(task.cron);
	const scheduleType = task.scheduleType ?? parsed.type ?? "cron";

	if (scheduleType === "interval" && parsed.intervalMs) {
		// Base on last scheduled run to prevent drift
		const base = task.nextRunAt ?? Date.now();
		return base + parsed.intervalMs;
	}
	if (scheduleType === "once") {
		return undefined; // one-shot: no next run
	}
	const nextRun = getNextRun(task.cron);
	return nextRun?.getTime();
}

export class SchedulerEngine {
	readonly #storage: SchedulerStorage;
	readonly #onTrigger: (task: ScheduledTask, executionId: string) => Promise<void>;
	readonly #cronJobs = new Map<string, Cron>();
	readonly #intervals = new Map<string, NodeJS.Timeout>();
	readonly #timeouts = new Map<string, NodeJS.Timeout>();
	readonly #taskMap = new Map<string, ScheduledTask>();
	#running = false;

	constructor(options: EngineOptions) {
		this.#storage = options.storage;
		this.#onTrigger = options.onTrigger;
	}

	start(): void {
		if (this.#running) return;
		this.#running = true;

		const tasks = this.#storage.listTasks();
		for (const task of tasks) {
			if (task.status === "active") {
				try {
					this.schedule(task);
				} catch (error) {
					logger.error("Failed to schedule task, skipping", {
						taskId: task.id,
						taskName: task.name,
						error: error instanceof Error ? error.message : String(error),
					});
					this.#storage.updateTask(task.id, { status: "disabled" });
				}
			}
		}

		logger.debug("Scheduler engine started", { taskCount: this.#cronJobs.size });
	}

	stop(): void {
		if (!this.#running) return;
		this.#running = false;

		for (const job of this.#cronJobs.values()) {
			job.stop();
		}
		this.#cronJobs.clear();

		for (const interval of this.#intervals.values()) {
			clearInterval(interval);
		}
		this.#intervals.clear();

		for (const timeout of this.#timeouts.values()) {
			clearTimeout(timeout);
		}
		this.#timeouts.clear();

		this.#taskMap.clear();

		logger.debug("Scheduler engine stopped");
	}

	reload(): void {
		if (!this.#running) return;

		const tasks = this.#storage.listTasks();
		const activeIds = new Set<string>();

		for (const task of tasks) {
			if (task.status === "active") {
				activeIds.add(task.id);
				const existing = this.#taskMap.get(task.id);
				if (!existing || existing.cron !== task.cron || existing.command !== task.command) {
					this.schedule(task);
				}
			}
		}

		for (const [id, job] of this.#cronJobs) {
			if (!activeIds.has(id)) {
				job.stop();
				this.#cronJobs.delete(id);
				this.#taskMap.delete(id);
			}
		}

		logger.debug("Scheduler engine reloaded", { taskCount: this.#cronJobs.size });
	}

	schedule(task: ScheduledTask): void {
		this.unschedule(task.id);
		if (task.status !== "active") return;

		const parsed = parseSchedule(task.cron);
		const scheduleType = task.scheduleType ?? parsed.type ?? "cron";

		if (scheduleType === "interval" && parsed.intervalMs) {
			const interval = setInterval(async () => {
				if (!this.#running) return;
				await this.#handleTrigger(task.id);
			}, parsed.intervalMs);
			this.#intervals.set(task.id, interval);
			this.#taskMap.set(task.id, task);
			this.#storage.updateTask(task.id, { nextRunAt: Date.now() + parsed.intervalMs });
		} else if (scheduleType === "once") {
			const target = parsed.nextRunAt ?? task.nextRunAt ?? Date.now();
			const delay = target - Date.now();
			if (delay > 0) {
				const timeout = setTimeout(async () => {
					if (!this.#running) return;
					await this.#handleTrigger(task.id);
					// Auto-disable one-shot jobs after execution
					this.#storage.updateTask(task.id, { status: "disabled" });
				}, delay);
				this.#timeouts.set(task.id, timeout);
				this.#taskMap.set(task.id, task);
				this.#storage.updateTask(task.id, { nextRunAt: target });
			} else {
				logger.warn("One-shot task scheduled for the past, disabling", { taskId: task.id });
				this.#storage.updateTask(task.id, { status: "disabled" });
			}
		} else {
			try {
				const cron = new Cron(task.cron, async () => {
					if (!this.#running) return;
					await this.#handleTrigger(task.id);
				});
				this.#cronJobs.set(task.id, cron);
				this.#taskMap.set(task.id, task);

				const nextRun = getNextRun(task.cron);
				if (nextRun) {
					this.#storage.updateTask(task.id, { nextRunAt: nextRun.getTime() });
				}
			} catch (error) {
				logger.error("Invalid cron expression for task, disabling", {
					taskId: task.id,
					taskName: task.name,
					cron: task.cron,
					error: error instanceof Error ? error.message : String(error),
				});
				this.#storage.updateTask(task.id, { status: "disabled" });
			}
		}
	}

	unschedule(taskId: string): void {
		const job = this.#cronJobs.get(taskId);
		if (job) {
			job.stop();
			this.#cronJobs.delete(taskId);
		}

		const interval = this.#intervals.get(taskId);
		if (interval) {
			clearInterval(interval);
			this.#intervals.delete(taskId);
		}

		const timeout = this.#timeouts.get(taskId);
		if (timeout) {
			clearTimeout(timeout);
			this.#timeouts.delete(taskId);
		}

		this.#taskMap.delete(taskId);
	}

	getActiveTaskIds(): string[] {
		return Array.from(this.#cronJobs.keys());
	}

	async #handleTrigger(taskId: string): Promise<void> {
		const task = this.#taskMap.get(taskId);
		if (!task || !this.#running) return;

		// Grace window: if task is overdue beyond the grace period, skip execution
		// and advance to next run. Prevents backlog explosion after gateway restart.
		if (task.nextRunAt) {
			const overdueSec = (Date.now() - task.nextRunAt) / 1000;
			const graceSec = computeGraceSeconds(task);
			if (overdueSec > graceSec) {
				const nextRunAt = advanceNextRun(task);
				this.#storage.updateTask(task.id, { nextRunAt });
				logger.warn("Task skipped due to grace window", {
					taskId: task.id,
					taskName: task.name,
					overdueSec: Math.round(overdueSec),
					graceSec,
				});
				return;
			}
		}

		// At-most-once: advance next_run BEFORE execution.
		// If the process crashes mid-execution, the job won't re-fire on restart.
		const nextRunAt = advanceNextRun(task);
		this.#storage.updateTask(task.id, { nextRunAt });

		const retryConfig = task.retry;
		const maxAttempts = retryConfig?.maxAttempts ?? 0;
		const backoffMs = retryConfig?.backoffMs ?? [10_000, 30_000, 60_000];

		let lastError: Error | undefined;
		let succeeded = false;

		for (let attempt = 0; attempt <= maxAttempts; attempt++) {
			if (attempt > 0) {
				const delay = getRetryDelay(backoffMs, attempt - 1);
				logger.debug("Retrying task", { taskId, attempt, delayMs: delay });
				await Bun.sleep(delay);
			}

			const exec = this.#storage.recordExecution({
				taskId: task.id,
				startedAt: Date.now(),
				status: "running",
			});

			try {
				await this.#onTrigger(task, exec.id);
				this.#storage.updateExecution(exec.id, {
					status: "success",
					endedAt: Date.now(),
				});
				succeeded = true;
				break;
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));
				this.#storage.updateExecution(exec.id, {
					status: "failure",
					endedAt: Date.now(),
				});
				logger.warn("Task attempt failed", {
					taskId,
					attempt,
					error: lastError.message,
				});
			}
		}

		const currentTask = this.#storage.getTask(task.id);

		if (succeeded) {
			const newRunCount = (currentTask?.runCount ?? 0) + 1;
			const newRepeatCompleted = (currentTask?.repeatCompleted ?? 0) + 1;
			const repeatExhausted = (currentTask?.repeatCount ?? undefined) !== undefined && newRepeatCompleted >= (currentTask?.repeatCount ?? Infinity);

			this.#storage.updateTask(task.id, {
				lastRunAt: Date.now(),
				runCount: newRunCount,
				repeatCompleted: newRepeatCompleted,
				consecutiveFailures: 0,
				// Auto-disable when repeat count is exhausted
				...(repeatExhausted ? { status: "disabled" } : {}),
			});

			if (repeatExhausted) {
				this.unschedule(task.id);
				logger.info("Task auto-disabled after exhausting repeat count", {
					taskId: task.id,
					taskName: task.name,
					repeatCount: currentTask?.repeatCount,
				});
			}
		} else {
			this.#storage.updateTask(task.id, {
				lastRunAt: Date.now(),
				runCount: (currentTask?.runCount ?? 0) + 1,
				failCount: (currentTask?.failCount ?? 0) + 1,
				consecutiveFailures: (currentTask?.consecutiveFailures ?? 0) + 1,
			});
			if (lastError) {
				logger.error("Task failed after all retries", {
					taskId,
					task: task.name,
					maxAttempts,
					error: lastError.message,
				});
			}
		}
	}
}
