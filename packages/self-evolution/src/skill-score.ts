/**
 * Normalization helpers for skill quality and population evolution scores.
 */

/** Evolution score is stored on a 0–1 scale; legacy rows may have 0–100. */
export function normalizeEvolutionScore(score: number): number {
	if (!Number.isFinite(score)) return 0;
	if (score > 1) {
		return Math.min(1, Math.max(0, score / 100));
	}
	return Math.min(1, Math.max(0, score));
}

export function isValidSkillName(name: string): boolean {
	const trimmed = name.trim();
	if (!trimmed) return false;
	const sanitized = trimmed
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
	return sanitized.length > 0;
}
