/**
 * `runTestRun` — the core test-run logic, shared by the CLI and the LLM
 * `cron` host tool.
 *
 * A test-run is a **verification path**: it temporarily rewrites a task
 * to a one-shot schedule (e.g. `+120s` once), waits for the gateway
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
import {
	clearTestRunMarker,
	isTestRunSchedule,
	readTestRunMarker,
	type TestRunOrigin,
	writeTestRunMarker,
} from "./test-run-marker";
import type { SchedulerStorage, TaskExecution } from "./types";

/**
 * Options for the shared test-run core.
 *
 * `inMs` and `timeoutMs` semantics:
 *   - `inMs` — how long from now until the one-shot fires. Default
 *     120_000ms (2x the default 60s gateway tick; reliable in normal
 *     configurations). Anything < 2x the gateway tick is in the
 *     "racy zone" — see {@link TestRunWarning}.
 *   - `timeoutMs` — after the one-shot has fired, how long to wait for
 *     the agent run to reach a terminal state (success / failure with
 *     exit code). Default 30_000ms.
 *   - Total tool call wall-time = inMs + timeoutMs. With defaults:
 *     150s. LLM tool calls can run this long; the OMP host-tool
 *     bridge imposes no client-side timeout. AbortSignal is honored
 *     on the polling loop and restores the schedule in `finally`.
 *
 * `tickIntervalMs` is the gateway's scheduler reload interval. The
 * default is 60_000ms; the host-tool caller passes the gateway's
 * configured value. Used to warn when `inMs` lands in the racy zone
 * (< 2x tick). The CLI default is also 60_000; the cron tool threads
 * the gateway's actual config through {@link CronToolContext}.
 *
 * `awaitResult` (default `true`) — the CLI keeps the legacy
 * poll-and-restore behavior. The LLM host tool passes `false`:
 *   - Snapshots the task, rewrites to one-shot, writes the marker
 *     (with `awaitingFire: true` and `expiresAt`), reloads the
 *     scheduler, and returns `{ kind: "started" }` immediately.
 *   - Does NOT poll, restore, or clear the marker.
 *   - The engine's post-fire restore (engine.ts#restoreTestRunSchedule)
 *     picks up the marker after the one-shot fires and applies the
 *     snapshot back.
 *   - If the engine never fires (rare: schedule race / gateway restart
 *     / tick skipped), orphan recovery picks it up after `expiresAt`.
 *
 * Why fire-and-forget for the LLM path: the previous sync path
 * blocked the LLM's `runExclusive` for `inMs + timeoutMs` (default
 * 150s), during which no session events fired, tripping the
 * agent-bridge watchdog at 60s and killing the LLM. Fire-and-forget
 * unblocks the LLM in milliseconds; the actual run + card delivery
 * proceed through the same pipeline the real cron tick uses.
 */
