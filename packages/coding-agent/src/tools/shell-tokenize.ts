/**
 * Conservative shell command segmentation, shared by the bash interceptor's
 * per-segment rule matching.
 *
 * Splits a bash command into the independent command segments a shell would run,
 * each with the original text (quoting and escaping preserved) and the facts the
 * interceptor needs to decide whether a dedicated tool can replace it: where the
 * segment's stdin comes from and whether it writes a file.
 *
 * Ported from upstream `oh-my-pi` `src/tools/shell-tokenize.ts`
 * (`extractFlatShellCommandSegments`, `extractLeadingCdTarget`), with heredocs
 * scanned instead of declined. Upstream declines the whole command at `<<`, which
 * leaves the raw input as the only matchable text — heredoc bodies included, and a
 * segment fed by a heredoc indistinguishable from one reading a path. Here the
 * scanner locates the body boundary so bodies are never command text and a
 * heredoc-fed segment can be excluded from interception.
 *
 * It is deliberately not a full POSIX parser. Command substitution, arithmetic
 * expansion, grouping, malformed quoting, and a heredoc whose boundary cannot be
 * located all make it declare the command unsplittable (`[]`) so callers fall back
 * to checking the complete input. `<<` used as an arithmetic shift (`let x=1<<2`)
 * reads as a heredoc opener, which can hide the text after it — the same
 * conservative direction as everything else here: the scanner never invents a
 * segment the shell would not run.
 */

/** A heredoc redirection: the delimiter that closes its body, and `<<-` tab-stripping. */
interface HeredocOpener {
	delimiter: string;
	stripTabs: boolean;
}

/**
 * Reads the delimiter word of an unquoted `<<` at `start` (the index right after
 * the operator): `<<-`, inter-token whitespace, and quoted or escaped delimiters
 * are handled the way the shell reads them.
 *
 * Returns `null` when the delimiter cannot be resolved without running the shell —
 * an empty word, unterminated quoting, or an expansion (`<<$X`) — leaving the
 * command unsplittable rather than guessing where the body ends.
 */
