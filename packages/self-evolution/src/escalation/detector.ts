/**
 * Detect evolution deadlocks: recurring failures without a proven active fix.
 */
import type { Learning, RegressionFixture, RegressionTrial } from "../types";
import { regressionPatternKey } from "./pattern-key";

export const ESCALATION_MIN_OCCURRENCES = 3;

export interface EscalationCandidate {
	patternKey: string;
	patternLabel: string;
	dominantErrorTool?: string;
	dominantErrorPattern?: string;
	occurrenceCount: number;
	failedImprovementCount: number;
	message: string;
	suggestion: string;
}

function learningMightAddressFixture(learning: Learning, sample: RegressionFixture): boolean {
	const text = learning.content.toLowerCase();
	const pattern = (sample.dominantErrorPattern ?? sample.dominantErrorTool ?? "").toLowerCase();
	if (!pattern) return false;
	return text.includes(pattern);
}

function hasActiveFix(learnings: Learning[], sample: RegressionFixture): boolean {
	return learnings.some(l => l.lifecycle === "active" && learningMightAddressFixture(l, sample));
}

export function detectEscalationCandidates(input: {
	fixtures: RegressionFixture[];
	learnings: Learning[];
	trials: RegressionTrial[];
}): EscalationCandidate[] {
	const groups = new Map<string, RegressionFixture[]>();
	for (const fixture of input.fixtures) {
		const key = regressionPatternKey(fixture);
		const list = groups.get(key) ?? [];
		list.push(fixture);
		groups.set(key, list);
	}

	const candidates: EscalationCandidate[] = [];

	for (const [patternKey, group] of groups) {
		if (group.length < ESCALATION_MIN_OCCURRENCES) continue;

		const sample = group[0]!;
		if (hasActiveFix(input.learnings, sample)) continue;

		const label = sample.dominantErrorPattern ?? sample.dominantErrorTool ?? patternKey.slice(0, 24);

		const failedImprovementCount = input.trials.filter(
			t => t.targetType === "skill" && t.verdict === "discard",
		).length;

		candidates.push({
			patternKey,
			patternLabel: label,
			dominantErrorTool: sample.dominantErrorTool,
			dominantErrorPattern: sample.dominantErrorPattern,
			occurrenceCount: group.length,
			failedImprovementCount,
			message: `Recurring error pattern (${group.length} failed sessions): ${label}`,
			suggestion:
				"Automatic evolution has not produced an active learning fix. Review with /evolution stuck, adjust environment, or pin a learning via /evolution learnings pin.",
		});
	}

	return candidates;
}
