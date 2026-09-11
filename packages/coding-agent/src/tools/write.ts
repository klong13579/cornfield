import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@cornfield/agent";
import type { Component } from "@cornfield/tui";
import { Text } from "@cornfield/tui";
import { isEnoent, isRecord, prompt, untilAborted } from "@cornfield/utils";
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { unzipSync, zipSync } from "fflate";
import { stripHashlinePrefixes } from "../edit";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { createLspWritethrough, type FileDiagnosticsResult, type WritethroughCallback, writethroughNoop } from "../lsp";
import { getLanguageFromPath, type Theme } from "../modes/theme/theme";
import writeDescription from "../prompts/tools/write.md" with { type: "text" };
import type { ToolSession } from "../sdk";
import { Ellipsis, Hasher, type RenderCache, renderStatusLine, truncateToWidth } from "../tui";
import { resolveFileDisplayMode } from "../utils/file-display-mode";
import { parseArchivePathCandidates } from "./archive-reader";
import { assertEditableFile } from "./auto-generated-guard";
import { normalizeToolName } from "./builtin-names";
import { invalidateFsScanAfterWrite } from "./fs-cache-invalidation";
import { type OutputMeta, outputMeta } from "./output-meta";
import { formatPathRelativeToCwd } from "./path-utils";
import { enforcePlanModeWrite, resolvePlanPath } from "./plan-mode-guard";
import {
	formatDiagnostics,
	formatExpandHint,
	formatMoreItems,
	formatStatusIcon,
	formatTitle,
	getLspBatchRequest,
	replaceTabs,
	shortenPath,
} from "./render-utils";
import {
	deleteRowByKey,
	deleteRowByRowId,
	insertRow,
	isSqliteFile,
	parseSqlitePathCandidates,
	resolveTableRowLookup,
	updateRowByKey,
	updateRowByRowId,
} from "./sqlite-reader";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";

const writeSchema = Type.Object({
	path: Type.String({ description: "file path", examples: ["src/new.ts"] }),
	content: Type.String({ description: "file content" }),
});

export type WriteToolInput = Static<typeof writeSchema>;

/** Details returned by the write tool for TUI rendering */
export interface WriteToolDetails {
	diagnostics?: FileDiagnosticsResult;
	meta?: OutputMeta;
}

/**
 * Strip hashline display prefixes from write content.
 *
 * Only active when hashline edit mode is enabled — the model sees `LINE+ID|`
 * prefixes in read output and sometimes copies them into write content.
 */
function stripWriteContent(session: ToolSession, content: string): { text: string; stripped: boolean } {
	if (!resolveFileDisplayMode(session).hashLines) {
		return { text: content, stripped: false };
	}
	const lines = content.split("\n");
	const cleaned = stripHashlinePrefixes(lines);
	if (cleaned === lines) return { text: content, stripped: false };
	return { text: cleaned.join("\n"), stripped: true };
}

// ═══════════════════════════════════════════════════════════════════════════
// Tool Class
// ═══════════════════════════════════════════════════════════════════════════

type WriteParams = WriteToolInput;

interface ResolvedArchiveWritePath {
	absolutePath: string;
	archivePath: string;
	archiveSubPath: string;
	exists: boolean;
}

interface ResolvedSqliteWritePath {
	absolutePath: string;
	sqlitePath: string;
	table: string;
	key?: string;
	exists: boolean;
}

function isArchivePathNotFound(error: unknown): boolean {
	if (isEnoent(error)) return true;
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOTDIR";
}

function normalizeArchiveWriteSubPath(rawPath: string): string {
	const normalized = rawPath.replace(/\\/g, "/");
	if (normalized.length === 0) {
		throw new ToolError("Archive write path must target a file inside the archive");
	}
	if (normalized.endsWith("/")) {
		throw new ToolError("Archive write path must target a file, not a directory");
	}

	const parts = normalized.split("/");
	const normalizedParts: string[] = [];
	for (const part of parts) {
		if (!part || part === ".") continue;
		if (part === "..") {
			throw new ToolError("Archive path cannot contain '..'");
		}
		normalizedParts.push(part);
	}

	if (normalizedParts.length === 0) {
		throw new ToolError("Archive write path must target a file inside the archive");
	}

	return normalizedParts.join("/");
}

