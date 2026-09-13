import { completeSimple } from "@cornfield/ai";
import { type SummarizeCodeDiagnostic, type SummarizeCodeResult, summarizeCode } from "@cornfield/natives";
import { logger, prompt } from "@cornfield/utils";
import * as Diff from "diff";
import { resolveModelRoleValue } from "../config/model-resolver";
import type { ToolSession } from "../tools";
import { normalizeToLF } from "./normalize";
import repairPromptTemplate from "./repair.md" with { type: "text" };

/** A syntax failure detectable through the native tree-sitter parse. */
interface ParseFailure {
	detail: string;
	language: string;
	/** 1-based start line of the first error/missing node, when known. */
	badLine: number | undefined;
	diagnostics: SummarizeCodeDiagnostic[];
}

/**
 * Raised when an edit leaves a target file in a state native tree-sitter
 * can no longer parse, and auto-repair (if enabled) did not adopt a fix.
 * Carries the damage site so the caller can report it precisely.
 */
export class EditValidationError extends Error {
	constructor(
		readonly path: string,
		readonly badLine: number | undefined,
		readonly language: string,
		readonly parseDetail: string,
	) {
		super(EditValidationError.formatMessage(path, badLine, language, parseDetail));
		this.name = "EditValidationError";
	}

	static formatMessage(path: string, badLine: number | undefined, language: string, parseDetail: string): string {
		const location = badLine !== undefined ? `line ${badLine}` : "unknown line";
		return (
			`Edit made ${path} unparseable as ${language} near ${location}. ` +
			`Expected valid ${language} syntax. ${parseDetail}. ` +
			"The change was rolled back."
		);
	}
}

function formatDiagnosticLocation(diagnostic: SummarizeCodeDiagnostic): string {
	return `${diagnostic.kind} '${diagnostic.nodeKind}' at ${diagnostic.startLine}:${diagnostic.startColumn}`;
}

function formatParseFailureDetail(language: string, diagnostics: SummarizeCodeDiagnostic[]): string {
	const noun = diagnostics.length === 1 ? "node" : "nodes";
	const head = `syntax tree contains ${diagnostics.length} error or missing ${noun} (${language})`;
	const first = diagnostics[0];
	if (!first) return head;
	const extra = diagnostics.slice(1, 3).map(formatDiagnosticLocation).join("; ");
	return `${head}. First: ${formatDiagnosticLocation(first)}${extra ? `. Also: ${extra}` : ""}`;
}

/**
 * Prove (or disprove) that `content` still parses using the native tree-sitter
 * grammars exposed through `summarizeCode`. Files whose extension has no native
 * grammar (or whose parse otherwise fails to run) are not candidates and count
 * as "still parseable".
 *
 * `parsed: false` is derived from the tree containing error OR missing nodes,
 * so an unclosed delimiter (a *missing* node, not an *error* node) is caught.
 */
function detectParseFailure(content: string, absolutePath: string): ParseFailure | undefined {
	let result: SummarizeCodeResult;
	try {
		result = summarizeCode({ code: content, path: absolutePath });
	} catch {
		// Unsupported language, worker failure, or native error — treat as valid
		// rather than blocking the edit.
		return undefined;
	}
	if (result.parsed) return undefined;
	const diagnostics = result.diagnostics ?? [];
	return {
		detail: formatParseFailureDetail(result.language, diagnostics),
		language: result.language,
		badLine: diagnostics[0]?.startLine,
		diagnostics,
	};
}

/** Normalize whitespace so whitespace-only differences become invisible. */
function normalizeWhitespace(text: string): string {
	return normalizeToLF(text)
		.split("\n")
		.map(line => line.replace(/[ \t]+/g, " ").trim())
		.filter(line => line.length > 0)
		.join("\n");
}

/** Non-empty, whitespace-normalized lines of `text`. */
function normalizedNonEmptyLines(text: string): string[] {
	return normalizeWhitespace(text)
		.split("\n")
		.filter(line => line.length > 0);
}

function countDiffLines(value: string): number {
	const lines = value.split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	return lines.length;
}

/**
 * Lines this edit genuinely inserted (net additions), excluding replacements.
 *
 * A removal/immediately-following-addition pair in the line diff is a
 * replacement, not an insertion: only the added lines beyond the removed count
 * represent new content the edit contributed.
 */
function computeNetAddedLines(original: string, broken: string): string[] {
	const parts = Diff.diffLines(normalizeWhitespace(original), normalizeWhitespace(broken));
	const added: string[] = [];
	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		if (!part.added) continue;
		const removedCount = i > 0 && parts[i - 1].removed ? countDiffLines(parts[i - 1].value) : 0;
		const lines = part.value.split("\n");
		const cleanLines = lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
		for (let j = removedCount; j < cleanLines.length; j++) {
			const line = cleanLines[j].trim();
			if (line) added.push(line);
		}
	}
	return added;
}

