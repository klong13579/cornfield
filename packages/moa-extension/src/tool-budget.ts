/**
 * Research-stage tool budget: count only `web_search`, soft-trip then hard-abort.
 * See docs/plans/2026-07-18-moa-research-soft-stop-design.md.
 */

export type ToolBudgetDecision = "ok" | "soft_trip" | "hard_abort";

export interface WebSearchToolBudgetOptions {
	/** Max allowed counted tool starts. 0 = unlimited. */
	maxWebSearches: number;
	/**
	 * Soft-trip after this many searches even if `maxWebSearches` is higher.
	 * 0 = disabled (only trip past max). Default callers pass 3 for research.
	 */
	earlyStopAt?: number;
	/** After soft_trip, abort if the agent has not finished within this window. */
	softAbortMs: number;
	/** Soft window when earlyStopAt trips (defaults to softAbortMs). */
	earlySoftAbortMs?: number;
	onSoftAbort: () => void;
	/** Fired on each counted tool start after the count increments (including over-budget). */
	onWebSearch?: (info: { count: number; max: number }) => void;
	/**
	 * Which tools increment the budget. Default `"web_search"` (research stage).
	 * Pass `"*"` to count every tool start (plan-worker round caps).
	 */
	countedTool?: string | "*";
}

export interface WebSearchToolBudget {
	readonly exceeded: boolean;
	readonly searchCount: number;
	onToolStart(toolName: string): ToolBudgetDecision;
	/** Soft-trip early once enough evidence URLs were collected (idempotent). */
	signalEnoughEvidence(): void;
	dispose(): void;
}

const SEARCH_TOOL = "web_search";

export function createWebSearchToolBudget(options: WebSearchToolBudgetOptions): WebSearchToolBudget {
	const max = Math.max(0, Math.floor(options.maxWebSearches));
	const earlyStopAt = Math.max(0, Math.floor(options.earlyStopAt ?? 0));
	const softAbortMs = Math.max(0, Math.floor(options.softAbortMs));
	const earlySoftAbortMs = Math.max(0, Math.floor(options.earlySoftAbortMs ?? softAbortMs));
	const countedTool = options.countedTool ?? SEARCH_TOOL;
	/** Effective trip point: earlyStopAt when set and below max, else max. */
	const tripAfter = max > 0 && earlyStopAt > 0 ? Math.min(earlyStopAt, max) : max;
	let searchCount = 0;
	let exceeded = false;
	let softTimer: ReturnType<typeof setTimeout> | undefined;
	let disposed = false;

	const scheduleSoftAbort = (ms: number) => {
		if (ms <= 0 || softTimer !== undefined || disposed) return;
		softTimer = setTimeout(() => {
			if (!disposed) options.onSoftAbort();
		}, ms);
	};

	const trip = (windowMs: number): ToolBudgetDecision => {
		if (!exceeded) {
			exceeded = true;
			scheduleSoftAbort(windowMs);
			return "soft_trip";
		}
		return "hard_abort";
	};

	const shouldCount = (toolName: string): boolean => {
		if (countedTool === "*") return toolName.length > 0;
		return toolName === countedTool;
	};

	return {
		get exceeded() {
			return exceeded;
		},
		get searchCount() {
			return searchCount;
		},
		onToolStart(toolName: string): ToolBudgetDecision {
			if (disposed || max <= 0) return "ok";
			const name = toolName.trim();
			if (!shouldCount(name)) return "ok";

			searchCount += 1;
			options.onWebSearch?.({ count: searchCount, max: tripAfter > 0 ? tripAfter : max });
			if (searchCount <= tripAfter && !exceeded) return "ok";

			const windowMs = earlyStopAt > 0 && searchCount === tripAfter + 1 ? earlySoftAbortMs : softAbortMs;
			return trip(windowMs);
		},
		signalEnoughEvidence() {
			if (disposed || exceeded || max <= 0) return;
			trip(earlySoftAbortMs);
		},
		dispose() {
			disposed = true;
			if (softTimer !== undefined) {
				clearTimeout(softTimer);
				softTimer = undefined;
			}
		},
	};
}

/** Default soft window after budget trip — emit pack quickly, don't wait 90s. */
export const RESEARCH_SOFT_ABORT_MS = 25_000;

/** Soft window when early-stop / enough-evidence trips. */
export const RESEARCH_EARLY_SOFT_ABORT_MS = 15_000;

/** Unique URLs from tool traces that trigger signalEnoughEvidence. */
export const RESEARCH_ENOUGH_URLS = 3;
