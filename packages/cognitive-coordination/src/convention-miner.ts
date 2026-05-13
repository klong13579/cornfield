import { logger } from "@oh-my-pi/pi-utils";
import type { ImplicitConvention } from "./types";

/**
 * Implicit convention extracted from session logs
 * Re-exported for convenience.
 */
export type { ImplicitConvention };

/**
 * Session log entry (JSONL format)
 */
interface SessionLogEntry {
	/** Entry type (e.g., "user_message", "agent_message") */
	type?: string;
	/** The message content */
	content?: string;
	/** Timestamp */
	timestamp?: string;
	/** Entry ID */
	entry_id?: string;
}

/**
 * Negative keywords with their confidence weights.
 * Higher weight = stronger negative intent.
 */
const NEGATIVE_KEYWORDS: Array<{ keyword: string; weight: number; phrase?: string }> = [
	{ keyword: "never", weight: 1.0 },
	{ keyword: "don't ever", weight: 0.95 },
	{ keyword: "do not ever", weight: 0.95 },
	{ keyword: "must not", weight: 0.9 },
	{ keyword: "mustn't", weight: 0.9 },
	{ keyword: "stop using", weight: 0.85 },
	{ keyword: "stop calling", weight: 0.85 },
	{ keyword: "avoid using", weight: 0.8 },
	{ keyword: "avoid calling", weight: 0.8 },
	{ keyword: "no more", weight: 0.75 },
	{ keyword: "don't use", weight: 0.7 },
	{ keyword: "do not use", weight: 0.7 },
	{ keyword: "don't call", weight: 0.7 },
	{ keyword: "do not call", weight: 0.7 },
	{ keyword: "never use", weight: 0.8 },
	{ keyword: "stop", weight: 0.6 },
	{ keyword: "avoid", weight: 0.6 },
	{ keyword: "don't", weight: 0.5 },
	{ keyword: "do not", weight: 0.5 },
	{ keyword: "no", weight: 0.4 },
];

/**
 * False positive patterns that should be filtered out.
 * These are common phrases that contain negative keywords but aren't actual rules.
 */
const FALSE_POSITIVE_PATTERNS = [
	/don't worry/i,
	/don't know/i,
	/don't understand/i,
	/don't think/i,
	/don't want/i,
	/don't have/i,
	/don't see/i,
	/don't need/i,
	/don't mean/i,
	/don't remember/i,
	/don't care/i,
	/don't feel/i,
	/don't ask/i,
	/don't tell/i,
	/don't say/i,
	/don't get/i,
	/don't go/i,
	/don't be/i,
	/never mind/i,
	/never thought/i,
	/never knew/i,
	/never seen/i,
	/never heard/i,
	/never going to/i,
	/no (worried|concerned|problem|sure)/i,
	/it's not/i,
	/that's not/i,
	/this is not/i,
	/there is no/i,
	/that's a no/i,
];

/**
 * Check if a sentence matches any false positive pattern.
 */
function isFalsePositive(sentence: string): boolean {
	return FALSE_POSITIVE_PATTERNS.some(pattern => pattern.test(sentence));
}

/**
 * Extract the sentence containing the negative keyword.
 * Tries to extract a complete sentence rather than just the match.
 */
function extractSentence(content: string, keyword: string): string {
	// Normalize content
	const normalizedContent = content.trim();

	// Find the position of the keyword (case-insensitive)
	const lowerContent = normalizedContent.toLowerCase();
	const lowerKeyword = keyword.toLowerCase();
	const matchIndex = lowerContent.indexOf(lowerKeyword);

	if (matchIndex === -1) {
		return normalizedContent;
	}

	// Try to find sentence boundaries around the match
	// Look for sentence-ending punctuation before the match
	let sentenceStart = 0;
	for (let i = matchIndex - 1; i >= 0; i--) {
		const char = normalizedContent[i];
		if (char === "." || char === "!" || char === "?" || char === "\n") {
			sentenceStart = i + 1;
			break;
		}
	}

	// Look for sentence-ending punctuation after the match
	let sentenceEnd = normalizedContent.length;
	for (let i = matchIndex; i < normalizedContent.length; i++) {
		const char = normalizedContent[i];
		if ((char === "." || char === "!" || char === "?" || char === "\n") && i > matchIndex + keyword.length) {
			sentenceEnd = i + 1;
			break;
		}
	}

	// Extract and clean the sentence
	let sentence = normalizedContent.slice(sentenceStart, sentenceEnd).trim();

	// If sentence is too short or empty, use the whole content
	if (sentence.length < 10) {
		sentence = normalizedContent;
	}

	return sentence;
}

