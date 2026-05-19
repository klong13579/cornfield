/**
 * V3 learnings: write-time confidence + injection stats (no regression replay).
 */
import type { Learning, LearningLifecycle, LearningScope, LearningSource } from "./types";

export const LEARNING_MIN_CONTENT_LENGTH = 20;
export const LEARNING_MAX_PER_SESSION = 3;
export const LEARNING_INJECTION_PROMOTE_MIN = 3;
export const LEARNING_INJECTION_HELP_RATE = 0.5;

export function learningHelpRate(l: Learning): number | null {
	if (l.timesInjected < 1) return null;
	return l.timesHelped / l.timesInjected;
}

export function isLearningEligibleForInjection(l: Learning): boolean {
	// Ephemeral-scope learnings are one-time task descriptions — never inject
	if (l.scope === "ephemeral") return false;
	if (l.lifecycle === "archived") return false;
	if (l.source === "manual_pin") return true;
	if (l.lifecycle !== "active") return false;
	if (l.confidence < 4) return false;
	return true;
}

export function classifyLearningLifecycle(l: Learning): LearningLifecycle {
	if (l.lifecycle === "archived") return "archived";
	if (l.source === "manual_pin") return "active";
	if (l.lifecycle === "active") return "active";
	// Auto-promote high-confidence learnings to break the chicken-and-egg:
	// learnings cannot be promoted via injection stats if never injected,
	// and cannot be injected if not active. Confidence >= 4 is a strong
	// signal the content is meaningful enough to start injection.
	if (l.confidence >= 4) return "active";
	const rate = learningHelpRate(l);
	if (l.timesInjected >= LEARNING_INJECTION_PROMOTE_MIN && rate !== null && rate >= LEARNING_INJECTION_HELP_RATE) {
		return "active";
	}
	return "candidate";
}

export function newLearningLifecycleState(source: LearningSource): LearningLifecycle {
	return source === "manual_pin" ? "active" : "candidate";
}

export function validateLearningContent(content: string): boolean {
	const trimmed = content.trim();
	if (trimmed.length < LEARNING_MIN_CONTENT_LENGTH) return false;
	if (/失败后不要立即/.test(trimmed)) return false;
	if (/^option\(/.test(trimmed)) return false;
	if (/^[\s\W]{0,5}["'`]/.test(trimmed) && trimmed.length < 40) return false;
	return true;
}
