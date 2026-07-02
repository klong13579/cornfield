/**
 * Best-effort cleanup of artifacts that accumulate in the logs dir.
 *
 * Two kinds of leftovers are removed:
 *
 * 1. 0-byte `omp.<date>.log.<N>` files. `file-stream-rotator` opens
 *    the rotated file with `O_CREAT` before any byte is written. If
 *    the process is killed (or the stream is closed for any reason)
 *    before the first chunk lands, the file is left at 0 bytes.
 *    These are NOT tracked in the audit file — the audit only
 *    records files that were actually written and hashed — so the
 *    transport's `maxFiles` retention never reclaims them. They
 *    accumulate forever otherwise.
 *
 * 2. `.omp-audit-<PID>.json` files whose PID is no longer alive. The
 *    audit file is keyed by PID so concurrent processes do not
 *    contend on a single shared file (a known
 *    `winston-daily-rotate-file` deadlock — see issue #245). The
 *    cost is one audit file per process, ever. They are useless
 *    once the process is dead.
 *
 * We do NOT touch:
 *  - `omp.<date>.log` (the active log file, even if the date
 *    changed and the process is still running).
 *  - Non-zero `omp.<date>.log.<N>` (real rotated content; the
 *    transport's `maxFiles` policy cleans them).
 *  - Our own audit file.
 *
 * Lives in its own module (no transport-side effects on import) so
 * tests can exercise it without booting the full logger stack.
 *
 * @param logsDir - Override the directory. When omitted, uses
 *                  `getLogsDir()`.
 * @returns number of files removed. Exported for tests and the
 *          one-shot manual cleanup of an existing backlog.
 */
import * as fs from "node:fs";
import { getLogsDir } from "./dirs";

export function cleanupStaleLogs(logsDir?: string): number {
	const dir = logsDir ?? getLogsDir();
	let entries: string[];
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return 0;
	}

	let removed = 0;
	for (const name of entries) {
		// 0-byte rotated logs: omp.<date>.log.<N>
		if (/^omp\..*\.log\.\d+$/.test(name)) {
			try {
				const stat = fs.statSync(`${dir}/${name}`);
				if (stat.size === 0) {
					fs.unlinkSync(`${dir}/${name}`);
					removed++;
				}
			} catch {
				/* ignore: race with another cleanup pass */
			}
			continue;
		}
		// Orphan audit files: .omp-audit-<PID>.json
		const m = /^\.omp-audit-(\d+)\.json$/.exec(name);
		if (m) {
			const pid = parseInt(m[1], 10);
			if (pid === process.pid) continue;
			try {
				process.kill(pid, 0);
				// alive — keep
			} catch {
				try {
					fs.unlinkSync(`${dir}/${name}`);
					removed++;
				} catch {
					/* ignore */
				}
			}
		}
	}
	return removed;
}