/**
 * Get the best matching keyword for a given content.
 * Returns the keyword with the highest weight that matches.
 */
function getBestMatchingKeyword(content: string): { keyword: string; weight: number } | null {
	const lowerContent = content.toLowerCase();

	let bestMatch: { keyword: string; weight: number } | null = null;

	for (const { keyword, weight, phrase } of NEGATIVE_KEYWORDS) {
		const searchTerm = phrase || keyword;
		if (lowerContent.includes(searchTerm.toLowerCase())) {
			// Keep the first (most specific) match, but prioritize higher weights
			if (!bestMatch || weight > bestMatch.weight) {
				bestMatch = { keyword: phrase || keyword, weight };
			}
		}
	}

	return bestMatch;
}

/**
 * Mine implicit conventions from a session log file.
 *
 * Scans user_message entries for negative keywords indicating implicit rules
 * that the user has expressed (e.g., "don't use X", "never do Y").
 *
 * @param sessionLogPath - Path to the JSONL session log file
 * @returns Array of extracted ImplicitConvention objects
 */
export async function mineImplicitConventions(sessionLogPath: string): Promise<ImplicitConvention[]> {
	const conventions: ImplicitConvention[] = [];

	logger.debug("ConventionMiner: starting analysis", { path: sessionLogPath });

	try {
		const file = Bun.file(sessionLogPath);
		if (!(await file.exists())) {
			logger.warn("ConventionMiner: session log file not found", { path: sessionLogPath });
			return conventions;
		}

		const content = await file.text();

		// Parse JSONL
		const entries: SessionLogEntry[] = [];
		const lines = content.split("\n").filter(line => line.trim());

		for (const line of lines) {
			try {
				const entry = JSON.parse(line) as SessionLogEntry;
				entries.push(entry);
			} catch {
				// Skip invalid JSON lines
				logger.debug("ConventionMiner: skipping invalid JSON line", { line: line.slice(0, 100) });
			}
		}

		logger.debug("ConventionMiner: parsed entries", { count: entries.length });

		const userMessages = entries.filter(entry => entry.type === "user_message" || entry.content);

		// Process each user message
		for (const entry of userMessages) {
			const content = entry.content;
			if (!content) continue;

			const matchResult = getBestMatchingKeyword(content);
			if (!matchResult) continue;

			// Extract the sentence containing the keyword
			const sentence = extractSentence(content, matchResult.keyword);

			// Skip false positives
			if (isFalsePositive(sentence)) {
				logger.debug("ConventionMiner: filtered false positive", {
					sentence: sentence.slice(0, 50),
					keyword: matchResult.keyword,
				});
				continue;
			}

			// Skip if the sentence is too short (likely not a meaningful rule)
			if (sentence.length < 15) {
				continue;
			}

			// Generate unique ID based on content hash
			const id = `conv_${Buffer.from(sentence.slice(0, 50)).toString("base64").replace(/[/+=]/g, "_").slice(0, 16)}_${Date.now()}`;

			conventions.push({
				rule: sentence,
				sourceSessionId: sessionLogPath,
				confidence: matchResult.weight,
			});

			logger.debug("ConventionMiner: extracted convention", {
				keyword: matchResult.keyword,
				confidence: matchResult.weight,
				rule: sentence.slice(0, 50),
			});
		}

		logger.debug("ConventionMiner: analysis complete", {
			path: sessionLogPath,
			conventionsFound: conventions.length,
		});
	} catch (err) {
		logger.error("ConventionMiner: failed to analyze session log", {
			path: sessionLogPath,
			error: String(err),
		});
	}

	return conventions;
}
