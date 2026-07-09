/**
 * Doom-loop (a.k.a. "repetitive degeneration", "thinking loop") detector.
 *
 * Streaming detectors that decide whether an in-flight assistant message has
 * collapsed into the autoregressive self-reinforcement pattern documented in
 *   - Holtzman et al. 2020, "The Curious Case of Neural Text Degeneration"
 *   - Duan et al. 2026, "Circular Reasoning" (arxiv 2601.05693)
 *   - Pipis et al. 2025, "Wait, Wait, Wait... Why Do Reasoning Models Loop?"
 *     (arxiv 2512.12895)
 *   - Liquid AI 2026, "Antidoom / Final Token Preference Optimization"
 *
 * Two flavors are checked separately because the structural cause differs:
 *   - thinking blocks: a discourse-marker fallback pattern (e.g. "Now run
 *     checks." / "All 78 tests pass.") that the model re-emits because the
 *     easy cyclic action is more probable than the hard progress action.
 *   - text blocks: a literal n-gram (>=60 chars) repeated four or more times,
 *     characteristic of tail-end repetition when the model never produces EOS.
 *
 * The detector is invoked from the agent loop on every thinking_/text_
 * streaming event with the cumulative partial message. It returns a verdict
 * that the loop turns into `stopReason: "length"` with a descriptive
 * `errorMessage`. The detector itself never aborts the stream; aborting the
 * for-await is the loop's job.
 *
 * Pure / stateless w.r.t. the outside world — all bookkeeping is recomputed
 * from the partial on every call. Cost is O(n) per call where n is the
 * accumulated content length; for typical doom loops the partial is already
 * large (>=5K chars) when the verdict flips, so the total work over a stream
 * is O(n * k) where k is the number of deltas. With k=1000 and n=32K the
 * worst case is ~3.2e7 hash/lookup operations, dominated by Map.set/get.
 * Acceptable for the streaming path; if it ever isn't, the right move is
 * incremental state, not a different algorithm.
 */

import type {
	AssistantMessage,
	AssistantMessageEvent,
	Model,
	SimpleStreamOptions,
	TextContent,
	ThinkingContent,
} from "@oh-my-pi/pi-ai";

/**
 * Per-content-type detector thresholds. Defaults are calibrated against the
 * `minimax-m3` doom loop observed in session 143736 (c31: a single ~30-char
 * phrase repeated 276 times inside 17,837 chars of thinking) and the broader
 * Liquid AI / Dharma-AI production reports. They err on the side of
 * tolerating long, slow deliberation — the hard cap and the "no text yet"
 * gate below both prevent a long-but-coherent thought from being mistaken
 * for a loop.
 */
export interface DoomLoopConfig {
	/**
	 * Master switch. When false the detector is a no-op so callers (tests,
	 * eval harnesses) can disable it without re-plumbing config.
	 */
	enabled: boolean;

	/**
	 * Thinking-block rule. Matches the Liquid AI observation that doom loops
	 * collapse to a small vocabulary of discourse markers plus a long
	 * repeated phrase. Two independent sub-rules, OR-combined.
	 */
	thinking: ThinkingDoomConfig;

	/**
	 * Text-block rule. The Holtzman 2020 n-gram repetition test, made
	 * concrete: any substring of length `ngramSize` repeated `minNgramRepeat`
	 * times inside a single assistant text block.
	 */
	text: TextDoomConfig;

	/**
	 * Optional hard ceiling on cumulative thinking content per assistant
	 * message. Independent of degeneration — this is the user-set
	 * "minimax-m3 is not allowed to think for more than 16K chars" guard.
	 * 0 or `undefined` disables the cap.
	 */
	maxThinkingChars?: number;

	/**
	 * How many times the agent loop should re-stream the same prompt when
	 * the detector fires before giving up. Each retry is a fresh
	 * `streamSimple()` call — the prior doom message is stripped from
	 * `context.messages` so the model never sees the runaway on the
	 * retry. The doom message itself is preserved in the agent event
	 * stream and the session JSONL for postmortem.
	 *
	 * Default: 1. Set to 0 to keep the old "terminate on doom" behavior
	 * (useful for tests that want to verify detection only, and for
	 * callers that prefer to handle recovery themselves via
	 * `getSteeringMessages`).
	 */
	maxRetries?: number;

	/**
	 * Per-retry stream-options override. The default implementation
	 * returns `{ reasoning: undefined }`, which strips the thinking-mode
	 * hint from the retry call. Provider-specific behavior:
	 *   - Anthropic: `reasoning: undefined` → `thinkingEnabled: false`
	 *   - OpenAI Responses / Completions: `reasoning: undefined` →
	 *     `reasoning_effort` omitted (provider default)
	 *   - Google Gemini: `reasoning: undefined` → no thinking config
	 *
	 * Override this to plug a per-model recovery policy (e.g. force a
	 * different model id, bump temperature, set a hard timeout).
	 */
	retryStreamOptions?: (model: Model, attempt: number) => Partial<SimpleStreamOptions> | undefined;
}

