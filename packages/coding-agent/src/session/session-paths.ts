/**
 * Session file path generation for the hierarchical layout.
 *
 * Layout:
 *   <sessionDir>/
 *     by-date/
 *       YYYY-MM-DD/
 *         HHMMSS[-<slug>]__<8hex>.jsonl
 *
 * The 8-hex suffix is the last 8 chars of the session UUIDv7 — gives
 * uniqueness within a millisecond without dragging the full UUID into
 * the filename. The slug is only included when a title is available at
 * file creation time (e.g. forking from a titled parent). For the common
 * case (fresh session), the filename is `HHMMSS__<8hex>.jsonl`; the title
 * lives in the JSONL header and surfaces via `omp session ls`.
 */
import * as path from "node:path";
import { slugifySync } from "@oh-my-pi/pi-utils";

/** Extract `YYYY-MM-DD` from a Date. */
export function dateStamp(d: Date = new Date()): string {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

/** Extract `HHMMSS` from a Date. */
export function timeStamp(d: Date = new Date()): string {
	const h = String(d.getHours()).padStart(2, "0");
	const m = String(d.getMinutes()).padStart(2, "0");
	const s = String(d.getSeconds()).padStart(2, "0");
	return `${h}${m}${s}`;
}

/**
 * Compute the relative path for a session file inside its `by-date/<date>/`
 * sub-tree. Pass this to `path.join(sessionDir, relative)` to get the full
 * path. Keeping the relative form lets callers handle `ensureDir` themselves.
 *
 * @param sessionId - full session UUIDv7 (or any opaque id)
 * @param date - when the session was created
 * @param title - optional title used to derive a slug; omit for a plain
 *                `HHMMSS__<8hex>.jsonl` filename.
 */
export function sessionRelativePath(sessionId: string, date: Date = new Date(), title?: string): string {
	const stamp = timeStamp(date);
	const dateDir = dateStamp(date);
	const tail = sessionId.slice(-8);
	const slug = title ? slugifySync(title, { maxLen: 32 }) : "";
	const file = slug ? `${stamp}-${slug}__${tail}.jsonl` : `${stamp}__${tail}.jsonl`;
	return path.join("by-date", dateDir, file);
}

/** Convenience: full absolute path for a session file. */
export function sessionFilePath(
	sessionDir: string,
	sessionId: string,
	date: Date = new Date(),
	title?: string,
): string {
	return path.join(sessionDir, sessionRelativePath(sessionId, date, title));
}