export interface RunTestRunOptions {
	name: string;
	inMs?: number;
	timeoutMs?: number;
	noRestore?: boolean;
	/** Gateway scheduler reload interval. Used to flag racy inMs values. */
	tickIntervalMs: number;
	/**
	 * If `false` (LLM host tool path), return `{ kind: "started" }`
	 * immediately after writing the marker. The schedule rewrite +
	 * marker are the only mutations. Default `true` (CLI path)
	 * preserves the poll-and-restore behavior.
	 */
	awaitResult?: boolean;
	/** AbortSignal from the host-tool caller. Polling stops on abort and
	 *  the schedule snapshot is restored in `finally`. */
	signal?: AbortSignal;
	/** Storage handle. The cron tool resolves this lazily because the
	 *  scheduler DB is created by `CronLifecycle.start()` after the
	 *  dispatcher is wired. */
	storage: SchedulerStorage;
	/**
	 * Polling interval for execution table reads. Default 2000ms (CLI
	 * + LLM production path). Tests pass a smaller value (e.g. 25ms)
	 * to keep the suite fast; production callers should leave this
	 * alone because 2s is the right cadence for not hammering SQLite
	 * during a 90+ second wait.
	 */
	pollIntervalMs?: number;
	/**
	 * Optional callback invoked after the test-run writes or restores
	 * the one-shot schedule in the DB. The gateway passes
	 * `() => engine.reload()` so the SchedulerEngine picks up the
	 * changed schedule immediately instead of waiting for the next
	 * tick (which can be up to 60s away). Without this, the engine's
	 * in-memory task cache never sees the one-shot and test-run
	 * always times out.
	 */
	reloadScheduler?: () => void;
	/**
	 * Override the directory used for the restore marker file. The
	 * default is the gateway's scheduler dir. Tests pass a tempdir
	 * so they don't pollute the real `~/.omp/gateway-data/`. Production
	 * callers leave this alone.
	 */
	markerBaseDir?: string;
	/**
	 * Origin IM session. When set, written into the marker so the
	 * post-delivery notifier (`CronLifecycle.#maybeNotifyOriginSession`)
	 * can push a new prompt to this session after the task completes.
	 * Only meaningful for the LLM `cron.test-run` host tool path
	 * (awaitResult=false); CLI callers pass `undefined`. Without an
	 * origin, the notifier silently no-ops — backward compatible
	 * with all pre-B markers.
	 */
	origin?: TestRunOrigin;
	/**
	 * Called after the corruption guard's auto-heal restores a clean
	 * schedule to storage. The caller's job: reload the gateway's
	 * in-memory engine so the OLD `+<n>s` `setTimeout` (the one left
	 * behind by the previous failed test-run) is cleared and the
	 * engine reschedules on the restored cron expression.
	 *
	 * Without this hook the storage heals but the in-memory map
	 * stays stale; the OLD `setTimeout` fires one more time and
	 * delivers a "stale" test-run card to the user. With it, the
	 * engine's `reload()` clears all timeouts/intervals and rebuilds
	 * the schedule from the now-clean storage.
	 *
	 * Optional: tests and the CLI pass `undefined` (the CLI runs in
	 * a separate process from the gateway's engine; the gateway's
	 * own tick picks up the change on the next cycle, ≤60s).
	 */
	onReload?: () => void;
}

/** Hard error — task not found, etc. The caller surfaces this to the
 *  user/LLM as a failed tool result. The schedule is NOT touched on
 *  this path. */
export type TestRunHardError =
	| { kind: "task_not_found"; name: string }
	/**
	 * Corruption detected on entry: the task's current `cron` is
	 * already a test-run one-shot shape (`+<n>s`), but no test-run
	 * is in flight from this process. This means a previous
	 * test-run's `finally` restore never completed (SIGKILL, OOM,
	 * gateway crash mid-handleTrigger, or a clean-source-less
	 * SIGKILL during the previous restore). Without this guard the
	 * next test-run would snapshot the corrupted cron into a new
	 * marker, the restore would write it back, and the corruption
	 * self-perpetuates (snowball).
	 *
	 * Self-heal logic ran first; if it failed, the task has been
	 * disabled in storage and the caller is told to fix the task
	 * manually. `currentCron` is included for diagnostics.
	 */
	| {
			kind: "schedule_corrupted";
			name: string;
			currentCron: string;
	  };

/**
 * Fire-and-forget acknowledgement (LLM host tool path with
 * `awaitResult: false`). The schedule rewrite and marker write
 * have happened; the engine will fire the task, the cron service
 * will run it, the card will be delivered, and the engine's
 * post-fire restore will put the schedule back. The LLM is free
 * to continue its turn. The user gets the result via the card.
 */
export interface TestRunStarted {
	kind: "started";
	name: string;
	inMs: number;
	testTimeoutMs: number;
	wasClamped: boolean;
	expiresAt: number;
	startedAt: number;
}

/** Soft error — the trigger fired (or didn't) but the result is not a
 *  clean success. Returned as part of {@link TestRunResult}; the
 *  schedule IS restored on this path. */
export type TestRunSoftError =
	| {
			kind: "trigger_timeout";
			waitedMs: number;
			sawRunningExec: boolean;
			runningExecId?: string;
			scheduleRestored: boolean;
	  }
	| {
			kind: "task_failed";
			execId: string;
			status: string;
			exitCode: number;
			stderr: string | null;
			scheduleRestored: boolean;
	  }
	| {
			kind: "delivery_failed";
			execId: string;
			status: string;
			exitCode: number;
			deliveryError: string;
			scheduleRestored: boolean;
	  };

