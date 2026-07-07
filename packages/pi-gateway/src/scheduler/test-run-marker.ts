/**
 * `test-run-marker` — durability layer for `runTestRun` schedule restore.
 *
 * `runTestRun` rewrites a task's schedule to a one-shot (e.g. `+120s
 * once`) so the gateway engine can fire it immediately, then restores the
 * original schedule in `finally`. The `finally` is the contract — it
 * runs on normal exit, thrown errors, AbortSignal, SIGINT, SIGTERM.
 * But it does NOT run on:
 *
 *   - `SIGKILL` (kernel-killed; no handlers fire)
 *   - uncaught native crashes
 *   - hard process termination (OOM, host shutdown)
 *   - `&` + `kill $!` patterns that bypass graceful shutdown
 *
 * In any of those paths, the task is left on the one-shot schedule in
 * `jobs.json` and (worse) in the gateway's in-memory task map. The
 * gateway's next tick will see the past-dated `+120s once` and
 * auto-disable the task — the next real cron tick never fires.
 *
 * `test-run-marker` closes that gap. `runTestRun` writes a marker file
 * (the original task snapshot) BEFORE mutating the schedule, and the
 * restore in `finally` deletes the marker on success. Three consumers
 * ensure the marker always gets cleared:
 *
 *   1. `runTestRun`'s own `finally` — clears after successful restore.
 *   2. CLI's `process.on("exit")` — sync restore from marker on any
 *      CLI exit mode (SIGINT, SIGTERM, uncaught exception, `process.exit`).
 *   3. Gateway startup + watch tick — detects orphan markers left by
 *      dead CLI/LLM processes and applies the snapshot.
 *
 * The marker lives next to `jobs.json` so a single FS listing shows
 * both the live task state and any pending restore.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import type { ScheduledTask } from "./types";
import { getSchedulerDir } from "./types";

/**
 * Fields snapshot for a test-run's restore.
 *
 * The full task snapshot is persisted in the marker so a restore
 * can be replayed without the original in-memory state (e.g. by a
 * fresh gateway process picking up an orphan marker on startup).
 * Only the fields that `runTestRun` mutates or that other code paths
 * may bump while the test-run is in flight are needed.
 */
export interface TestRunSnapshot {
	cron: string;
	scheduleType: "cron" | "interval" | "once" | undefined;
	nextRunAt: number | undefined;
	status: "active" | "disabled" | "paused";
	lastRunAt: number | undefined;
	runCount: number;
	failCount: number;
	consecutiveFailures: number;
	repeatCompleted: number | undefined;
	lastDeliveryError: string | undefined;
}

/**
 * Origin IM session. When a `cron.test-run` is triggered by an LLM
 * `cron` host tool call, the host tool stamps this on the marker so
 * the post-delivery notifier can push a new prompt back to the
 * origin session — closing the loop so the LLM sees the result in
 * its next turn.
 *
 * `sessionPath` is the OMP session file path the LLM is using. The
 * bridge `executePrompt` switches to this path before running, so
 * the LLM gets a continuation turn on the same conversation context.
 *
 * Kept intentionally minimal: only the session path is needed to
 * dispatch the new prompt. Other fields (accountId, conversationId,
 * userId) are not required for routing and were dropped to keep the
 * marker small and avoid a SessionManager lookup that the bridge
 * handles internally (it throws if the session is gone, which the
 * notifier catches and logs).
 */
export interface TestRunOrigin {
	sessionPath: string;
}

/** On-disk shape of the marker file. Versioned for forward compat. */
export interface TestRunMarker {
	version: 1;
	taskId: string;
	taskName: string;
	snapshot: TestRunSnapshot;
	startedAt: number;
	pid: number;
	/**
	 * `true` when the host tool returned immediately (fire-and-forget).
	 * The marker is left on disk and the engine's post-fire restore
	 * (engine.ts#restoreTestRunSchedule) consumes it after the task
	 * fires. `false` (default) means the host tool is still actively
	 * polling (legacy CLI path) — orphan recovery must NOT touch this
	 * marker, the in-flight test-run still expects to clear it itself.
	 *
	 * The flag exists to give the engine tick a way to distinguish
	 * "host tool still alive and waiting" from "host tool returned and
	 * is gone". Without it, the tick's `consumeOrphanTestRunMarker`
	 * would race the in-flight test-run's `finally` (the original
	 * Phase-3.5 bug). Same-process markers are now safe to consume in
	 * one of two conditions:
	 *   1. `awaitingFire === true` (host tool returned) AND
	 *      `Date.now() > expiresAt` (engine should have fired by now
	 *      but didn't — safe to recover)
	 *   2. `pid !== process.pid` (cross-process orphan, e.g. CLI
	 *      died; recoverable regardless of awaitingFire)
	 */
	awaitingFire?: boolean;
	/**
	 * Hard deadline (ms since epoch) after which orphan recovery will
	 * recover the marker even if it's from the current process. Set
	 * by `runTestRun` to `startedAt + inMs + 90_000` (inMs covers
	 * the wait; the 90s buffer covers the engine tick + agent run
	 * + card delivery). Without this TTL, a marker written by a
	 * host tool that returned immediately would stay on disk forever
	 * if the engine ever failed to fire (rare but possible: schedule
	 * race, gateway restart between marker write and engine reload,
	 * etc.). With the TTL, the next engine tick after the deadline
	 * recovers the snapshot and the task is back to its real cron.
	 *
	 * `undefined` for legacy / CLI markers — those are recovered
	 * based on the cross-process pid check, not the TTL.
	 */
	expiresAt?: number;
	/**
	 * Set by the LLM `cron.test-run` host tool path. When present,
	 * the post-delivery notifier (`CronLifecycle.#maybeNotifyOriginSession`)
	 * pushes a new prompt to this session after the task's card /
	 * text delivery completes — closing the loop so the LLM sees
	 * the result in its next turn. CLI test-run callers do not set
	 * this (no IM session to push to). Absent on markers written
	 * before this field was introduced; readers must treat missing
	 * `origin` as "no notification needed".
	 */
	origin?: TestRunOrigin;
}

