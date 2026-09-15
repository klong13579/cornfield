/**
 * Auto-repair for edits that leave a file unparseable.
 *
 * An edit that breaks the parse is localized to the smallest set of changed
 * line runs ("hunks") whose reversion restores the parse. The repair model is
 * handed only those lines; the surrounding context is shown as fixed reference
 * and spliced back verbatim. That is what keeps a repair from drifting into the
 * parts of the edit that were fine — and what makes "the candidate is an undo of
 * the intended change" a decidable question rather than a judgement call.
 *
 * Localization re-parses the file at each step: revert one hunk, then two, then
 * peel greedily. Preferring the smallest explanation first is what bounds the
 * region handed to a small model; the greedy peel is the fallback for edits
 * whose hunks only parse again when a larger set is reverted together.
 */

import type { completeSimple, Model } from "@cornfield/ai";
import { summarizeCode } from "@cornfield/natives";
import { logger, prompt } from "@cornfield/utils";
import * as Diff from "diff";
import { resolveModelRoleValue } from "../config/model-resolver";
import type { ToolSession } from "../tools";
import { normalizeToLF } from "./normalize";
import repairPromptTemplate from "./repair.md" with { type: "text" };

/** Context lines shown around the culprit hunks in the repair prompt. */
const REPAIR_CONTEXT_LINES = 6;

/** Hunk count above which the O(n²) pair search is skipped for the O(n) greedy peel. */
const MAX_PAIR_SEARCH_HUNKS = 24;

/** One contiguous changed line run, in pre-image (`a`) / post-image (`b`) coordinates. */
interface EditHunk {
	/** Start of the run in pre-image lines. */
	aStart: number;
	/** End of the run in pre-image lines (exclusive). */
	aEnd: number;
	/** Start of the run in post-image lines. */
	bStart: number;
	/** End of the run in post-image lines (exclusive). */
	bEnd: number;
}

/**
 * The localized parse breakage, in both the coordinates the splice needs and the
 * text the repair model reads.
 */
export interface RepairRegion {
	/** Editable line span of the broken file, `[editStart, editEnd)`; the candidate replaces exactly these. */
	editStart: number;
	/** End of the editable span (exclusive). Equal to `editStart` when the edit only deleted lines. */
	editEnd: number;
	/** The region as it exists on disk — the editable span widened by {@link REPAIR_CONTEXT_LINES}. */
	brokenText: string;
	/** The same region with the culprit hunks restored to pre-image lines: the model's BEFORE. */
	referenceText: string;
	/** The editable span as it reads with the culprits reverted — a candidate equal to this is an undo. */
	revertedText: string;
	/** 1-based first line of the editable span, for the prompt. */
	editStartLine: number;
	/** 1-based inclusive last line of the editable span; `editStartLine - 1` when the span is empty. */
	editEndLine: number;
	/** Canonical tree-sitter language name of the pre-image. */
	language: string;
}

/**
 * Whether `code` parses as the language inferred from `path`.
 *
 * A parse that cannot run at all counts as *not* parsing. Every caller uses this
 * to decide whether to adopt content, and an unverifiable file must never be
 * adopted — the alternative is writing a file we never proved parses.
 */
function parsesSource(code: string, path: string): boolean {
	try {
		return summarizeCode({ code: code.length === 0 ? "\n" : code, path }).parsed;
	} catch {
		return false;
	}
}

/** Canonical language of `code`, falling back to the generic name when the parse cannot run. */
function languageOf(code: string, path: string): string {
	try {
		return summarizeCode({ code: code.length === 0 ? "\n" : code, path }).language;
	} catch {
		return "source";
	}
}

/**
 * Line-level diff of pre-image → post-image, as hunks plus both line arrays.
 *
 * An adjacent removed/added run pair is one replace hunk, not two: reverting it
 * is a single operation, and the isolation below counts hunks as operations.
 */
function buildHunks(prev: string, next: string): { hunks: EditHunk[]; a: string[]; b: string[] } {
	const runs = Diff.diffLines(prev, next);
	const a = prev.split("\n");
	const b = next.split("\n");
	const hunks: EditHunk[] = [];
	let ai = 0;
	let bi = 0;
	for (const run of runs) {
		const count = run.count ?? 0;
		if (count === 0) continue;
		if (!run.added && !run.removed) {
			ai += count;
			bi += count;
			continue;
		}
		const del = run.removed ? count : 0;
		const add = run.added ? count : 0;
		const last = hunks.at(-1);
		if (last && last.aEnd === ai && last.bEnd === bi) {
			last.aEnd += del;
			last.bEnd += add;
		} else {
			hunks.push({ aStart: ai, aEnd: ai + del, bStart: bi, bEnd: bi + add });
		}
		ai += del;
		bi += add;
	}
	return { hunks, a, b };
}

