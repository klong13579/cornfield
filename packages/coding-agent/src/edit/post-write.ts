/**
 * Post-write gate for the edit tool.
 *
 * Validate that the file an edit just wrote still parses. A file that no longer
 * does is either repaired (when auto-repair produces a fix that parses and is not
 * an undo) or rolled back to the exact bytes the edit started from. Localizing
 * and correcting the breakage is {@link ./auto-repair}'s job; this module decides
 * what the caller ends up with.
 */
import { completeSimple } from "@cornfield/ai";
import { type SummarizeCodeDiagnostic, summarizeCode } from "@cornfield/natives";
import type { ToolSession } from "../tools";
import { attemptAutoRepair } from "./auto-repair";
import { recordEditParseRegression } from "./blackbox";

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
	let result: ReturnType<typeof summarizeCode>;
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
		{
			absolutePath,
			displayPath,
			previousContent: originalContent,
			brokenContent,
			language: failure.language,
			parseDetail: failure.detail,
			badLine: failure.badLine,
		},
		complete,
		signal,
	);

	// Recorded for both outcomes: a regression we could repair is as informative
	// as one we had to roll back.
	await recordEditParseRegression(session, {
		path: displayPath,
		language: failure.language,
		badLine: failure.badLine,
		before: originalContent,
		after: brokenContent,
		adopted: repair.adopted,
	});

	if (repair.adopted) return { outcome: "repaired", note: repair.note };

	await Bun.write(absolutePath, originalContent);
	throw new EditValidationError(displayPath, failure.badLine, failure.language, failure.detail);
}
