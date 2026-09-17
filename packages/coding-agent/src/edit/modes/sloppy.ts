/**
 * Sloppy edit mode — a raw text replacement payload.
 *
 * The model writes one or more `<SM:EDIT>` blocks; each block names a file and
 * carries one or more ordered `<SM:FIND>`/`<SM:PUT>` pairs:
 *
 *   <SM:EDIT path="src/foo.ts">
 *   <SM:FIND>
 *   text to find
 *   </SM:FIND>
 *   <SM:PUT>
 *   replacement text
 *   </SM:PUT>
 *   </SM:EDIT>
 *
 * This mode exists for models that cannot hold an anchor-based (hashline) or
 * patch-based payload reliably: it is the plain "here is the old text, here is
 * the new text" fallback. The same payload shape is also recovered when a
 * model emits it as assistant *text* instead of calling `edit` — see
 * `extractInlineSloppyRegions` (here) and `recoverInlineSloppyEdit`
 * (`../inline-recovery`).
 *
 * Pairs are applied through the replace engine (`executeReplaceSingle`), so
 * plan-mode guards, notebook refusal, fuzzy matching, the LSP writethrough and
 * post-write validation/auto-repair all behave exactly as they do in `replace`
 * mode.
 */

import type { AgentToolResult } from "@cornfield/agent";
import { type Static, Type } from "@sinclair/typebox";
import type { WritethroughCallback, WritethroughDeferredHandle } from "../../lsp";
import type { ToolSession } from "../../tools";
import type { EditToolDetails, EditToolPerFileResult, LspBatchRequest } from "../renderer";
import { executeReplaceSingle } from "./replace";

export const sloppyEditSchema = Type.Object(
	{
		input: Type.String({
			description: 'One or more <SM:EDIT path="…">blocks carrying <SM:FIND>/<SM:PUT> replacements',
		}),
	},
	{ additionalProperties: false },
);

export type SloppyParams = Static<typeof sloppyEditSchema>;

/** One find/replace pair from a `<SM:EDIT>` block, in payload order. */
export interface SloppyPayloadPair {
	old_text: string;
	new_text: string;
}

/** One `<SM:EDIT>` block: a file and its ordered find/replace pairs. */
export interface SloppyPayloadBlock {
	path: string;
	pairs: SloppyPayloadPair[];
}

/** A complete `<SM:EDIT>…</SM:EDIT>` region found in free-form text. */
export interface SloppyPayloadRegion {
	/** Offset of the opening `<SM:EDIT>` tag. */
	start: number;
	/** Offset just past the closing `</SM:EDIT>` tag. */
	end: number;
	/** The full region text, opening tag included — a valid `sloppy` payload on its own. */
	payload: string;
}

const SLOPPY_FORMAT_HINT =
	'Expected shape: <SM:EDIT path="file.ts">, then one or more <SM:FIND>text to find</SM:FIND><SM:PUT>replacement</SM:PUT> pairs, then </SM:EDIT>.';

/** Tag names are matched case-insensitively; `path` is the only accepted attribute. */
const SLOPPY_TAG_SOURCE = "<(\\/?)SM:(EDIT|FIND|PUT)\\b([^>]*)>";
const SLOPPY_OPEN_EDIT_SOURCE = "<SM:EDIT\\b[^>]*>";
const SLOPPY_CLOSE_EDIT_SOURCE = "<\\/SM:EDIT\\s*>";
const SLOPPY_PATH_ATTR_RE = /(?:^|\s)path\s*=\s*(?:"([^"]*)"|'([^']*)')/i;

function sloppyTagRe(): RegExp {
	return new RegExp(SLOPPY_TAG_SOURCE, "gi");
}

function fail(detail: string): never {
	throw new Error(`Invalid sloppy edit payload: ${detail}. ${SLOPPY_FORMAT_HINT}`);
}

/**
 * Drop the single newline that follows an opening tag and the single newline
 * that precedes a closing tag, so
 *
 *   <SM:FIND>\nfoo\n</SM:FIND>
 *
 * yields `foo` rather than `\nfoo\n`. Any further leading/trailing blank lines
 * in the body are content and are preserved.
 */
function stripBodyNewlines(body: string): string {
	let out = body;
	if (out.startsWith("\n")) out = out.slice(1);
	if (out.endsWith("\n")) out = out.slice(0, -1);
	return out;
}

function parseEditOpenTag(attrs: string): string {
	const match = SLOPPY_PATH_ATTR_RE.exec(attrs);
	if (!match) {
		fail('<SM:EDIT> is missing its path attribute, as in <SM:EDIT path="src/foo.ts">');
	}
	const path = (match[1] ?? match[2] ?? "").trim();
	if (path.length === 0) {
		fail("<SM:EDIT> has an empty path attribute");
	}
	const leftover = `${attrs.slice(0, match.index)}${attrs.slice(match.index + match[0].length)}`;
	if (leftover.trim().length > 0) {
		fail(`<SM:EDIT> carries unsupported attribute(s): ${leftover.trim()}`);
	}
	return path;
}