/** Post-image with the given hunks reverted to their pre-image lines. */
function revertHunks(a: string[], b: string[], hunks: EditHunk[], set: readonly number[]): string {
	const sorted = [...set].sort((x, y) => x - y);
	const out: string[] = [];
	let bi = 0;
	for (const i of sorted) {
		const h = hunks[i];
		out.push(...b.slice(bi, h.bStart), ...a.slice(h.aStart, h.aEnd));
		bi = h.bEnd;
	}
	out.push(...b.slice(bi));
	return out.join("\n");
}

/**
 * Smallest hunk set whose reversion restores the parse: singles, then pairs
 * (bounded), then a greedy peel that drops hunks one at a time while the file
 * keeps parsing.
 *
 * `undefined` means no such set was found — including the case where the
 * pre-image itself does not parse, which is the caller's cue to fall back to
 * the plain parse warning rather than hand the model a region it cannot fix.
 */
function isolateCulpritHunks(path: string, a: string[], b: string[], hunks: EditHunk[]): number[] | undefined {
	const n = hunks.length;
	if (n === 0) return undefined;
	for (let i = 0; i < n; i++) {
		if (parsesSource(revertHunks(a, b, hunks, [i]), path)) return [i];
	}
	if (n <= MAX_PAIR_SEARCH_HUNKS) {
		for (let i = 0; i < n; i++) {
			for (let j = i + 1; j < n; j++) {
				if (parsesSource(revertHunks(a, b, hunks, [i, j]), path)) return [i, j];
			}
		}
	}
	const keep = new Set<number>(Array.from({ length: n }, (_, i) => i));
	for (let i = 0; i < n; i++) {
		const trial = new Set(keep);
		trial.delete(i);
		if (parsesSource(revertHunks(a, b, hunks, [...trial]), path)) keep.delete(i);
	}
	// Reverting every remaining hunk must parse (the full revert is the
	// pre-image); an empty set would mean the pre-image itself is broken.
	if (keep.size === 0 || !parsesSource(revertHunks(a, b, hunks, [...keep]), path)) return undefined;
	return [...keep];
}

export interface RepairRegionOptions {
	/** Path used to select the tree-sitter language and to re-parse during isolation. */
	path: string;
	/** File content before the edit. */
	prev: string;
	/** File content after the edit — the content that no longer parses. */
	next: string;
	/** Largest region worth sending to a small model; regions above it are not repaired. */
	maxRegionLines: number;
}

/**
 * Localize the parse breakage introduced by `prev → next`.
 *
 * Returns `undefined` when the breakage cannot be isolated under
 * `maxRegionLines` — the caller then surfaces the plain parse warning instead of
 * asking a model to fix a region it was never shown the boundaries of.
 */
export function computeRepairRegion(options: RepairRegionOptions): RepairRegion | undefined {
	const { path, prev, next, maxRegionLines } = options;
	const { hunks, a, b } = buildHunks(prev, next);
	const culprits = isolateCulpritHunks(path, a, b, hunks);
	if (!culprits) return undefined;

	const culpritHunks = culprits.map(i => hunks[i]).sort((x, y) => x.bStart - y.bStart);
	const first = culpritHunks[0];
	const last = culpritHunks[culpritHunks.length - 1];
	const regionStart = Math.max(0, first.bStart - REPAIR_CONTEXT_LINES);
	const regionEnd = Math.min(b.length, last.bEnd + REPAIR_CONTEXT_LINES);
	if (regionEnd - regionStart > Math.max(1, maxRegionLines)) return undefined;

	// The editable span is the smallest contiguous run of post-image lines
	// covering every culprit. Lines between two culprits belong to it because the
	// model's reply arrives as one block — there is no way to scatter it back
	// across disjoint holes without guessing.
	const editStart = first.bStart;
	const editEnd = last.bEnd;

	// The reference keeps every non-culprit line exactly as it is on disk, so the
	// only difference the model sees between BEFORE and AFTER is the breakage.
	const revertedSpan: string[] = [];
	let bi = editStart;
	for (const h of culpritHunks) {
		revertedSpan.push(...b.slice(bi, h.bStart), ...a.slice(h.aStart, h.aEnd));
		bi = h.bEnd;
	}
	revertedSpan.push(...b.slice(bi, editEnd));

	const referenceSpan = [...b.slice(regionStart, editStart), ...revertedSpan, ...b.slice(editEnd, regionEnd)];

	return {
		editStart,
		editEnd,
		brokenText: b.slice(regionStart, regionEnd).join("\n"),
		referenceText: referenceSpan.join("\n"),
		revertedText: revertedSpan.join("\n"),
		editStartLine: editStart + 1,
		editEndLine: editEnd,
		language: languageOf(prev, path),
	};
}

