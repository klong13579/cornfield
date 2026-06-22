/**
 * JSONL-based execution log for the scheduler.
 *
 * Logs live under `~/.omp/gateway-data/scheduler/logs/by-task/<slug>/<YYYY-MM-DD>.jsonl`
 * where `<slug>` is `slugify(task.name)` (kebab-case, pinyin for CJK). All runs
 * of a task on the same day are appended to the same file. Browsing the tree
 * shows tasks as directories and dates as files.
 *
 * The original task name is preserved in `tasks.name` (SQLite); the slug is
 * purely a filesystem hint.
 *
 * Backward compatibility: readers also look at the legacy flat location
 * `<logs>/<sanitized_task_name>.jsonl` (created by older versions). A one-shot
 * migration on first access moves legacy files into the new tree based on the
 * JSONL line's `ts` field.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { logger, slugifySync } from "@oh-my-pi/pi-utils";
import { pinyin } from "pinyin-pro";

const DEFAULT_LOG_ROOT = path.join(os.homedir(), ".omp", "gateway-data", "scheduler", "logs");

/** Active log root; tests can override via {@link setLogRoot}. */
let activeLogRoot: string = DEFAULT_LOG_ROOT;

export function getLogRoot(): string {
	return activeLogRoot;
}

export function setLogRoot(root: string): void {
	activeLogRoot = root;
	// Clear the slug cache so a different root gets its own resolution.
	dirCache.clear();
}

function byTaskDir(): string {
	return path.join(activeLogRoot, "by-task");
}
function legacyDir(): string {
	return activeLogRoot;
}

/**
 * Synchronous slug derivation that always runs pinyin-pro for CJK.
 * Falls back to the legacy ASCII sanitizer for empty input.
 */
