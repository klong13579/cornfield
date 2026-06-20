/**
 * Filename-safe slug generator.
 *
 * Used to turn human-readable names (including CJK) into a filesystem-safe
 * kebab-case slug suitable for filenames and directory names. The original
 * name is always preserved alongside the slug (in DB columns, JSONL headers,
 * task names) — the slug is purely a presentation hint.
 *
 * Behaviour:
 *   1. Empty / null / undefined → `fallback` (default "session")
 *   2. NFKD normalize → ASCII (handles `é → e`, `ñ → n`, etc.)
 *   3. If still contains CJK or other non-ASCII ranges, run pinyin-pro
 *   4. Lowercase, replace non-[a-z0-9-] with `-`, collapse runs, trim
 *   5. If still > maxLen, append `-<6 char hash of original>` and re-cap
 *   6. Strip leading/trailing `-` once more
 *
 * Pinyin-pro is loaded lazily inside the function (dynamic import) so
 * callers that only use ASCII names pay zero startup cost.
 *
 * Examples:
 *   slugify("Hello World")           → "hello-world"
 *   slugify("01-算法模块")          → "01-suan-fa-mo-kuai"
 *   slugify("omp-atomix:wiki")       → "omp-atomix-wiki"
 *   slugify("")                      → "session"
 *   slugify("a".repeat(50), {maxLen: 32}) → "aaaa-...-<hash>"
 */
import { createHash } from "node:crypto";

export interface SlugOptions {
	/** Maximum slug length in characters. Default 32. */
	maxLen?: number;
	/** Append a 6-char hash suffix when truncating. Default true. */
	hashOnTruncate?: boolean;
	/** Fallback when input is empty/null. Default "session". */
	fallback?: string;
}

/** Matches a Unicode "Mark" category char (combining diacritics, etc.). */
const COMBINING_MARK_RE = /\p{M}/gu;

/** Matches a run of CJK Unified Ideographs and common extensions. */
const CJK_RUN_RE = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g;

/** Matches any non-ASCII character not in safe ranges. */
const NON_ASCII_RE = /[^\x00-\x7f]/;

/** Matches a run of characters that aren't safe for filenames. */
const UNSAFE_RE = /[^a-z0-9-]+/g;

/** Matches leading/trailing hyphens. */
const TRIM_HYPHEN_RE = /^-+|-+$/g;

/** Matches a run of one or more hyphens (for collapsing). */
const DASH_RUN_RE = /-+/g;

/**
 * Replace CJK runs with their pinyin, joined by `-`. ASCII runs (including
 * digits, dashes, slashes) are preserved verbatim. Non-CJK non-ASCII (e.g.
 * accented Latin like `é`) is left for NFKD to handle.
 */
async function toAscii(input: string): Promise<string> {
	const cjkRuns = input.match(CJK_RUN_RE);
	if (!cjkRuns || cjkRuns.length === 0) return input;

	const { pinyin } = await import("pinyin-pro");
	let out = input;
	for (const run of cjkRuns) {
		const tokens = pinyin(run, { toneType: "none", type: "array" }).filter(Boolean);
		// Boundary: pad with spaces so the finalizer's space→dash conversion
		// provides a separator between pinyin syllables and surrounding ASCII.
		// The collapse of `--+` to `-` in finalize() handles the case where
		// there's already a dash on the boundary (e.g. "01-算法").
		const replacement = ` ${tokens.join("-")} `;
		out = out.replace(run, replacement);
	}
	return out;
}

function finalize(raw: string, maxLen: number, hashOnTruncate: boolean, fallback: string): string {
	let slug = raw
		.toLowerCase()
		.replace(UNSAFE_RE, "-")
		.replace(DASH_RUN_RE, "-") // collapse "01--suan" to "01-suan"
		.replace(TRIM_HYPHEN_RE, "");

	if (slug.length === 0) return fallback;

	if (slug.length > maxLen) {
		if (hashOnTruncate) {
			const hash = createHash("sha256").update(raw).digest("hex").slice(0, 6);
			// Reserve 7 chars for `-xxxxxx` and re-trim.
			const cap = Math.max(1, maxLen - 7);
			slug = `${slug.slice(0, cap).replace(TRIM_HYPHEN_RE, "")}-${hash}`;
		} else {
			slug = slug.slice(0, maxLen).replace(TRIM_HYPHEN_RE, "");
		}
	}

	return slug;
}

/**
 * Convert a human-readable name into a kebab-case ASCII slug.
 *
 * Async because CJK paths go through pinyin-pro. ASCII-only input never
 * touches the dynamic import.
 */
export async function slugify(input: string | null | undefined, opts: SlugOptions = {}): Promise<string> {
	const { maxLen = 32, hashOnTruncate = true, fallback = "session" } = opts;

	if (input == null || input.trim().length === 0) return fallback;

	// NFKD pulls accented chars apart into base + combining mark; the
	// combining mark is still non-ASCII, so we strip the whole Mark category
	// to land on the ASCII base char.
	const normalized = input.normalize("NFKD").replace(COMBINING_MARK_RE, "");
	const ascii = NON_ASCII_RE.test(normalized) ? await toAscii(normalized) : normalized;

	return finalize(ascii, maxLen, hashOnTruncate, fallback);
}

/**
 * Synchronous variant: skips pinyin-pro. CJK input falls through to a
 * hex-only filename (the original CJK name lives in DB; the file is still
 * unique). Use this on hot paths where dynamic import is unacceptable.
 */
export function slugifySync(input: string | null | undefined, opts: SlugOptions = {}): string {
	const { maxLen = 32, hashOnTruncate = true, fallback = "session" } = opts;

	if (input == null || input.trim().length === 0) return fallback;

	// Strip combining marks too so the sync path collapses diacritics cleanly.
	const normalized = input.normalize("NFKD").replace(COMBINING_MARK_RE, "");
	// Without pinyin-pro, non-ASCII becomes dashes via UNSAFE_RE.
	return finalize(normalized, maxLen, hashOnTruncate, fallback);
}