/** Replace the editable span of the post-image with `text`. */
function spliceRegion(b: string[], region: RepairRegion, text: string): string {
	return [...b.slice(0, region.editStart), ...text.split("\n"), ...b.slice(region.editEnd)].join("\n");
}

/**
 * Re-indent a candidate by trimmed-line alignment against source lines:
 * candidate lines that match a source line modulo whitespace inherit the source
 * line verbatim, recovering indentation small models routinely drop from lines
 * they echo back.
 */
function realignToSource(srcLines: string[], candidate: string): string {
	const out = candidate.split("\n");
	const runs = Diff.diffLines(srcLines.map(line => line.trim()).join("\n"), out.map(line => line.trim()).join("\n"));
	const merged: string[] = [];
	let si = 0;
	let oi = 0;
	for (const run of runs) {
		const count = run.count ?? 0;
		if (count === 0) continue;
		if (!run.added && !run.removed) {
			for (let k = 0; k < count; k++) merged.push(srcLines[si + k] ?? "");
			si += count;
			oi += count;
		} else if (run.removed) {
			si += count;
		} else {
			for (let k = 0; k < count; k++) merged.push(out[oi + k] ?? "");
			oi += count;
		}
	}
	return merged.join("\n");
}

/** Strip one wrapping markdown code fence, if present. */
function stripCodeFence(text: string): string {
	const fenced = text.trim().match(/^```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)\n?```$/);
	return trimBlankLines(fenced ? fenced[1] : text);
}

/**
 * Drop the blank lines a model pads its reply with, leaving every other byte —
 * including the first code line's indentation — alone. Trimming the whole reply
 * would silently unindent the region's first line, which is exactly the damage
 * {@link realignToSource} exists to repair.
 */
function trimBlankLines(text: string): string {
	const lines = text.split("\n");
	while (lines.length > 0 && lines[0].trim() === "") lines.shift();
	while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
	return lines.join("\n");
}

