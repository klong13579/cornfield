import type { LineRange } from "./path-utils";
import { parseLineRanges, parseTailCount } from "./path-utils";
import { ToolError } from "./tool-errors";

/**
 * Parsed representation of the `sel` parameter.
 *
 * `none` and `raw` name the whole resource; `lines` and `tail` select part of
 * it. A selector that is not recognized is an error, never `{kind:"none"}`:
 * reading the whole resource after the caller asked for a slice silently
 * widens the request (measured: 104 such calls in 560 local sessions).
 */
export type ParsedSelector =
	| { kind: "none" }
	| { kind: "raw" }
	/** The unresolved-merge-conflict index of the file — see `conflict-detect.ts`. */
	| { kind: "conflicts" }
	| { kind: "lines"; ranges: [LineRange, ...LineRange[]] }
	/** `-N` — the last N lines. Needs the source's line count before it can be sliced. */
	| { kind: "tail"; count: number };

/**
 * A selector whose bounds are absolute — every kind except `tail`. Slicing
 * helpers take this type so a tail selector cannot silently read from the head;
 * callers convert with {@link resolveTailSelector} once the line count is known.
 */
export type ResolvedSelector = Exclude<ParsedSelector, { kind: "tail" }>;

/**
 * Returns true when the selector names more than one disjoint line window,
 * narrowing to the range list so callers can address each window.
 */
export function isMultiRange(
	parsed: ResolvedSelector,
): parsed is { kind: "lines"; ranges: [LineRange, LineRange, ...LineRange[]] } {
	return parsed.kind === "lines" && parsed.ranges.length > 1;
}

/**
 * Pin a `-N` tail selector to absolute lines against a source of `totalLines`
 * lines; every other selector passes through unchanged. The last N lines become
 * one inclusive range clamped to the source (`totalLines - N + 1` .. `totalLines`),
 * so N >= totalLines reads the whole source from the top and N = 1 reads only the
 * last line — no separate tail-slicing path, and no way to resolve to a start
 * line before the first.
 */
export function resolveTailSelector(parsed: ParsedSelector, totalLines: number): ResolvedSelector {
	if (parsed.kind !== "tail") return parsed;
	const startLine = Math.max(1, totalLines - parsed.count + 1);
	return { kind: "lines", ranges: [{ startLine, endLine: Math.max(startLine, totalLines) }] };
}

/**
 * Parse `sel`. A selector that is not recognized is an error, never `none`:
 * reading the whole resource after the caller asked for a slice silently widens
 * the request. Bare `N` is open-ended from N, which is what read.md documents;
 * `-N` is the last N lines. Compound selectors (`raw:50-100`) and the `img`
 * mode are not accepted here.
 */
export function parseSel(sel: string | undefined): ParsedSelector {
	if (!sel || sel.length === 0) return { kind: "none" };
	if (sel === "raw") return { kind: "raw" };
	if (sel === "conflicts") return { kind: "conflicts" };
	const ranges = parseLineRanges(sel);
	if (ranges) return { kind: "lines", ranges };
	const count = parseTailCount(sel);
	if (count !== null) return { kind: "tail", count };
	throw new ToolError(
		`Unsupported selector "${sel}". Use N, N-M, N+K (K lines from N), N- (from N onward), -N (last N lines), a comma-separated list of ranges, raw, or conflicts.`,
	);
}

/** Convert a line-range selector to the offset/limit pair used by internal pagination. */
export function selToOffsetLimit(parsed: ResolvedSelector): { offset?: number; limit?: number } {
	if (parsed.kind !== "lines") return {};
	const range = parsed.ranges[0];
	const limit = range.endLine !== undefined ? range.endLine - range.startLine + 1 : undefined;
	return { offset: range.startLine, limit };
}

/**
 * Render a range the way a caller would have to write it, for notices that tell
 * the reader which lines were skipped or left unread.
 */
export function formatRangeLabel(range: LineRange): string {
	return range.endLine === undefined ? `${range.startLine}-` : `${range.startLine}-${range.endLine}`;
}
