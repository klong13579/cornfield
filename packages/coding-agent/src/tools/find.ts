import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@cornfield/agent";
import * as natives from "@cornfield/natives";
import type { Component } from "@cornfield/tui";
import { Text } from "@cornfield/tui";
import { isEnoent, prompt, untilAborted } from "@cornfield/utils";
import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import findDescription from "../prompts/tools/find.md" with { type: "text" };
import { type TruncationResult, truncateHead } from "../session/streaming-output";
import {
	Ellipsis,
	Hasher,
	type RenderCache,
	renderFileList,
	renderStatusLine,
	renderTreeList,
	truncateToWidth,
} from "../tui";
import type { ToolSession } from ".";
import { applyListLimit } from "./list-limit";
import { formatFullOutputReference, type OutputMeta, persistToolOutputArtifact } from "./output-meta";
import {
	formatPathRelativeToCwd,
	normalizePathLikeInput,
	parseFindPattern,
	resolveMultiFindPattern,
	resolveToCwd,
} from "./path-utils";
import { formatCount, formatEmptyMessage, formatErrorMessage, PREVIEW_LIMITS } from "./render-utils";
import { ToolAbortError, ToolError, throwIfAborted } from "./tool-errors";
import { toolResult } from "./tool-result";

const findSchema = Type.Object({
	pattern: Type.String({
		description: "glob including search path",
		examples: ["src/**/*.ts", "lib/*.json", "apps/,packages/", "*.ts"],
	}),
	hidden: Type.Optional(Type.Boolean({ description: "include hidden files", default: true })),
	limit: Type.Optional(Type.Number({ description: "max results", default: 1000 })),
});

export type FindToolInput = Static<typeof findSchema>;

const DEFAULT_LIMIT = 1000;
const GLOB_TIMEOUT_MS = 5000;

/**
 * Set when the search stopped before covering its whole scope.
 *
 * The distinction is load-bearing for the model: `files` holding N entries and
 * `files` holding the N entries *an unfinished search reached* are different
 * claims, and only one of them supports "there is no such file".
 */
export interface FindIncomplete {
	/** Why the search stopped early. */
	reason: "timeout";
	/** The time budget that was exhausted, in milliseconds. */
	timeoutMs: number;
}

export interface FindToolDetails {
	truncation?: TruncationResult;
	resultLimitReached?: number;
	meta?: OutputMeta;
	// Fields for TUI rendering
	scopePath?: string;
	fileCount?: number;
	files?: string[];
	truncated?: boolean;
	/** Present when the search was cut short; `files` is then a partial result set. */
	incomplete?: FindIncomplete;
	error?: string;
}

/**
 * Pluggable operations for the find tool.
 * Override these to delegate file search to remote systems (e.g., SSH).
 */
export interface FindOperations {
	/** Check if path exists */
	exists: (absolutePath: string) => Promise<boolean> | boolean;
	/** Optional stat for distinguishing files vs directories. */
	stat?: (
		absolutePath: string,
	) => Promise<{ isFile(): boolean; isDirectory(): boolean }> | { isFile(): boolean; isDirectory(): boolean };
	/** Find files matching glob pattern. Returns relative paths. */
	glob: (pattern: string, cwd: string, options: { ignore: string[]; limit: number }) => Promise<string[]> | string[];
}

export interface FindToolOptions {
	/** Custom operations for find. Default: local filesystem + rg */
	operations?: FindOperations;
	/**
	 * Time budget for the native filesystem walk, in milliseconds
	 * (default {@link GLOB_TIMEOUT_MS}). Custom `operations` are not subject to it.
	 * Exhausting the budget returns the matches collected so far, marked incomplete.
	 */
	globTimeoutMs?: number;
}

/** A match streamed by the native walker before the search finished. */
export interface CollectedFindMatch {
	/** Path as displayed to the model, normalized against the session cwd. */
	path: string;
	/** Modification time in ms since epoch; 0 when the walker reported none. */
	mtime: number;
}