function taskSlugSync(taskName: string): string {
	if (!taskName) return "task";
	// CJK detection: any character in CJK ranges
	if (/[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(taskName)) {
		const tokens = pinyin(taskName, { toneType: "none", type: "array" }).filter(Boolean);
		const slug = tokens.join("-").toLowerCase();
		// Reuse the same finalizer as slugifySync (collapse non-alnum, trim)
		return slugifySync(slug, { maxLen: 32, fallback: "task" }) || "task";
	}
	return slugifySync(taskName, { maxLen: 32, fallback: "task" });
}

export interface ExecutionLogEntry {
	id: string;
	ts: number;
	exitCode: number;
	status: "running" | "success" | "failure";
	durationMs: number;
	output: string;
	stderr: string;
}

/** YYYY-MM-DD in local time, used as the per-day filename. */
function dateStamp(ms: number): string {
	const d = new Date(ms);
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

/**
 * Legacy sanitizer — preserved so we can read files written by older
 * versions. Mirrors the old `replace(/[^a-zA-Z0-9_.-]/g, "_")` exactly.
 */
function legacySafeName(name: string): string {
	return name.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

/** Pending async slug resolution — drained on every write. */
const dirCache = new Map<string, string>();

/** Synchronous slug path (best-effort ASCII-only). */
function ensureTaskDirSync(taskName: string): string {
	const cached = dirCache.get(taskName);
	if (cached) return cached;
	const slug = taskSlugSync(taskName);
	const dir = path.join(byTaskDir(), slug);
	dirCache.set(taskName, dir);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	return dir;
}

/** Compute the destination file path for a given task + timestamp. */
function logFileFor(taskDirPath: string, ts: number): string {
	return path.join(taskDirPath, `${dateStamp(ts)}.jsonl`);
}

/**
 * Append an execution log entry to the task's per-day JSONL log file.
 *
 * Slug resolution is fully synchronous (pinyin-pro is sync; we just pay
 * the ~50KB import cost once at module load). The cached dir means each
 * task only computes its slug on the first write.
 */
export function appendExecutionLog(taskName: string, entry: ExecutionLogEntry): void {
	const dir = ensureTaskDirSync(taskName);
	const filePath = logFileFor(dir, entry.ts);
	try {
		const line = `${JSON.stringify(entry)}\n`;
		fs.appendFileSync(filePath, line, { encoding: "utf-8" });
	} catch (error) {
		logger.warn("Failed to append execution log", { taskName, error: String(error) });
	}
}

/** Single-line delivery-failure log entry. Compact, only the fields an
 * operator needs to debug. Kept separate from the per-task execution log
 * because the user can't see the per-task log without knowing the task
 * name, and the global failure log is the one place a delivery issue
 * surfaces when the IM channel itself is the problem. */
export interface DeliveryFailureEntry {
	ts: number;
	taskId: string;
	taskName: string;
	channel: string;
	userId: string;
	reason: string;
	attempts: number;
	exitCode: number;
}

function deliveryFailurePath(): string {
	return path.join(activeLogRoot, "delivery-failures.jsonl");
}

/**
 * Append a delivery-failure entry to the global delivery-failure log.
 *
 * Best-effort: a write failure itself is logged and swallowed (we never
 * throw from logging). This is the escalation target when the configured
 * deliver channel rejects the message — the entry stays on disk after
 * the in-memory log lines roll off, so operators have a record even
 * after a gateway restart.
 */
export function appendDeliveryFailureLog(entry: DeliveryFailureEntry): void {
	const filePath = deliveryFailurePath();
	try {
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, { encoding: "utf-8" });
	} catch (error) {
		logger.warn("Failed to append delivery-failure log", { error: String(error) });
	}
}

/**
 * Read recent delivery-failure entries from the global log, grouped by
 * taskId. Returns a Map keyed by taskId with the array of failures
 * (most-recent first). Use this to surface a per-task "X delivery
 * failures in last N hours" indicator in `cron list` without forcing
 * the operator to grep the JSONL file by hand.
 *
 * Backed by an in-memory cache: a single `cron list` invocation calls
 * this once, the file is small (one line per persistent failure), and
 * re-reading across `formatTaskRow()` calls would be wasted I/O.
 */
let deliveryFailureCache: { mtimeMs: number; entries: Map<string, DeliveryFailureEntry[]> } | null = null;
function loadDeliveryFailureCache(): Map<string, DeliveryFailureEntry[]> {
	const filePath = deliveryFailurePath();
	let stat: fs.Stats | null = null;
	try {
		stat = fs.statSync(filePath);
	} catch {
		// No log file yet = no failures
		return new Map();
	}
	if (deliveryFailureCache && deliveryFailureCache.mtimeMs === stat.mtimeMs) {
		return deliveryFailureCache.entries;
	}
	const grouped = new Map<string, DeliveryFailureEntry[]>();
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		for (const line of content.split("\n")) {
			if (!line) continue;
			try {
				const entry = JSON.parse(line) as DeliveryFailureEntry;
				const arr = grouped.get(entry.taskId) ?? [];
				arr.push(entry);
				grouped.set(entry.taskId, arr);
			} catch {
				// skip malformed line
			}
		}
		// Sort each group newest-first
		for (const arr of grouped.values()) {
			arr.sort((a, b) => b.ts - a.ts);
		}
	} catch (error) {
		logger.warn("Failed to read delivery-failure log", { error: String(error) });
	}
	deliveryFailureCache = { mtimeMs: stat.mtimeMs, entries: grouped };
	return grouped;
}

/** Invalidate the delivery-failure cache. Tests call this between
 *  scenarios; production code never needs to call it. */
export function clearDeliveryFailureCache(): void {
	deliveryFailureCache = null;
}

/**
 * Get the count of recent delivery failures for a given taskId.
 * `sinceMs` (default 24h) bounds the window so a task with one
 * historical failure three months ago doesn't keep showing a warning
 * forever. The cron list renders this count in a "DELIVERY" column.
 */
export function getRecentDeliveryFailureCount(taskId: string, sinceMs = 24 * 60 * 60 * 1000): number {
	const grouped = loadDeliveryFailureCache();
	const arr = grouped.get(taskId);
	if (!arr) return 0;
	const cutoff = Date.now() - sinceMs;
	return arr.filter(e => e.ts >= cutoff).length;
}

/** Read all delivery-failure entries (for tests / debugging). */
export function readDeliveryFailureLog(): DeliveryFailureEntry[] {
	const filePath = deliveryFailurePath();
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		return content
			.split("\n")
			.filter(Boolean)
			.map(line => JSON.parse(line) as DeliveryFailureEntry);
	} catch {
		return [];
	}
}