/** True when the candidate kept at least one of the edit's net-new lines. */
function keptLine(addedLine: string, candidateLine: string): boolean {
	const a = addedLine.trim();
	const c = candidateLine.trim();
	return c === a || c.startsWith(a) || a.startsWith(c);
}

function candidateKeepsAnyAddedLine(netAddedLines: string[], candidate: string): boolean {
	if (netAddedLines.length === 0) return true;
	const candidateLines = normalizedNonEmptyLines(candidate);
	return netAddedLines.some(line => candidateLines.some(candidateLine => keptLine(line, candidateLine)));
}

interface ChangedLineRange {
	start: number;
	end: number;
}

/** 1-based inclusive range of lines that differ between `original` and `current`. */
function computeChangedLineRange(original: string, current: string): ChangedLineRange | undefined {
	const parts = Diff.diffLines(original, current);
	let newLine = 1;
	let first: number | undefined;
	let last: number | undefined;
	for (const part of parts) {
		const raw = part.value.split("\n");
		if (raw[raw.length - 1] === "") raw.pop();
		const count = raw.length;
		if (part.added) {
			if (first === undefined) first = newLine;
			last = newLine + count - 1;
			newLine += count;
		} else if (part.removed) {
			if (first === undefined) first = newLine;
			last ??= newLine;
		} else {
			newLine += count;
		}
	}
	if (first === undefined) return undefined;
	return { start: first, end: last ?? first };
}

function extractResponseText(response: Awaited<ReturnType<typeof completeSimple>>): string {
	return response.content
		.filter(content => content.type === "text")
		.map(content => content.text)
		.join("")
		.trim();
}

function stripCodeFences(text: string): string {
	const trimmed = text.trim();
	const fence = trimmed.match(/^```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)\n?```$/);
	if (fence) return fence[1];
	return trimmed;
}

function spliceRegion(content: string, range: ChangedLineRange, replacement: string): string {
	const lines = content.split("\n");
	const before = lines.slice(0, range.start - 1);
	const after = lines.slice(range.end);
	return [...before, ...replacement.split("\n"), ...after].join("\n");
}

type RepairModel = NonNullable<ReturnType<typeof resolveModelRoleValue>["model"]>;

function resolveRepairModel(session: ToolSession): { model: RepairModel } | undefined {
	const availableModels = session.modelRegistry?.getAvailable() ?? session.getAvailableModels?.() ?? [];
	if (availableModels.length === 0) return undefined;
	const role = session.settings.get("edit.autoRepair.modelRole");
	const roleValue = session.settings.getModelRole(role);
	const resolved = resolveModelRoleValue(roleValue, availableModels, {
		settings: session.settings,
		matchPreferences: { usageOrder: session.settings.getStorage()?.getModelUsageOrder() },
		modelRegistry: session.modelRegistry,
	});
	if (!resolved.model) return undefined;
	return { model: resolved.model };
}

async function callRepairModel(
	session: ToolSession,
	model: RepairModel,
	args: { language: string; path: string; parseDetail: string; region: string; range: ChangedLineRange },
	complete: typeof completeSimple,
	signal?: AbortSignal,
): Promise<string | undefined> {
	const registry = session.modelRegistry;
	if (!registry) return undefined;
	const apiKey = await registry.getApiKey(model, session.getSessionId?.() ?? undefined);
	if (!apiKey) return undefined;

	const systemPrompt = prompt.render(repairPromptTemplate, {
		language: args.language,
		path: args.path,
		parse_error: args.parseDetail,
		region_start: args.range.start,
		region_end: args.range.end,
	});

	try {
		const response = await complete(
			model,
			{
				systemPrompt,
				messages: [{ role: "user", content: args.region, timestamp: Date.now() }],
			},
			{ apiKey, signal, maxTokens: 1024 },
		);
		if (response.stopReason === "error" || response.stopReason === "aborted") {
			logger.debug("edit-auto-repair: model call failed", {
				model: `${model.provider}/${model.id}`,
				stopReason: response.stopReason,
				error: response.errorMessage,
			});
			return undefined;
		}
		return stripCodeFences(extractResponseText(response));
	} catch (err) {
		logger.debug("edit-auto-repair: model call threw", {
			model: `${model.provider}/${model.id}`,
			error: err instanceof Error ? err.message : String(err),
		});
		return undefined;
	}
}

interface AutoRepairResult {
	adopted: boolean;
	note?: string;
}

