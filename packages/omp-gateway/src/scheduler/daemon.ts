/**
 * Scheduler daemon — persists tasks in SQLite and runs them via cron.
 *
 * Now part of the unified Gateway architecture. The SchedulerEngine
 * is started/stopped within the Gateway lifecycle, not as a standalone daemon.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { SchedulerEngine } from "./engine";
import { appendExecutionLog } from "./execution-log";
import { executeScheduledCommand } from "./executor";
import { SchedulerFileStore } from "./file-store";
import { JsonFileStorage } from "./json-file-storage";
import type { DaemonOptions, DaemonStatus, ScheduledTask, SchedulerConfig } from "./types";
import {
	clearDaemonPid,
	DEFAULT_SCHEDULER_CONFIG,
	getSchedulerDir,
	getSchedulerLogPath,
	getSchedulerPidPath,
	isDaemonRunning,
	readDaemonPid,
	writeDaemonPid,
} from "./types";

const SCHEDULER_DIR_MODE = 0o700;
const SCHEDULER_LOCK_NAME = ".scheduler.lock";

export class SchedulerDaemon {
	readonly #dbPath: string;
	readonly #ompBinary: string;
	readonly #foreground: boolean;
	readonly #config: SchedulerConfig;
	#storage?: JsonFileStorage;
	#engine?: SchedulerEngine;
	#fileStore?: SchedulerFileStore;
	#pidPath: string;
	/** File descriptor for the cross-process lock (fd held open == lock held) */
	#lockFd?: number;
	#lockPath: string;
	#started = false;

	constructor(options: DaemonOptions) {
		this.#dbPath = options.dbPath;
		this.#ompBinary = options.ompBinary;
		this.#foreground = options.foreground ?? false;
		this.#pidPath = getSchedulerPidPath();
		this.#lockPath = path.join(getSchedulerDir(), SCHEDULER_LOCK_NAME);
		this.#config = {
			...DEFAULT_SCHEDULER_CONFIG,
			taskDir: path.join(getSchedulerDir(), "tasks"),
			...(options.config ?? {}),
		};
	}

	start(): void {
		if (this.#started) {
			logger.warn("Daemon already started");
			return;
		}

		if (!this.#foreground) {
			this.#daemonize();
			return;
		}

		if (isDaemonRunning(this.#pidPath)) {
			logger.warn("Scheduler daemon is already running", { pid: readDaemonPid(this.#pidPath) });
			return;
		}

		// Acquire fd-based exclusive lock. Unlike mkdir(), the fd is auto-released
		// by the OS when the process exits (even on crash), so stale locks cannot
		// accumulate. This is the closest cross-platform equivalent to fcntl.flock.
		try {
			fs.mkdirSync(path.dirname(this.#lockPath), { recursive: true, mode: SCHEDULER_DIR_MODE });
			this.#lockFd = fs.openSync(
				this.#lockPath,
				fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
				0o600,
			);
			// Write PID into the lock file so a reader can tell who owns it
			fs.writeSync(this.#lockFd, String(process.pid));
		} catch (err: unknown) {
			if ((err as NodeJS.ErrnoException).code === "EEXIST") {
				// Read the stale PID from the lock file for diagnostics
				try {
					const oldPid = Number.parseInt(fs.readFileSync(this.#lockPath, "utf8").trim(), 10);
					if (!Number.isNaN(oldPid)) {
						try {
							process.kill(oldPid, 0);
							logger.warn(`Scheduler daemon is already running (PID ${oldPid})`);
							return;
						} catch {
							// Stale lock — process is dead, remove and retry
							logger.warn(`Removing stale scheduler lock from PID ${oldPid}`);
							fs.unlinkSync(this.#lockPath);
							this.#lockFd = fs.openSync(
								this.#lockPath,
								fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
								0o600,
							);
							fs.writeSync(this.#lockFd, String(process.pid));
						}
					}
				} catch {
					// Can't read/corrupt lock file — treat as locked
					logger.warn("Scheduler daemon is already running (lock exists)");
					return;
				}
			} else {
				throw err;
			}
		}

		this.#storage = new JsonFileStorage();
		// Migrate from existing SQLite if present
		try {
			if (fs.existsSync(this.#dbPath)) {
				const { migrated, errors } = this.#storage.migrateFromDb(this.#dbPath);
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

		// Initialize file store and sync to DB
		this.#fileStore = new SchedulerFileStore(this.#config.taskDir, this.#storage);
		const syncResult = this.#fileStore.syncToDb();
		if (syncResult.added > 0 || syncResult.removed > 0 || syncResult.updated > 0) {
			logger.debug("File store initial sync", syncResult);
		}

		this.#engine = new SchedulerEngine({
			storage: this.#storage,
			onTrigger: this.#onTrigger.bind(this),
			config: this.#config,
		});

		this.#engine.start();
		writeDaemonPid(this.#pidPath, process.pid);
		this.#started = true;

		this.#setupSignalHandlers();

		logger.debug("Scheduler daemon started", {
			pid: process.pid,
			taskDir: this.#config.taskDir,
		});
	}

	stop(): void {
		if (!this.#started) return;

		this.#engine?.stop();
		this.#engine = undefined;

		clearDaemonPid(this.#pidPath);

		this.#storage?.close();
		this.#storage = undefined;
		this.#fileStore = undefined;

		// Release fd-based lock
		try {
			if (this.#lockFd !== undefined) {
				fs.closeSync(this.#lockFd);
				this.#lockFd = undefined;
			}
			fs.unlinkSync(this.#lockPath);
		} catch {
			// ignore — lock fd is auto-released by OS on exit
		}

		this.#started = false;

		logger.debug("Scheduler daemon stopped");
	}

	getStatus(): DaemonStatus {
		return {
			running: this.#started,
			pid: this.#started ? process.pid : undefined,
			taskCount: this.#engine ? this.#engine.getActiveTaskIds().length : 0,
			startedAt: this.#started ? Date.now() : undefined,
		};
	}

	async #onTrigger(task: ScheduledTask, executionId: string): Promise<void> {
		if (!this.#storage) return;

		const startedAt = Date.now();
		const { exitCode, output, stderr, timedOut } = await executeScheduledCommand(task.command, {
			taskType: task.taskType,
			timeoutMs: task.timeoutMs,
			ompBinary: this.#ompBinary,
			skills: task.skills,
			preScript: task.preScript,
		});
		const endedAt = Date.now();
		const durationMs = endedAt - startedAt;

		this.#storage.updateExecution(executionId, {
			status: exitCode === 0 ? "success" : "failure",
			exitCode,
			output: timedOut ? `[TIMED OUT after ${task.timeoutMs ?? 30_000}ms]\n${output}` : output,
			stderr: timedOut ? `[TIMED OUT]\n${stderr}` : stderr,
			endedAt,
		});

		// Append execution log to JSONL
		const finalOutput = timedOut ? `[TIMED OUT after ${task.timeoutMs ?? 30_000}ms]\n${output}` : output;
		const finalStderr = timedOut ? `[TIMED OUT]\n${stderr}` : stderr;
		appendExecutionLog(task.name, {
			id: executionId,
			ts: endedAt,
			exitCode,
			status: exitCode === 0 ? "success" : "failure",
			durationMs,
			output: finalOutput,
			stderr: finalStderr,
		});

		if (exitCode !== 0 || timedOut) {
			const currentTask = this.#storage.getTask(task.id);
			if (currentTask) {
				this.#storage.updateTask(task.id, {
					failCount: currentTask.failCount + 1,
				});
			}
			logger.warn("Task execution failed", { taskId: task.id, exitCode, executionId, timedOut });
		} else {
			logger.debug("Task execution succeeded", { taskId: task.id, executionId });
		}
	}

	#daemonize(): void {
		const logPath = getSchedulerLogPath();
		fs.mkdirSync(path.dirname(logPath), { recursive: true });
		const logFd = fs.openSync(logPath, "a");

		const args = process.argv.slice(2);
		if (!args.includes("--foreground")) {
			args.push("--foreground");
		}

		const isScript =
			this.#ompBinary.endsWith(".ts") || this.#ompBinary.endsWith(".js") || this.#ompBinary.endsWith(".mjs");
		const cmd = isScript ? [process.execPath, this.#ompBinary] : [this.#ompBinary];

		const proc = Bun.spawn([...cmd, ...args], {
			detached: true,
			stdout: logFd,
			stderr: logFd,
			stdin: "ignore",
		});

		proc.unref();

		logger.debug("Scheduler daemon spawned in background", { pid: proc.pid });
	}

	#setupSignalHandlers(): void {
		const gracefulShutdown = () => {
			logger.debug("Received shutdown signal, stopping daemon");
			this.stop();
			process.exit(0);
		};

		process.once("SIGTERM", gracefulShutdown);
		process.once("SIGINT", gracefulShutdown);
	}
}
