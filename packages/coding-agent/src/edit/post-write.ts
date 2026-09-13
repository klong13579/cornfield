import { completeSimple } from "@cornfield/ai";
import { astGrep } from "@cornfield/natives";
import { logger, prompt } from "@cornfield/utils";
import * as Diff from "diff";
import { resolveModelRoleValue } from "../config/model-resolver";
import { getLanguageFromPath } from "../modes/theme/theme";
import type { ToolSession } from "../tools";
import repairPromptTemplate from "./repair.md" with { type: "text" };

const PARSE_ERROR_MARKER = "parse error (syntax tree contains error nodes)";

/** A syntax failure detectable through the native tree-sitter parse. */
interface ParseFailure {
	detail: string;
	language: string;
}

/**
 * Raised when an edit leaves a target file in a state native tree-sitter
 * can no longer parse, and auto-repair (if enabled) did not adopt a fix.
 * Carries the first changed line so the caller can report the damage site.
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

/**
 * Prove (or disprove) that the file at `absolutePath` still parses using the
 * native tree-sitter grammars exposed through ast-grep. Files whose extension
 * has no native grammar are not candidates and count as "still parseable".
 */
async function detectParseFailure(absolutePath: string): Promise<ParseFailure | undefined> {
	const language = getLanguageFromPath(absolutePath) ?? "source";
	try {
		// A single meta-variable pattern forces ast-grep to parse the whole file
		// (parse is all-or-nothing per file) while keeping match output bounded.
		const result = await astGrep({ patterns: ["$A"], path: absolutePath, limit: 1, timeoutMs: 10_000 });
		const detail = result.parseErrors?.find(error => error.endsWith(PARSE_ERROR_MARKER));
		if (!detail) return undefined;
		return { detail, language };
	} catch {
		// If the native layer cannot even run (unsupported language, worker
		// failure), treat the file as valid rather than blocking the edit.
		return undefined;
	}
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

/**
 * Attempt to repair a broken edit with the model assigned to
 * `edit.autoRepair.modelRole`. Returns true only when the repaired file
 * parses again and the repair is not a verbatim undo of the edit.
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
): Promise<boolean> {
	if (!session.settings.get("edit.autoRepair.enabled")) return false;

	const maxAttempts = Math.max(0, session.settings.get("edit.autoRepair.maxAttempts"));
	if (maxAttempts === 0) return false;

	const maxRegionLines = Math.max(1, session.settings.get("edit.autoRepair.maxRegionLines"));
	const range = computeChangedLineRange(args.originalContent, args.brokenContent);
	if (!range) return false;
	if (range.end - range.start + 1 > maxRegionLines) return false;

	const brokenLines = args.brokenContent.split("\n");
	const region = brokenLines.slice(range.start - 1, range.end).join("\n");

	const resolved = resolveRepairModel(session);
	if (!resolved) return false;

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
		if (candidate === args.originalContent) {
			// A verbatim undo would silently discard the edit; reject it.
			continue;
		}
		if (candidate === args.brokenContent) {
			// The model returned the broken region unchanged.
			continue;
		}

		await Bun.write(args.absolutePath, candidate);
		const stillBroken = await detectParseFailure(args.absolutePath);
		if (!stillBroken) return true;
		if (signal?.aborted) return false;
	}

	return false;
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

/**
 * Post-write gate for the edit tool: validate that the target file still
 * parses. On failure, attempt auto-repair (when enabled); if that does not
 * produce an adopted fix, roll the edit back and surface the damage site.
 */
export async function validateEditedFile(options: ValidateEditedFileOptions): Promise<void> {
	const { session, absolutePath, displayPath, originalContent, signal, complete = completeSimple } = options;
	if (!session.settings.get("edit.validate.enabled")) return;

	const failure = await detectParseFailure(absolutePath);
	if (!failure) return;

	const brokenContent = await Bun.file(absolutePath).text();
	const repaired = await attemptAutoRepair(
		session,
		{ absolutePath, displayPath, originalContent, brokenContent, failure },
		complete,
		signal,
	);
	if (repaired) return;

	await Bun.write(absolutePath, originalContent);
	const range = computeChangedLineRange(originalContent, brokenContent);
	throw new EditValidationError(displayPath, range?.start, failure.language, failure.detail);
}
