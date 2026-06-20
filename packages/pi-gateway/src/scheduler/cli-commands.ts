/**
 * Shared cron CLI command implementations.
 *
 * These functions provide the canonical implementation of cron subcommands
 * used by both `pi-gateway` and `omp gateway cron`. They live in the
 * scheduler package so both CLIs can call them without duplicating logic.
 *
 * Feature set (richer than the old pi-gateway CLI):
 * - create: --name, --type, --deliver, --timeout-ms, --skills, --retry, --pre-script
 * - run: writes JSONL execution log + links agent session traces
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { appendExecutionLog } from "./execution-log";
import { executeScheduledCommand } from "./executor";
import type { SchedulerDbStorage } from "./storage";
import { formatExecutionRow, formatTaskRow, getGatewayPidPath, getNextRun, isDaemonRunning, parseSchedule } from "./types";

// ---------------------------------------------------------------------------
// Agent session path discovery
// ---------------------------------------------------------------------------

/**
 * Find the OMP agent session JSONL created during a specific time window.
 *
 * OMP writes agent session files to
 *   `~/.omp/agent/sessions/<encoded-cwd>/<timestamp>_<id>.jsonl`
 * where the ISO timestamp prefix is the immutable creation time of the
 * session (e.g. `2026-06-15T09-18-46-865Z_019eca93-...jsonl`).
 *
 * Why filename-based, not mtime: OMP frequently touches mtime on existing
 * session files (compaction, --continue, etc.), so mtime-based filtering
 * produces false positives linking to the wrong (older) session.
 *
 * To stay decoupled from OMP's cwd-encoding scheme, we scan ALL session
 * subdirectories and pick the file whose filename timestamp is closest
 * to (and >= startedAt - tolerance) within the window.
 */