/** Path to the marker file. One global file (only one test-run at a time). */
export function getTestRunMarkerPath(baseDir?: string): string {
	return path.join(baseDir ?? getSchedulerDir(), "test-run-restore.json");
}

/**
 * Atomically write the marker. Sync — `runTestRun` is the only writer
 * and there's exactly one marker on disk. The tmp + rename pattern
 * protects against a torn write if the process is killed mid-write
 * (the tmp file may exist but the rename is atomic, so the marker is
 * either fully present or fully absent).
 *
 * `awaitingFire` and `expiresAt` are fire-and-forget fields. The
 * legacy CLI path (which still polls) leaves both `undefined`. The
 * host tool's new path (which returns immediately) sets
 * `awaitingFire: true` and `expiresAt: startedAt + inMs + 90_000`.
 *
 * `baseDir` overrides `getSchedulerDir()` for tests; production
 * callers pass nothing.
 */
export function writeTestRunMarker(
	task: ScheduledTask,
	snapshot: TestRunSnapshot,
	startedAt: number,
	baseDir?: string,
	pid: number = process.pid,
	opts?: { awaitingFire?: boolean; expiresAt?: number; origin?: TestRunOrigin },
): void {
	const marker: TestRunMarker = {
		version: 1,
		taskId: task.id,
		taskName: task.name,
		snapshot,
		startedAt,
		pid,
		...(opts?.awaitingFire !== undefined ? { awaitingFire: opts.awaitingFire } : {}),
		...(opts?.expiresAt !== undefined ? { expiresAt: opts.expiresAt } : {}),
		...(opts?.origin !== undefined ? { origin: opts.origin } : {}),
	};
	const markerPath = getTestRunMarkerPath(baseDir);
	const tmpPath = `${markerPath}.tmp`;
	try {
		fs.mkdirSync(path.dirname(markerPath), { recursive: true });
		fs.writeFileSync(tmpPath, JSON.stringify(marker, null, 2), "utf-8");
		fs.renameSync(tmpPath, markerPath);
		logger.debug("[test-run] wrote restore marker", { taskName: task.name, taskId: task.id });
	} catch (err) {
		// Best-effort: if the marker write fails, the test-run still
		// proceeds. The `finally` restore is the primary safety net;
		// the marker is the belt-and-suspenders. Don't fail the
		// test-run over a marker write error.
		logger.warn("[test-run] failed to write restore marker; relying on finally restore only", {
			taskName: task.name,
			error: String(err),
		});
	}
}

/**
 * Delete the marker. Tolerant of ENOENT (already deleted).
 */
export function clearTestRunMarker(baseDir?: string): void {
	try {
		fs.unlinkSync(getTestRunMarkerPath(baseDir));
		logger.debug("[test-run] cleared restore marker");
	} catch (err) {
		if (!isEnoent(err)) {
			logger.warn("[test-run] failed to clear restore marker", { error: String(err) });
		}
	}
}

/**
 * Read the marker. Returns null if absent or unreadable.
 *
 * Intended for two callers:
 *   - The gateway on startup / tick, to apply an orphan marker's
 *     snapshot to a fresh in-memory task map.
 *   - The CLI's `process.on("exit")` handler, to do a sync restore
 *     when the CLI process is dying but the gateway is still alive.
 */
export function readTestRunMarker(baseDir?: string): TestRunMarker | null {
	let raw: string;
	try {
		raw = fs.readFileSync(getTestRunMarkerPath(baseDir), "utf-8");
	} catch (err) {
		if (isEnoent(err)) return null;
		logger.warn("[test-run] failed to read restore marker", { error: String(err) });
		return null;
	}
	try {
		const parsed = JSON.parse(raw) as TestRunMarker;
		if (parsed.version !== 1) {
			logger.warn("[test-run] unknown marker version; skipping", { version: parsed.version });
			return null;
		}
		return parsed;
	} catch (err) {
		logger.warn("[test-run] failed to parse restore marker; treating as corrupt", { error: String(err) });
		return null;
	}
}

/**
 * Returns true if a marker file exists on disk.
 *
 * Cheap O(1) check used by hot paths (gateway tick) to decide whether
 * to call `readTestRunMarker`. The read is skipped when this returns
 * false, so the tick overhead in the no-marker case is a single
 * `fs.existsSync`.
 */
export function hasTestRunMarker(baseDir?: string): boolean {
	try {
		return fs.existsSync(getTestRunMarkerPath(baseDir));
	} catch {
		return false;
	}
}

/**
 * Write an arbitrary marker (e.g. one with a different `pid` for
 * simulating a foreign process). Tests use this to exercise the
 * cross-process orphan path without spawning a real subprocess.
 */
export function writeTestRunMarkerRaw(marker: TestRunMarker, baseDir?: string): void {
	const markerPath = getTestRunMarkerPath(baseDir);
	const tmpPath = `${markerPath}.tmp`;
	fs.mkdirSync(path.dirname(markerPath), { recursive: true });
	fs.writeFileSync(tmpPath, JSON.stringify(marker, null, 2), "utf-8");
	fs.renameSync(tmpPath, markerPath);
}