/**
 * Attempt to repair a broken edit with the model assigned to
 * `edit.autoRepair.modelRole`. Reports adoption only when the repaired file
 * parses again and the repair is not an undo of the edit — where "undo" is
 * judged after whitespace normalization and additionally rejects candidates
 * that dropped every line this edit genuinely inserted.
 */
async function attemptAutoRepair(
	session: ToolSession,
	args: {
		absolutePath: string;
		displayPath: string;
		originalContent: string;
		brokenContent: string;
		failure: ParseFailure;
	},
	complete: typeof completeSimple,
	signal?: AbortSignal,
): Promise<AutoRepairResult> {
	if (!session.settings.get("edit.autoRepair.enabled")) return { adopted: false };

	const maxAttempts = Math.max(0, session.settings.get("edit.autoRepair.maxAttempts"));
	if (maxAttempts === 0) return { adopted: false };

	const maxRegionLines = Math.max(1, session.settings.get("edit.autoRepair.maxRegionLines"));
	const range = computeChangedLineRange(args.originalContent, args.brokenContent);
	if (!range) return { adopted: false };
	if (range.end - range.start + 1 > maxRegionLines) return { adopted: false };

	const brokenLines = args.brokenContent.split("\n");
	const region = brokenLines.slice(range.start - 1, range.end).join("\n");

	const resolved = resolveRepairModel(session);
	if (!resolved) return { adopted: false };

	const normalizedOriginal = normalizeWhitespace(args.originalContent);
	const netAddedLines = computeNetAddedLines(args.originalContent, args.brokenContent);

	for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
		const corrected = await callRepairModel(
			session,
			resolved.model,
			{
				language: args.failure.language,
				path: args.displayPath,
				parseDetail: args.failure.detail,
				region,
				range,
			},
			complete,
			signal,
		);
		if (corrected === undefined) break;

		const candidate = spliceRegion(args.brokenContent, range, corrected);
		if (candidate === args.brokenContent) {
			// The model returned the broken region unchanged.
			continue;
		}
		if (candidate === args.originalContent || normalizeWhitespace(candidate) === normalizedOriginal) {
			// A verbatim or whitespace-only undo would silently discard the edit.
			continue;
		}
		if (!candidateKeepsAnyAddedLine(netAddedLines, candidate)) {
			// The candidate dropped every line this edit inserted (a non-verbatim undo).
			continue;
		}

		await Bun.write(args.absolutePath, candidate);
		const stillBroken = detectParseFailure(candidate, args.absolutePath);
		if (!stillBroken) {
			const lineNote = args.failure.badLine !== undefined ? ` near line ${args.failure.badLine}` : "";
			return {
				adopted: true,
				note: `${args.displayPath}: auto-repair adopted a parseable fix${lineNote}; the edit was kept.`,
			};
		}
		if (signal?.aborted) return { adopted: false };
	}

	return { adopted: false };
}

export interface ValidateEditedFileOptions {
	session: ToolSession;
	absolutePath: string;
	displayPath: string;
	/** The file content before this edit (rollback target). */
	originalContent: string;
	signal?: AbortSignal;
	/** LLM completion call, injectable for tests; defaults to {@link completeSimple}. */
	complete?: typeof completeSimple;
}

/** What post-write validation did, surfaced so the tool result can say so. */
export interface EditValidationOutcome {
	outcome: "clean" | "repaired";
	/** Human-readable note for the tool result when a repair was adopted. */
	note?: string;
}

/**
 * Post-write gate for the edit tool: validate that the target file still
 * parses. On failure, attempt auto-repair (when enabled); if that does not
 * produce an adopted fix, roll the edit back and surface the damage site.
 *
 * Rollback concludes by throwing {@link EditValidationError} (which the caller
 * already surfaces), while an adopted repair is returned so the tool result can
 * report it to the model.
 */
export async function validateEditedFile(options: ValidateEditedFileOptions): Promise<EditValidationOutcome> {
	const { session, absolutePath, displayPath, originalContent, signal, complete = completeSimple } = options;
	if (!session.settings.get("edit.validate.enabled")) return { outcome: "clean" };

	const brokenContent = await Bun.file(absolutePath).text();
	const failure = detectParseFailure(brokenContent, absolutePath);
	if (!failure) return { outcome: "clean" };

	const repair = await attemptAutoRepair(
		session,
		{ absolutePath, displayPath, originalContent, brokenContent, failure },
		complete,
		signal,
	);
	if (repair.adopted) return { outcome: "repaired", note: repair.note };

	await Bun.write(absolutePath, originalContent);
	throw new EditValidationError(displayPath, failure.badLine, failure.language, failure.detail);
}