export function findAgentSessionPath(startedAt: number, endedAt: number): string | undefined {
	const sessionsRoot = path.join(os.homedir(), ".omp", "agent", "sessions");
	if (!fs.existsSync(sessionsRoot)) return undefined;

	// New layout: by-date/<YYYY-MM-DD>/<HHMMSS>[-<slug>]__<8hex>.jsonl
	// Legacy: <YYYY-MM-DD>T<HH-MM-SS-mmm>Z_<uuidv7>.jsonl
	const NEW_FILENAME_TS = /^(\d{2})-(\d{2})-(\d{2})(?:-.+)?__[0-9a-f]{8}\.jsonl$/;
	const LEGACY_FILENAME_TS = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_/;
	const toleranceMs = 5_000;

	let bestMatch: { path: string; score: number } | undefined;
	try {
		const walk = (dir: string): void => {
			let entries: fs.Dirent[];
			try {
				entries = fs.readdirSync(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const ent of entries) {
				const full = path.join(dir, ent.name);
				if (ent.isDirectory()) {
					// Only descend into by-date/ at the cwd root, or recurse one level
					// into the yyyy-mm-dd/ sub-dirs.
					if (ent.name === "by-date" || /^\d{4}-\d{2}-\d{2}$/.test(ent.name)) walk(full);
					continue;
				}
				if (!ent.isFile() || !ent.name.endsWith(".jsonl")) continue;

				let createdAt: number | undefined;
				let dateFromDir: string | undefined;
				// If we're inside a yyyy-mm-dd directory, the date prefix comes from the parent.
				const parentName = path.basename(dir);
				if (/^\d{4}-\d{2}-\d{2}$/.test(parentName)) {
					dateFromDir = parentName;
				}

				const newMatch = NEW_FILENAME_TS.exec(ent.name);
				if (newMatch && dateFromDir) {
					const iso = `${dateFromDir}T${newMatch[1]}:${newMatch[2]}:${newMatch[3]}.000Z`;
					createdAt = Date.parse(iso);
				} else {
					const legacyMatch = LEGACY_FILENAME_TS.exec(ent.name);
					if (legacyMatch) {
						const iso = `${legacyMatch[1]}T${legacyMatch[2]}:${legacyMatch[3]}:${legacyMatch[4]}.${legacyMatch[5]}Z`;
						createdAt = Date.parse(iso);
					}
				}

				if (createdAt === undefined || !Number.isFinite(createdAt)) continue;
				if (createdAt < startedAt - toleranceMs) continue;
				if (createdAt > endedAt + toleranceMs) continue;

				const score = Math.abs(createdAt - startedAt);
				if (!bestMatch || score < bestMatch.score) {
					bestMatch = { path: full, score };
				}
			}
		};
		walk(sessionsRoot);
	} catch {
		return undefined;
	}
	return bestMatch?.path;
}

// ---------------------------------------------------------------------------
// Cron subcommands
// ---------------------------------------------------------------------------

export async function cronCreate(args: string[], storage: SchedulerDbStorage): Promise<void> {
	let name: string | undefined;
	let schedule: string | undefined;
	let deliver: string | undefined;
	let type: "shell" | "agent" = "shell";
	let timeoutMs: number | undefined;
	let skills: string[] | undefined;
	let retryMaxAttempts: number | undefined;
	let preScript: string | undefined;
	const commandParts: string[] = [];

	let i = 0;
	while (i < args.length) {
		if (args[i] === "--name" && args[i + 1]) {
			name = args[i + 1]!;
			i += 2;
		} else if (args[i] === "--type" && args[i + 1]) {
			type = args[i + 1] as "shell" | "agent";
			i += 2;
		} else if (args[i] === "--deliver" && args[i + 1]) {
			deliver = args[i + 1];
			i += 2;
		} else if (args[i] === "--timeout-ms" && args[i + 1]) {
			const v = Number.parseInt(args[i + 1]!, 10);
			if (!Number.isFinite(v) || v <= 0) {
				console.error(`Invalid --timeout-ms: must be a positive integer (got "${args[i + 1]}")`);
				process.exitCode = 1;
				return;
			}
			timeoutMs = v;
			i += 2;
		} else if (args[i] === "--skills" && args[i + 1]) {
			skills = args[i + 1]!.split(",")
				.map(s => s.trim())
				.filter(Boolean);
			if (skills.length === 0) {
				console.error(`Invalid --skills: must be a non-empty comma-separated list (got "${args[i + 1]}")`);
				process.exitCode = 1;
				return;
			}
			i += 2;
		} else if (args[i] === "--retry" && args[i + 1]) {
			const v = Number.parseInt(args[i + 1]!, 10);
			if (!Number.isFinite(v) || v < 1) {
				console.error(`Invalid --retry: must be a positive integer >= 1 (got "${args[i + 1]}")`);
				process.exitCode = 1;
				return;
			}
			retryMaxAttempts = v;
			i += 2;
		} else if (args[i] === "--pre-script" && args[i + 1]) {
			preScript = args[i + 1]!;
			i += 2;
		} else {
			if (!schedule) schedule = args[i];
			else commandParts.push(args[i]!);
			i++;
		}
	}

	const command = commandParts.join(" ");
	if (!schedule || !command) {
		console.error(
			"Usage: <schedule> <command...> [--name <name>] [--type shell|agent] [--deliver <channel>] [--timeout-ms <ms>] [--skills <s1,s2,...>] [--retry <maxAttempts>] [--pre-script <path>]",
		);
		process.exitCode = 1;
		return;
	}

	if (!name) name = `task_${Date.now()}`;

	const parsed = parseSchedule(schedule);
	if (parsed.error) {
		console.error(`Invalid schedule: ${parsed.error}`);
		process.exitCode = 1;
		return;
	}

	if (storage.getTaskByName(name)) {
		console.error(`Task "${name}" already exists.`);
		process.exitCode = 1;
		return;
	}

	const nextRun =
		parsed.type === "cron" ? getNextRun(parsed.schedule) : parsed.nextRunAt ? new Date(parsed.nextRunAt) : undefined;
	storage.addTask({
		name,
		cron: parsed.schedule,
		command,
		scheduleType: parsed.type,
		taskType: type,
		timeoutMs: timeoutMs ?? (type === "agent" ? 120_000 : 30_000),
		retry:
			retryMaxAttempts !== undefined ? { maxAttempts: retryMaxAttempts, backoffMs: [1000, 5000, 30000] } : undefined,
		skills,
		preScript,
		deliver,
		status: "active",
		createdAt: Date.now(),
		updatedAt: Date.now(),
		nextRunAt: nextRun ? nextRun.getTime() : parsed.nextRunAt,
		runCount: 0,
		failCount: 0,
		consecutiveFailures: 0,
	});

	console.log(`Task "${name}" created.`);
	console.log(
		`  Type: ${parsed.type} | Schedule: ${parsed.schedule} | Next: ${nextRun ? nextRun.toLocaleString() : "—"}`,
	);
	if (deliver) console.log(`  Delivery: ${deliver}`);
	if (timeoutMs !== undefined) console.log(`  Timeout: ${timeoutMs}ms`);
	if (skills) console.log(`  Skills: ${skills.join(", ")}`);
	if (retryMaxAttempts !== undefined) console.log(`  Retry: max ${retryMaxAttempts} attempts (backoff 1s/5s/30s)`);
	if (preScript) console.log(`  Pre-script: ${preScript}`);
}

export async function cronList(storage: SchedulerDbStorage, json: boolean): Promise<void> {
	const tasks = storage.listTasks();
	if (json) {
		console.log(JSON.stringify(tasks, null, 2));
		return;
	}
	if (tasks.length === 0) {
		console.log("No scheduled tasks.");
		return;
	}
	console.log("NAME                 TYPE    STATUS     CRON                 NEXT RUN             LAST RUN");
	console.log("─".repeat(96));
	for (const task of tasks) console.log(formatTaskRow(task));
}

export async function cronSetStatus(
	name: string,
	status: "active" | "disabled",
	storage: SchedulerDbStorage,
): Promise<void> {
	if (!name) {
		console.error("Usage: pause|resume <name>");
		process.exitCode = 1;
		return;
	}
	const task = storage.getTaskByName(name);
	if (!task) {
		console.error(`Task "${name}" not found.`);
		process.exitCode = 1;
		return;
	}
	storage.updateTask(task.id, {
		status,
		nextRunAt: status === "active" ? getNextRun(task.cron)?.getTime() : undefined,
		updatedAt: Date.now(),
	});
	console.log(`Task "${name}" ${status === "active" ? "resumed" : "paused"}.`);
}

export async function cronRun(name: string, storage: SchedulerDbStorage): Promise<void> {
	if (!name) {
		console.error("Usage: cron run <name>");
		process.exitCode = 1;
		return;
	}
	const task = storage.getTaskByName(name);
	if (!task) {
		console.error(`Task "${name}" not found.`);
		process.exitCode = 1;
		return;
	}
	const startedAt = Date.now();
	const exec = storage.recordExecution({ taskId: task.id, startedAt, status: "running" });
	try {
		const { exitCode, output, stderr } = await executeScheduledCommand(task.command, {
			taskType: task.taskType,
			timeoutMs: task.timeoutMs,
			skills: task.skills,
			preScript: task.preScript,
		});
		const endedAt = Date.now();
		const durationMs = endedAt - startedAt;
		const status = exitCode === 0 ? "success" : "failure";

		// Link agent session trace for agent tasks
		const agentSessionPath = task.taskType === "agent" ? findAgentSessionPath(startedAt, endedAt) : undefined;

		storage.updateExecution(exec.id, {
			endedAt,
			exitCode,
			output,
			stderr,
			status,
			...(agentSessionPath ? { agentSessionPath } : {}),
		});
		storage.updateTask(task.id, {
			lastRunAt: Date.now(),
			runCount: task.runCount + 1,
			failCount: exitCode === 0 ? task.failCount : task.failCount + 1,
		});

		// Write full stdout/stderr to JSONL log
		appendExecutionLog(task.name, {
			id: exec.id,
			ts: endedAt,
			exitCode,
			status,
			durationMs,
			output,
			stderr,
		});

		if (agentSessionPath) {
			console.log(`[trace] agent session: ${agentSessionPath}`);
		}

		if (exitCode !== 0) {
			console.error(`Task "${name}" failed (exit ${exitCode}).`);
			process.exitCode = exitCode;
		} else {
			console.log(`Task "${name}" completed.`);
		}
	} catch (err) {
		const endedAt = Date.now();
		const agentSessionPath = task.taskType === "agent" ? findAgentSessionPath(startedAt, endedAt) : undefined;
		storage.updateExecution(exec.id, {
			endedAt,
			exitCode: 1,
			stderr: String(err),
			status: "failure",
			...(agentSessionPath ? { agentSessionPath } : {}),
		});
		if (agentSessionPath) console.log(`[trace] agent session: ${agentSessionPath}`);
		console.error(`Task "${name}" failed: ${err}`);
		process.exitCode = 1;
	}
}

export async function cronRemove(name: string, storage: SchedulerDbStorage): Promise<void> {
	if (!name) {
		console.error("Usage: cron remove <name>");
		process.exitCode = 1;
		return;
	}
	const task = storage.getTaskByName(name);
	if (!task) {
		console.error(`Task "${name}" not found.`);
		process.exitCode = 1;
		return;
	}
	storage.deleteTask(task.id);
	console.log(`Task "${name}" removed.`);
}

export function cronStatus(): void {
	// The scheduler runs inside the gateway process; check gateway.pid.
	const pidPath = getGatewayPidPath();
	const running = isDaemonRunning(pidPath);
	console.log(`Scheduler: ${running ? "running" : "stopped"}`);
	if (running) {
		try {
			const pid = Number.parseInt(fs.readFileSync(pidPath, "utf8").trim(), 10);
			if (!Number.isNaN(pid)) console.log(`  PID: ${pid}`);
		} catch {
			// ignore
		}
	}
}

export async function cronDiagnose(storage: SchedulerDbStorage, json: boolean): Promise<void> {
	const tasks = storage.listTasks();
	const total = tasks.length;
	const active = tasks.filter(t => t.status === "active").length;
	const paused = tasks.filter(t => t.status === "paused").length;
	const disabled = tasks.filter(t => t.status === "disabled").length;
	if (json) {
		console.log(JSON.stringify({ taskCounts: { total, active, paused, disabled } }, null, 2));
		return;
	}
	console.log("## Scheduler Diagnosis");
	console.log(`Tasks: ${total} total (${active} active, ${paused} paused, ${disabled} disabled)`);
}

export async function cronLogs(name: string, storage: SchedulerDbStorage, json: boolean): Promise<void> {
	if (!name) {
		console.error("Usage: cron logs <name>");
		process.exitCode = 1;
		return;
	}
	const task = storage.getTaskByName(name);
	if (!task) {
		console.error(`Task "${name}" not found.`);
		process.exitCode = 1;
		return;
	}
	const executions = storage.getExecutions(task.id, 20);
	if (json) {
		console.log(JSON.stringify(executions, null, 2));
		return;
	}
	if (executions.length === 0) {
		console.log(`No executions for task "${name}".`);
		return;
	}
	console.log("ID                 STATUS   DURATION EXIT");
	console.log("─".repeat(50));
	for (const exec of executions) console.log(formatExecutionRow(exec));
}