/**
 * Parse a `sloppy` payload into blocks in document order.
 *
 * Throws on anything malformed — a missing `path`, an unclosed tag, an
 * unexpected tag or stray content inside a block. Text outside `<SM:EDIT>`
 * blocks (prose a model wrapped around the payload) is ignored.
 */
export function parseSloppyPayload(input: string): SloppyPayloadBlock[] {
	const text = input.replaceAll("\r\n", "\n");
	const tagRe = sloppyTagRe();
	const blocks: SloppyPayloadBlock[] = [];

	type Phase = "outside" | "inBlock" | "inFind" | "afterFind" | "inPut";
	let phase: Phase = "outside";
	let cursor = 0;
	let block: SloppyPayloadBlock | undefined;
	let blockNumber = 0;
	let findBody = "";

	for (let match = tagRe.exec(text); match !== null; match = tagRe.exec(text)) {
		const closing = match[1] === "/";
		const name = match[2]!.toUpperCase();
		const attrs = match[3] ?? "";
		const tag = `<${closing ? "/" : ""}SM:${name}${attrs}>`;
		const afterTag = match.index + match[0].length;

		switch (phase) {
			case "outside": {
				if (closing) fail(`stray ${tag} outside an <SM:EDIT> block`);
				if (name !== "EDIT") fail(`${tag} appears outside an <SM:EDIT> block`);
				block = { path: parseEditOpenTag(attrs), pairs: [] };
				blocks.push(block);
				blockNumber++;
				phase = "inBlock";
				cursor = afterTag;
				break;
			}
			case "inBlock": {
				const between = text.slice(cursor, match.index);
				if (between.trim().length > 0) {
					fail(`unexpected text inside <SM:EDIT path="${block!.path}">: ${preview(between)}`);
				}
				if (closing && name === "EDIT") {
					if (block!.pairs.length === 0) {
						fail(`<SM:EDIT path="${block!.path}"> carries no <SM:FIND>/<SM:PUT> pair`);
					}
					block = undefined;
					phase = "outside";
					cursor = afterTag;
					break;
				}
				if (!closing && name === "FIND") {
					phase = "inFind";
					cursor = afterTag;
					break;
				}
				fail(`unexpected ${tag} inside <SM:EDIT path="${block!.path}">; expected <SM:FIND> or </SM:EDIT>`);
				break;
			}
			case "inFind": {
				if (closing && name === "FIND") {
					findBody = text.slice(cursor, match.index);
					phase = "afterFind";
					cursor = afterTag;
					break;
				}
				fail(
					`unexpected ${tag} inside the <SM:FIND> of block ${blockNumber}; the find body must not contain edit tags`,
				);
				break;
			}
			case "afterFind": {
				const between = text.slice(cursor, match.index);
				if (between.trim().length > 0) {
					fail(`unexpected text between </SM:FIND> and its <SM:PUT>: ${preview(between)}`);
				}
				if (!closing && name === "PUT") {
					phase = "inPut";
					cursor = afterTag;
					break;
				}
				fail(`${tag} is not a valid follow-up to </SM:FIND>; every find needs a <SM:PUT>`);
				break;
			}
			case "inPut": {
				if (closing && name === "PUT") {
					const oldText = stripBodyNewlines(findBody);
					if (oldText.length === 0) {
						fail(`<SM:FIND> in block ${blockNumber} is empty; it must contain the text to find`);
					}
					block!.pairs.push({ old_text: oldText, new_text: stripBodyNewlines(text.slice(cursor, match.index)) });
					phase = "inBlock";
					cursor = afterTag;
					break;
				}
				fail(
					`unexpected ${tag} inside the <SM:PUT> of block ${blockNumber}; the replacement must not contain edit tags`,
				);
				break;
			}
		}
	}

	if (phase === "outside" && blocks.length === 0) {
		fail("no <SM:EDIT> block found");
	}
	if (phase === "inBlock") fail(`<SM:EDIT path="${block!.path}"> is missing its closing </SM:EDIT>`);
	if (phase === "inFind") fail(`<SM:FIND> in block ${blockNumber} is missing its closing </SM:FIND>`);
	if (phase === "afterFind") fail(`<SM:FIND> in block ${blockNumber} is missing its <SM:PUT>`);
	if (phase === "inPut") fail(`<SM:PUT> in block ${blockNumber} is missing its closing </SM:PUT>`);

	return blocks;
}

function preview(text: string): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	return collapsed.length > 60 ? `${collapsed.slice(0, 60)}…` : collapsed;
}

/**
 * Extract every complete `<SM:EDIT>…</SM:EDIT>` region from free-form text, in
 * document order. Used to recover a payload a model emitted as assistant text.
 *
 * Only complete regions are returned: a payload that is still streaming (or
 * was truncated) has no closing tag, and half an edit must never be
 * materialized. Scanning stops at the first unclosed opening tag, since any
 * later tag sits inside that unfinished block.
 */