/** Whitespace-insensitive form used to detect a candidate that only restores the pre-image. */
function normalizeForRevertCheck(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** Normalize whitespace so whitespace-only differences become invisible. */
function normalizeWhitespace(text: string): string {
	return normalizeToLF(text)
		.split("\n")
		.map(line => line.replace(/[ \t]+/g, " ").trim())
		.filter(line => line.length > 0)
		.join("\n");
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
	const candidateLines = normalizeWhitespace(candidate)
		.split("\n")
		.filter(line => line.length > 0);
	return netAddedLines.some(line => candidateLines.some(candidateLine => keptLine(line, candidateLine)));
}

function extractResponseText(response: Awaited<ReturnType<typeof completeSimple>>): string {
	return response.content
		.filter(content => content.type === "text")
		.map(content => content.text)
		.join("");
}

function resolveRepairModel(session: ToolSession): Model | undefined {
	const availableModels = session.modelRegistry?.getAvailable() ?? session.getAvailableModels?.() ?? [];
	if (availableModels.length === 0) return undefined;
	const role = session.settings.get("edit.autoRepair.modelRole");
	const roleValue = session.settings.getModelRole(role);
	const resolved = resolveModelRoleValue(roleValue, availableModels, {
		settings: session.settings,
		matchPreferences: { usageOrder: session.settings.getStorage()?.getModelUsageOrder() },
		modelRegistry: session.modelRegistry,
	});
	return resolved.model;
}

/**
 * One completion from the repair model. `previousAttempt` is the rejected
 * candidate of the prior attempt, or `undefined` on the first shot.
 */
async function callRepairModel(
	session: ToolSession,
	model: Model,
	args: RepairRegion & { path: string; parseDetail: string; previousAttempt: string | undefined },
	complete: typeof completeSimple,
	signal?: AbortSignal,
): Promise<string | undefined> {
	const registry = session.modelRegistry;
	if (!registry) return undefined;
	const apiKey = await registry.getApiKey(model, session.getSessionId?.() ?? undefined);
	if (!apiKey) return undefined;

	const built = prompt.render(repairPromptTemplate, {
		lang: args.language,
		path: args.path,
		parse_error: args.parseDetail,
		before: args.referenceText,
		after: args.brokenText,
		replace_start: args.editStartLine,
		replace_end: args.editEndLine,
		replace_count: args.editEnd - args.editStart,
		previousAttempt: args.previousAttempt,
	});

	try {
		const response = await complete(
			model,
			{ messages: [{ role: "user", content: built, timestamp: Date.now() }] },
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
		return stripCodeFence(extractResponseText(response));
	} catch (err) {
		logger.debug("edit-auto-repair: model call threw", {
			model: `${model.provider}/${model.id}`,
			error: err instanceof Error ? err.message : String(err),
		});
		return undefined;
	}
}

/** A parse failure of an edited file, as the repair path needs to see it. */
export interface RepairRequest {
	/** Absolute path of the file on disk. */
	absolutePath: string;
	/** Display path used in the adoption note and the prompt. */
	displayPath: string;
	/** File content before the edit — the parseable pre-image. */
	previousContent: string;
	/** File content after the edit, which no longer parses. */
	brokenContent: string;
	/** Canonical tree-sitter language of the file. */
	language: string;
	/** Human-readable description of what failed to parse. */
	parseDetail: string;
	/** 1-based line of the first error/missing node, when known. */
	badLine: number | undefined;
}

/** What auto-repair did, if anything. */
export interface AutoRepairOutcome {
	/** True when a verified-parseable, non-undo candidate was written to disk. */
	adopted: boolean;
	/** Tool-result note describing the adoption. */
	note?: string;
}

/**
 * Attempt to repair a committed edit that broke the parse, with the model
 * assigned to `edit.autoRepair.modelRole`. Reports adoption only when the
 * candidate makes the whole file parse again and none of the guardrails reject
 * it: a candidate that restores the pre-image would silently discard the edit,
 * and one that drops every line the edit inserted is a non-verbatim undo.
 *
 * Returns `{ adopted: false }` whenever repair is unavailable or unsafe; the
 * caller then rolls the edit back.
 */
export async function attemptAutoRepair(
	session: ToolSession,
	request: RepairRequest,
	complete: typeof completeSimple,
	signal?: AbortSignal,
): Promise<AutoRepairOutcome> {
	if (!session.settings.get("edit.autoRepair.enabled")) return { adopted: false };

	const maxAttempts = Math.max(0, session.settings.get("edit.autoRepair.maxAttempts"));
	if (maxAttempts === 0) return { adopted: false };

	const region = computeRepairRegion({
		path: request.absolutePath,
		prev: request.previousContent,
		next: request.brokenContent,
		maxRegionLines: session.settings.get("edit.autoRepair.maxRegionLines"),
	});
	if (!region) return { adopted: false };

	const model = resolveRepairModel(session);
	if (!model) return { adopted: false };

	const b = request.brokenContent.split("\n");
	const normalizedRevert = normalizeForRevertCheck(region.revertedText);
	const normalizedOriginal = normalizeWhitespace(request.previousContent);
	const netAddedLines = computeNetAddedLines(request.previousContent, request.brokenContent);
	const brokenSpan = b.slice(region.editStart, region.editEnd);

	let previousAttempt: string | undefined;
	for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
		const corrected = await callRepairModel(
			session,
			model,
			{ ...region, path: request.displayPath, parseDetail: request.parseDetail, previousAttempt },
			complete,
			signal,
		);
		if (corrected === undefined) break;
		previousAttempt = corrected;

		// Realigned variants first: where the candidate echoes a line that is
		// already in the file modulo whitespace, the realigned form restores the
		// original bytes, so it preserves indentation the model dropped.
		const variants = new Set([realignToSource(brokenSpan, corrected), corrected]);
		for (const text of variants) {
			// Splicing a candidate equal to the reverted span discards the edit
			// outright — worse than surfacing the parse warning.
			if (normalizeForRevertCheck(text) === normalizedRevert) continue;
			// Ditto for a non-verbatim undo that dropped every inserted line.
			if (!candidateKeepsAnyAddedLine(netAddedLines, text)) continue;
			const candidate = spliceRegion(b, region, text);
			if (candidate === request.previousContent || normalizeWhitespace(candidate) === normalizedOriginal) {
				continue;
			}
			if (!parsesSource(candidate, request.absolutePath)) continue;
			await Bun.write(request.absolutePath, candidate);
			const lineNote = request.badLine !== undefined ? ` near line ${request.badLine}` : "";
			return {
				adopted: true,
				note: `${request.displayPath}: auto-repair adopted a parseable fix${lineNote}; the edit was kept.`,
			};
		}

		if (signal?.aborted) return { adopted: false };
	}

	return { adopted: false };
}