function readHeredocOpener(command: string, start: number): { opener: HeredocOpener; next: number } | null {
	let i = start;
	let stripTabs = false;
	if (command[i] === "-") {
		stripTabs = true;
		i++;
	}
	while (command[i] === " " || command[i] === "\t") i++;

	let delimiter = "";
	let quote: "'" | '"' | undefined;
	for (; i < command.length; i++) {
		const ch = command[i];
		if (quote === "'") {
			if (ch === "'") quote = undefined;
			else delimiter += ch;
			continue;
		}
		if (quote === '"') {
			if (ch === '"') {
				quote = undefined;
				continue;
			}
			if (ch === "\\") {
				const next = command[i + 1];
				if (next === undefined || next === "\n") return null;
				if (next === '"' || next === "\\" || next === "$" || next === "`") {
					delimiter += next;
					i++;
					continue;
				}
				delimiter += ch;
				continue;
			}
			// `$` and backticks expand inside a double-quoted delimiter.
			if (ch === "$" || ch === "`") return null;
			delimiter += ch;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (ch === "\\") {
			const next = command[i + 1];
			if (next === undefined || next === "\n") return null;
			delimiter += next;
			i++;
			continue;
		}
		// An unquoted expansion makes the delimiter — and therefore the body
		// boundary — unknowable before the shell runs.
		if (ch === "$" || ch === "`") return null;
		if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") break;
		if (ch === ";" || ch === "&" || ch === "|" || ch === "<" || ch === ">" || ch === "(" || ch === ")") break;
		delimiter += ch;
	}
	if (quote !== undefined || delimiter.length === 0) return null;
	return { opener: { delimiter, stripTabs }, next: i };
}

/**
 * Index just past the line that closes `opener`'s body, or the end of the command
 * when no such line exists — which is where the shell would have looked for it.
 */
function skipHeredocBody(command: string, from: number, opener: HeredocOpener): number {
	let lineStart = from;
	while (lineStart <= command.length) {
		const newline = command.indexOf("\n", lineStart);
		const lineEnd = newline === -1 ? command.length : newline;
		const rawLine = command.slice(lineStart, lineEnd);
		// CRLF input reaches the scanner as-is; the delimiter line carries no `\r`.
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		if ((opener.stripTabs ? line.replace(/^\t+/u, "") : line) === opener.delimiter) {
			return newline === -1 ? command.length : newline + 1;
		}
		if (newline === -1) return command.length;
		lineStart = newline + 1;
	}
	return command.length;
}

/**
 * A flat shell command segment with the context needed to decide interception.
 *
 * @see extractFlatShellCommandSegments
 */
export interface FlatShellCommandSegment {
	/** Original segment text with quoting and escaping preserved. */
	text: string;
	/**
	 * True when this segment consumes the previous stage's stdout via an
	 * unquoted `|` or `|&`. Blank and comment-only continuation lines preserve
	 * the pending pipe state. Such a stage reads piped stdin, so path-based
	 * dedicated tools (read/grep/glob) cannot replace it. `||`, `;`, `&`, and
	 * `&&` start an independent command and leave this false.
	 */
	pipedStdin: boolean;
	/**
	 * True when this segment's stdin is data the command itself supplies — a
	 * heredoc body (`cat <<'EOF'`) or a `<<<` here-string — rather than a path a
	 * dedicated tool could take.
	 */
	heredocStdin: boolean;
	/**
	 * True when this segment redirects output to a file: an unquoted `>`/`>>`
	 * that is not the `>&` descriptor duplication. Such a segment produces a
	 * file, which the `write` tool can replace.
	 */
	redirectsOutput: boolean;
}

/**
 * Returns the flat shell command segments with the original text of each. Unlike
 * a tokenizer that returns argv, this preserves quoting and escaping so the
 * results are safe to match against user-configured regular expressions, and it
 * reports where each segment's stdin comes from.
 *
 * Heredoc bodies are skipped rather than returned: a body is data the command
 * feeds itself, not command text, so its lines are never segments.
 *
 * Returns `[]` when the command cannot be split without executing it (command
 * substitution, grouping, malformed quoting, an unresolvable heredoc delimiter,
 * or a heredoc opened on a line that continues into the next). Callers must then
 * check the complete input instead.
 */
export function extractFlatShellCommandSegments(command: string): FlatShellCommandSegment[] {
	const segments: FlatShellCommandSegment[] = [];
	let segmentStart = 0;
	let inSingle = false;
	let inDouble = false;
	let atWordStart = true;
	let currentPiped = false;
	let currentHeredoc = false;
	let currentRedirects = false;
	/** Heredocs opened on the current line; their bodies follow its newline, in this order. */
	const pendingHeredocs: HeredocOpener[] = [];
	/** The last `\n`/`;`/`&`/`|` operator seen. A continuation operator that is still trailing means the line does not end at the next newline. */
	let lastOperator = "";

	const pushSegment = (end: number): boolean => {
		const text = command.slice(segmentStart, end).trim();
		if (text.length === 0) return false;
		segments.push({
			text,
			pipedStdin: currentPiped,
			heredocStdin: currentHeredoc,
			redirectsOutput: currentRedirects,
		});
		return true;
	};
	const beginSegment = (start: number, piped: boolean): void => {
		segmentStart = start;
		currentPiped = piped;
		currentHeredoc = false;
		currentRedirects = false;
	};
	/**
	 * Index where scanning resumes after the line that opened the pending heredocs:
	 * past their bodies, or `null` when a trailing `|`, `|&`, `&&`, or `||` continues
	 * the line — the shell reads the bodies after the *complete* line, which is
	 * further down than this scanner tracks.
	 */
	const resumeAfterOpenerLine = (lineEnd: number, textEnd: number): number | null => {
		if (isLineContinuation(lastOperator) && command.slice(segmentStart, textEnd).trim().length === 0) return null;
		return consumeHeredocBodies(command, lineEnd, pendingHeredocs);
	};

	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (inSingle) {
			if (ch === "'") inSingle = false;
			continue;
		}
		if (inDouble) {
			if (ch === "\\") {
				if (i + 1 >= command.length) return [];
				i++;
				continue;
			}
			if (ch === '"') {
				inDouble = false;
				continue;
			}
			if (ch === "`" || (ch === "$" && command[i + 1] === "(")) return [];
			continue;
		}

		if (ch === "'") {
			inSingle = true;
			atWordStart = false;
			continue;
		}
		if (ch === '"') {
			inDouble = true;
			atWordStart = false;
			continue;
		}
		if (ch === "\\") {
			if (i + 1 >= command.length) return [];
			i++;
			atWordStart = false;
			continue;
		}
		if (ch === "<" && command[i + 1] === "<") {
			if (command[i + 2] === "<") {
				// `<<<` is a here-string: stdin comes from a string, never a file,
				// and there is no body to skip.
				currentHeredoc = true;
				i += 2;
				atWordStart = false;
				continue;
			}
			const opener = readHeredocOpener(command, i + 2);
			if (!opener) return [];
			pendingHeredocs.push(opener.opener);
			currentHeredoc = true;
			i = opener.next - 1;
			atWordStart = false;
			continue;
		}
		if (
			ch === "`" ||
			ch === "(" ||
			ch === ")" ||
			(ch === "$" && command[i + 1] === "(") ||
			(ch === "$" && command[i + 1] === "{") ||
			((ch === "{" || ch === "}") &&
				atWordStart &&
				(command[i + 1] === undefined || /[ \t\n;]/u.test(command[i + 1])))
		) {
			return [];
		}
		if (ch === "#" && atWordStart) {
			const pushed = pushSegment(i);
			const newline = command.indexOf("\n", i + 1);
			if (newline === -1) return segments;
			if (pendingHeredocs.length > 0) {
				// A heredoc opened before the comment still owns the bodies that follow
				// this line; skipping them keeps them out of the next segment.
				const afterBodies = resumeAfterOpenerLine(newline + 1, i);
				if (afterBodies === null) return [];
				pendingHeredocs.length = 0;
				beginSegment(afterBodies, false);
				i = afterBodies - 1;
			} else {
				// A comment-only continuation line preserves a pending pipe.
				beginSegment(newline + 1, pushed ? false : currentPiped);
				i = newline;
			}
			atWordStart = true;
			continue;
		}
		if (ch === "\n" && pendingHeredocs.length > 0) {
			// The bodies start on the line after the one that opened them.
			pushSegment(i);
			const afterBodies = resumeAfterOpenerLine(i + 1, i);
			if (afterBodies === null) return [];
			pendingHeredocs.length = 0;
			beginSegment(afterBodies, false);
			i = afterBodies - 1;
			atWordStart = true;
			continue;
		}
		if (ch === ">" && command[i - 1] !== "<" && command[i + 1] !== "&") {
			currentRedirects = true;
		}
		const isRedirectionOperatorCharacter =
			ch === "|"
				? command[i - 1] === ">"
				: ch === "&"
					? command[i - 1] === ">" || command[i - 1] === "<" || command[i + 1] === ">"
					: false;
		if ((ch === "\n" || ch === ";" || ch === "|" || ch === "&") && !isRedirectionOperatorCharacter) {
			const pushed = pushSegment(i);
			const doubled = (ch === "|" || ch === "&") && command[i + 1] === ch;
			const pipeStderr = ch === "|" && command[i + 1] === "&";
			if (doubled || pipeStderr) i++;
			// `|` and `|&` pipe into the next segment. Blank continuation lines
			// preserve that pending state; all other operators reset it.
			const piped = ch === "|" && !doubled;
			beginSegment(i + 1, pushed || ch !== "\n" ? piped : currentPiped);
			lastOperator = pipeStderr ? "|&" : doubled ? ch + ch : ch;
			atWordStart = true;
			continue;
		}
		atWordStart = ch === " " || ch === "\t";
	}

	if (inSingle || inDouble) return [];
	pushSegment(command.length);
	return segments;
}

