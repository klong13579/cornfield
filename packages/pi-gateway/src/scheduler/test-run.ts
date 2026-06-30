/**
 * `runTestRun` — the core test-run logic, shared by the CLI and the LLM
 * `cron` host tool.
 *
 * A test-run is a **verification path**: it temporarily rewrites a task
 * to a one-shot schedule (e.g. `+90s` once), waits for the gateway
 * scheduler to fire it, then restores the original schedule. This is
 * the only way to exercise the **end-to-end pipeline** (warm bridge →
 * agent run → DingTalk delivery) without waiting for the real cron
 * tick. The CLI `cron run` skips delivery by design; `test-run` goes
 * through the real scheduler and reports the delivery verdict.
 *
 * Why a shared core:
 *   - CLI (`omp gateway cron test-run <name>`) and the LLM `cron` host
 *     tool action `test-run` need **identical** semantics. A drift
 *     between them would mean the operator verifies one thing and the
 *     agent verifies another — exactly the kind of split that hides
 *     bugs.
 *   - The CLI owns signal handling (SIGINT/SIGTERM restore) and
 *     console formatting; the host tool owns AbortSignal handling and
 *     JSON serialization. The shared core does the schedule rewrite +
 *     poll + restore, and returns a structured result.
 *
 * Critical invariant — **schedule restore MUST happen on every exit
 * path** (success, timeout, abort, error). The LLM AbortSignal path
 * in particular: if the agent decides mid-wait that test-run is no
 * longer needed and aborts, the task must not be left stuck on
 * `+<delay>s once`. The restore runs in a `try/finally`; the `finally`
 * is the contract.
 */

import { logger } from "@oh-my-pi/pi-utils";
import type { SchedulerDbStorage } from "./storage";
import type { TaskExecution } from "./types";

/**
 * Options for the shared test-run core.
 *
 * `inMs` and `timeoutMs` semantics:
 *   - `inMs` — how long from now until the one-shot fires. Default
 *     90_000ms (1.5x the default 60s gateway tick; reliable in normal
 *     configurations). Anything < 2x the gateway tick is in the
 *     "racy zone" — see {@link TestRunWarning}.
 *   - `timeoutMs` — after the one-shot has fired, how long to wait for
 *     the agent run to reach a terminal state (success / failure with
 *     exit code). Default 30_000ms.
 *   - Total tool call wall-time = inMs + timeoutMs. With defaults:
 *     120s. LLM tool calls can run this long; the OMP host-tool
 *     bridge imposes no client-side timeout. AbortSignal is honored
 *     on the polling loop and restores the schedule in `finally`.
 *
 * `tickIntervalMs` is the gateway's scheduler reload interval. The
 * default is 60_000ms; the host-tool caller passes the gateway's
 * configured value. Used to warn when `inMs` lands in the racy zone
 * (< 2x tick). The CLI default is also 60_000; the cron tool threads
 * the gateway's actual config through {@link CronToolContext}.
 */
export interface RunTestRunOptions {
	name: string;
	inMs?: number;
	timeoutMs?: number;
	noRestore?: boolean;
	/** Gateway scheduler reload interval. Used to flag racy inMs values. */
	tickIntervalMs: number;
	/** AbortSignal from the host-tool caller. Polling stops on abort and
	 *  the schedule snapshot is restored in `finally`. */
	signal?: AbortSignal;
	/** Storage handle. The cron tool resolves this lazily because the
	 *  scheduler DB is created by `CronLifecycle.start()` after the
	 *  dispatcher is wired. */
	storage: SchedulerDbStorage;
	/**
	 * Polling interval for execution table reads. Default 2000ms (CLI
	 * + LLM production path). Tests pass a smaller value (e.g. 25ms)
	 * to keep the suite fast; production callers should leave this
	 * alone because 2s is the right cadence for not hammering SQLite
	 * during a 90+ second wait.
	 */
	pollIntervalMs?: number;
}

/** Hard error — task not found, etc. The caller surfaces this to the
 *  user/LLM as a failed tool result. The schedule is NOT touched on
 *  this path. */
export interface TestRunHardError {
	kind: "task_not_found";
	name: string;
}

/** Soft error — the trigger fired (or didn't) but the result is not a
 *  clean success. Returned as part of {@link TestRunResult}; the
 *  schedule IS restored on this path. */
export type TestRunSoftError =
	| { kind: "trigger_timeout"; waitedMs: number; sawRunningExec: boolean; runningExecId?: string; scheduleRestored: boolean }
	| { kind: "task_failed"; execId: string; status: string; exitCode: number; stderr: string | null; scheduleRestored: boolean }
	| { kind: "delivery_failed"; execId: string; status: string; exitCode: number; deliveryError: string; scheduleRestored: boolean };

/** Result of a successful trigger + run. */
export interface TestRunSuccess {
	kind: "success";
	execId: string;
	status: string;
	exitCode: number;
	durationMs: number | null;
	stderr: string | null;
	delivery: { configured: boolean; ok: boolean; error: string | null };
	output: string | null;
	scheduleRestored: boolean;
	triggerLatencyMs: number;
}