function parseSqliteWriteTarget(subPath: string, queryString: string): { table: string; key?: string } {
	if (queryString.trim().length > 0) {
		throw new ToolError("SQLite write paths do not support query parameters");
	}

	const normalized = subPath.replace(/^:+/, "").trim();
	if (!normalized) {
		throw new ToolError("SQLite write path must target a table");
	}

	const separatorIndex = normalized.indexOf(":");
	const table = separatorIndex === -1 ? normalized : normalized.slice(0, separatorIndex);
	const key = separatorIndex === -1 ? undefined : normalized.slice(separatorIndex + 1);
	if (!table) {
		throw new ToolError("SQLite write path must target a table");
	}
	if (key !== undefined && key.length === 0) {
		throw new ToolError("SQLite row writes require a non-empty row key");
	}

	return { table, key };
}

/**
 * Write tool implementation.
 *
 * Creates or overwrites files with optional LSP formatting and diagnostics.
 */
export class WriteTool implements AgentTool<typeof writeSchema, WriteToolDetails> {
	readonly name = "write";
	readonly label = "Write";
	readonly description: string;
	readonly parameters = writeSchema;
	readonly nonAbortable = true;
	readonly strict = true;
	readonly concurrency = "exclusive";

	readonly #writethrough: WritethroughCallback;

	constructor(private readonly session: ToolSession) {
		const enableLsp = session.enableLsp ?? true;
		const enableFormat = enableLsp && session.settings.get("lsp.formatOnWrite");
		const enableDiagnostics = enableLsp && session.settings.get("lsp.diagnosticsOnWrite");
		this.#writethrough = enableLsp
			? createLspWritethrough(session.cwd, { enableFormat, enableDiagnostics })
			: writethroughNoop;
		this.description = prompt.render(writeDescription);
	}

	async #resolveArchiveWritePath(writePath: string): Promise<ResolvedArchiveWritePath | null> {
		const candidates = parseArchivePathCandidates(writePath).filter(candidate => candidate.archivePath !== writePath);
		if (candidates.length === 0) {
			return null;
		}

		const fallbackCandidate = candidates[candidates.length - 1]!;
		const fallback: ResolvedArchiveWritePath = {
			absolutePath: resolvePlanPath(this.session, fallbackCandidate.archivePath),
			archivePath: fallbackCandidate.archivePath,
			archiveSubPath: normalizeArchiveWriteSubPath(fallbackCandidate.subPath),
			exists: false,
		};

		for (const candidate of candidates) {
			const absolutePath = resolvePlanPath(this.session, candidate.archivePath);
			try {
				const stat = await Bun.file(absolutePath).stat();
				if (stat.isDirectory()) {
					continue;
				}

				return {
					absolutePath,
					archivePath: candidate.archivePath,
					archiveSubPath: normalizeArchiveWriteSubPath(candidate.subPath),
					exists: true,
				};
			} catch (error) {
				if (!isArchivePathNotFound(error)) {
					throw error;
				}
			}
		}