export function extractInlineSloppyRegions(text: string): SloppyPayloadRegion[] {
	const regions: SloppyPayloadRegion[] = [];
	const openRe = new RegExp(SLOPPY_OPEN_EDIT_SOURCE, "gi");
	const closeRe = new RegExp(SLOPPY_CLOSE_EDIT_SOURCE, "gi");

	for (let open = openRe.exec(text); open !== null; open = openRe.exec(text)) {
		closeRe.lastIndex = open.index + open[0].length;
		const close = closeRe.exec(text);
		if (!close) break;
		const end = close.index + close[0].length;
		regions.push({ start: open.index, end, payload: text.slice(open.index, end) });
		openRe.lastIndex = end;
	}

	return regions;
}

export interface ExecuteSloppySingleOptions {
	session: ToolSession;
	input: string;
	signal?: AbortSignal;
	batchRequest?: LspBatchRequest;
	allowFuzzy: boolean;
	fuzzyThreshold: number;
	writethrough: WritethroughCallback;
	beginDeferredDiagnosticsForPath: (path: string) => WritethroughDeferredHandle;
}

/**
 * Apply a `sloppy` payload.
 *
 * Pairs run strictly in payload order — a pair sees the file as left by the
 * previous one, so several pairs may target the same file. A single pair
 * behaves exactly like `replace` mode (errors propagate); with several pairs,
 * a failing pair is reported in the result and the remaining ones still run,
 * matching the multi-entry behaviour of `replace`/`patch`.
 */
export async function executeSloppySingle(
	options: ExecuteSloppySingleOptions,
): Promise<AgentToolResult<EditToolDetails, typeof sloppyEditSchema>> {
	const blocks = parseSloppyPayload(options.input);
	const ops = blocks.flatMap(block => block.pairs.map(pair => ({ path: block.path, pair })));

	const runOp = (
		op: (typeof ops)[number],
		batchRequest: LspBatchRequest | undefined,
	): Promise<AgentToolResult<EditToolDetails, typeof sloppyEditSchema>> =>
		executeReplaceSingle({
			session: options.session,
			path: op.path,
			params: op.pair,
			signal: options.signal,
			batchRequest,
			allowFuzzy: options.allowFuzzy,
			fuzzyThreshold: options.fuzzyThreshold,
			writethrough: options.writethrough,
			beginDeferredDiagnosticsForPath: options.beginDeferredDiagnosticsForPath,
		}) as Promise<AgentToolResult<EditToolDetails, typeof sloppyEditSchema>>;

	// The LSP batch is flushed by the write that puts the last pair on disk;
	// earlier writes keep the batch open so diagnostics arrive once.
	const batchFor = (index: number): LspBatchRequest | undefined =>
		options.batchRequest
			? { id: options.batchRequest.id, flush: index === ops.length - 1 && options.batchRequest.flush }
			: undefined;

	if (ops.length === 1) {
		return runOp(ops[0]!, batchFor(0));
	}

	// Several pairs: a payload spanning more than one file reports per-file
	// results (the TUI renders one block per file); a payload confined to one
	// file reports a single combined diff, like `replace` with a multi-entry
	// `edits` array.
	const perPath = new Map<string, EditToolPerFileResult>();
	const multiFile = new Set(ops.map(op => op.path)).size > 1;
	const contentTexts: string[] = [];

	for (let i = 0; i < ops.length; i++) {
		const { path } = ops[i]!;
		try {
			const result = await runOp(ops[i]!, batchFor(i));
			const details = result.details;
			const text = result.content?.find(c => c.type === "text")?.text ?? "";
			if (text) contentTexts.push(text);

			const existing = perPath.get(path);
			const entry: EditToolPerFileResult = existing ?? { path, diff: "" };
			if (details?.diff) entry.diff = entry.diff ? `${entry.diff}\n${details.diff}` : details.diff;
			entry.firstChangedLine ??= details?.firstChangedLine;
			entry.diagnostics = details?.diagnostics ?? entry.diagnostics;
			entry.meta = details?.meta ?? entry.meta;
			if (!existing) perPath.set(path, entry);
		} catch (err) {
			const errorText = err instanceof Error ? err.message : String(err);
			contentTexts.push(`Error editing ${path}: ${errorText}`);
			const existing = perPath.get(path);
			const entry: EditToolPerFileResult = existing ?? { path, diff: "" };
			entry.isError = true;
			entry.errorText = entry.errorText ? `${entry.errorText}\n${errorText}` : errorText;
			if (!existing) perPath.set(path, entry);
		}
	}

	const results = [...perPath.values()];
	return {
		content: [{ type: "text", text: contentTexts.join("\n") }],
		details: {
			diff: results
				.map(r => r.diff)
				.filter(Boolean)
				.join("\n"),
			firstChangedLine: results.find(r => r.firstChangedLine)?.firstChangedLine,
			...(multiFile ? { perFileResults: results } : {}),
		},
	};
}
