/**
 * Retry-fallback cooldown escalation.
 *
 * The plain cooldown from `parseRateLimitReason` (5min for UNKNOWN, 45-75s for
 * MODEL_CAPACITY, etc.) is the per-failure cooldown. When a selector fails
 * repeatedly within a short window, that cooldown is too short — the next
 * restore cycle will re-pick the same selector and trigger another failure.
 *
 * This module provides the escalation layer: when the same selector failed
 * within `RETRY_FALLBACK_FLAPPING_WINDOW_MS`, the cooldown is multiplied and
 * floored at `RETRY_FALLBACK_MIN_ESCALATED_COOLDOWN_MS`.
 *
 * Production observation (session 042253__37002e77):
 *   - 5 model changes within a 5s window
 *   - Selector cooldown expired faster than the restore cycle
 *   - Primary → fallback → restore → primary → fallback → ...
 *
 * After escalation, the second failure of the same selector within 60s gets
 * at least a 5-minute cooldown, breaking the loop.
 */

/** Window during which a repeat failure is considered flapping. */
export const RETRY_FALLBACK_FLAPPING_WINDOW_MS = 60_000;

/** Multiplier applied to base cooldown when a selector is flapping. */
export const RETRY_FALLBACK_ESCALATION_FACTOR = 5;

/** Floor for the escalated cooldown. */
export const RETRY_FALLBACK_MIN_ESCALATED_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * Compute the cooldown for a model selector, escalating if the selector
 * has failed recently, and floored at a user-configured minimum.
 *
 * Order of operations:
 *   1. Apply flapping escalation if the same selector failed within the
 *      flapping window. The escalation multiplies the base cooldown and
 *      floors at `RETRY_FALLBACK_MIN_ESCALATED_COOLDOWN_MS` (5 min).
 *   2. Apply the user-configured `minCooldownMs` floor. This is a hard
 *      minimum that the flapping escalation does NOT multiply — it represents
 *      "never suppress a model for less than this many ms".
 *
 * The floor is applied after escalation so a high user floor (e.g. 10 min)
 * survives a flapping episode that would otherwise produce only 5 min.
 *
 * @param baseCooldownMs - The cooldown derived from the error (e.g. via
 *   `parseRateLimitReason` / `calculateRateLimitBackoffMs`, or a `retry-after-ms`
 *   hint from the error message).
 * @param lastFailureAtMs - Timestamp (ms) of the previous failure of the same
 *   selector, or `undefined` if this is the first failure.
 * @param nowMs - Current timestamp (ms). Injected for testability.
 * @param flappingWindowMs - Window during which repeat failures escalate.
 *   Defaults to `RETRY_FALLBACK_FLAPPING_WINDOW_MS`.
 * @param minCooldownMs - User-configured hard floor. `undefined`, `0`, or
 *   negative values disable the floor.
 * @returns The final cooldown to apply to the selector, in ms.
 */
export function computeRetryFallbackCooldown(
	baseCooldownMs: number,
	lastFailureAtMs: number | undefined,
	nowMs: number,
	flappingWindowMs: number = RETRY_FALLBACK_FLAPPING_WINDOW_MS,
	minCooldownMs: number | undefined = undefined,
): number {
	let cooldown = baseCooldownMs;
	if (lastFailureAtMs !== undefined && nowMs - lastFailureAtMs < flappingWindowMs) {
		cooldown = Math.max(
			cooldown * RETRY_FALLBACK_ESCALATION_FACTOR,
			RETRY_FALLBACK_MIN_ESCALATED_COOLDOWN_MS,
		);
	}
	if (typeof minCooldownMs === "number" && minCooldownMs > 0) {
		cooldown = Math.max(cooldown, minCooldownMs);
	}
	return cooldown;
}