		return fallback;
	}

	async #writeArchiveEntry(
		content: string,
		resolvedArchivePath: ResolvedArchiveWritePath,
	): Promise<AgentToolResult<WriteToolDetails>> {
		const isZip = resolvedArchivePath.absolutePath.toLowerCase().endsWith(".zip");

		const parentDir = path.dirname(resolvedArchivePath.absolutePath);
		if (parentDir && parentDir !== ".") {
			await fs.mkdir(parentDir, { recursive: true });
		}

		if (isZip) {
			const zipEntries: Record<string, Uint8Array> = {};

			if (resolvedArchivePath.exists) {
				try {
					const bytes = await Bun.file(resolvedArchivePath.absolutePath).bytes();
					const existing = unzipSync(new Uint8Array(bytes));
					for (const [entryPath, data] of Object.entries(existing)) {
						zipEntries[entryPath.replace(/\\/g, "/")] = data;
					}
				} catch (error) {
					throw new ToolError(error instanceof Error ? error.message : String(error));
				}
			}

			zipEntries[resolvedArchivePath.archiveSubPath] = new TextEncoder().encode(content);

			try {
				const zipBuffer = zipSync(zipEntries);
				await Bun.write(resolvedArchivePath.absolutePath, zipBuffer);
			} catch (error) {
				throw new ToolError(error instanceof Error ? error.message : String(error));
			}
		} else {
			const archiveEntries: Record<string, string | File> = {};
			if (resolvedArchivePath.exists) {
				let archive: Bun.Archive;
				try {
					archive = new Bun.Archive(await Bun.file(resolvedArchivePath.absolutePath).bytes());
				} catch (error) {
					throw new ToolError(error instanceof Error ? error.message : String(error));
				}

				let files: Map<string, File>;
				try {
					files = await archive.files();
				} catch (error) {
					throw new ToolError(error instanceof Error ? error.message : String(error));
				}

				for (const [entryPath, file] of files) {
					archiveEntries[entryPath.replace(/\\/g, "/")] = file;
				}
			}

			archiveEntries[resolvedArchivePath.archiveSubPath] = content;

			try {
				await Bun.Archive.write(resolvedArchivePath.absolutePath, archiveEntries);
			} catch (error) {
				throw new ToolError(error instanceof Error ? error.message : String(error));
			}
		}

		invalidateFsScanAfterWrite(resolvedArchivePath.absolutePath);
		const outputPath = `${formatPathRelativeToCwd(resolvedArchivePath.absolutePath, this.session.cwd)}:${
			resolvedArchivePath.archiveSubPath
		}`;
		return {
			content: [{ type: "text", text: `Successfully wrote ${content.length} bytes to ${outputPath}` }],
			details: {},
		};
	}

	async #resolveSqliteWritePath(writePath: string): Promise<ResolvedSqliteWritePath | null> {
		const candidates = parseSqlitePathCandidates(writePath).filter(candidate => candidate.sqlitePath !== writePath);
		if (candidates.length === 0) {
			return null;
		}

		const fallbackCandidate = candidates[candidates.length - 1]!;
		const fallbackTarget = parseSqliteWriteTarget(fallbackCandidate.subPath, fallbackCandidate.queryString);
		const fallback: ResolvedSqliteWritePath = {
			absolutePath: resolvePlanPath(this.session, fallbackCandidate.sqlitePath),
			sqlitePath: fallbackCandidate.sqlitePath,
			table: fallbackTarget.table,
			key: fallbackTarget.key,
			exists: false,
		};

		let sawExistingNonSqlite = false;
		for (const candidate of candidates) {
			const target = parseSqliteWriteTarget(candidate.subPath, candidate.queryString);
			const absolutePath = resolvePlanPath(this.session, candidate.sqlitePath);
			try {
				const stat = await Bun.file(absolutePath).stat();
				if (stat.isDirectory()) {
					continue;
				}
				if (!(await isSqliteFile(absolutePath))) {
					sawExistingNonSqlite = true;
					continue;
				}

				return {
					absolutePath,
					sqlitePath: candidate.sqlitePath,
					table: target.table,
					key: target.key,
					exists: true,
				};
			} catch (error) {
				if (!isArchivePathNotFound(error)) {
					throw error;
				}
			}
		}

		if (sawExistingNonSqlite) {
			return null;
		}

		return fallback;
	}

	async #writeSqliteRow(
		displayPath: string,
		content: string,
		resolvedSqlitePath: ResolvedSqliteWritePath,
	): Promise<AgentToolResult<WriteToolDetails>> {
		let db: Database | null = null;
		try {
			if (!resolvedSqlitePath.exists) {
				throw new ToolError(`SQLite database '${displayPath}' not found`);
			}

			db = new Database(resolvedSqlitePath.absolutePath, { create: false, strict: true });
			db.run("PRAGMA busy_timeout = 3000");

			const trimmedContent = content.trim();
			let resultText: string;
			if (trimmedContent.length === 0) {
				if (!resolvedSqlitePath.key) {
					throw new ToolError("SQLite deletes require a row key in the path");
				}

				const lookup = resolveTableRowLookup(db, resolvedSqlitePath.table);
				const deleted =
					lookup.kind === "pk"
						? deleteRowByKey(db, resolvedSqlitePath.table, lookup, resolvedSqlitePath.key)
						: deleteRowByRowId(db, resolvedSqlitePath.table, resolvedSqlitePath.key);
				resultText =
					deleted > 0
						? `Deleted row '${resolvedSqlitePath.key}' from ${resolvedSqlitePath.table}`
						: `No row deleted from ${resolvedSqlitePath.table} for key '${resolvedSqlitePath.key}'`;
			} else {
				let parsedContent: unknown;
				try {
					parsedContent = Bun.JSON5.parse(content);
				} catch (error) {
					throw new ToolError(
						`SQLite write content must be valid JSON5: ${error instanceof Error ? error.message : String(error)}`,
					);
				}

				if (!isRecord(parsedContent)) {
					throw new ToolError("SQLite write content must be a JSON object");
				}

				if (resolvedSqlitePath.key) {
					const lookup = resolveTableRowLookup(db, resolvedSqlitePath.table);
					const updated =
						lookup.kind === "pk"
							? updateRowByKey(db, resolvedSqlitePath.table, lookup, resolvedSqlitePath.key, parsedContent)
							: updateRowByRowId(db, resolvedSqlitePath.table, resolvedSqlitePath.key, parsedContent);
					resultText =
						updated > 0
							? `Updated row '${resolvedSqlitePath.key}' in ${resolvedSqlitePath.table}`
							: `No row updated in ${resolvedSqlitePath.table} for key '${resolvedSqlitePath.key}'`;
				} else {
					insertRow(db, resolvedSqlitePath.table, parsedContent);
					resultText = `Inserted row into ${resolvedSqlitePath.table}`;
				}
			}

			invalidateFsScanAfterWrite(resolvedSqlitePath.absolutePath);
			return toolResult<WriteToolDetails>({}).text(resultText).sourcePath(resolvedSqlitePath.absolutePath).done();
		} catch (error) {
			if (isEnoent(error)) {
				throw new ToolError(`SQLite database '${displayPath}' not found`);
			}
			if (error instanceof ToolError) {
				throw error;
			}
			throw new ToolError(error instanceof Error ? error.message : String(error));
		} finally {
			db?.close();
		}
	}

	async execute(
		_toolCallId: string,
		{ path, content }: WriteParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<WriteToolDetails>,
		context?: AgentToolContext,
	): Promise<AgentToolResult<WriteToolDetails>> {
		return untilAborted(signal, async () => {
			// Strip hashline display prefixes (LINE+ID|) if the model copied them from read output
			const { text: cleanContent, stripped } = stripWriteContent(this.session, content);

			// Single virtual-path dispatch table: every non-plain-path write target
			// (xd:// device execution, `archive.zip:entry` and `db.sqlite:table`
			// concatenation paths) is one entry tried in order; plain filesystem
			// writes are the terminal fallback. There is no second dispatch path.
			const dispatch: Array<{
				try(path: string, text: string): Promise<AgentToolResult<WriteToolDetails> | null>;
			}> = [
				{
					try: (p, text) => this.#writeXdDevice(p, text, signal, _onUpdate, context),
				},
				{
					try: async (p, text) => {
						const resolved = await this.#resolveArchiveWritePath(p);
						if (!resolved) return null;
						enforcePlanModeWrite(this.session, resolved.archivePath, {
							op: resolved.exists ? "update" : "create",
						});
						return this.#writeArchiveEntry(text, resolved);
					},
				},
				{
					try: async (p, text) => {
						const resolved = await this.#resolveSqliteWritePath(p);
						if (!resolved) return null;
						enforcePlanModeWrite(this.session, resolved.sqlitePath, { op: "update" });
						return this.#writeSqliteRow(p, text, resolved);
					},
				},
			];

			for (const entry of dispatch) {
				const result = await entry.try(path, cleanContent);
				if (result) {
					return this.#noteHashlineStripping(result, stripped);
				}
			}

			enforcePlanModeWrite(this.session, path, { op: "create" });
			const absolutePath = resolvePlanPath(this.session, path);
			const batchRequest = getLspBatchRequest(context?.toolCall);

			// Check if file exists and is auto-generated before overwriting
			if (await fs.exists(absolutePath)) {
				await assertEditableFile(absolutePath, path);
			}

			const diagnostics = await this.#writethrough(absolutePath, cleanContent, signal, undefined, batchRequest);
			invalidateFsScanAfterWrite(absolutePath);

			const displayPath = formatPathRelativeToCwd(absolutePath, this.session.cwd);
			const resultText = `Successfully wrote ${cleanContent.length} bytes to ${displayPath}`;
			const plainResult: AgentToolResult<WriteToolDetails> = diagnostics
				? {
						content: [{ type: "text", text: resultText }],
						details: {
							diagnostics,
							meta: outputMeta()
								.diagnostics(diagnostics.summary, diagnostics.messages ?? [])
								.get(),
						},
					}
				: { content: [{ type: "text", text: resultText }], details: {} };
			return this.#noteHashlineStripping(plainResult, stripped);
		});
	}

	/** Append the hashline-stripping note to the first text block, if any prefixes were stripped. */
	#noteHashlineStripping(
		result: AgentToolResult<WriteToolDetails>,
		stripped: boolean,
	): AgentToolResult<WriteToolDetails> {
		if (!stripped) return result;
		const firstText = result.content.find(
			(block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string",
		);
		if (firstText) {
			firstText.text += `\nNote: auto-stripped hashline display prefixes from content before writing.`;
		}
		return result;
	}

	/**
	 * Execute a mounted xd:// device through the write transport.
	 * Returns null when `path` is not an xd:// URL (falls through the dispatch table).
	 */
	async #writeXdDevice(
		path: string,
		content: string,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<WriteToolDetails>,
		context?: AgentToolContext,
	): Promise<AgentToolResult<WriteToolDetails> | null> {
		const match = path.match(/^xd:\/\/(.+)$/i);
		if (!match) return null;
		const name = normalizeToolName(match[1]!.replace(/^\/+|\/+$/g, ""));
		if (!name) {
			throw new ToolError("xd:// write requires a device name, e.g. xd://<tool>");
		}
		const devices = this.session.xdevDevices;
		const device = devices?.get(name);
		if (!device) {
			const available = devices && devices.size > 0 ? Array.from(devices.keys()).join(", ") : "none";
			throw new ToolError(
				`Unknown xd device: ${name}\nMounted devices: ${available}\nUse read xd:// for the catalog.`,
			);
		}

		let args: unknown;
		try {
			args = Bun.JSON5.parse(content);
		} catch (error) {
			throw new ToolError(
				`xd:// write content must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (!isRecord(args)) {
			throw new ToolError("xd:// write content must be a JSON object of tool arguments");
		}
		if (!Value.Check(device.parameters, args)) {
			const errors = Array.from(Value.Errors(device.parameters, args))
				.map(e => `${e.path || "(root)"}: ${e.message}`)
				.join("; ");
			throw new ToolError(`Arguments do not match the wire schema of xd://${name}: ${errors}`);
		}

		const toolCallId = `xd-${crypto.randomUUID()}`;
		return (await device.execute(toolCallId, args, signal, onUpdate, context)) as AgentToolResult<WriteToolDetails>;
	}
}