export interface ThinkingDoomConfig {
	/** Skip the check until cumulative thinking is at least this long. */
	minChars: number;
	/**
	 * Sub-rule A: collapse ratio. Fires when (unique 4-gram count / total
	 * 4-gram count) drops below this AND `minChars` is satisfied. 0.15 was
	 * the observed ratio for the 143736 c31 / c27 loops.
	 */
	uniqueRatioThreshold: number;
	/**
	 * Sub-rule B: phrase repetition. Fires when any normalized phrase of
	 * `minPhraseLength`+ chars appears `minPhraseRepeat`+ times. 200 / 20
	 * is the floor; real loops run into the hundreds.
	 */
	minPhraseRepeat: number;
	minPhraseLength: number;
}

export interface TextDoomConfig {
	/** Skip the check until cumulative text is at least this long. */
	minChars: number;
	/**
	 * Sliding-window n-gram length. 60 chars covers the typical doom-loop
	 * sentence ("All 78 channel tests pass. Run biome + related.") and is
	 * long enough to be effectively unique on non-degenerate outputs.
	 */
	ngramSize: number;
	/** How many times the same n-gram must appear before we fire. */
	minNgramRepeat: number;
}

export type DoomVerdict =
	| { kind: "clean" }
	| {
			kind: "doom";
			where: "thinking" | "text" | "thinking_cap";
			reason: string;
			chars: number;
	  };

/** Default thresholds — see `DoomLoopConfig` for derivation. */
export const DEFAULT_DOOM_LOOP_CONFIG: DoomLoopConfig = {
	enabled: true,
	thinking: {
		minChars: 5000,
		uniqueRatioThreshold: 0.15,
		minPhraseRepeat: 200,
		minPhraseLength: 20,
	},
	text: {
		minChars: 500,
		ngramSize: 60,
		minNgramRepeat: 4,
	},
	maxThinkingChars: 16384,
	maxRetries: 1,
	retryStreamOptions: (_model, _attempt) => ({ reasoning: undefined }),
};

/** Events that warrant a doom check; everything else is a no-op. */
const DETECTABLE_EVENTS = new Set<AssistantMessageEvent["type"]>([
	"thinking_delta",
	"thinking_end",
	"text_delta",
	"text_end",
	"toolcall_end",
]);

/**
 * Run the detector on the current partial. Cheap no-op for non-streaming
 * events. Returns `clean` for disabled configs and for partials that haven't
 * crossed the per-kind minChars gate, so callers can invoke this on every
 * event without branching.
 */
export function detectDoomLoop(
	partial: AssistantMessage,
	event: AssistantMessageEvent,
	cfg: DoomLoopConfig,
): DoomVerdict {
	if (!cfg.enabled) return { kind: "clean" };
	if (!DETECTABLE_EVENTS.has(event.type)) return { kind: "clean" };

	const thinkingText = concatBlocks(partial, "thinking");
	const textText = concatBlocks(partial, "text");

	// Hard cap on thinking length — independent of degeneration.
	if (cfg.maxThinkingChars !== undefined && cfg.maxThinkingChars > 0 && thinkingText.length > cfg.maxThinkingChars) {
		return {
			kind: "doom",
			where: "thinking_cap",
			reason: `thinking content exceeded maxThinkingChars=${cfg.maxThinkingChars}`,
			chars: thinkingText.length,
		};
	}

	// Only run content checks on the matching event type so the
	// text-delta path doesn't redundantly re-scan the (typically much
	// larger) thinking block and vice versa.
	if (event.type.startsWith("thinking_")) {
		const verdict = checkThinkingDoom(thinkingText, cfg.thinking);
		if (verdict.kind === "doom") return verdict;
	}
	if (event.type.startsWith("text_")) {
		const verdict = checkTextDoom(textText, cfg.text);
		if (verdict.kind === "doom") return verdict;
	}

	return { kind: "clean" };
}

