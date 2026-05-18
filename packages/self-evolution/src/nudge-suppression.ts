/**
 * Shared nudge suppression (dismiss / acknowledge) for in-session and cross-session delivery.
 */
import type { NudgeHistoryStore } from "./storage/types";
import type { CrossSessionNudge, Nudge, NudgeRecord } from "./types";

export const NUDGE_DISMISS_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

/** In-session detector types + cross-session engine types (for cache warmup). */
export const KNOWN_NUDGE_TYPES = [
	"cascade-read-verify-failure",
	"edit-verify-path-mismatch",
	"search-misled-read",
	"error-cascade",
	"redundant-search",
	"slow-loop",
	"read-only-after-write",
	"cross-session-redundant-search",
	"cross-session-error-cascade",
	"cross-session-high-error-rate",
	"cross-session-slow-warmup",
	"cross-session-skill-underutilization",
] as const;

export function shouldSuppressNudgeRecord(record: NudgeRecord, now: number): boolean {
	if (record.acknowledged) return true;
	if (record.dismissedAt !== undefined && now - record.dismissedAt < NUDGE_DISMISS_COOLDOWN_MS) {
		return true;
	}
	return false;
}

export function suppressedTypesFromRecords(records: NudgeRecord[], now: number): Set<string> {
	const suppressed = new Set<string>();
	for (const record of records) {
		if (shouldSuppressNudgeRecord(record, now)) {
			suppressed.add(record.type);
		}
	}
	return suppressed;
}

export async function shouldSuppressNudgeType(store: NudgeHistoryStore, type: string, now: number): Promise<boolean> {
	const recent = await store.listByType(type, 10);
	return recent.some(record => shouldSuppressNudgeRecord(record, now));
}

export class NudgeSuppressionCache {
	#suppressedTypes = new Set<string>();

	isSuppressed(type: string): boolean {
		return this.#suppressedTypes.has(type);
	}

	/** Build suppression set from recent history (one query). */
	async refreshFromRecent(store: NudgeHistoryStore, limit = 80): Promise<void> {
		const now = Date.now();
		const recent = await store.listRecent(limit);
		this.#suppressedTypes = suppressedTypesFromRecords(recent, now);
	}

	clear(): void {
		this.#suppressedTypes.clear();
	}
}

export function crossSessionNudgeToNudge(cross: CrossSessionNudge): Nudge {
	return {
		type: cross.type,
		severity: cross.severity,
		message: cross.message,
		suggestion: cross.suggestion,
	};
}
