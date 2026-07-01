// Reasoning-tag handling shared by the OpenAI-completions streaming parser and
// the TUI renderer's defensive strip.
//
// Background:
//   Anthropic-format and MiniMax/MiniMax chat completions providers stream the
//   model's chain-of-thought inline as `<think>...</think>` (or namespaced
//   variants like `antml:think` / `mm:think`) inside the regular `content`
//   field, rather than as a separate `thinking` block. The streaming parser in
//   `openai-completions.ts` partitions these out into a `ThinkingContent`
//   block. When that partition fails — for an unrecognised namespace, a bug,
//   or because the tag literal appeared inside a code block — the thinking
//   content leaks into the visible `TextContent` block.
//
//   This module is the safety net. It exposes:
//     * The full tag set (`REASONING_OPEN_TAGS` / `REASONING_CLOSE_TAGS`),
//       so the streaming parser and the renderer agree on what counts as a
//       reasoning tag.
//     * `findFirstTag` / `getTrailingPartialTag`, the two helpers the parser
//       uses to scan a streaming buffer with arbitrary chunk boundaries.
//     * `stripReasoningTagsFromText`, a code-region-aware post-process that
//       removes any reasoning block the parser missed.
//
//   Code-region awareness: tags that appear inside a fenced code block
//   (`` ``` ... ``` `` or `~~~ ... ~~~`) are left alone, so the renderer
//   can safely apply this as a final pass without breaking legitimate
//   mentions of `<think>` inside user examples.

const REASONING_TAG_NAMES = ["think", "thinking", "thought", "reasoning", "antthinking"] as const;
const REASONING_TAG_NAMESPACES = ["", "antml:", "mm:"] as const;
// Tag literals include the trailing `>`. The parser consumes the full tag
// atom — leaving the `>` in the buffer would leak it into adjacent
// text/thinking content (visible as a stray Markdown blockquote character).
// The trailing-partial logic in `getTrailingPartialTag` automatically holds
// back any short prefix of these literals while waiting for the next chunk.
const REASONING_OPEN_TAGS: readonly string[] = REASONING_TAG_NAMESPACES.flatMap(ns =>
	REASONING_TAG_NAMES.map(n => `<${ns}${n}>`),
);
const REASONING_CLOSE_TAGS: readonly string[] = REASONING_TAG_NAMESPACES.flatMap(ns =>
	REASONING_TAG_NAMES.map(n => `</${ns}${n}>`),
);

/**
 * Locate the earliest occurrence of any of `tags` in `text`. Returns the byte
 * index and the matching tag, or `undefined` if no tag is present.
 */
function findFirstTag(text: string, tags: readonly string[]): { index: number; tag: string } | undefined {
	let earliestIndex = Number.POSITIVE_INFINITY;
	let earliestTag: string | undefined;
	for (const tag of tags) {
		const index = text.indexOf(tag);
		if (index !== -1 && index < earliestIndex) {
			earliestIndex = index;
			earliestTag = tag;
		}
	}
	if (!earliestTag) return undefined;
	return { index: earliestIndex, tag: earliestTag };
}

/**
 * Return the trailing slice of `text` that could still grow into one of `tags`
 * when more characters arrive. Used by the streaming parser to hold back
 * partial matches until the next chunk disambiguates them.
 */
function getTrailingPartialTag(text: string, tags: readonly string[]): string {
	let maxLength = 0;
	for (const tag of tags) {
		const maxCandidateLength = Math.min(tag.length - 1, text.length);
		for (let length = maxCandidateLength; length > 0; length--) {
			if (text.endsWith(tag.slice(0, length))) {
				if (length > maxLength) maxLength = length;
				break;
			}
		}
	}
	if (maxLength === 0) return "";
	return text.slice(-maxLength);
}