function checkThinkingDoom(text: string, cfg: ThinkingDoomConfig): DoomVerdict {
	if (text.length < cfg.minChars) return { kind: "clean" };

	// Sub-rule A: collapse ratio via 4-gram uniqueness.
	const uniqueRatio = collapseRatio(text, 4);
	if (uniqueRatio < cfg.uniqueRatioThreshold) {
		return {
			kind: "doom",
			where: "thinking",
			reason: `4-gram collapse ratio ${uniqueRatio.toFixed(3)} < ${cfg.uniqueRatioThreshold}`,
			chars: text.length,
		};
	}

	// Sub-rule B: single phrase repeated too many times.
	const topPhrase = mostRepeatedPhrase(text, cfg.minPhraseLength);
	if (topPhrase && topPhrase.count >= cfg.minPhraseRepeat) {
		const sample = topPhrase.phrase.length > 80 ? `${topPhrase.phrase.slice(0, 80)}…` : topPhrase.phrase;
		return {
			kind: "doom",
			where: "thinking",
			reason: `phrase "${sample}" repeated ${topPhrase.count}×`,
			chars: text.length,
		};
	}

	return { kind: "clean" };
}

function checkTextDoom(text: string, cfg: TextDoomConfig): DoomVerdict {
	if (text.length < cfg.minChars) return { kind: "clean" };

	const ngram = findRepeatingNgram(text, cfg.ngramSize, cfg.minNgramRepeat);
	if (ngram) {
		const sample = ngram.ngram.length > 100 ? `${ngram.ngram.slice(0, 100)}…` : ngram.ngram;
		return {
			kind: "doom",
			where: "text",
			reason: `${cfg.ngramSize}-gram "${sample}" repeated ${ngram.count}×`,
			chars: text.length,
		};
	}

	return { kind: "clean" };
}

/**
 * Extract the cumulative text of every content block of the given kind.
 * Content blocks within an assistant message appear in the order the model
 * produced them; concatenating in order preserves the running stream the
 * model sees.
 */
function concatBlocks(partial: AssistantMessage, kind: "thinking" | "text"): string {
	if (!Array.isArray(partial.content)) return "";
	const blocks: string[] = [];
	for (const block of partial.content) {
		if (kind === "thinking" && block.type === "thinking") {
			blocks.push((block as ThinkingContent).thinking);
		} else if (kind === "text" && block.type === "text") {
			blocks.push((block as TextContent).text);
		}
	}
	return blocks.join("");
}

/**
 * Ratio of unique n-grams to total n-grams in the text. 0 means every n-gram
 * is a repeat of an earlier one; 1 means no two n-grams match. 0.15 is the
 * observed floor for the 143736 doom loops.
 */
function collapseRatio(text: string, n: number): number {
	if (text.length < n) return 1;
	const seen = new Set<string>();
	let total = 0;
	for (let i = 0; i <= text.length - n; i++) {
		seen.add(text.slice(i, i + n));
		total++;
	}
	return seen.size / total;
}

interface PhraseHit {
	phrase: string;
	count: number;
}

/**
 * Find the most-repeated whitespace-trimmed phrase of length >= `minLen`.
 * Splits on whitespace, hashes each phrase (>= minLen chars), returns the
 * top count. Cheap enough to run on a 32K thinking block once per call.
 */
function mostRepeatedPhrase(text: string, minLen: number): PhraseHit | null {
	if (text.length < minLen) return null;
	const counts = new Map<string, number>();
	const tokens = text.split(/\s+/);
	let buf = "";
	for (const tok of tokens) {
		const candidate = buf.length === 0 ? tok : `${buf} ${tok}`;
		if (candidate.length >= minLen) {
			counts.set(candidate, (counts.get(candidate) ?? 0) + 1);
			// Sliding window: drop the leading word so "foo bar foo bar" gives
			// bar both on its own and inside the longer phrase.
			const parts = candidate.split(" ");
			if (parts.length > 1) {
				buf = parts.slice(1).join(" ");
			} else {
				buf = "";
			}
		} else {
			buf = candidate;
		}
	}
	let best: PhraseHit | null = null;
	for (const [phrase, count] of counts) {
		if (best === null || count > best.count) best = { phrase, count };
	}
	return best;
}

interface NgramHit {
	ngram: string;
	count: number;
}

/**
 * Find the first substring of `ngramSize` characters that occurs at least
 * `minRepeat` times. Returns the one with the highest count. The n-gram
 * overlap check is the canonical Holtzman test; "first" / "highest" tie-break
 * doesn't matter for the verdict, only the existence of a repeat.
 */
function findRepeatingNgram(text: string, ngramSize: number, minRepeat: number): NgramHit | null {
	if (text.length < ngramSize * 2) return null;
	const counts = new Map<string, number>();
	for (let i = 0; i <= text.length - ngramSize; i++) {
		const ngram = text.slice(i, i + ngramSize);
		counts.set(ngram, (counts.get(ngram) ?? 0) + 1);
	}
	let best: NgramHit | null = null;
	for (const [ngram, count] of counts) {
		if (count < minRepeat) continue;
		if (best === null || count > best.count) best = { ngram, count };
	}
	return best;
}
