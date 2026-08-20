/**
 * Shared test-run core — used by both the LLM `cron` host tool's
 * `test-run` action and the `cron test-run` CLI.
 *
 * Fire-and-forget by design: rewrite the task to a one-shot, write the
 * restore marker (`awaitingFire` + `expiresAt`), reload the engine, and
 * return immediately. The daemon's engine fires the one-shot at the
 * ABSOLUTE target written into `nextRunAt` (engine.schedule honors it —
 * the CLI/LLM target is never re-derived from reload time), the task
 * runs through the normal cron pipeline (warm bridge or cold fallback),
 * and the engine's post-fire restore (`#restoreTestRunSchedule`)
 * reverts the schedule. Orphan recovery consumes the marker if the
 * engine never fires before `expiresAt`.
 *
 * History: the pre-2026-08-20 mode polled for a terminal execution and
 * restored the schedule itself. Removed: in-flight exec state exists
 * only in the gateway's memory (a cross-process viewer can never see
 * it), and the wait was capped at 120s, so the CLI misreported
 * `trigger_timeout` on any run longer than ~2 minutes while the task
 * actually fired and completed. Both callers now use this core;
 * verdicts come from the exec JSONL / delivery card, which the runner
 * itself writes and are truthful.
 */
import { logger } from "@oh-my-pi/pi-utils";
import {
	clearTestRunMarker,
	isTestRunSchedule,
	readTestRunMarker,
	type TestRunOrigin,
	writeTestRunMarker,
} from "./test-run-marker";
import type { SchedulerStorage } from "./types";

/** Options for the shared test-run core. */
export interface RunTestRunOptions {
	/** Task name to rewrite to a one-shot and fire. */
	name: string;
	/**
	 * Delay (ms) from now until the one-shot fires. Default 120_000
	 * (2x the default 60s gateway tick; sub-tick values are rejected
	 * at the CLI/host-tool entry points). The fired target is written
	 * as an ABSOLUTE `nextRunAt`, so the engine fires on time even
	 * when its reload tick lands after this write.
	 */
	inMs?: number;
	/** Gateway scheduler reload interval. Used for racy-zone warnings. */
	tickIntervalMs?: number;
	/** Storage handle (resolved lazily by the caller). */
	storage: SchedulerStorage;
	/**
	 * Optional callback invoked after the one-shot is written, so the
	 * gateway can reload its in-memory engine immediately instead of
	 * waiting for the next tick (up to 60s away).
	 */
	reloadScheduler?: () => void;
	/**
	 * Override the directory used for the restore marker file. Defaults
	 * to the gateway's scheduler dir; tests pass a tempdir.
	 */
	markerBaseDir?: string;
	/**
	 * Origin IM session. Written into the marker so the post-delivery
	 * notifier (`CronLifecycle.#maybeNotifyOriginSession`) can push a
	 * follow-up prompt to that session when the task completes. Only
	 * the LLM host tool passes this; the CLI has no chat context and
	 * the notifier silently no-ops without it.
	 */
	origin?: TestRunOrigin;
	/**
	 * Called after the corruption guard auto-heals a clean schedule
	 * into storage, so the caller can reload the engine and clear the
	 * stale `setTimeout` left behind by the previous failed test-run.
	 * Optional: the CLI passes `undefined` (the gateway's own tick
	 * picks the change up on the next cycle, ≤60s).
	 */
	onReload?: () => void;
}

/** Hard error — task not found, etc. The schedule is NOT touched. */
export type TestRunHardError =
	| { kind: "task_not_found"; name: string }
	/**
	 * Corruption detected on entry: the task's `cron` is already a
	 * test-run one-shot shape (`+<n>s`), so a previous test-run's
	 * restore never completed. The auto-heal ran first; when it has
	 * no clean source the task is disabled and surfaced here.
	 */
	| {
			kind: "schedule_corrupted";
			name: string;
			currentCron: string;
	  };

/**
 * Fire-and-forget acknowledgement. The schedule rewrite and marker
 * write have happened; the engine will fire the task, the cron service
 * will run it, the card will be delivered, and the engine's post-fire
 * restore will put the schedule back. The caller (CLI or LLM) is free
 * to return; the result arrives via the exec JSONL and delivery card.
 */
export interface TestRunStarted {
	kind: "started";
	name: string;
	/** Clamped delay (ms) until the one-shot fires. */
	inMs: number;
	/** `startedAt + inMs + 90s` — orphan recovery deadline. */
	expiresAt: number;
	startedAt: number;
}

// DEFAULT_IN_MS is exported for tests and tooling that want to assert
// the production default (the LLM host tool surfaces it in its
// parameter description).
export const DEFAULT_IN_MS = 120_000;

// Lower bounds are intentionally tiny (1s) so tests and operator
// workflows can use short values (e.g. `--in 1s` for a quick
// verification). The racy-zone warning in `runTestRun` still fires for
// short inMs relative to the gateway tick; the clamp is just a sanity
// rail against negative / zero / sub-second inputs. Hard rejection of
// sub-tick values happens at the entry points (host tool / CLI).
const MIN_IN_MS = 1_000;
const MAX_IN_MS = 600_000; // 10 min
const DEFAULT_TICK_MS = 60_000;

