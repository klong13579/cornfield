/**
 * Tracks whether injected nudges correlated with improved tool behavior.
 */
import { NudgeDetector } from "./nudge-detector";
import type { NudgeHistoryStore } from "./storage/types";
import type { QueuedAgentNudge, SessionTrace, TraceEntry } from "./types";

interface ActiveInjection {
	historyId: string;
	nudgeType: string;
	injectedAt: number;
	postToolCalls: number;
}

export class NudgeEffectivenessTracker {
	#active: ActiveInjection[] = [];

	registerInjected(queued: QueuedAgentNudge[], injectedAt: number): void {
		for (const item of queued) {
			this.#active.push({
				historyId: item.historyId,
				nudgeType: item.nudge.type,
				injectedAt,
				postToolCalls: 0,
			});
		}
	}

	onToolExecution(): void {
		for (const item of this.#active) {
			item.postToolCalls++;
		}
	}

	async finalizeSession(trace: SessionTrace, store: NudgeHistoryStore): Promise<void> {
		const scoredIds = new Set<string>();

		for (const item of this.#active) {
			await this.#recordOutcomeForInjection(trace, store, {
				historyId: item.historyId,
				nudgeType: item.nudgeType,
				injectedAt: item.injectedAt,
				postToolCalls: item.postToolCalls,
			});
			scoredIds.add(item.historyId);
		}
		this.#active = [];

		const unscored = await store.listUnscoredInjectedForSession(trace.sessionId);
		for (const record of unscored) {
			if (scoredIds.has(record.id)) continue;
			const injectedAt = record.injectedAt ?? record.detectedAt;
			const postToolCalls =
				record.postToolCalls && record.postToolCalls > 0
					? record.postToolCalls
					: countPostToolCalls(trace, injectedAt);
			await this.#recordOutcomeForInjection(trace, store, {
				historyId: record.id,
				nudgeType: record.type,
				injectedAt,
				postToolCalls,
			});
		}
	}

	clear(): void {
		this.#active = [];
	}

	async #recordOutcomeForInjection(
		trace: SessionTrace,
		store: NudgeHistoryStore,
		item: { historyId: string; nudgeType: string; injectedAt: number; postToolCalls: number },
	): Promise<void> {
		const slice = sliceTraceAfter(trace, item.injectedAt);
		const repeated = didNudgePatternRepeat(item.nudgeType, slice);
		const outcomeScore = scoreNudgeOutcome(trace, repeated);
		await store.recordOutcome(item.historyId, {
			postToolCalls: item.postToolCalls,
			patternRepeated: repeated,
			outcomeScore,
		});
	}
}

export function countPostToolCalls(trace: SessionTrace, afterMs: number): number {
	let count = 0;
	for (const entry of trace.entries) {
		if (entry.timestamp >= afterMs && entry.type === "tool_call") {
			count++;
		}
	}
	return count;
}

export function sliceTraceAfter(trace: SessionTrace, afterMs: number): SessionTrace {
	const entries = trace.entries.filter(e => e.timestamp >= afterMs);
	let toolCallCount = 0;
	let errorCount = 0;
	for (const entry of entries) {
		if (entry.type === "tool_call") toolCallCount++;
		if (entry.type === "tool_result" && entry.isError) errorCount++;
	}
	return {
		...trace,
		entries,
		toolCallCount,
		errorCount,
		hadRecovery: false,
		completedSuccessfully: trace.completedSuccessfully,
	};
}

export function didNudgePatternRepeat(nudgeType: string, slice: SessionTrace): boolean {
	if (slice.entries.length === 0) return false;
	const detector = new NudgeDetector();
	const again = detector.check(slice);
	return again?.type === nudgeType;
}

export function scoreNudgeOutcome(trace: SessionTrace, patternRepeated: boolean): number {
	if (patternRepeated) return -0.6;
	if (trace.completedSuccessfully && trace.errorCount === 0) return 0.5;
	if (trace.hadRecovery) return 0.2;
	if (trace.errorCount > 0) return -0.2;
	return 0;
}

/** @internal Exported for tests */
export function buildMinimalTraceFromEntries(base: SessionTrace, entries: TraceEntry[]): SessionTrace {
	return sliceTraceAfter({ ...base, entries: [...base.entries, ...entries] }, entries[0]?.timestamp ?? base.startTime);
}
