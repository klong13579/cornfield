/**
 * Learning relevance checker — precise attribution of whether an injected
 * learning actually influenced the current session.
 *
 * Per-kind strategy:
 * - preference: did the described rule/entity appear in the session?
 * - procedure: were the described tools/steps used?
 * - fact: did named entities from the fact appear in the session?
 * - skill_hint: was the suggested tool used?
 */
import type { Learning, LearningKind, SessionTrace } from "./types";

const STOP_WORDS = new Set([
	"the",
	"a",
	"an",
	"is",
	"are",
	"was",
	"were",
	"be",
	"been",
	"being",
	"have",
	"has",
	"had",
	"do",
	"does",
	"did",
	"will",
	"would",
	"could",
	"should",
	"may",
	"might",
	"must",
	"shall",
	"can",
	"need",
	"to",
	"of",
	"in",
	"for",
	"on",
	"with",
	"at",
	"by",
	"from",
	"as",
	"and",
	"but",
	"or",
	"yet",
	"so",
	"if",
	"because",
	"while",
	"where",
	"when",
	"that",
	"which",
	"who",
	"whom",
	"what",
	"this",
	"these",
	"those",
	"i",
	"you",
	"he",
	"she",
	"it",
	"we",
	"they",
	"me",
	"him",
	"her",
	"us",
	"them",
	"my",
	"your",
	"his",
	"its",
	"our",
	"their",
	"不要",
	"不能",
	"必须",
	"应该",
	"可以",
	"需要",
	"使用",
	"进行",
	"所有",
	"每个",
	"任何",
	"一些",
	"这些",
	"那些",
	"这个",
	"那个",
	"用户",
	"遇到",
	"如果",
	"然后",
	"最后",
	"首先",
	"接着",
]);

/** Extract English technical terms: tool names, commands, file extensions */
function extractTerms(text: string): string[] {
	const lower = text.toLowerCase();
	// Tool names, commands, paths, URLs
	const terms = [
		...(lower.match(/\b[a-z][a-z0-9_-]{2,}\b/g) ?? []),
		...(lower.match(/[./~][\w/.-]+/g) ?? []),
		...(lower.match(/[a-z0-9-]+\.[a-z]{2,}/g) ?? []),
	];
	return [...new Set(terms)].filter(t => !STOP_WORDS.has(t));
}

/** Extract Chinese named entities (2-4 char phrases that look like names/org names) */
function extractChineseEntities(text: string): string[] {
	const chars = text.replace(/[^\u4e00-\u9fff]/g, "");
	const entities: string[] = [];
	// Person names are typically 2-4 Chinese characters
	for (let i = 0; i <= chars.length - 2; i++) {
		for (let len = 2; len <= 4 && i + len <= chars.length; len++) {
			const entity = chars.slice(i, i + len);
			// Skip common particles
			if (!/^[的了我你他是她它在和与及或]/g.test(entity)) {
				entities.push(entity);
			}
		}
	}
	return [...new Set(entities)];
}

function sessionText(trace: SessionTrace): string {
	const parts: string[] = [trace.userPrompt.toLowerCase()];
	for (const e of trace.entries) {
		if (e.type === "tool_call") {
			parts.push(e.toolName?.toLowerCase() ?? "");
			if (e.args && typeof e.args === "object") {
				parts.push(JSON.stringify(e.args).toLowerCase());
			}
		}
		if (e.type === "assistant_message" && e.content) {
			parts.push(e.content.toLowerCase());
		}
	}
	return parts.join(" ");
}

function scorePreferenceRelevance(learning: Learning, session: string): number {
	const content = learning.content.toLowerCase();
	const terms = extractTerms(content);
	if (terms.length === 0) {
		// Fallback: check if any Chinese entity appears
		const entities = extractChineseEntities(content);
		const matched = entities.filter(e => session.includes(e));
		return entities.length > 0 ? matched.length / entities.length : 0;
	}
	const matched = terms.filter(t => session.includes(t));
	return matched.length / terms.length;
}

function scoreProcedureRelevance(learning: Learning, session: string): number {
	// Split into steps, check each step for tool/term matches
	const steps = learning.content
		.toLowerCase()
		.split(/[.!?;。！？；]|\n/)
		.map(s => s.trim())
		.filter(s => s.length >= 5);

	if (steps.length === 0) return 0;

	let matchedSteps = 0;
	for (const step of steps) {
		const terms = extractTerms(step);
		if (terms.length === 0) continue;

		const matched = terms.filter(k => session.includes(k));
		if (matched.length / terms.length >= 0.3) {
			matchedSteps++;
		}
	}

	return matchedSteps / steps.length;
}

function scoreFactRelevance(learning: Learning, session: string): number {
	const content = learning.content.toLowerCase();

	// Check English terms first
	const terms = extractTerms(content);
	if (terms.length > 0) {
		const matched = terms.filter(t => session.includes(t));
		if (matched.length > 0) return matched.length / terms.length;
	}

	// For Chinese: find the longest common substring between learning and session
	const learningChars = content.replace(/[^\u4e00-\u9fff]/g, "");
	const sessionChars = session.replace(/[^\u4e00-\u9fff]/g, "");
	if (learningChars.length === 0 || sessionChars.length === 0) return 0;

	let longest = 0;
	for (let i = 0; i < learningChars.length; i++) {
		for (let j = i + 2; j <= learningChars.length; j++) {
			const substr = learningChars.slice(i, j);
			if (sessionChars.includes(substr)) {
				longest = Math.max(longest, substr.length);
			}
		}
	}

	// Score by match length: 2 chars = 0.15, 3 chars = 0.45, 4+ chars = 0.8+
	if (longest >= 4) return 0.8 + Math.min(0.2, (longest - 4) * 0.05);
	if (longest === 3) return 0.45;
	if (longest === 2) return 0.15;
	return 0;
}
function scoreSkillHintRelevance(learning: Learning, session: string): number {
	const content = learning.content.toLowerCase();
	const terms = extractTerms(content);
	if (terms.length === 0) {
		return scoreFactRelevance(learning, session);
	}
	const matched = terms.filter(t => session.includes(t));
	return matched.length / terms.length;
}

const SCORERS: Record<LearningKind, (l: Learning, s: string) => number> = {
	preference: scorePreferenceRelevance,
	procedure: scoreProcedureRelevance,
	fact: scoreFactRelevance,
	skill_hint: scoreSkillHintRelevance,
};

/** Minimum relevance score to consider a learning as having influenced the session */
const RELEVANCE_THRESHOLD = 0.25;

/**
 * Determine whether a specific learning influenced the current session.
 * Returns a score 0–1 and a boolean indicating whether to record feedback.
 */
export function checkLearningRelevance(
	learning: Learning,
	trace: SessionTrace,
): { score: number; shouldRecord: boolean } {
	const session = sessionText(trace);
	const scorer = SCORERS[learning.kind] ?? scoreFactRelevance;
	const score = scorer(learning, session);
	return { score, shouldRecord: score >= RELEVANCE_THRESHOLD };
}

/** For tests: expose internals */
export const _testing = {
	extractTerms,
	extractChineseEntities,
	scoreFactRelevance,
	scoreProcedureRelevance,
	scorePreferenceRelevance,
	scoreSkillHintRelevance,
};