// =============================================================================
// TUI Renderer
// =============================================================================

interface WriteRenderArgs {
	path?: string;
	file_path?: string;
	content?: string;
}

const WRITE_PREVIEW_LINES = 6;
const WRITE_STREAMING_PREVIEW_LINES = 12;

function countLines(text: string): number {
	if (!text) return 0;
	return text.split("\n").length;
}

function formatMetadataLine(lineCount: number | null, language: string | undefined, uiTheme: Theme): string {
	const icon = uiTheme.getLangIcon(language);
	if (lineCount !== null) {
		return uiTheme.fg("dim", `${icon} ${lineCount} lines`);
	}
	return uiTheme.fg("dim", `${icon}`);
}

function normalizeDisplayText(text: string): string {
	return text.replace(/\r/g, "");
}

function formatStreamingContent(content: string, uiTheme: Theme): string {
	if (!content) return "";
	const lines = normalizeDisplayText(content).split("\n");
	const displayLines = lines.slice(-WRITE_STREAMING_PREVIEW_LINES);
	const hidden = lines.length - displayLines.length;

	let text = "\n\n";
	if (hidden > 0) {
		text += uiTheme.fg("dim", `… (${hidden} earlier lines)\n`);
	}
	for (const line of displayLines) {
		text += `${uiTheme.fg("toolOutput", truncateToWidth(replaceTabs(line), 80))}\n`;
	}
	text += uiTheme.fg("dim", `… (streaming)`);
	return text;
}