const FENCE_REGEX = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;
const OPEN_TAG_REGEX_SOURCE = REASONING_OPEN_TAGS.map(escapeRegExp).join("|");
const CLOSE_TAG_REGEX_SOURCE = REASONING_CLOSE_TAGS.map(escapeRegExp).join("|");
const REASONING_BLOCK_REGEX = new RegExp(`(?:${OPEN_TAG_REGEX_SOURCE})[\\s\\S]*?(?:${CLOSE_TAG_REGEX_SOURCE})`, "g");

/**
 * Remove inline reasoning blocks (`<think>...</think>`, `antml:think...`,
 * `mm:think...`, etc.) from `text`. Fenced code regions are preserved
 * verbatim so that model output like ``Use `<think>` to mark...`` is not
 * corrupted.
 *
 * Intended as a defensive final pass applied at the render boundary. The
 * primary mechanism for hiding thinking remains the streaming parser in
 * `openai-completions.ts`; this only catches leaks.
 */
function stripReasoningTagsFromText(text: string): string {
	if (!text) return text;
	// Split the text into fenced and non-fenced segments, strip reasoning
	// blocks only from non-fenced segments, then rejoin. Fenced segments
	// include the surrounding fences, so concatenation is lossless.
	const parts: string[] = [];
	let cursor = 0;
	for (const match of text.matchAll(FENCE_REGEX)) {
		const start = match.index ?? 0;
		if (start > cursor) {
			parts.push(text.slice(cursor, start).replace(REASONING_BLOCK_REGEX, ""));
		}
		parts.push(match[0]);
		cursor = start + match[0].length;
	}
	if (cursor < text.length) {
		parts.push(text.slice(cursor).replace(REASONING_BLOCK_REGEX, ""));
	}
	return parts.join("");
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Decide whether the streaming parser should scan a model's `content` deltas
 * for inline reasoning tags (`<think>...</think>`, `antml:think`, `mm:think`).
 *
 * Why a gate at all? Naive string matching in the parser can eat a `<think>`
 * literal that the model wrote inside a code example. The renderer's
 * `stripReasoningTagsFromText` is code-region aware, but the streaming parser
 * is not — so we narrow the gate to models known to emit these tags, accepting
 * that unknown models fall through to the renderer's defensive strip.
 *
 * Match by:
 *   1. Provider allowlist (explicit, low false-positive risk).
 *   2. Model id pattern (catches third-party gateways that re-host a reasoning
 *      model under a different provider name — the original bug for
 *      `narwal-plan/minimax-m3`).
 *
 * The DeepSeek pattern is broad on purpose: every DeepSeek variant exposed
 * through OpenAI-compat hosts (r1, v3, v3.1, v3.2, v4, plus dot- and
 * dash-style revisions like `deepseek-v3-0324`) emits the same `<think>` tag.
 */
const REASONING_TAG_PROVIDERS: ReadonlySet<string> = new Set(["minimax-code", "narwal-plan"]);
const REASONING_TAG_ID_PATTERNS: readonly RegExp[] = [
	/^(?:minimax|antml|mm|minimaxai)[-/]/i,
	/^MiniMax[-/]/,
	/-thinking$/i,
	// DeepSeek reasoning models: r1, v3 (including dash revisions like
	// `deepseek-v3-0324`), v3.1, v3.2, v4. The pattern is intentionally not
	// just `^deepseek-` because NVIDIA NIM hosts DeepSeek under a longer
	// `deepseek-ai/...` id and runs the chat-template special-token
	// stripper instead — not the reasoning-tag parser.
	/^deepseek-(?:r1|v3|v3\.1|v3\.2|v4)/i,
];
function shouldParseReasoningTags(model: { provider: string; id: string }): boolean {
	if (REASONING_TAG_PROVIDERS.has(model.provider)) return true;
	return REASONING_TAG_ID_PATTERNS.some(pattern => pattern.test(model.id));
}

export {
	findFirstTag,
	getTrailingPartialTag,
	REASONING_CLOSE_TAGS,
	REASONING_OPEN_TAGS,
	REASONING_TAG_NAMES,
	REASONING_TAG_NAMESPACES,
	shouldParseReasoningTags,
	stripReasoningTagsFromText,
};
