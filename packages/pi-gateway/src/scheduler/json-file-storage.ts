/**
 * JSON-file-backed implementation of SchedulerStorage.
 *
 * Task definitions + runtime state live in a single `~/.omp/gateway-data/scheduler/jobs.json`
 * file with atomic writes (tmp → os.replace + fsync). Execution records are ephemeral
 * in-memory during runtime and also written to JSONL logs for persistence.
 *
 * This replaces SchedulerDbStorage (SQLite) for the scheduler — the JSONL execution
 * logs were already plain text and stay as-is.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import { clearTestRunMarker, readTestRunMarker } from "./test-run-marker";
import { pruneAllLogs, readExecutionLog } from "./execution-log";
import type { ScheduledTask, SchedulerStorage, TaskExecution } from "./types";
import { generateExecutionId, generateTaskId, getSchedulerDir } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface JobsFile {
	version: 1;
	tasks: ScheduledTask[];
	metadata: {
		updatedAt: number;
	};
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

function defaultJobsPath(): string {
	return path.join(getSchedulerDir(), "jobs.json");
}

// ---------------------------------------------------------------------------
// JsonFileStorage
// ---------------------------------------------------------------------------

export class JsonFileStorage implements SchedulerStorage {
	readonly #jobsPath: string;
	readonly #maxBackups: number;
	/** In-memory task map: id → task */
	readonly #tasks = new Map<string, ScheduledTask>();
	/** In-memory execution map: id → execution (for in-flight "running" records) */
	readonly #executions = new Map<string, TaskExecution>();
	#loaded = false;

	constructor(jobsPath?: string, maxBackups = 5) {
		this.#jobsPath = jobsPath ?? defaultJobsPath();
		this.#maxBackups = maxBackups;
	}

	// ── Loading / flushing ──────────────────────────────────────────────

	/** Ensure tasks are loaded from disk. Idempotent on subsequent calls. */
	#ensureLoaded(): void {
		if (this.#loaded) return;
		this.#tasks.clear();

		try {
			const content = fs.readFileSync(this.#jobsPath, "utf-8");
			const data = JSON.parse(content) as JobsFile;
			if (data.version !== 1) {
				logger.warn("Unknown jobs.json version, may be incompatible", { version: data.version });
			}
			for (const task of data.tasks) {
				this.#tasks.set(task.id, task);
			}
		} catch (err) {
			if (!isEnoent(err)) {
				logger.warn("Failed to parse jobs.json, starting fresh", { error: String(err) });
			}
		}
		this.#loaded = true;
	}

	/**
	 * Rotate backup files: .bak.0 → .bak.1 → … → .bak.N-1, then copy
	 * the current jobs.json to .bak.0. Only backs up if the file exists
	 * and is non-empty. No-op when the file doesn't exist (fresh start).
	 */
	#rotateBackups(): void {
		if (this.#maxBackups <= 0) return;
		try {
			const stat = fs.statSync(this.#jobsPath);
			if (!stat.isFile() || stat.size === 0) return;
		} catch {
			return; // File doesn't exist yet — nothing to back up
		}

		// Shift backups: .bak.N-1 → delete, then .bak.N-2 → .bak.N-1, …
		const lastIdx = this.#maxBackups - 1;
		const lastBak = `${this.#jobsPath}.bak.${lastIdx}`;
		try {
			fs.unlinkSync(lastBak);
		} catch {
			// May not exist
		}
		for (let i = lastIdx - 1; i >= 0; i--) {
			const src = `${this.#jobsPath}.bak.${i}`;
			const dst = `${this.#jobsPath}.bak.${i + 1}`;
			try {
				fs.renameSync(src, dst);
			} catch {
				// Source doesn't exist — skip
			}
		}

		// Copy current file to .bak.0
		const bak0 = `${this.#jobsPath}.bak.0`;
		try {
			fs.copyFileSync(this.#jobsPath, bak0);
		} catch {
			// Source vanished between stat and copy — skip
		}
	}

	/** Flush the in-memory task map to disk (atomic write). */
	#flush(): void {
		this.#rotateBackups();
		const data: JobsFile = {
			version: 1,
			tasks: Array.from(this.#tasks.values()),
			metadata: {
				updatedAt: Date.now(),
			},
		};
		const dir = path.dirname(this.#jobsPath);
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

		const tmpPath = `${this.#jobsPath}.tmp`;
		fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");

		// fsync the tmp file then replace atomically
		const fd = fs.openSync(tmpPath, "r");
		try {
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
		fs.renameSync(tmpPath, this.#jobsPath);

		// fsync the directory
		const dirFd = fs.openSync(dir, "r");
		try {
			fs.fsyncSync(dirFd);
		} finally {
			fs.closeSync(dirFd);
		}
	}

	// ── Task operations ─────────────────────────────────────────────────

	addTask(task: Omit<ScheduledTask, "id">): ScheduledTask {
		this.#ensureLoaded();
		// Reject duplicate task names
		if (this.getTaskByName(task.name)) {
			throw new Error(`Task "${task.name}" already exists`);
		}
		const id = generateTaskId();
		const now = Date.now();
		const full: ScheduledTask = {
			id,
			...task,
			createdAt: task.createdAt ?? now,
			updatedAt: task.updatedAt ?? now,
		};
		this.#tasks.set(id, full);
		this.#flush();
		return full;
	}

	getTask(id: string): ScheduledTask | undefined {
		this.#ensureLoaded();
		return this.#tasks.get(id);
	}

	getTaskByName(name: string): ScheduledTask | undefined {
		this.#ensureLoaded();
		for (const task of this.#tasks.values()) {
			if (task.name === name) return task;
		}
		return undefined;
	}

	listTasks(): ScheduledTask[] {
		this.#ensureLoaded();
		return Array.from(this.#tasks.values()).sort((a, b) => b.createdAt - a.createdAt);
	}

	updateTask(id: string, updates: Partial<ScheduledTask>): void {
		this.#ensureLoaded();
		const existing = this.#tasks.get(id);
		if (!existing) return;
		const updated: ScheduledTask = {
			...existing,
			...updates,
			updatedAt: Date.now(),
		};
		this.#tasks.set(id, updated);
		this.#flush();
	}

	deleteTask(id: string): void {
		this.#ensureLoaded();
		this.#tasks.delete(id);
		this.#flush();
	}

	/**
	 * Consume a leftover test-run restore marker (if any) and apply
	 * the snapshot to the in-memory task. Called by the gateway on
	 * startup and on every scheduler tick — both cheap (a single
	 * `fs.existsSync` per call) and idempotent (no-op if no marker
	 * or no matching task).
	 *
	 * Why this matters: if the test-run process (CLI or LLM) dies
	 * between writing the marker and clearing it in `finally`, the
	 * task is left on a one-shot schedule and the in-memory map is
	 * stale. The next engine tick sees the past-dated `+120s once`
	 * and auto-disables the task. This method is the safety net:
	 * the gateway heals the schedule before the engine can break it.
	 *
	 * Returns `true` if a marker was consumed (i.e. a restore
	 * happened), `false` otherwise. Callers can use the return to
	 * decide whether to reload the engine.
	 */
	consumeOrphanTestRunMarker(): boolean {
		this.#ensureLoaded();
		const marker = readTestRunMarker(this.getMarkerBaseDir());
		if (!marker) return false;
		// Same-process marker is an in-flight test-run, NOT an orphan —
		// UNLESS it carries an `awaitingFire: true` flag AND its
		// `expiresAt` deadline has passed. The flag means the host tool
		// already returned (it's not polling); the deadline means the
		// engine should have fired the task by now. In that case, the
		// engine's post-fire restore either already ran (and the marker
		// should be gone — we wouldn't be here) or never ran (engine
		// failed to fire; rare but possible after a schedule race or
		// a gateway restart between marker write and engine reload).
		// Recovering here is the right move: the task is stuck on
		// `+<n>s once` with `nextRunAt` in the past, and the engine's
		// own grace-period logic will disable it on the next tick.
		//
		// Cross-process markers (CLI test-run in a separate process, or
		// a previous gateway instance) are always recoverable —
		// they're true orphans.
		const sameProcess = marker.pid === process.pid;
		const awaitingFireExpired =
			marker.awaitingFire === true &&
			marker.expiresAt !== undefined &&
			Date.now() > marker.expiresAt;
		if (sameProcess && !awaitingFireExpired) {
			return false;
		}
		const existing = this.#tasks.get(marker.taskId);
		if (!existing) {
			// Task was deleted while test-run was in flight. Nothing
			// to restore; just clear the marker.
			clearTestRunMarker(this.getMarkerBaseDir());
			logger.info("[test-run] orphan marker for deleted task; cleared", {
				taskId: marker.taskId,
				taskName: marker.taskName,
			});
			return false;
		}
		const snap = marker.snapshot;
		this.#tasks.set(marker.taskId, {
			...existing,
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
		this.#flush();
		clearTestRunMarker(this.getMarkerBaseDir());
		logger.warn("[test-run] recovered orphan marker; restored schedule", {
			taskId: marker.taskId,
			taskName: marker.taskName,
			restoredCron: snap.cron,
			originalPid: marker.pid,
		});
		return true;
	}

	/**
	 * Returns the directory containing the test-run restore marker.
	 * The marker lives next to `jobs.json`; the notifier in
	 * `CronLifecycle.notifyOriginSessionIfPending` reads from this
	 * directory. Tests inject a custom `jobsPath` via the
	 * `JsonFileStorage` constructor to redirect both `jobs.json` and
	 * the marker into a tempdir.
	 */
	getMarkerBaseDir(): string {
		return path.dirname(this.#jobsPath);
	}

	// ── Execution operations ────────────────────────────────────────────
	//
	// In-flight ("running") executions live in memory only.
	// Finalized executions are read from the JSONL log files (same files
	// that appendExecutionLog writes to).

	recordExecution(exec: Omit<TaskExecution, "id">): TaskExecution {
		const id = generateExecutionId();
		const full: TaskExecution = { id, ...exec };
		this.#executions.set(id, full);
		return full;
	}

	updateExecution(id: string, updates: Partial<TaskExecution>): void {
		const existing = this.#executions.get(id);
		if (existing) {
			Object.assign(existing, updates);
		}
		// If not found in memory, it's already finalized and in JSONL log — no-op.
	}

	getExecutions(taskId: string, limit = 50): TaskExecution[] {
		const results: TaskExecution[] = [];
		const seenIds = new Set<string>();

		// 1. In-memory executions: includes both running (in-flight) and
		// terminal (not yet flushed to JSONL — e.g. tests that seed
		// `recordExecution` + `getExecutions` in the same process). The
		// production path also lands terminal execs in JSONL via
		// `appendExecutionLog` (called by CronService.#onTrigger after
		// the agent finishes); that path takes the JSONL branch below.
		// De-dup by id so the two sources don't double-count after
		// process restart (when JSONL is the only source).
		for (const exec of this.#executions.values()) {
			if (exec.taskId === taskId) {
				results.push(exec);
				seenIds.add(exec.id);
			}
		}

		// 2. Read from JSONL logs (finalized executions)
		const task = this.#tasks.get(taskId);
		if (task) {
			const logEntries = readExecutionLog(task.name, limit);
			for (const entry of logEntries) {
				if (seenIds.has(entry.id)) continue;
				results.push({
					id: entry.id,
					taskId,
					startedAt: entry.ts - entry.durationMs,
					endedAt: entry.ts,
					exitCode: entry.exitCode,
					output: entry.output,
					stderr: entry.stderr,
					status: entry.status,
					// Persisted in the JSONL log since the agentSessionPath
					// persistence fix; absent for entries written before
					// the fix (legacy fallback to no path → Tier 3
					// silently skipped, which is the safe default).
					agentSessionPath: entry.agentSessionPath,
				});
				seenIds.add(entry.id);
			}
		}

		// Sort by startedAt desc
		results.sort((a, b) => b.startedAt - a.startedAt);
		return results.slice(0, limit);
	}

	pruneExecutions(maxAgeDays = 30, _maxCount = 100): number {
		return pruneAllLogs(maxAgeDays);
	}

	// ── Cleanup ─────────────────────────────────────────────────────────

	close(): void {
		this.#executions.clear();
	}

	// ── Migration from SQLite ───────────────────────────────────────────

	/**
	 * Migrate all tasks from an existing SQLite DB into this JSON file storage.
	 * Returns { migrated, errors } counts.
	 */
	migrateFromDb(dbPath: string): { migrated: number; errors: string[] } {
		const result = { migrated: 0, errors: [] as string[] };
		// Pre-load existing tasks so we don't wipe them
		this.#ensureLoaded();

		try {
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			const { Database } = require("bun:sqlite") as {
				Database: new (
					path: string,
				) => { close(): void; prepare(sql: string): { all(): Record<string, unknown>[] } };
			};
			const db = new Database(dbPath);
			try {
				const rows = db.prepare("SELECT * FROM tasks ORDER BY created_at ASC").all();
				for (const row of rows) {
					try {
						const task = this.#rowToTask(row);
						if (task) {
							// Don't overwrite existing tasks
							if (!this.#tasks.has(task.id)) {
								this.#tasks.set(task.id, task);
								result.migrated++;
							}
						}
					} catch (err) {
						result.errors.push(`Failed to convert row ${row.id}: ${String(err)}`);
					}
				}
			} finally {
				db.close();
			}
		} catch (err) {
			result.errors.push(`Failed to open SQLite DB at ${dbPath}: ${String(err)}`);
		}

		if (result.migrated > 0) {
			this.#flush();
		}
		return result;
	}

	/** Convert a SQLite task row (Record<string, unknown>) to a ScheduledTask. */
	#rowToTask(row: Record<string, unknown>): ScheduledTask | null {
		const id = String(row.id ?? "");
		if (!id) return null;

		// agentDir: prefer agent_dir, fall back to account_id
		const agentDir = row.agent_dir ? String(row.agent_dir) : row.account_id ? String(row.account_id) : undefined;

		// delivery: from structured columns only (legacy deliver/deliver_user
		// columns were removed from ScheduledTask).
		const delivery: ScheduledTask["delivery"] = row.delivery_channel
			? {
					channel: String(row.delivery_channel),
					accountId: row.delivery_account_id ? String(row.delivery_account_id) : undefined,
					toUserId: row.delivery_to_user_id ? String(row.delivery_to_user_id) : undefined,
					toConversationId: row.delivery_to_conversation_id ? String(row.delivery_to_conversation_id) : undefined,
					mode: (String(row.delivery_mode) as "announce" | "none") ?? "announce",
				}
			: undefined;

		return {
			id,
			name: String(row.name ?? ""),
			description: row.description ? String(row.description) : undefined,
			cron: String(row.cron ?? ""),
			command: String(row.command ?? ""),
			status: (String(row.status) as ScheduledTask["status"]) ?? "active",
			scheduleType: row.schedule_type ? (String(row.schedule_type) as "cron" | "interval" | "once") : "cron",
			taskType: row.task_type ? (String(row.task_type) as "shell" | "agent") : "shell",
			model: row.model ? String(row.model) : undefined,
			provider: row.provider ? String(row.provider) : undefined,
			enabledToolsets: row.enabled_toolsets ? (JSON.parse(String(row.enabled_toolsets)) as string[]) : undefined,
			timeoutMs: row.timeout_ms ? Number(row.timeout_ms) : undefined,
			retry: row.retry_config ? JSON.parse(String(row.retry_config)) : undefined,
			skills: row.skills_config ? JSON.parse(String(row.skills_config)) : undefined,
			preScript: row.pre_script ? String(row.pre_script) : undefined,
			consecutiveFailures: Number(row.consecutive_failures ?? 0),
			createdAt: Number(row.created_at ?? Date.now()),
			updatedAt: Number(row.updated_at ?? Date.now()),
			lastRunAt: row.last_run_at ? Number(row.last_run_at) : undefined,
			nextRunAt: row.next_run_at ? Number(row.next_run_at) : undefined,
			runCount: Number(row.run_count ?? 0),
			failCount: Number(row.fail_count ?? 0),
			repeatCount: row.repeat_count ? Number(row.repeat_count) : undefined,
			repeatCompleted: row.repeat_completed ? Number(row.repeat_completed) : undefined,
			agentDir,
			delivery,
			lastDeliveryError: row.last_delivery_error ? String(row.last_delivery_error) : undefined,
			accountId: row.account_id ? String(row.account_id) : undefined,
			createdByUserId: row.created_by_user_id ? String(row.created_by_user_id) : undefined,
			createdByAccountId: row.created_by_account_id ? String(row.created_by_account_id) : undefined,
		};
	}
}
