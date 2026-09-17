import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Skill } from "../extensibility/skills";
import { type LocalProtocolOptions, resolveLocalUrlToPath } from "../internal-urls";
import { validateRelativePath } from "../internal-urls/skill-protocol";
import type { InternalResource } from "../internal-urls/types";
import { normalizeLocalScheme } from "./path-utils";
import { ToolError } from "./tool-errors";

/** Regex to find skill:// tokens in command text. */
const INTERNAL_URL_PATTERN_INCLUDING_NORMALIZED_LOCAL =
	/'(?:skill|agent|artifact|plan|memory|rule|local):\/\/[^'\s")`\\]+'|"(?:skill|agent|artifact|plan|memory|rule|local):\/\/[^"\s')`\\]+"|(?:skill|agent|artifact|plan|memory|rule|local):\/\/[^\s'")`\\]+|'local:\/[^'\s")`\\]+'|"local:\/[^"\s')`\\]+"|(?<![./\\\\\w-])local:\/[^\s'")`\\]+/g;

const SUPPORTED_INTERNAL_SCHEMES = ["skill", "agent", "artifact", "plan", "memory", "rule", "local"] as const;

type SupportedInternalScheme = (typeof SUPPORTED_INTERNAL_SCHEMES)[number];

interface InternalUrlResolver {
	canHandle(input: string): boolean;
	resolve(input: string): Promise<InternalResource>;
}

export interface InternalUrlExpansionOptions {
	skills: readonly Skill[];
	noEscape?: boolean;
	/**
	 * Resolve a bare `skill://<name>` to the skill directory instead of its
	 * SKILL.md. Used for `cwd`, where the file path is never a directory and the
	 * call could only fail.
	 */
	skillUrlForDirectory?: boolean;
	internalRouter?: InternalUrlResolver;
	localOptions?: LocalProtocolOptions;
	ensureLocalParentDirs?: boolean;
}

/**
 * Add the offending token to a skill:// resolution failure.
 *
 * The bash tool rewrites every internal URI in a command string before the shell runs
 * it — including URIs inside quotes, and text that only looks like a URI. Without the
 * token the caller cannot tell which part of a long command failed (2026-09-15: a commit
 * message carrying a literal skill:// path failed with a bare traversal error and no
 * pointer to the offending text).
 */
function withToken(message: string, url: string): string {
	return `${message}\n  token: ${url}\n  note: bash commands auto-resolve internal URIs; prefix the URL with \\ to keep it literal`;
}

/**
 * Resolve a single skill:// URL to its absolute filesystem path.
 * Does NOT read file content or verify existence.
 */
export function resolveSkillUrlToPath(
	url: string,
	skills: readonly Skill[],
	options?: { forDirectory?: boolean },
): string {
	const parsed = /^skill:\/\/([^/?#]+)(\/[^?#]*)?(?:[?#].*)?$/.exec(url);
	if (!parsed) {
		throw new ToolError(`Invalid skill:// URL: ${url}`);
	}

	let rawSkillSegment = parsed[1];
	if (!rawSkillSegment) {
		throw new ToolError(`skill:// URL requires a skill name: ${url}`);
	}
	// Decode percent-encoded colons (%3A) used for namespaced skill names
	try {
		rawSkillSegment = decodeURIComponent(rawSkillSegment);
	} catch {
		// Leave as-is if decoding fails
	}

	// Resolve skill name by longest-prefix match against registered skills.
	// This handles namespaced skills ("plugin:skill") where the URI may also
	// carry a colon-delimited suffix (e.g., ":1-5" line range).
	const { skill, suffix } = matchSkillName(rawSkillSegment, skills);
	if (!skill) {
		const available = skills.map(s => s.name);
		const availableStr = available.length > 0 ? available.join(", ") : "none";
		throw new ToolError(withToken(`Unknown skill: ${rawSkillSegment}. Available: ${availableStr}`, url));
	}

	// Combine any colon suffix (line range like ":1-5") with the path segment
	const rawPath = (parsed[2] ?? "") + (suffix ? `/${suffix}` : "");
	const hasRelativePath = rawPath !== "" && rawPath !== "/";

	if (!hasRelativePath) {
		return path.resolve(options?.forDirectory === true ? skill.baseDir : skill.filePath);
	}

	let relativePath: string;
	try {
		relativePath = decodeURIComponent(rawPath.slice(1));
	} catch {
		throw new ToolError(`Invalid skill:// URL path encoding: ${url}`);
	}
	try {
		validateRelativePath(relativePath);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new ToolError(withToken(message, url));
	}

	const targetPath = path.join(skill.baseDir, relativePath);
	const resolvedPath = path.resolve(targetPath);
	const resolvedBaseDir = path.resolve(skill.baseDir);
	if (!resolvedPath.startsWith(resolvedBaseDir + path.sep) && resolvedPath !== resolvedBaseDir) {
		throw new ToolError(withToken("Path traversal is not allowed in skill:// URLs", url));
	}

	return resolvedPath;
}

/**
 * Match a raw skill segment against registered skills using longest-prefix match.
 * Handles colons in both skill names (namespacing) and suffixes (line ranges).
 *
 * For "superpowers:brainstorming:1-5" with skill "superpowers:brainstorming":
 *   -> skill = superpowers:brainstorming, suffix = "1-5"
 * For "brainstorming" with skill "brainstorming":
 *   -> skill = brainstorming, suffix = undefined
 */
function matchSkillName(
	rawSegment: string,
	skills: readonly Skill[],
): { skill: Skill | undefined; suffix: string | undefined } {
	// Exact match first (most common case)
	const exact = skills.find(s => s.name === rawSegment);
	if (exact) return { skill: exact, suffix: undefined };

	// Try stripping colon-delimited suffixes from the right
	let candidate = rawSegment;
	while (true) {
		const lastColon = candidate.lastIndexOf(":");
		if (lastColon <= 0) break;
		candidate = candidate.slice(0, lastColon);
		const match = skills.find(s => s.name === candidate);
		if (match) {
			const suffix = rawSegment.slice(lastColon + 1);
			return { skill: match, suffix };
		}
	}

	return { skill: undefined, suffix: undefined };
}

function extractScheme(url: string): SupportedInternalScheme | undefined {
	const match = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url);
	if (!match) return undefined;
	const scheme = match[1].toLowerCase();
	if (!SUPPORTED_INTERNAL_SCHEMES.includes(scheme as SupportedInternalScheme)) return undefined;
	return scheme as SupportedInternalScheme;
}

function unquoteToken(token: string): string {
	if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
		return token.slice(1, -1);
	}
	return token;
}

/** Shell-escape a path using single quotes. */
function shellEscape(p: string): string {
	return `'${p.replace(/'/g, "'\\''")}'`;
}

async function resolveInternalUrlToPath(
	rawUrl: string,
	skills: readonly Skill[],
	internalRouter?: InternalUrlResolver,
	localOptions?: LocalProtocolOptions,
	ensureLocalParentDirs?: boolean,
	forDirectory?: boolean,
): Promise<string> {
	const url = normalizeLocalScheme(rawUrl);
	const scheme = extractScheme(url);
	if (!scheme) {
		throw new ToolError(`Unsupported internal URL in bash command: ${url}`);
	}

	if (scheme === "skill") {
		return resolveSkillUrlToPath(url, skills, { forDirectory });
	}

	if (scheme === "local") {
		if (!localOptions) {
			throw new ToolError(
				"Cannot resolve local:// URL in bash command: local protocol options are unavailable for this session.",
			);
		}
		const resolvedLocalPath = resolveLocalUrlToPath(url, localOptions);
		if (ensureLocalParentDirs) {
			await fs.mkdir(path.dirname(resolvedLocalPath), { recursive: true });
		}
		return resolvedLocalPath;
	}

	if (!internalRouter?.canHandle(url)) {
		throw new ToolError(
			`Cannot resolve ${scheme}:// URL in bash command: ${url}\n` +
				"Internal URL router is unavailable for this protocol in the current session.",
		);
	}

	let resource: InternalResource;
	try {
		resource = await internalRouter.resolve(url);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new ToolError(`Failed to resolve ${scheme}:// URL in bash command: ${url}\n${message}`);
	}

	if (!resource.sourcePath) {
		throw new ToolError(`${scheme}:// URL resolved without a filesystem path and cannot be used in bash: ${url}`);
	}

	return path.resolve(resource.sourcePath);
}

/**
 * A span of the command text that must not be rewritten.
 */
interface ProtectedRange {
	start: number;
	end: number;
}

/** One heredoc redirection: its delimiter and whether the delimiter was quoted. */
interface HeredocOpener {
	delimiter: string;
	stripTabs: boolean;
	quoted: boolean;
}

/**
 * Every heredoc redirection on the [from, lineEnd) line, in shell body order.
 * All of them have to be collected before consuming bodies: bodies follow their
 * openers in order, so skipping one would misplace the rest.
 */
function collectHeredocOpeners(command: string, from: number, lineEnd: number): HeredocOpener[] {
	const openers: HeredocOpener[] = [];
	let i = from;

	while (i < lineEnd) {
		const char = command[i];
		if (char === "\\") {
			i += 2;
			continue;
		}
		if (char === "'" || char === '"') {
			const close = command.indexOf(char, i + 1);
			i = close === -1 || close >= lineEnd ? lineEnd : close + 1;
			continue;
		}
		// `<<` opens a heredoc; `<<<` is a here-string and takes no body.
		if (char !== "<" || command[i + 1] !== "<" || command[i + 2] === "<") {
			i++;
			continue;
		}

		let j = i + 2;
		const stripTabs = command[j] === "-";
		if (stripTabs) j++;
		while (command[j] === " " || command[j] === "\t") j++;
		const quote = command[j];
		if (quote === "'" || quote === '"') {
			const close = command.indexOf(quote, j + 1);
			if (close !== -1 && close < lineEnd) {
				openers.push({ delimiter: command.slice(j + 1, close), stripTabs, quoted: true });
				i = close + 1;
				continue;
			}
			i = j;
			continue;
		}

		let k = j;
		while (k < lineEnd && !/[\s;&|<>()]/.test(command[k])) k++;
		if (k > j) openers.push({ delimiter: command.slice(j, k), stripTabs, quoted: false });
		i = k > j ? k : j + 1;
	}

	return openers;
}

/**
 * Index where a heredoc body ends — the start of the line holding the closing
 * delimiter (which carries nothing but the delimiter). An unterminated body runs to
 * the end of the command, which is where the shell would have looked for it.
 */
function findHeredocBodyEnd(command: string, bodyStart: number, delimiter: string, stripTabs: boolean): number {
	let lineStart = bodyStart;
	while (lineStart <= command.length) {
		const lineEnd = command.indexOf("\n", lineStart);
		const rawLine = lineEnd === -1 ? command.slice(lineStart) : command.slice(lineStart, lineEnd);
		const line = stripTabs ? rawLine.replace(/^\t+/, "") : rawLine;
		if (line === delimiter) return lineStart;
		if (lineEnd === -1) return command.length;
		lineStart = lineEnd + 1;
	}

	return command.length;
}

/**
 * Bodies of quoted heredocs (`<<'EOF'`, `<<"EOF"`, `<<-'EOF'`).
 *
 * Quoting the delimiter is how a shell is told "no expansion in this body": the
 * text is data the command writes, not command text, so a URI in it is a string to
 * emit rather than a path to resolve. Rewriting it there silently changes what the
 * caller's file or script receives.
 *
 * Unquoted heredocs are left alone: the shell expands inside those, so expanding a
 * URI there matches what the caller asked for.
 */
function findQuotedHeredocBodies(command: string): ProtectedRange[] {
	const ranges: ProtectedRange[] = [];
	let i = 0;
	let inSingle = false;
	let inDouble = false;

	while (i < command.length) {
		const char = command[i];

		if (inSingle) {
			if (char === "'") inSingle = false;
			i++;
			continue;
		}
		if (char === "\\") {
			i += 2;
			continue;
		}
		if (inDouble) {
			if (char === '"') inDouble = false;
			i++;
			continue;
		}
		if (char === "'") {
			inSingle = true;
			i++;
			continue;
		}
		if (char === '"') {
			inDouble = true;
			i++;
			continue;
		}
		// An unquoted `#` at the start of a word comments out the rest of the line.
		if (char === "#" && (i === 0 || /[\s;&|(]/.test(command[i - 1]))) {
			const newline = command.indexOf("\n", i);
			if (newline === -1) break;
			i = newline + 1;
			continue;
		}

		// `<<` opens a heredoc; `<<<` is a here-string and takes no body.
		if (char === "<" && command[i + 1] === "<" && command[i + 2] !== "<") {
			const openerLineEnd = command.indexOf("\n", i);
			const lineEnd = openerLineEnd === -1 ? command.length : openerLineEnd;
			const openers = collectHeredocOpeners(command, i, lineEnd);
			if (openers.length > 0) {
				let bodyStart = lineEnd === command.length ? command.length : lineEnd + 1;
				for (const opener of openers) {
					const bodyEnd = findHeredocBodyEnd(command, bodyStart, opener.delimiter, opener.stripTabs);
					if (opener.quoted) ranges.push({ start: bodyStart, end: bodyEnd });
					const closingLineEnd = command.indexOf("\n", bodyEnd);
					bodyStart = closingLineEnd === -1 ? command.length : closingLineEnd + 1;
				}
				i = bodyStart;
				continue;
			}
			i += 2;
			continue;
		}

		i++;
	}

	return ranges;
}

/** Count the backslashes directly before `index` (text is unchanged above it). */
function countPrecedingBackslashes(text: string, index: number): number {
	let count = 0;
	while (index - count - 1 >= 0 && text[index - count - 1] === "\\") count++;
	return count;
}

/**
 * Expand supported internal URLs in a bash command string to shell-escaped absolute paths.
 * Supported schemes: skill://, agent://, artifact://, memory://, rule://, local://
 *
 * A backslash directly in front of a URL escapes it: the text is kept as written.
 * Without that, a URI that exists resolves to a path and one that does not aborts
 * the command — neither is "emit this string".
 */
export async function expandInternalUrls(command: string, options: InternalUrlExpansionOptions): Promise<string> {
	if (!command.includes("://") && !command.includes("local:/")) return command;

	const matches = Array.from(command.matchAll(INTERNAL_URL_PATTERN_INCLUDING_NORMALIZED_LOCAL));
	if (matches.length === 0) return command;

	const protectedRanges = findQuotedHeredocBodies(command);
	const isProtected = (index: number) => protectedRanges.some(range => index >= range.start && index < range.end);

	let expanded = command;
	for (let i = matches.length - 1; i >= 0; i--) {
		const match = matches[i];
		const token = match[0];
		const index = match.index;
		if (index === undefined) continue;
		if (isProtected(index)) continue;

		// Escaped: drop the backslash, keep the URL as the caller wrote it.
		if (countPrecedingBackslashes(command, index) % 2 === 1) {
			expanded = `${expanded.slice(0, index - 1)}${expanded.slice(index)}`;
			continue;
		}

		const rawUrl = unquoteToken(token);
		const url = normalizeLocalScheme(rawUrl);
		const resolvedPath = await resolveInternalUrlToPath(
			url,
			options.skills,
			options.internalRouter,
			options.localOptions,
			options.ensureLocalParentDirs,
			options.skillUrlForDirectory,
		);
		const replacement = options.noEscape ? resolvedPath : shellEscape(resolvedPath);
		expanded = `${expanded.slice(0, index)}${replacement}${expanded.slice(index + token.length)}`;
	}

	return expanded;
}
