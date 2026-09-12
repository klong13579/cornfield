/**
 * Internal-URL path detection for self-evolution file bookkeeping.
 *
 * After ADR-0003, `read`/`write` carry an `xd://` transport family: a tool
 * `path` argument is no longer always a filesystem path. Heuristics that
 * record "modified files" or attribute edits by path must not treat internal
 * URLs (`xd://`, `agent://`, `skill://`, ...) as files.
 */
const INTERNAL_URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/** True when a tool `path` is an internal URL rather than a filesystem path. */
export function isInternalUrlPath(value: string): boolean {
	return INTERNAL_URL_RE.test(value.trim());
}