/** True when a shell operator leaves the command line open for the next line. */
function isLineContinuation(operator: string): boolean {
	return operator === "|" || operator === "|&" || operator === "&&" || operator === "||";
}

/** Bodies of every heredoc opened on the current line, consumed at the next newline, in shell order. */
function consumeHeredocBodies(command: string, from: number, openers: readonly HeredocOpener[]): number {
	let index = from;
	for (const opener of openers) index = skipHeredocBody(command, index, opener);
	return index;
}

/**
 * Shell metacharacters that end an unquoted `cd` target token. A redirect, extra
 * argument, or any operator in this set means the leading construct is more than
 * a bare `cd <path>`, so extraction must bail.
 */
const CD_TARGET_TERMINATORS: Record<string, true> = {
	" ": true,
	"\t": true,
	"\n": true,
	"\r": true,
	"&": true,
	"|": true,
	";": true,
	"<": true,
	">": true,
	"(": true,
	")": true,
};

/**
 * Parses a leading `cd <path> && ...` prefix so the bash tool can route the
 * target through its structured `cwd` parameter when the model omits it.
 *
 * Returns the single path token (quotes and backslash escapes resolved to their
 * literal value) and the command remainder after the top-level `&&`, or `null`
 * when the command does not begin with exactly `cd`, one path token, and a
 * top-level `&&`. The scanner deliberately bails on anything else in the prefix —
 * redirects (`cd /tmp 2>/dev/null && ...`), extra arguments, or paths needing
 * shell expansion (`$`, backticks, `(`) — leaving the whole command for the shell
 * instead of absorbing shell syntax into `cwd`.
 */