/** Result of a successful trigger + run. */
export interface TestRunSuccess {
	kind: "success";
	execId: string;
	status: string;
	exitCode: number;
	durationMs: number | null;
	stderr: string | null;
	delivery: { configured: boolean; ok: boolean; error: string | null; mode?: "announce" | "none" };
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
export type TestRunResult = TestRunSuccess | TestRunSoftError | TestRunAborted | TestRunStarted;

// DEFAULT_IN_MS is exported for tests and tooling that want to
// assert the production default. Runtime callers go through
// `runTestRun`'s `inMs` parameter (which defaults to this value);
// the LLM host tool surfaces the value to the model in its
// parameter description.
export const DEFAULT_IN_MS = 120_000;
// DEFAULT_IN_MS = 120s = 2x the default 60s gateway tick. Anything
// shorter is in the "racy zone" (1x–2x tick) where the engine tick
// may load the new schedule AFTER next_run_at and auto-disable the
// task. The LLM host tool and CLI both surface this as the default
// when the caller does not pass `inMs`; unit tests call runTestRun
// directly with shorter values and bypass the default.
const DEFAULT_TIMEOUT_MS = 30_000;
// Lower bounds are intentionally tiny (1s) so tests and operator
// workflows can use short values (e.g. `--in 1s` for a quick
// verification). The racy-zone warning in `runTestRun` still fires
// for short inMs relative to the gateway tick; the clamp is just a
// sanity rail against negative / zero / sub-second inputs. Hard
// rejection of sub-tick values happens at the entry points (host
// tool / CLI) so the LLM/operator gets a clear error rather than
// a silent 60s wait.
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
		awaitResult = true,
		signal,
		storage,
		pollIntervalMs = POLL_INTERVAL_MS,
		markerBaseDir,
		origin,
	} = opts;

	// Clamp. The lower bounds are safety rails (don't let the LLM pick
	// a 0 or negative delay); the upper bounds keep the tool call from
	// blocking forever.
	const cappedInMs = Math.min(MAX_IN_MS, Math.max(MIN_IN_MS, inMs));
	const cappedTimeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, timeoutMs));
	const wasClamped = cappedInMs !== inMs || cappedTimeoutMs !== timeoutMs;