/** Read all log entries for a task from both the new tree and the legacy flat file. */
export function readExecutionLog(taskName: string, limit = 20): ExecutionLogEntry[] {
	const entries: ExecutionLogEntry[] = [];

	// New tree: walk the task directory (slug-resolved or sync-fallback) and
	// collect every .jsonl file, sorted newest first.
	const candidateDirs = new Set<string>();
	candidateDirs.add(ensureTaskDirSync(taskName));
	const resolved = dirCache.get(taskName);
	if (resolved) candidateDirs.add(resolved);

	for (const dir of candidateDirs) {
		try {
			const files = fs
				.readdirSync(dir)
				.filter(f => f.endsWith(".jsonl"))
				.sort()
				.reverse();
			for (const file of files) {
				const content = fs.readFileSync(path.join(dir, file), "utf-8");
				for (const line of content.split("\n")) {
					if (!line) continue;
					try {
						entries.push(JSON.parse(line) as ExecutionLogEntry);
					} catch {
						// skip malformed line
					}
				}
			}
		} catch {
			// dir may not exist yet
		}
	}

	// Legacy flat file (older versions)
	const legacyPath = path.join(legacyDir(), `${legacySafeName(taskName)}.jsonl`);
	try {
		const content = fs.readFileSync(legacyPath, "utf-8");
		for (const line of content.split("\n")) {
			if (!line) continue;
			try {
				entries.push(JSON.parse(line) as ExecutionLogEntry);
			} catch {
				// skip
			}
		}
	} catch {
		// no legacy file
	}

	entries.sort((a, b) => b.ts - a.ts);
	return entries.slice(0, limit);
}

/**
 * Prune execution logs for a task across all dates, keeping only the most
 * recent `keep` entries (by `ts`).
 */
export function pruneExecutionLog(taskName: string, keep: number): number {
	const entries = readExecutionLog(taskName, Number.MAX_SAFE_INTEGER);
	if (entries.length <= keep) return 0;

	const cutoff = entries[keep - 1]?.ts ?? 0;
	let removed = 0;

	const dirs = new Set<string>([
		ensureTaskDirSync(taskName),
		...(dirCache.has(taskName) ? [dirCache.get(taskName)!] : []),
	]);
	for (const dir of dirs) {
		try {
			const files = fs.readdirSync(dir).filter(f => f.endsWith(".jsonl"));
			for (const file of files) {
				const filePath = path.join(dir, file);
				const content = fs.readFileSync(filePath, "utf-8");
				const lines = content.split("\n").filter(Boolean);
				const keptLines: string[] = [];
				for (const line of lines) {
					try {
						const entry = JSON.parse(line) as ExecutionLogEntry;
						if (entry.ts >= cutoff) keptLines.push(line);
						else removed++;
					} catch {
						keptLines.push(line); // keep unparseable lines as-is
					}
				}
				if (keptLines.length === 0) {
					fs.unlinkSync(filePath);
				} else if (keptLines.length < lines.length) {
					fs.writeFileSync(filePath, `${keptLines.join("\n")}\n`, { encoding: "utf-8" });
				}
			}
		} catch {
			// dir may not exist
		}
	}

	return removed;
}

/**
 * Prune all execution logs older than maxAgeDays.
 *
 * Walks the by-task tree (one directory per task, one JSONL file per day) and
 * drops lines whose timestamp is before the cutoff. Empty files are deleted.
 * Legacy flat files at the logs root are processed the same way.
 */
export function pruneAllLogs(maxAgeDays: number): number {
	const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
	let deleted = 0;

	// Walk by-task tree
	try {
		const taskDirs = fs.readdirSync(byTaskDir(), { withFileTypes: true });
		for (const taskEnt of taskDirs) {
			if (!taskEnt.isDirectory()) continue;
			const taskDirPath = path.join(byTaskDir(), taskEnt.name);
			const files = fs.readdirSync(taskDirPath).filter(f => f.endsWith(".jsonl"));
			for (const file of files) {
				deleted += pruneFile(path.join(taskDirPath, file), cutoff);
			}
		}
	} catch {
		// by-task dir may not exist yet
	}

	// Walk legacy flat files (older versions)
	try {
		const legacyFiles = fs.readdirSync(legacyDir()).filter(f => f.endsWith(".jsonl"));
		for (const file of legacyFiles) {
			deleted += pruneFile(path.join(legacyDir(), file), cutoff);
		}
	} catch {
		// legacy dir may not exist
	}

	return deleted;
}

function pruneFile(filePath: string, cutoff: number): number {
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		const lines = content.split("\n").filter(Boolean);
		const kept: string[] = [];
		let removed = 0;
		for (const line of lines) {
			try {
				const entry = JSON.parse(line) as ExecutionLogEntry;
				if (entry.ts >= cutoff) kept.push(line);
				else removed++;
			} catch {
				kept.push(line);
			}
		}
		if (removed === 0) return 0;
		if (kept.length === 0) {
			fs.unlinkSync(filePath);
		} else {
			fs.writeFileSync(filePath, `${kept.join("\n")}\n`, { encoding: "utf-8" });
		}
		return removed;
	} catch {
		return 0;
	}
}