export function extractLeadingCdTarget(command: string): { path: string; rest: string } | null {
	const prefix = /^cd[ \t]+/u.exec(command);
	if (!prefix) return null;
	let i = prefix[0].length;
	let path = "";
	let inSingle = false;
	let inDouble = false;
	for (; i < command.length; i++) {
		const ch = command[i];
		if (inSingle) {
			if (ch === "'") {
				inSingle = false;
				continue;
			}
			path += ch;
			continue;
		}
		if (inDouble) {
			if (ch === "\\" && i + 1 < command.length) {
				const next = command[i + 1];
				// A line continuation crosses the first physical line. Leave it to
				// the shell rather than turning the escaped newline into cwd text.
				if (next === "\n" || next === "\r") return null;
				if (next === '"' || next === "\\" || next === "$" || next === "`") {
					path += next;
					i++;
					continue;
				}
			}
			if (ch === '"') {
				inDouble = false;
				continue;
			}
			path += ch;
			continue;
		}
		if (ch === "'") {
			inSingle = true;
			continue;
		}
		if (ch === '"') {
			inDouble = true;
			continue;
		}
		if (ch === "\\" && i + 1 < command.length) {
			// Preserve shell line-continuation semantics by declining extraction.
			if (command[i + 1] === "\n" || command[i + 1] === "\r") return null;
			path += command[i + 1];
			i++;
			continue;
		}
		if (CD_TARGET_TERMINATORS[ch]) break;
		path += ch;
	}
	// Unterminated quote or empty target: leave the command for the shell.
	if (inSingle || inDouble || path.length === 0) return null;
	// A path needing shell expansion can't be resolved literally through cwd.
	if (/[$`(]/u.test(path)) return null;
	// Skip inter-token whitespace, then require a top-level `&&` (a single `&`,
	// `||`, `;`, `|`, or a redirect all mean this is not a bare `cd <path>`).
	while (command[i] === " " || command[i] === "\t") i++;
	if (command[i] !== "&" || command[i + 1] !== "&") return null;
	i += 2;
	while (command[i] === " " || command[i] === "\t") i++;
	return { path, rest: command.slice(i) };
}
