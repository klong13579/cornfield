/**
 * Virtual Sandbox
 *
 * Heuristically validates a UnifiedSkill against a Session Log.
 * Instead of expensive LLM replay, we use pattern matching to check
 * if the skill is relevant to past failures or patterns in the log.
 */

import type { UnifiedSkill } from "./types";

export interface SandboxReport {
	skillId: string;
	scoreDelta: number; // Change in confidence (-1.0 to +1.0)
	reason: string;
	passed: boolean;
}

/**
 * Analyzes a skill against log content to determine its relevance/effectiveness.
 *
 * Logic:
 * 1. Relevance: Do keywords from the skill (name, taskPattern, approach) appear in the log?
 * 2. Error Prevention: If the log has errors, does the skill contain keywords related to those errors?
 */
export function validateSkill(skill: UnifiedSkill, logContent: string): SandboxReport {
	const text = logContent.toLowerCase();
	const skillText = `${skill.name} ${skill.metadata?.description ?? ""} ${skill.content}`.toLowerCase();

	// 1. Token Overlap Check (Relevance)
	const words = new Set(skillText.split(/\W+/).filter(w => w.length > 3));
	let matches = 0;
	for (const word of words) {
		if (text.includes(word)) matches++;
	}
	const relevanceScore = words.size > 0 ? matches / words.size : 0;

	// 2. Error Correlation Check
	const hasErrors = text.includes('"isError": true') || text.includes("error") || text.includes("failed");
	const mentionsFix = skillText.includes("fix") || skillText.includes("avoid") || skillText.includes("ensure");

	let scoreDelta = 0;
	let reason = "";

	if (relevanceScore > 0.1) {
		// Skill is relevant to this session
		if (hasErrors && mentionsFix) {
			// Session had errors, skill offers fixes -> High value
			scoreDelta = 0.15;
			reason = "Skill addresses errors found in session log.";
		} else if (!hasErrors) {
			// Session was successful, skill is relevant -> Positive reinforcement
			scoreDelta = 0.05;
			reason = "Skill is relevant to successful session.";
		} else {
			// Session failed, but skill didn't seem to help (or wasn't used) -> Neutral/Slight Negative
			scoreDelta = -0.05;
			reason = "Skill relevant but session failed.";
		}
	} else {
		// Skill not relevant to this session -> Decay slightly to prune unused skills
		scoreDelta = -0.02;
		reason = "Skill not relevant to recent activity.";
	}

	return {
		skillId: skill.id,
		scoreDelta,
		reason,
		passed: scoreDelta >= 0,
	};
}