if (wasClamped) {
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

	// Corruption guard. If the task's current `cron` is already a
	// test-run one-shot shape (`+<n>s`) but no in-flight test-run
	// from this process owns the marker, the previous test-run's
	// `finally` restore never completed (SIGKILL, OOM, gateway crash
	// mid-handleTrigger, or any path that bypasses the `finally`
	// contract — see `test-run-marker.ts` header for the full list).
	//
	// Self-heal: if a marker exists and its `snapshot.cron` is a
	// clean value (NOT a test-run shape — a real cron expression,
	// interval, or ISO timestamp), apply the snapshot to storage,
	// clear the marker, and continue. The caller's `onReload` hook
	// then rebuilds the in-memory engine schedule so the OLD
	// `setTimeout` (left behind by the failed previous run) doesn't
	// fire one more time and deliver a stale card.
	//
	// If no clean source exists (no marker, or the marker's
	// snapshot is also a `+<n>s` shape — meaning a previous test-run
	// already snapshotted the corruption), disable the task. The
	// caller surfaces `schedule_corrupted` to the user/LLM as a
	// clear "fix this manually" error.
	//
	// Without this guard, a single SIGKILL during a test-run would
	// stick the task on `+<n>s` forever: every subsequent test-run
	// snapshots the corrupted value into a new marker, and the
	// restore writes it back unchanged. This is the snowball bug.
	if (isTestRunSchedule(task.cron)) {
		const marker = readTestRunMarker(markerBaseDir);
		const markerSnapIsClean = marker !== null && !isTestRunSchedule(marker.snapshot.cron);
		if (markerSnapIsClean) {
			const snap = marker.snapshot;
			storage.updateTask(task.id, {
				cron: snap.cron,
				scheduleType: snap.scheduleType,
				nextRunAt: snap.nextRunAt,
				status: snap.status,
				lastRunAt: snap.lastRunAt,
				runCount: snap.runCount,
				failCount: snap.failCount,
				consecutiveFailures: snap.consecutiveFailures,
				repeatCompleted: snap.repeatCompleted,
				lastDeliveryError: snap.lastDeliveryError,
				updatedAt: Date.now(),
			});
			clearTestRunMarker(markerBaseDir);
			logger.info("[test-run] auto-heal: restored corrupted schedule from orphan marker", {
				taskId: task.id,
				taskName: task.name,
				restoredCron: snap.cron,
			});
			// Re-load the task so the new test-run snapshots the
			// restored (clean) schedule, not the stale in-memory
			// copy of the corrupted one.
			const reloaded = storage.getTask(task.id);
			if (!reloaded) return { kind: "task_not_found", name };
			Object.assign(task, reloaded);
			// Caller picks up the in-memory reload. Without this
			// hook the gateway's OLD setTimeout for the previous
			// (failed) test-run still fires once and delivers a
			// stale card before its next tick reloads.
			opts.onReload?.();
			// Fall through to the normal snapshot/mutate path.
		} else {
			storage.updateTask(task.id, { status: "disabled" });
			logger.error("[test-run] auto-heal FAILED: corrupted schedule with no clean source; task disabled", {
				taskId: task.id,
				taskName: task.name,
				currentCron: task.cron,
				hasMarker: marker !== null,
				markerCron: marker?.snapshot.cron,
			});
			return {
				kind: "schedule_corrupted",
				name: task.name,
				currentCron: task.cron,
			};
		}
	}

	// Snapshot. We restore ALL of these on every exit path.
	//
	// Schedule fields (cron, scheduleType, nextRunAt, status): the test-run
	// rewrites the schedule to a one-shot and back; restore must put the
	// original schedule back regardless of which path we exited through.
	//
	// Stats fields (lastRunAt, runCount, failCount, consecutiveFailures,
	// repeatCompleted, lastDeliveryError): the engine AND the CronService
	// write these on every execution — see engine.ts#runTask (success
	// bumps runCount/lastRunAt/consecutiveFailures=0/repeatCompleted;
	// failure bumps runCount/failCount/consecutiveFailures/lastRunAt)
	// and cron-service.ts#onTrigger (lastDeliveryError). Without
	// snapshotting them, a successful test-run would leave the task
	// with runCount+1 even though no real run happened, and a delivery
	// failure during the test would clobber the prior lastDeliveryError.
	// test-run is a verification path — it must be transparent: the
	// task's audit counters look exactly the same after as before.
	const snapshot = {
		cron: task.cron,
		scheduleType: task.scheduleType,
		nextRunAt: task.nextRunAt,
		status: task.status,
		lastRunAt: task.lastRunAt,
		runCount: task.runCount,
		failCount: task.failCount,
		consecutiveFailures: task.consecutiveFailures,
		repeatCompleted: task.repeatCompleted,
		lastDeliveryError: task.lastDeliveryError,
	};
	// Truthful delivery flag. Only count as "delivery attempted" when
	// the task will actually push. v2 tasks with `mode: "none"` are
	// silent by config (e.g. daily-2000-calendar-push was once stored
	// with mode=none; the old `Boolean(task.delivery ?? task.deliver)`
	// check reported delivery.ok=true despite no push ever happening —
	// false positive that masked the missing-DingTalk-message bug).
	// The canonical "will push" check lives in `cron-service.ts` and
	// uses the same `mode === "announce"` rule — we mirror it.
	//
	// `task.delivery` is the only source of truth: `storage.ts`
	// `rowToTask` reconstructs it from the legacy `deliver` column on
	// read, so any task with any delivery config has `task.delivery`
	// populated by the time we see it. The legacy `task.deliver`
	// field is a read-time back-compat shim and not consulted here.
	const taskDelivery = task.delivery;
	const hadDelivery = taskDelivery?.mode === "announce";
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
		// `+${delaySec}s` is a **test-run marker**. The engine sees
		// this shape (`/^\+\d+s$/`, see `isTestRunSchedule` in
		// engine.ts) and SKIPS the post-execution `status="disabled"`
		// auto-disable. That lets this function's `finally` block be
		// the final word on the task's status — without the skip, the
		// engine would race the restore below and the task could end
		// up `disabled` after we report `scheduleRestored: true`.
		// Do NOT change this format without also updating
		// `isTestRunSchedule` in engine.ts.
		cron: `+${delaySec}s`,
		scheduleType: "once",
		nextRunAt: targetTime,
		status: "active",
		updatedAt: Date.now(),
	});

	// Persist a restore marker BEFORE the schedule mutation takes
	// effect. The marker is the safety net for crash / SIGKILL paths
	// where `finally` never runs. Cleared in `finally` after the
	// successful restore below; orphan markers are picked up by the
	// gateway on startup / tick.
	//
	// For the fire-and-forget path (awaitResult=false), the marker
	// gets `awaitingFire: true` and an `expiresAt` deadline. The
	// engine's post-fire restore consumes it after the task fires;
	// orphan recovery consumes it if the engine never fires before
	// `expiresAt`.
	const markerExpiresAt = startedAt + cappedInMs + 90_000;
	writeTestRunMarker(
		task,
		snapshot,
		startedAt,
		markerBaseDir,
		process.pid,
		awaitResult
			? origin
				? { origin }
				: undefined
			: {
					awaitingFire: true,
					expiresAt: markerExpiresAt,
					...(origin ? { origin } : {}),
				},
	);

	// Reload the scheduler engine so it picks up the one-shot
	// schedule. Without this, the engine's in-memory task map never
	// sees the change and no setTimeout is created.
	opts.reloadScheduler?.();

	// Fire-and-forget fast path (LLM host tool). The schedule is
	// rewritten, the marker is on disk, the engine has been reloaded
	// to pick up the one-shot timeout. The LLM gets the result of
	// this call in milliseconds instead of `inMs + timeoutMs`,
	// which is what kills the agent-bridge watchdog in the legacy
	// poll path (60s inactivity while the LLM awaits tool_result).
	// The cron service will still run the task on the next engine
	// tick, the card will still be delivered, and the engine's
	// post-fire restore will put the schedule back. Orphan recovery
	// is the safety net for the rare case where the engine fails
	// to fire before `expiresAt`.
	if (!awaitResult) {
		logger.info("[test-run] fire-and-forget started", {
			taskId: task.id,
			taskName: task.name,
			inMs: cappedInMs,
			timeoutMs: cappedTimeoutMs,
			wasClamped,
			expiresAt: markerExpiresAt,
		});
		return {
			kind: "started",
			name: task.name,
			inMs: cappedInMs,
			testTimeoutMs: cappedTimeoutMs,
			wasClamped,
			expiresAt: markerExpiresAt,
			startedAt,
		};
	}

	let restored = false;
	const restoreSnapshot = () => {
		if (restored || noRestore) return;
		try {
			storage.updateTask(task.id, {
				cron: snapshot.cron,
				scheduleType: snapshot.scheduleType,
				nextRunAt: snapshot.nextRunAt,
				status: snapshot.status,
				lastRunAt: snapshot.lastRunAt,
				runCount: snapshot.runCount,
				failCount: snapshot.failCount,
				consecutiveFailures: snapshot.consecutiveFailures,
				repeatCompleted: snapshot.repeatCompleted,
				lastDeliveryError: snapshot.lastDeliveryError,
				updatedAt: Date.now(),
			});
			restored = true;
			// Reload the scheduler engine so it picks up the restored
			// original schedule. Without this, the engine continues
			// running the old one-shot timeout or nothing at all.
			opts.reloadScheduler?.();
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
			const candidate = execs.find(e => e.startedAt >= startMark - TRIGGER_WINDOW_SLACK_MS && e.endedAt != null);
			if (candidate) {
				rawResult = buildResult({
					storage,
					taskId: task.id,
					hadDelivery,
					deliveryMode: taskDelivery?.mode,
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
				: {
						kind: "trigger_timeout",
						waitedMs: Date.now() - startMark,
						sawRunningExec: false,
						scheduleRestored: false,
					};
		}
	} finally {
		restoreSnapshot();
		clearTestRunMarker(markerBaseDir);
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
	storage: SchedulerStorage;
	taskId: string;
	hadDelivery: boolean;
	deliveryMode: "announce" | "none" | undefined;
	execution: TaskExecution;
	startedAt: number;
}

function buildResult(args: BuildResultArgs): TestRunResult {
	const { storage, taskId, hadDelivery, deliveryMode, execution, startedAt } = args;
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
	// Three shapes:
	//   - silent (v2 mode=none): configured but won't push. Report
	//     configured=true with mode="none" so the LLM doesn't mistake
	//     this for "no config" and try to add a delivery.
	//   - hadDelivery (v2 announce OR legacy): configured and pushed.
	//     ok tracks the actual verdict; error is the lastDeliveryError
	//     the cron service wrote.
	//   - no config: configured=false, ok=true (no failure to report).
	const delivery =
		deliveryMode === "none"
			? { configured: true, ok: true, error: null, mode: "none" as const }
			: hadDelivery
				? { configured: true, ok: deliveryError == null, error: deliveryError }
				: { configured: false, ok: true, error: null };

	// Failure precedence: delivery failure > task failure > success.
	// Both can technically be true; delivery is the more user-visible
	// signal because the agent's response didn't reach the user. Only
	// flag delivery_failed when an actual push was attempted
	// (hadDelivery). Silent mode (hadDelivery=false but configured)
	// is never delivery_failed — it never tried.
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
