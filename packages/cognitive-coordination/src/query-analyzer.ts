/**
 * Query Analyzer
 *
 * Analyzes natural language queries to classify intent, detect target domains,
 * determine episodic memory requirements, and extract keywords for downstream routing.
 */

export type QueryDomain = "memory" | "skills" | "conventions" | "episodic" | "workflows" | "general";

export type IntentCategory =
	| "refactoring"
	| "bugfix"
	| "feature-add"
	| "testing"
	| "documentation"
	| "configuration"
	| "exploration"
	| "optimization"
	| "integration";

export interface QueryAnalysis {
	intent: IntentCategory;
	confidence: number;
	domains: QueryDomain[];
	requiresEpisodic: boolean;
	keywords: string[];
}

const NOISE_WORDS = new Set([
	"what",
	"when",
	"where",
	"which",
	"with",
	"that",
	"this",
	"from",
	"have",
	"been",
	"just",
	"like",
	"some",
	"your",
	"will",
	"about",
	"would",
	"could",
	"should",
]);

const INTENT_KEYWORDS: [string[], IntentCategory][] = [
	[["refactor", "refactoring", "restructure", "revamp"], "refactoring"],
	[["fix", "bug", "issue", "error", "crash", "fail"], "bugfix"],
	[["add", "implement", "create", "build", "develop", "new feature"], "feature-add"],
	[["test", "spec", "unit test", "e2e", "integration test"], "testing"],
	[["docs", "document", "readme", "wiki"], "documentation"],
	[["config", "settings", "configure", "setup"], "configuration"],
	[["explore", "find", "search", "understand", "look up", "how does"], "exploration"],
	[["optimize", "perf", "performance", "speed", "slow", "bottleneck"], "optimization"],
	[["integrate", "connect", "api", "interop", "migrate"], "integration"],
];

const DOMAIN_KEYWORDS: [string[], QueryDomain][] = [
	[["memory", "recall", "remember"], "memory"],
	[["skill", "learn"], "skills"],
	[["convention", "rule", "always", "never", "convention"], "conventions"],
	[["session", "history", "last time", "previous session", "earlier"], "episodic"],
	[["workflow", "pattern"], "workflows"],
];

const EPISODIC_TRIGGER_PHRASES = ["session", "history", "previous session", "last time", "earlier"];

function tokenize(query: string): string[] {
	return query.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function matchesAnyKeyword(text: string, keywords: string[]): boolean {
	for (const kw of keywords) {
		if (text.includes(kw)) return true;
	}
	return false;
}

function extractKeywords(tokens: string[]): string[] {
	return tokens.filter(t => t.length > 3 && !NOISE_WORDS.has(t));
}

function computeConfidence(
	queryLower: string,
	intentKeywords: [string[], IntentCategory][],
): { intent: IntentCategory; confidence: number } | null {
	const matched: { intent: IntentCategory; score: number }[] = [];

	for (const [keywords, intent] of intentKeywords) {
		let score = 0;
		for (const kw of keywords) {
			if (queryLower.includes(kw)) {
				score += 1;
			}
		}
		if (score > 0) {
			matched.push({ intent, score });
		}
	}

	if (matched.length === 0) return null;

	// Use highest scoring match; if top two scores are equal, prefer earlier entry
	matched.sort((a, b) => b.score - a.score);
	const best = matched[0];

	let confidence = 0.9;
	if (best.score >= 2) {
		confidence = 0.95;
	} else if (matched.length > 1 && matched[1].score === best.score) {
		// Tie — slightly lower confidence
		confidence = 0.75;
	}

	return { intent: best.intent, confidence };
}

function detectDomains(queryLower: string): QueryDomain[] {
	const detected: QueryDomain[] = [];

	for (const [keywords, domain] of DOMAIN_KEYWORDS) {
		if (matchesAnyKeyword(queryLower, keywords)) {
			if (!detected.includes(domain)) {
				detected.push(domain);
			}
		}
	}

	if (detected.length === 0) {
		detected.push("general");
	}

	return detected;
}

function checkRequiresEpisodic(queryLower: string): boolean {
	return EPISODIC_TRIGGER_PHRASES.some(phrase => queryLower.includes(phrase));
}

/**
 * Classifies user queries by intent, target domain, episodic requirements,
 * and extracts meaningful keywords.
 */
export class QueryAnalyzer {
	#impl(query: string): QueryAnalysis {
		const queryLower = query.trim().toLowerCase();
		const tokens = tokenize(query);
		const keywords = extractKeywords(tokens);

		const { intent, confidence } = computeConfidence(queryLower, INTENT_KEYWORDS) ?? {
			intent: this.#getDefaultIntent(keywords),
			confidence: 0.4,
		};

		const domains = detectDomains(queryLower);
		const requiresEpisodic = checkRequiresEpisodic(queryLower) || domains.includes("episodic");

		return { intent, confidence, domains, requiresEpisodic, keywords };
	}

	analyze(query: string): QueryAnalysis {
		return this.#impl(query);
	}

	#getDefaultIntent(keywords: string[]): IntentCategory {
		// If keywords suggest any of our intent categories directly, use that as default
		for (const [keywordsList, intent] of INTENT_KEYWORDS) {
			for (const kw of keywordsList) {
				if (keywords.includes(kw)) {
					return intent;
				}
			}
		}
		return "exploration";
	}
}
