/**
 * CrashLog — JSONL persistence of agent bridge crash events.
 *
 * Why: in-memory crash state (`CrashRecovery.#timestamps`, `CircuitBreaker.#failures`)
 * is lost when the gateway process restarts. A bridge that crashes 8 times in
 * 10 minutes and then gets restarted by launchd would otherwise appear
 * "fresh" and repeat the same failure cycle indefinitely. Persisting each
 * crash event to disk makes the death loop observable across restarts and
 * lets `doctor` / `status` readers see history without holding the gateway
 * process alive.
 *
 * Schema (JSONL, one event per line):
 *   { kind: "crash",       ts, accountId, exitCode?, reason }
 *   { kind: "recovery",    ts, accountId, attempt, success }
 *   { kind: "suppressed",  ts, accountId, crashCount, windowMs }
 *   { kind: "state",       ts, accountId, state, windowCount, suppressed, timeout }
 *
 * Inspired by openclaw's `agent_lifecycle_manager._log_activation` JSONL
 * pattern (workspace-main/01-研发与技术/项目管理/agent_lifecycle_manager.py).
 *
 * IO failures are swallowed (logged as warn) — the crash log is an
 * observability layer, not a source of truth, and a write failure must
 * never escalate into a fresh crash.
 */

import * as fsp from "node:fs/promises";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";

export type CrashLogKind = "crash" | "recovery" | "suppressed" | "state";

export interface CrashLogEntryBase {
	kind: CrashLogKind;
	ts: number;
	accountId: string;
}

export interface CrashLogCrash extends CrashLogEntryBase {
	kind: "crash";
	exitCode?: number;
	reason: string;
}

export interface CrashLogRecovery extends CrashLogEntryBase {
	kind: "recovery";
	attempt: number;
	success: boolean;
}

export interface CrashLogSuppressed extends CrashLogEntryBase {
	kind: "suppressed";
	crashCount: number;
	windowMs: number;
}

export interface CrashLogState extends CrashLogEntryBase {
	kind: "state";
	state: "active" | "timeout" | "suppressed";
	windowCount: number;
	suppressed: boolean;
	timeout: boolean;
}

export type CrashLogEntry = CrashLogCrash | CrashLogRecovery | CrashLogSuppressed | CrashLogState;

const DEFAULT_LOG_DIR = path.join(os.homedir(), ".omp", "gateway-data");
const DEFAULT_LOG_FILE = "crash_log.jsonl";

export class CrashLog {
	readonly #logPath: string;

	constructor(logPath?: string) {
		this.#logPath = logPath ?? path.join(DEFAULT_LOG_DIR, DEFAULT_LOG_FILE);
	}

	get logPath(): string {
		return this.#logPath;
	}

	/** Append a single entry to the JSONL log. Best-effort: errors are
	 *  logged at warn and never re-thrown. */
	append(
		entry:
			| Omit<CrashLogCrash, "ts">
			| Omit<CrashLogRecovery, "ts">
			| Omit<CrashLogSuppressed, "ts">
			| Omit<CrashLogState, "ts">,
	): void {
		const line = `${JSON.stringify({ ts: Date.now(), ...entry })}\n`;
		try {
			fs.mkdirSync(path.dirname(this.#logPath), { recursive: true });
			fs.appendFileSync(this.#logPath, line, "utf8");
		} catch (err) {
			logger.warn("CrashLog.append failed", {
				path: this.#logPath,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	logCrash(accountId: string, reason: string, exitCode?: number): void {
		const entry: Omit<CrashLogCrash, "ts"> = { kind: "crash", accountId, reason };
		if (exitCode !== undefined) entry.exitCode = exitCode;
		this.append(entry);
	}

	logRecovery(accountId: string, attempt: number, success: boolean): void {
		this.append({ kind: "recovery", accountId, attempt, success });
	}

	logSuppressed(accountId: string, crashCount: number): void {
		this.append({ kind: "suppressed", accountId, crashCount, windowMs: 0 });
	}

	logState(
		accountId: string,
		state: "active" | "timeout" | "suppressed",
		windowCount: number,
		suppressed: boolean,
		timeout: boolean,
	): void {
		this.append({ kind: "state", accountId, state, windowCount, suppressed, timeout });
	}

	/** Read recent entries for an account, newest first. Bounded by `limit`
	 *  to keep callers from reading the whole file. */
	async recent(accountId: string, sinceMs?: number, limit = 200): Promise<CrashLogEntry[]> {
		let raw = "";
		try {
			raw = await fsp.readFile(this.#logPath, "utf8");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
			logger.warn("CrashLog.recent read failed", {
				path: this.#logPath,
				error: err instanceof Error ? err.message : String(err),
			});
			return [];
		}
		const cutoff = sinceMs ?? 0;
		const out: CrashLogEntry[] = [];
		for (const line of raw.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				const entry = JSON.parse(trimmed) as CrashLogEntry;
				if (entry.accountId !== accountId) continue;
				if (entry.ts < cutoff) continue;
				out.push(entry);
			} catch {
				// skip malformed line
			}
		}
		out.sort((a, b) => b.ts - a.ts);
		return out.slice(0, limit);
	}

	/** Count crash entries for `accountId` whose timestamp is within
	 *  `[now - windowMs, now]`. Used at startup to decide whether the
	 *  recovered process should be treated as already-suppressed. */
	async recentCrashCount(accountId: string, windowMs: number): Promise<number> {
		const sinceMs = Date.now() - windowMs;
		const entries = await this.recent(accountId, sinceMs, 1000);
		return entries.filter(e => e.kind === "crash").length;
	}
}

/** Process-wide default instance (lazy). */
let _default: CrashLog | undefined;
export function defaultCrashLog(): CrashLog {
	if (!_default) _default = new CrashLog();
	return _default;
}
