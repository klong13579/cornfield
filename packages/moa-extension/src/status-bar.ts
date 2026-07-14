/**
 * MOA TUI status-bar formatter (design §7.3).
 *
 * Example: `Round 2/3 · asking question 3/5 · divergent OK · grounded OK · critical BLOCKED`
 */

import { formatDuration } from "./timing";

export type MoaStatusPhase = "discovery" | "rewrite" | "workers" | "asking" | "synthesis";

export interface MoaStatusWorker {
	name: string;
	ok: boolean;
	qualityDropped?: boolean;
}

export interface MoaStatusBarInput {
	round: number;
	maxRounds: number;
	phase: MoaStatusPhase;
	/** 1-based index into the current ask list (asking phase only). */
	questionIndex?: number;
	questionTotal?: number;
	workers?: ReadonlyArray<MoaStatusWorker>;
	/** Optional wall-clock elapsed for the active stage (live ticker). */
	elapsedMs?: number;
}

export function formatWorkerStatusLabel(worker: MoaStatusWorker): string {
	if (worker.qualityDropped) return `${worker.name} BLOCKED`;
	if (worker.ok) return `${worker.name} OK`;
	return `${worker.name} FAIL`;
}

export function formatMoaStatusBar(input: MoaStatusBarInput): string {
	const maxRounds = Math.max(0, input.maxRounds);
	const round = Math.max(1, input.round);
	const parts: string[] = [`Round ${round}/${maxRounds || round}`];

	if (input.phase === "asking") {
		const total = Math.max(0, input.questionTotal ?? 0);
		const index = Math.min(Math.max(1, input.questionIndex ?? 1), Math.max(total, 1));
		parts.push(`asking question ${index}/${total}`);
	} else if (input.phase === "workers") {
		parts.push("running workers");
	} else {
		parts.push(input.phase);
	}

	if (input.elapsedMs !== undefined) {
		parts.push(formatDuration(input.elapsedMs));
	}

	if (input.workers && input.workers.length > 0) {
		for (const w of input.workers) {
			parts.push(formatWorkerStatusLabel(w));
		}
	}

	return parts.join(" · ");
}