/**
 * Normalize the matches streamed before a search was cut short.
 *
 * Rules, in order:
 * 1. **Deduplicate by display path** — first sighting wins. Distinct native
 *    entries can collapse onto one display path (a directory and its
 *    trailing-slash form, a symlink and its target), and a rescan can stream an
 *    entry twice.
 * 2. **Sort by mtime descending, then path ascending.** The complete-result path
 *    takes its order from the native walker; this path collects in scan order,
 *    which is not mtime-ordered, so it must sort. The path tiebreak keeps equal
 *    mtimes — the common case, since mtimes are coarse — from producing an
 *    order that differs run to run.
 *
 * The caller's result limit is applied afterwards, by the shared result builder.
 */
export function resolvePartialMatchPaths(collected: readonly CollectedFindMatch[]): string[] {
	const seen = new Set<string>();
	const unique: CollectedFindMatch[] = [];
	for (const match of collected) {
		if (seen.has(match.path)) continue;
		seen.add(match.path);
		unique.push(match);
	}
	unique.sort((a, b) => b.mtime - a.mtime || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	return unique.map(match => match.path);
}

/** Render a time budget compactly ("5s", "1.5s", "50ms"). */
function formatBudget(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const seconds = ms / 1000;
	return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`;
}

/**
 * One-line marker for a partial result set, shared by the model-facing text and
 * the TUI. It must survive output truncation, so callers append it last.
 */
function formatIncompleteNotice(incomplete: FindIncomplete, collected: number): string {
	const found =
		collected > 0
			? `the ${collected} result${collected === 1 ? "" : "s"} above are only what the search reached before the cut-off`
			: "no results were collected before the cut-off";
	return `[Incomplete: find timed out after ${formatBudget(incomplete.timeoutMs)}; ${found}. The scope was not fully searched, so this is not proof the files do not exist. Narrow the pattern or scope to get a complete list.]`;
}

/** TUI one-liner for a cut-short search; the model-facing notice carries the rest. */
function formatIncompleteLabel(incomplete: FindIncomplete): string {
	return `find timed out after ${formatBudget(incomplete.timeoutMs)} — the scope was not fully searched`;
}

export class FindTool implements AgentTool<typeof findSchema, FindToolDetails> {
	readonly name = "find";
	readonly label = "Find";
	readonly loadMode = "essential" as const;
	readonly summary = "Finds files by glob pattern.";
	readonly description: string;
	readonly parameters = findSchema;
	readonly strict = true;

	readonly #customOps?: FindOperations;
	readonly #globTimeoutMs: number;

	constructor(
		private readonly session: ToolSession,
		options?: FindToolOptions,
	) {
		this.#customOps = options?.operations;
		this.#globTimeoutMs = options?.globTimeoutMs ?? GLOB_TIMEOUT_MS;
		this.description = prompt.render(findDescription);
	}

	async execute(
		_toolCallId: string,
		params: Static<typeof findSchema>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<FindToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<FindToolDetails>> {
		const { pattern, limit, hidden } = params;

		return untilAborted(signal, async () => {
			const formatScopePath = (targetPath: string): string => formatPathRelativeToCwd(targetPath, this.session.cwd);
			const normalizedPattern = normalizePathLikeInput(pattern).replace(/\\/g, "/");
			if (!normalizedPattern) {
				throw new ToolError("Pattern must not be empty");
			}

			const multiPattern = await resolveMultiFindPattern(normalizedPattern, this.session.cwd);
			const parsedPattern = multiPattern ? null : parseFindPattern(normalizedPattern);
			const hasGlob = multiPattern ? true : (parsedPattern?.hasGlob ?? false);
			const globPattern = multiPattern?.globPattern ?? parsedPattern?.globPattern ?? "**/*";
			const searchPath = resolveToCwd(multiPattern?.basePath ?? parsedPattern?.basePath ?? ".", this.session.cwd);
			const scopePath = multiPattern?.scopePath ?? formatScopePath(searchPath);

			if (searchPath === "/") {
				throw new ToolError("Searching from root directory '/' is not allowed");
			}

			const rawLimit = limit ?? DEFAULT_LIMIT;
			const effectiveLimit = Number.isFinite(rawLimit) ? Math.floor(rawLimit) : Number.NaN;
			if (!Number.isFinite(effectiveLimit) || effectiveLimit <= 0) {
				throw new ToolError("Limit must be a positive number");
			}
			const includeHidden = hidden ?? true;
			const timeoutSignal = AbortSignal.timeout(this.#globTimeoutMs);
			const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
			const formatMatchPath = (matchPath: string, fileType?: natives.FileType): string => {
				const hadTrailingSlash = matchPath.endsWith("/") || matchPath.endsWith("\\");
				const absolutePath = path.isAbsolute(matchPath) ? matchPath : path.resolve(searchPath, matchPath);
				return formatPathRelativeToCwd(absolutePath, this.session.cwd, {
					trailingSlash: fileType === natives.FileType.Dir || hadTrailingSlash,
				});
			};

			const buildResult = async (
				files: string[],
				incomplete?: FindIncomplete,
			): Promise<AgentToolResult<FindToolDetails>> => {
				if (files.length === 0) {
					const details: FindToolDetails = { scopePath, fileCount: 0, files: [], truncated: false, incomplete };
					// A search cut short having collected nothing is not the same claim as
					// "no files found" — the scope was never fully searched, so say so.
					const text = incomplete ? formatIncompleteNotice(incomplete, 0) : "No files found matching pattern";
					return toolResult(details).text(text).done();
				}

				const listLimit = applyListLimit(files, { limit: effectiveLimit });
				const limited = listLimit.items;
				const limitMeta = listLimit.meta;
				const rawOutput = limited.join("\n");
				const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
				const sidecarId = truncation.truncated
					? await persistToolOutputArtifact(this.session, "find", rawOutput)
					: undefined;
				if (sidecarId) truncation.artifactId = sidecarId;
				// The incomplete marker is appended after truncation so it survives the
				// head-cut; a partial list the model mistakes for a complete one is the
				// exact failure this path exists to prevent.
				const output =
					truncation.content +
					(sidecarId ? `\n\n${formatFullOutputReference(sidecarId)}` : "") +
					(incomplete ? `\n\n${formatIncompleteNotice(incomplete, limited.length)}` : "");

				const details: FindToolDetails = {
					scopePath,
					fileCount: limited.length,
					files: limited,
					truncated: Boolean(limitMeta.resultLimit || truncation.truncated),
					resultLimitReached: limitMeta.resultLimit?.reached,
					truncation: truncation.truncated ? truncation : undefined,
					incomplete,
				};

				const resultBuilder = toolResult(details)
					.text(output)
					.limits({ resultLimit: limitMeta.resultLimit?.reached });
				if (truncation.truncated) {
					resultBuilder.truncation(truncation, { direction: "head" });
				}

				return resultBuilder.done();
			};

			if (this.#customOps?.glob) {
				if (!(await this.#customOps.exists(searchPath))) {
					throw new ToolError(`Path not found: ${scopePath}`);
				}

				if (!hasGlob && this.#customOps.stat) {
					const stat = await this.#customOps.stat(searchPath);
					if (stat.isFile()) {
						return await buildResult([scopePath]);
					}
				}

				const results = await this.#customOps.glob(globPattern, searchPath, {
					ignore: ["**/node_modules/**", "**/.git/**"],
					limit: effectiveLimit,
				});
				const relativized = results.map(p => formatMatchPath(p));

				return await buildResult(relativized);
			}

			let searchStat: fs.Stats;
			try {
				searchStat = await fs.promises.stat(searchPath);
			} catch (err) {
				if (isEnoent(err)) {
					throw new ToolError(`Path not found: ${scopePath}`);
				}
				throw err;
			}

			if (!hasGlob && searchStat.isFile()) {
				return await buildResult([scopePath]);
			}
			if (!searchStat.isDirectory()) {
				throw new ToolError(`Path is not a directory: ${searchPath}`);
			}

			let matches: natives.GlobMatch[];
			const collected: CollectedFindMatch[] = [];
			const updateIntervalMs = 200;
			let lastUpdate = 0;
			const emitUpdate = () => {
				if (!onUpdate) return;
				const now = Date.now();
				if (now - lastUpdate < updateIntervalMs) return;
				lastUpdate = now;
				const paths = collected.map(match => match.path);
				const details: FindToolDetails = {
					scopePath,
					fileCount: paths.length,
					files: paths,
					truncated: false,
				};
				onUpdate({
					content: [{ type: "text", text: paths.join("\n") }],
					details,
				});
			};
			// Collects unconditionally, not just while a UI is listening: the time budget
			// below can cut the walk short at any moment, and whatever streamed by then is
			// the only result set that survives the cut.
			const onMatch = (err: Error | null, match: natives.GlobMatch | null) => {
				if (err || signal?.aborted || !match?.path) return;
				collected.push({ path: formatMatchPath(match.path, match.fileType), mtime: match.mtime ?? 0 });
				emitUpdate();
			};

			const doGlob = async (useGitignore: boolean) =>
				untilAborted(combinedSignal, () =>
					natives.glob(
						{
							pattern: globPattern,
							path: searchPath,
							fileType: natives.FileType.File,
							hidden: includeHidden,
							maxResults: effectiveLimit,
							sortByMtime: true,
							gitignore: useGitignore,
							signal: combinedSignal,
						},
						onMatch,
					),
				);

			try {
				const result = await doGlob(true);
				// Sort by mtime descending (most recent first) in JS instead of native.
				// This allows native glob to early-terminate at maxResults.
				result.matches.sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
				matches = result.matches;
			} catch (error) {
				if (error instanceof Error && error.name === "AbortError") {
					if (timeoutSignal.aborted && !signal?.aborted) {
						// The budget ran out with the walk unfinished. Return what streamed
						// before the cut, explicitly marked incomplete, rather than discarding
						// the search and reporting a bare failure.
						return await buildResult(resolvePartialMatchPaths(collected), {
							reason: "timeout",
							timeoutMs: this.#globTimeoutMs,
						});
					}
					throw new ToolAbortError();
				}
				throw error;
			}

			const relativized: string[] = [];
			for (const match of matches) {
				throwIfAborted(signal);
				if (!match.path) {
					continue;
				}

				relativized.push(formatMatchPath(match.path, match.fileType));
			}

			return await buildResult(relativized);
		});
	}
}

// =============================================================================
// TUI Renderer
// =============================================================================

interface FindRenderArgs {
	pattern: string;
	limit?: number;
}

const COLLAPSED_LIST_LIMIT = PREVIEW_LIMITS.COLLAPSED_ITEMS;

export const findToolRenderer = {
	inline: true,
	renderCall(args: FindRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const meta: string[] = [];
		if (args.limit !== undefined) meta.push(`limit:${args.limit}`);

		const text = renderStatusLine(
			{ icon: "pending", title: "Find", description: args.pattern || "*", meta },
			uiTheme,
		);
		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: FindToolDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: FindRenderArgs,
	): Component {
		const details = result.details;

		if (result.isError || details?.error) {
			const errorText = details?.error || result.content?.find(c => c.type === "text")?.text || "Unknown error";
			return new Text(formatErrorMessage(errorText, uiTheme), 0, 0);
		}

		const hasDetailedData = details?.fileCount !== undefined;
		const textContent = result.content?.find(c => c.type === "text")?.text;

		if (!hasDetailedData) {
			if (
				!textContent ||
				textContent.includes("No files matching") ||
				textContent.includes("No files found") ||
				textContent.trim() === ""
			) {
				return new Text(formatEmptyMessage("No files found", uiTheme), 0, 0);
			}

			const lines = textContent.split("\n").filter(l => l.trim());
			const header = renderStatusLine(
				{
					icon: "success",
					title: "Find",
					description: args?.pattern,
					meta: [formatCount("file", lines.length)],
				},
				uiTheme,
			);
			let cached: RenderCache | undefined;
			return {
				render(width: number): string[] {
					const { expanded } = options;
					const key = new Hasher().bool(expanded).u32(width).digest();
					if (cached?.key === key) return cached.lines;
					const listLines = renderTreeList(
						{
							items: lines,
							expanded,
							maxCollapsed: COLLAPSED_LIST_LIMIT,
							itemType: "file",
							renderItem: line => uiTheme.fg("accent", line),
						},
						uiTheme,
					);
					const result = [header, ...listLines].map(l => truncateToWidth(l, width, Ellipsis.Omit));
					cached = { key, lines: result };
					return result;
				},
				invalidate() {
					cached = undefined;
				},
			};
		}

		const fileCount = details?.fileCount ?? 0;
		const truncation = details?.truncation ?? details?.meta?.truncation;
		const limits = details?.meta?.limits;
		const incomplete = details?.incomplete;
		const truncated = Boolean(details?.truncated || truncation || details?.resultLimitReached || limits?.resultLimit);
		const files = details?.files ?? [];

		if (fileCount === 0) {
			// An incomplete empty search is not "No files found": the scope was never
			// fully walked, so the empty-message rendering would state something the
			// result does not know.
			const emptyMeta = incomplete ? ["0 files", uiTheme.fg("warning", "incomplete")] : ["0 files"];
			const header = renderStatusLine(
				{ icon: "warning", title: "Find", description: args?.pattern, meta: emptyMeta },
				uiTheme,
			);
			const body = incomplete
				? uiTheme.fg("warning", formatIncompleteLabel(incomplete))
				: formatEmptyMessage("No files found", uiTheme);
			return new Text([header, body].join("\n"), 0, 0);
		}
		const meta: string[] = [formatCount("file", fileCount)];
		if (details?.scopePath) meta.push(`in ${details.scopePath}`);
		if (truncated) meta.push(uiTheme.fg("warning", "truncated"));
		if (incomplete) meta.push(uiTheme.fg("warning", "incomplete"));
		const header = renderStatusLine(
			{ icon: truncated || incomplete ? "warning" : "success", title: "Find", description: args?.pattern, meta },
			uiTheme,
		);

		const truncationReasons: string[] = [];
		if (details?.resultLimitReached) truncationReasons.push(`limit ${details.resultLimitReached} results`);
		if (limits?.resultLimit) truncationReasons.push(`limit ${limits.resultLimit.reached} results`);
		if (truncation) truncationReasons.push(truncation.truncatedBy === "lines" ? "line limit" : "size limit");
		const artifactId = truncation && "artifactId" in truncation ? truncation.artifactId : undefined;
		if (artifactId) truncationReasons.push(formatFullOutputReference(artifactId));

		const extraLines: string[] = [];
		if (truncationReasons.length > 0) {
			extraLines.push(uiTheme.fg("warning", `truncated: ${truncationReasons.join(", ")}`));
		}
		if (incomplete) {
			extraLines.push(uiTheme.fg("warning", `incomplete: ${formatIncompleteLabel(incomplete)}`));
		}

		let cached: RenderCache | undefined;
		return {
			render(width: number): string[] {
				const { expanded } = options;
				const key = new Hasher().bool(expanded).u32(width).digest();
				if (cached?.key === key) return cached.lines;
				const fileLines = renderFileList(
					{
						files: files.map(entry => ({ path: entry, isDirectory: entry.endsWith("/") })),
						expanded,
						maxCollapsed: COLLAPSED_LIST_LIMIT,
					},
					uiTheme,
				);
				const result = [header, ...fileLines, ...extraLines].map(l => truncateToWidth(l, width, Ellipsis.Omit));
				cached = { key, lines: result };
				return result;
			},
			invalidate() {
				cached = undefined;
			},
		};
	},
	mergeCallAndResult: true,
};