/** Result of an aborted call. Schedule IS restored. */
export interface TestRunAborted {
	kind: "aborted";
	scheduleRestored: boolean;
	waitedMs: number;
}

/** Tagged result union. The caller pattern-matches on `kind`. */
export type TestRunResult = TestRunSuccess | TestRunSoftError | TestRunAborted;

const DEFAULT_IN_MS = 90_000;
const DEFAULT_TIMEOUT_MS = 30_000;
// Lower bounds are intentionally tiny (1s) so tests and operator
// workflows can use short values (e.g. `--in 1s` for a quick
// verification). The racy-zone warning in `runTestRun` still fires
// for short inMs relative to the gateway tick; the clamp is just a
// sanity rail against negative / zero / sub-second inputs.
const MIN_IN_MS = 1_000;
const MAX_IN_MS = 600_000; // 10 min — keeps total tool call bounded
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000; // 2 min — how long to wait for agent terminal state
const POLL_INTERVAL_MS = 2_000;
const TRIGGER_WINDOW_SLACK_MS = 5_000; // absorbs clock drift between caller and gateway
const DEFAULT_TICK_MS = 60_000;

/**
 * Run the test-run core. Returns a tagged result; the caller is
 * responsible for translating the tag into the wire format (JSON
 * tool result for the host tool, console + process.exitCode for the
 * CLI).
 *
 * On hard error (task not found) the function returns
 * {@link TestRunHardError} WITHOUT touching the schedule. On every
 * other path the schedule is restored in `finally`.
 */
export async function runTestRun(opts: RunTestRunOptions): Promise<TestRunResult | TestRunHardError> {
	const {
		name,
		inMs = DEFAULT_IN_MS,
		timeoutMs = DEFAULT_TIMEOUT_MS,
		noRestore = false,
		tickIntervalMs = DEFAULT_TICK_MS,
		signal,
		storage,
		pollIntervalMs = POLL_INTERVAL_MS,
	} = opts;

	// Clamp. The lower bounds are safety rails (don't let the LLM pick
	// a 0 or negative delay); the upper bounds keep the tool call from
	// blocking forever.
	const cappedInMs = Math.min(MAX_IN_MS, Math.max(MIN_IN_MS, inMs));
	const cappedTimeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, timeoutMs));
	if (cappedInMs !== inMs || cappedTimeoutMs !== timeoutMs) {
		logger.debug("[test-run] clamping options", {
			requested: { inMs, timeoutMs },
			applied: { inMs: cappedInMs, timeoutMs: cappedTimeoutMs },
		});
	}

	if (signal?.aborted) {
		return { kind: "aborted", scheduleRestored: true, waitedMs: 0 };
	}

	const task = storage.getTaskByName(name);
	if (!task) return { kind: "task_not_found", name };

	// Snapshot. We restore ALL of these on every exit path.
	const snapshot = {
		cron: task.cron,
		scheduleType: task.scheduleType,
		nextRunAt: task.nextRunAt,
		status: task.status,
	};
	const hadDelivery = Boolean(task.delivery ?? task.deliver);
	const targetTime = Date.now() + cappedInMs;
	const delaySec = Math.ceil(cappedInMs / 1000);
	const startedAt = Date.now();

	// Warn if the chosen inMs is in the racy zone relative to the
	// gateway's actual tick. With a 60s tick, anything < 60s almost
	// always races past next_run_at; 60-120s is reliable in roughly
	// half of the tick phases. The warning is informational; the run
	// still proceeds (the LLM might be on a non-default tick). We log
	// to the gateway log rather than attaching to the result because
	// the LLM has no useful action for the warning — it already chose
	// inMs; the operator can read the gateway log if a test-run didn't
	// fire and wants to know why.
	if (cappedInMs < tickIntervalMs) {
		logger.warn(
			`[test-run] inMs=${cappedInMs}ms is shorter than the gateway tick (${tickIntervalMs}ms); ` +
				`the scheduler may reload AFTER next_run_at and auto-disable the task. ` +
				`Use inMs >= ${tickIntervalMs * 2}ms for reliable triggering.`,
			{ taskName: task.name, inMs: cappedInMs, tickIntervalMs },
		);
	} else if (cappedInMs < tickIntervalMs * 2) {
		logger.warn(
			`[test-run] inMs=${cappedInMs}ms is in the racy zone (between 1x and 2x the ${tickIntervalMs}ms tick); ` +
				`works most of the time, but if no trigger fires, retry with inMs=${tickIntervalMs * 2}ms.`,
			{ taskName: task.name, inMs: cappedInMs, tickIntervalMs },
		);
	}

	storage.updateTask(task.id, {
		cron: `+${delaySec}s`,
		scheduleType: "once",
		nextRunAt: targetTime,
		status: "active",
		updatedAt: Date.now(),
	});

	let restored = false;
	const restoreSnapshot = () => {
		if (restored || noRestore) return;
		try {
			storage.updateTask(task.id, {
				cron: snapshot.cron,
				scheduleType: snapshot.scheduleType,
				nextRunAt: snapshot.nextRunAt,
				status: snapshot.status,
				updatedAt: Date.now(),
			});
			restored = true;
		} catch (err) {
			logger.error("[test-run] failed to restore schedule", {
				taskId: task.id,
				name: task.name,
				error: String(err),
			});
		}
	};

	const startMark = Date.now();
	const totalDeadline = startMark + cappedInMs + cappedTimeoutMs;
	let rawResult: TestRunResult | null = null;

	try {
		while (Date.now() < totalDeadline) {
			if (signal?.aborted) {
				rawResult = { kind: "aborted", scheduleRestored: false, waitedMs: Date.now() - startMark };
				break;
			}
			await Bun.sleep(pollIntervalMs);
			const execs = storage.getExecutions(task.id, 50);
			// Look for a TERMINAL execution (endedAt != null) that
			// started within the trigger window. The 5s slack absorbs
			// clock drift. We only return on a terminal row — the
			// delivery verdict writes AFTER the agent finishes (see
			// CronService.#onTrigger), so the agent running is not
			// enough.
			const candidate = execs.find(
				e => e.startedAt >= startMark - TRIGGER_WINDOW_SLACK_MS && e.endedAt != null,
			);
			if (candidate) {
				rawResult = buildResult({
					storage,
					taskId: task.id,
					hadDelivery,
					execution: candidate,
					startedAt,
				});
				break;
			}
		}
		// If we never broke out of the loop with a result, distinguish
		// "trigger never fired" from "trigger fired but agent still
		// running". The latter is the more useful diagnostic for the
		// operator/LLM.
		if (!rawResult) {
			const runningExec = storage
				.getExecutions(task.id, 50)
				.find(e => e.startedAt >= startMark - TRIGGER_WINDOW_SLACK_MS);
			rawResult = runningExec
				? {
						kind: "trigger_timeout",
						waitedMs: Date.now() - startMark,
						sawRunningExec: true,
						runningExecId: runningExec.id,
						scheduleRestored: false, // patched in finally
					}
				: { kind: "trigger_timeout", waitedMs: Date.now() - startMark, sawRunningExec: false, scheduleRestored: false };
		}
	} finally {
		restoreSnapshot();
	}

	// Patch `scheduleRestored` on all result kinds with the actual
	// `restored` state. This is the only way to honestly report
	// restore status: a return-from-try would run the finally AFTER
	// the result is built, so we patch post-finally. Hard errors
	// (task_not_found) never reach here, so we always have a rawResult.
	const finalScheduleRestored = restored && !noRestore;
	if (rawResult && "scheduleRestored" in rawResult) {
		rawResult = { ...rawResult, scheduleRestored: finalScheduleRestored };
	}
	return rawResult!;
}