/**
 * Arm a test-run. Returns `started` (one-shot armed) or a hard error
 * (task not found / corrupted schedule — schedule untouched).
 */
export async function runTestRun(opts: RunTestRunOptions): Promise<TestRunStarted | TestRunHardError> {
	const {
		name,
		inMs = DEFAULT_IN_MS,
		tickIntervalMs = DEFAULT_TICK_MS,
		storage,
		markerBaseDir,
		origin,
		reloadScheduler,
		onReload,
	} = opts;

	const cappedInMs = Math.min(MAX_IN_MS, Math.max(MIN_IN_MS, inMs));
	const wasClamped = cappedInMs !== inMs;
	if (wasClamped) {
		logger.debug("[test-run] clamping inMs", { requested: inMs, applied: cappedInMs });
	}

	const task = storage.getTaskByName(name);
	if (!task) return { kind: "task_not_found", name };

	// Corruption guard. If the task's current `cron` is already a
	// test-run one-shot shape (`+<n>s`) but no in-flight test-run
	// from this process owns the marker, the previous test-run's
	// restore never completed (SIGKILL, OOM, gateway crash mid-run,
	// or any path that bypasses the restore contract — see
	// `test-run-marker.ts` header for the full list).
	//
	// Self-heal: if a marker exists and its `snapshot.cron` is a clean
	// value (NOT a test-run shape), apply the snapshot to storage,
	// clear the marker, and continue. The caller's `onReload` hook then
	// rebuilds the in-memory engine schedule so the OLD `setTimeout`
	// doesn't fire one more time and deliver a stale card.
	//
	// If no clean source exists (no marker, or the marker's snapshot is
	// also a `+<n>s` shape — the previous test-run snapshotted the
	// corruption), disable the task and surface `schedule_corrupted`.
	// Without this guard, a single SIGKILL during a test-run would
	// stick the task on `+<n>s` forever (snowball).
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
			// restored (clean) schedule, not the stale in-memory copy.
			const reloaded = storage.getTask(task.id);
			if (!reloaded) return { kind: "task_not_found", name };
			Object.assign(task, reloaded);
			// Caller picks up the in-memory reload. Without this the
			// gateway's OLD setTimeout for the previous (failed) run
			// still fires once and delivers a stale card.
			onReload?.();
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

	// Snapshot. The engine's post-fire restore applies ALL of these on
	// the actual run's completion, so the task's schedule AND audit
	// counters look exactly the same after a test-run as before.
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

	const targetTime = Date.now() + cappedInMs;
	const delaySec = Math.ceil(cappedInMs / 1000);
	const startedAt = Date.now();

	// Warn if the chosen inMs is in the racy zone relative to the
	// gateway's actual tick. With a 60s tick, anything < 60s almost
	// always races past next_run_at; 60-120s is reliable in roughly
	// half of the tick phases. The warning is informational — the
	// absolute-target engine fix guarantees the fire time even when
	// the reload lands after this write; the risk is only that the
	// engine reload itself misses the change entirely.
	if (cappedInMs < tickIntervalMs) {
		logger.warn(
			`[test-run] inMs=${cappedInMs}ms is shorter than the gateway tick (${tickIntervalMs}ms); ` +
				`the scheduler may reload AFTER next_run_at and never see the one-shot. ` +
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
		// auto-disable, so the engine's post-fire restore is the final
		// word on the task's schedule.
		// Do NOT change this format without also updating
		// `isTestRunSchedule` in engine.ts.
		cron: `+${delaySec}s`,
		scheduleType: "once",
		nextRunAt: targetTime,
		status: "active",
		updatedAt: Date.now(),
	});

	// Persist a restore marker BEFORE the schedule mutation takes
	// effect. `awaitingFire` + `expiresAt` tell the gateway's orphan
	// recovery when the engine should already have fired: while the
	// one-shot target is still in the future the marker is in-flight
	// and must not be consumed (even when the writer process exits
	// immediately — the fire-and-forget CLI does). After `expiresAt`,
	// orphan recovery applies the snapshot and clears the marker.
	const markerExpiresAt = startedAt + cappedInMs + 90_000;
	writeTestRunMarker(task, snapshot, startedAt, markerBaseDir, process.pid, {
		awaitingFire: true,
		expiresAt: markerExpiresAt,
		...(origin ? { origin } : {}),
	});

	// Reload the scheduler engine so it picks up the one-shot
	// schedule. Without this, the engine's in-memory task map never
	// sees the change and no setTimeout is created. The daemon's 60s
	// tick is the CLI's fallback reload path.
	reloadScheduler?.();

	logger.info("[test-run] fire-and-forget started", {
		taskId: task.id,
		taskName: task.name,
		inMs: cappedInMs,
		wasClamped,
		expiresAt: markerExpiresAt,
	});
	return {
		kind: "started",
		name: task.name,
		inMs: cappedInMs,
		expiresAt: markerExpiresAt,
		startedAt,
	};
}
