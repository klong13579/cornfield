/**
 * Natural-language model switch interception.
 *
 * Gateway intercepts user messages like "切换模型到 kimi-k2.6" before
 * forwarding to the agent, fuzzy-matches the model name against
 * available models, and calls bridge.setModel() directly — no LLM
 * round-trip, immediate effect.
 *
 * This mirrors Hermes Agent's `/model` slash command behavior, extended
 * to recognize Chinese/English natural-language patterns so users on
 * IM channels (DingTalk) don't need to know the slash-command syntax.
 */

/** Minimal model shape for matching (subset of @oh-my-pi/pi-ai Model). */
export interface MatchableModel {
	provider: string;
	id: string;
	name?: string;
}

export interface ModelMatch {
	provider: string;
	id: string;
}

/**
 * Extract a model name from a natural-language switch request.
 * Returns the raw model argument string, or null if the message
 * doesn't look like a model switch request.
 *
 * Recognized patterns (case-insensitive for English):
 *   切换模型到 X    切换模型到X
 *   切模型到 X      切模型到X
 *   换成 X          换成X
 *   切到 X          切到X
 *   switch model to X
 *   change model to X
 */
export function extractModelSwitchArg(text: string): string | null {
	const trimmed = text.trim();

	// Chinese patterns
	const zhMatch =
		trimmed.match(/^切换?模型?到\s*(.+)$/i) ?? trimmed.match(/^换成\s*(.+)$/) ?? trimmed.match(/^切到\s*(.+)$/);
	if (zhMatch?.[1]) return zhMatch[1].trim();

	// English patterns
	const enMatch = trimmed.match(/^switch\s+model\s+to\s+(.+)$/i) ?? trimmed.match(/^change\s+model\s+to\s+(.+)$/i);
	if (enMatch?.[1]) return enMatch[1].trim();

	return null;
}

/**
 * Fuzzy-match a user-provided model name against available models.
 *
 * Match priority:
 * 1. Exact "provider/id" (e.g. "narwal-plan/kimi-k2.6")
 * 2. Exact id match (e.g. "kimi-k2.6")
 * 3. Normalized substring — strip dashes/underscores/dots, so
 *    "kimi" matches "kimi-k2.6", "kimi2.6" matches "kimi-k2.6"
 * 4. Display name substring (e.g. "Kimi" matches name "Kimi K2.6")
 *
 * Returns the first match, or null if nothing matched.
 */
export function fuzzyMatchModel(models: MatchableModel[], query: string, currentProvider?: string): ModelMatch | null {
	const q = query.toLowerCase().trim();

	// 1. Exact "provider/id"
	if (q.includes("/")) {
		const [p, m] = q.split("/", 2);
		const exact = models.find(mdl => mdl.provider.toLowerCase() === p && mdl.id.toLowerCase() === m);
		if (exact) return { provider: exact.provider, id: exact.id };
	}

	// 2. Exact id
	const exactId = models.find(mdl => mdl.id.toLowerCase() === q);
	if (exactId) return { provider: exactId.provider, id: exactId.id };

	// 3. Normalized substring (strip - _ . for fuzzy matching)
	const normalized = q.replace(/[-_.]/g, "");
	if (normalized) {
		const substring = models.find(mdl => {
			const mid = mdl.id.toLowerCase();
			const mnorm = mid.replace(/[-_.]/g, "");
			return mid.includes(q) || q.includes(mid) || mnorm.includes(normalized) || normalized.includes(mnorm);
		});
		if (substring) return { provider: substring.provider, id: substring.id };
	}

	// 4. Prefix segment match — take the first segment of the query (split
	//    by dash/underscore/digit-boundary) and match it against the first
	//    segment of each model id. So "kimi-2.6" → prefix "kimi" matches
	//    "kimi-k2.6" → prefix "kimi". This catches the common case where
	//    users mistype version suffixes (kimi-2.6 vs kimi-k2.6).
	const queryPrefix = q.split(/[-_.\d]/)[0];
	if (queryPrefix && queryPrefix.length >= 2) {
		const prefixMatch = models.find(mdl => {
			const modelPrefix = mdl.id.toLowerCase().split(/[-_.\d]/)[0];
			return modelPrefix === queryPrefix;
		});
		if (prefixMatch) return { provider: prefixMatch.provider, id: prefixMatch.id };
	}

	// 5. Display name substring
	const nameMatch = models.find(mdl => mdl.name?.toLowerCase().includes(q));
	if (nameMatch) return { provider: nameMatch.provider, id: nameMatch.id };

	return null;
}