function renderContentPreview(content: string, expanded: boolean, uiTheme: Theme): string {
	if (!content) return "";
	const lines = normalizeDisplayText(content).split("\n");
	const maxLines = expanded ? lines.length : Math.min(lines.length, WRITE_PREVIEW_LINES);
	const displayLines = expanded ? lines : lines.slice(-maxLines);
	const hidden = lines.length - displayLines.length;

	let text = "\n\n";
	for (const line of displayLines) {
		text += `${uiTheme.fg("toolOutput", truncateToWidth(replaceTabs(line), 80))}\n`;
	}
	if (!expanded && hidden > 0) {
		const hint = formatExpandHint(uiTheme, expanded, hidden > 0);
		const moreLine = `${formatMoreItems(hidden, "line")}${hint ? ` ${hint}` : ""}`;
		text += uiTheme.fg("dim", moreLine);
	}
	return text;
}

export const writeToolRenderer = {
	renderCall(args: WriteRenderArgs, options: RenderResultOptions, uiTheme: Theme): Component {
		const rawPath = args.file_path || args.path || "";
		const filePath = shortenPath(rawPath);
		const lang = getLanguageFromPath(rawPath) ?? "text";
		const langIcon = uiTheme.fg("muted", uiTheme.getLangIcon(lang));
		const pathDisplay = filePath ? uiTheme.fg("accent", filePath) : uiTheme.fg("toolOutput", "…");
		const spinner =
			options?.spinnerFrame !== undefined ? formatStatusIcon("running", uiTheme, options.spinnerFrame) : "";

		let text = `${formatTitle("Write", uiTheme)} ${spinner ? `${spinner} ` : ""}${langIcon} ${pathDisplay}`;

		if (!args.content) {
			return new Text(text, 0, 0);
		}

		// Show streaming preview of content (tail)
		text += formatStreamingContent(args.content, uiTheme);

		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: WriteToolDetails },
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: WriteRenderArgs,
	): Component {
		const rawPath = args?.file_path || args?.path || "";
		const filePath = shortenPath(rawPath);
		const fileContent = args?.content || "";
		const lang = getLanguageFromPath(rawPath);
		const langIcon = uiTheme.fg("muted", uiTheme.getLangIcon(lang));
		const pathDisplay = filePath ? uiTheme.fg("accent", filePath) : uiTheme.fg("toolOutput", "…");
		const lineCount = countLines(fileContent);

		// Build header with status icon
		const header = renderStatusLine(
			{
				icon: "success",
				title: "Write",
				description: `${langIcon} ${pathDisplay}`,
			},
			uiTheme,
		);
		const metadataLine = formatMetadataLine(lineCount, lang ?? "text", uiTheme);
		const diagnostics = result.details?.diagnostics;

		let cached: RenderCache | undefined;

		return {
			render(width: number) {
				const { expanded } = options;
				const key = new Hasher().bool(expanded).u32(width).digest();
				if (cached?.key === key) return cached.lines;

				let text = header;
				text += `\n${metadataLine}`;
				text += renderContentPreview(fileContent, expanded, uiTheme);

				if (diagnostics) {
					const diagText = formatDiagnostics(diagnostics, expanded, uiTheme, fp =>
						uiTheme.getLangIcon(getLanguageFromPath(fp)),
					);
					if (diagText.trim()) {
						const diagLines = diagText.split("\n");
						const firstNonEmpty = diagLines.findIndex(line => line.trim());
						if (firstNonEmpty >= 0) {
							text += `\n${diagLines.slice(firstNonEmpty).join("\n")}`;
						}
					}
				}

				const lines = text.split("\n").map(l => truncateToWidth(l, width, Ellipsis.Omit));
				cached = { key, lines };
				return lines;
			},
			invalidate() {
				cached = undefined;
			},
		};
	},
	mergeCallAndResult: true,
};
