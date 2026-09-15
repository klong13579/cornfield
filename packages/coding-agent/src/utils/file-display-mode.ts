/**
 * Resolve line-display mode for file-like outputs (read, grep, @file mentions).
 */

import { resolveEditMode } from "./edit-mode";

export interface FileDisplayMode {
	lineNumbers: boolean;
	hashLines: boolean;
}

/** Session-like object providing settings and tool availability for display mode resolution. */
export interface FileDisplayModeSession {
	/** Whether the edit tool is available. Hashlines are suppressed without it. */
	hasEditTool?: boolean;
	settings: {
		get(key: "readLineNumbers" | "readHashLines" | "edit.mode"): unknown;
	};
}

/**
 * Computes effective line display mode from session settings/env.
 * Hashline mode takes precedence and implies line-addressed output everywhere.
 * Hashlines are suppressed when the edit tool is not available (e.g. explore agents),
 * when the caller signals a `raw` read, and when the resource is `immutable` —
 * an internal URL has no edit path that could consume the anchors. Raw output is
 * returned as-is. An immutable resource keeps line numbers, because `sel` takes
 * line numbers and a resource the agent cannot re-read by range is worse than an
 * unanchored one.
 */
export function resolveFileDisplayMode(
	session: FileDisplayModeSession,
	options?: { raw?: boolean; immutable?: boolean },
): FileDisplayMode {
	const { settings } = session;
	const hasEditTool = session.hasEditTool ?? true;
	const editMode = resolveEditMode(session);
	const usesHashLineAnchors = editMode === "hashline" || editMode === "atom";
	const raw = options?.raw === true;
	const immutable = options?.immutable === true;
	const anchorCapable = !raw && hasEditTool && usesHashLineAnchors && settings.get("readHashLines") !== false;
	const hashLines = anchorCapable && !immutable;
	return {
		hashLines,
		lineNumbers: !raw && (anchorCapable || settings.get("readLineNumbers") === true),
	};
}