interface BuildResultArgs {
	storage: SchedulerDbStorage;
	taskId: string;
	hadDelivery: boolean;
	execution: TaskExecution;
	startedAt: number;
}

function buildResult(args: BuildResultArgs): TestRunResult {
	const { storage, taskId, hadDelivery, execution, startedAt } = args;
	const triggerLatencyMs = Math.max(0, execution.startedAt - startedAt);
	const durationMs = execution.endedAt != null ? execution.endedAt - execution.startedAt : null;
	const stderr = execution.stderr ? execution.stderr.slice(0, 500) : null;
	const output = execution.output ? execution.output.slice(0, 2000) : null;

	// Re-read the task to see post-trigger `last_delivery_error`. The
	// scheduler writes this field on delivery failure and clears it on
	// success (see CronService.#onTrigger). Reading the row here gives
	// us the verdict the LLM/operator needs.
	const taskAfter = storage.getTask(taskId);
	const deliveryError = taskAfter?.lastDeliveryError ?? null;
	const delivery = hadDelivery
		? { configured: true, ok: deliveryError == null, error: deliveryError }
		: { configured: false, ok: true, error: null };

	// Failure precedence: delivery failure > task failure > success.
	// Both can technically be true; delivery is the more user-visible
	// signal because the agent's response didn't reach the user.
	if (hadDelivery && deliveryError) {
		return {
			kind: "delivery_failed",
			execId: execution.id,
			status: execution.status,
			exitCode: execution.exitCode,
			deliveryError,
			scheduleRestored: false, // patched in `runTestRun` post-finally
		};
	}
	if (execution.status !== "success" || execution.exitCode !== 0) {
		return {
			kind: "task_failed",
			execId: execution.id,
			status: execution.status,
			exitCode: execution.exitCode,
			stderr,
			scheduleRestored: false, // patched in `runTestRun` post-finally
		};
	}
	return {
		kind: "success",
		execId: execution.id,
		status: execution.status,
		exitCode: execution.exitCode,
		durationMs,
		stderr,
		delivery,
		output,
		scheduleRestored: false, // patched in `runTestRun` post-finally
		triggerLatencyMs,
	};
}
