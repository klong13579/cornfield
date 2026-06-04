/**
 * JSONL-based execution log for the scheduler.
 *
 * Each execution is appended as a JSON line to
 * `~/.omp/gateway-data/scheduler/logs/{task_name}.jsonl`.
 *
 * This complements the SQLite executions table (which stores metadata)
 * with full stdout/stderr output in an append-friendly format.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";

const LOG_DIR = path.join(os.homedir(), ".omp", "gateway-data", "scheduler", "logs");

export interface ExecutionLogEntry {
	id: string;
	ts: number;
	exitCode: number;
	status: "running" | "success" | "failure";
	durationMs: number;
	output: string;
	stderr: string;
}

function ensureLogDir(): void {
	fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
}

function safeFileName(name: string): string {
	return name.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

/**
 * Append an execution log entry to the task's JSONL log file.
 */
export function appendExecutionLog(taskName: string, entry: ExecutionLogEntry): void {
	ensureLogDir();
	const filePath = path.join(LOG_DIR, `${safeFileName(taskName)}.jsonl`);
	try {
		const line = `${JSON.stringify(entry)}\n`;
		fs.appendFileSync(filePath, line, { encoding: "utf-8" });
	} catch (error) {
		logger.warn("Failed to append execution log", { taskName, error: String(error) });
	}
}

/**
 * Read execution log entries for a task, most recent first.
 */
export function readExecutionLog(taskName: string, limit = 20): ExecutionLogEntry[] {
	const filePath = path.join(LOG_DIR, `${safeFileName(taskName)}.jsonl`);
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		const lines = content.trim().split("\n").filter(Boolean);
		const entries = lines.map(line => JSON.parse(line) as ExecutionLogEntry);
		return entries.reverse().slice(0, limit);
	} catch {
		return [];
	}
}

/**
 * Prune execution logs for a task, keeping only the most recent `keep` entries.
 */
export function pruneExecutionLog(taskName: string, keep: number): number {
	const filePath = path.join(LOG_DIR, `${safeFileName(taskName)}.jsonl`);
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		const lines = content.trim().split("\n").filter(Boolean);
		if (lines.length <= keep) return 0;

		const kept = lines.slice(-keep);
		fs.writeFileSync(filePath, `${kept.join("\n")}\n`, { encoding: "utf-8" });
		return lines.length - keep;
	} catch {
		return 0;
	}
}

/**
 * Prune all execution logs older than maxAgeDays.
 */
export function pruneAllLogs(maxAgeDays: number): number {
	ensureLogDir();
	let deleted = 0;
	const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

	try {
		const files = fs.readdirSync(LOG_DIR).filter(f => f.endsWith(".jsonl"));
		for (const file of files) {
			const filePath = path.join(LOG_DIR, file);
			try {
				const content = fs.readFileSync(filePath, "utf-8");
				const lines = content.trim().split("\n").filter(Boolean);
				const kept = lines.filter(line => {
					try {
						const entry = JSON.parse(line) as ExecutionLogEntry;
						return entry.ts >= cutoff;
					} catch {
						return false;
					}
				});
				if (kept.length < lines.length) {
					fs.writeFileSync(filePath, `${kept.join("\n")}\n`, { encoding: "utf-8" });
					deleted += lines.length - kept.length;
				}
			} catch {
				// skip unreadable files
			}
		}
	} catch {
		// skip if dir doesn't exist
	}

	return deleted;
}
