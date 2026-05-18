/**
 * V3: narrow regex for explicit user memory requests only (no miner / negative spam).
 */

import { LEARNING_MAX_PER_SESSION, newLearningLifecycleState, validateLearningContent } from "./learning-admission";
import type { Learning, LearningKind, SessionTrace } from "./types";

const EXPLICIT_PATTERNS: Array<{ kind: LearningKind; pattern: RegExp; confidence: number }> = [
	{
		kind: "preference",
		pattern: /(?:以后请记住|以后记住|请记住|记住)[：:,;]?\s*([^\u3002\uFF01\uFF1F\uFF1B\u3001\n]{8,120})/gi,
		confidence: 5,
	},
	{
		kind: "preference",
		pattern: /(?:必须先|必须|你应该|你要)[^\u3002\uFF01\uFF1F\uFF1B\u3001\n]{8,120}/gi,
		confidence: 4,
	},
];

function normalizeKey(content: string): string {
	return content.toLowerCase().trim().replace(/\s+/g, " ");
}

function learningId(content: string, kind: LearningKind): string {
	return `lrn_${Bun.hash(`${kind}:${content}`).toString(36)}`;
}

function collectUserTexts(trace: SessionTrace): string[] {
	const texts: string[] = [];
	const seen = new Set<string>();
	const add = (t: string) => {
		const trimmed = t.trim();
		if (!trimmed) return;
		const key = normalizeKey(trimmed);
		if (seen.has(key)) return;
		seen.add(key);
		texts.push(trimmed);
	};
	add(trace.userPrompt);
	for (const e of trace.entries) {
		if (e.type === "user_input" && e.content) add(e.content);
	}
	return texts;
}

export function extractUserExplicitLearnings(trace: SessionTrace, episodeId: string): Learning[] {
	const results: Learning[] = [];
	const seen = new Set<string>();
	const now = Date.now();

	for (const text of collectUserTexts(trace)) {
		for (const { kind, pattern, confidence } of EXPLICIT_PATTERNS) {
			const regex = new RegExp(pattern.source, pattern.flags);
			for (const match of text.matchAll(regex)) {
				const raw = (match[1] ?? match[0]).trim().replace(/^[，,；;：:\s]+/, "");
				if (!validateLearningContent(raw)) continue;
				const key = normalizeKey(raw);
				if (seen.has(key)) continue;
				seen.add(key);
				results.push({
					id: learningId(raw, kind),
					cwd: trace.cwd,
					kind,
					content: raw,
					source: "user_explicit",
					confidence,
					lifecycle: newLearningLifecycleState("user_explicit"),
					sessionId: episodeId,
					createdAt: now,
					updatedAt: now,
					timesInjected: 0,
					timesHelped: 0,
					timesIgnored: 0,
				});
				if (results.length >= LEARNING_MAX_PER_SESSION) return results;
			}
		}
	}

	return results;
}
