/**
 * Structured read summarization (`read.summarize.*`).
 *
 * When a plain-text file exceeds the configured thresholds, `read` returns a
 * summary that keeps the file's head and tail and omits the middle body —
 * instead of returning a truncated head. The model still sees the structure
 * (imports, top-level declarations, leading/trailing comments) and can expand
 * any omitted region with `sel`.
 *
 * The module is a pure function over text + settings so it is unit-testable
 * without a tool session. `read.ts` is responsible for reading the settings
 * through `session.settings` and calling this with safe, validated numbers.
 */

export interface ReadSummarySettings {
	enabled: boolean;
	minTotalLines: number;
	minBodyLines: number;
	minCommentLines: number;
	/** `true` = treat every non-blank line as body (no comment detection); `false` = classify code comments and require minCommentLines. */
	prose: boolean;
	/** Lines kept in the head and tail windows. */
	unfoldLimit: number;
	/** Lines-per-read used for the suggested `sel` unfold hint. */
	unfoldUntil: number;
}

export interface ReadSummary {
	text: string;
	totalLines: number;
	bodyLines: number;
	commentLines: number;
	omittedLines: number;
}

/** Leading tokens that mark a line as a comment in code mode (`prose=false`). */
const COMMENT_PREFIXES: readonly string[] = ["//", "#", "/*", "*", "--", "<!--"];

type LineKind = "blank" | "comment" | "body";

function classifyLine(line: string): LineKind {
	const trimmed = line.trim();
	if (trimmed === "") return "blank";
	for (const prefix of COMMENT_PREFIXES) {
		if (trimmed.startsWith(prefix)) return "comment";
	}
	return "body";
}

function toPositiveInt(value: number): number {
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * Summarize the given file content, or return `null` when the content should be
 * returned verbatim (feature off, file below thresholds, or nothing to elide).
 */
export function summarizeFileContent(content: string, settings: ReadSummarySettings): ReadSummary | null {
	if (!settings.enabled) return null;

	// Split into lines; a trailing newline must not produce a phantom empty line.
	const parts = content.split("\n");
	if (parts.length > 1 && parts[parts.length - 1] === "") {
		parts.pop();
	}
	const lines = parts;
	const totalLines = lines.length;
	if (totalLines < settings.minTotalLines) return null;

	const headCount = toPositiveInt(settings.unfoldLimit);
	if (headCount === 0 || totalLines <= headCount * 2) return null;

	let bodyLines = 0;
	let commentLines = 0;
	for (const line of lines) {
		if (settings.prose) {
			if (line.trim() !== "") bodyLines++;
		} else {
			const kind = classifyLine(line);
			if (kind === "body") bodyLines++;
			else if (kind === "comment") commentLines++;
		}
	}

	if (bodyLines < settings.minBodyLines) return null;
	if (!settings.prose && commentLines < settings.minCommentLines) return null;

	const head = lines.slice(0, headCount);
	const tail = lines.slice(lines.length - headCount);
	const omitted = totalLines - head.length - tail.length;
	const firstOmitted = headCount + 1;
	const lastOmitted = totalLines - headCount;

	const unfoldChunk = toPositiveInt(settings.unfoldUntil) || 1;
	const unfoldHintEnd = Math.min(firstOmitted + unfoldChunk - 1, lastOmitted);

	const stats = settings.prose
		? `${totalLines} lines total, ${bodyLines} body`
		: `${totalLines} lines total, ${bodyLines} body, ${commentLines} comments`;

	const text = [
		`[read.summarize] ${stats} — showing first ${head.length} and last ${tail.length} lines.`,
		"",
		...head,
		"",
		`[Omitted ${omitted} lines (${firstOmitted}-${lastOmitted}). Read them with sel="${firstOmitted}-${unfoldHintEnd}" (or any other sel range).]`,
		"",
		...tail,
	].join("\n");

	return { text, totalLines, bodyLines, commentLines, omittedLines: omitted };
}
