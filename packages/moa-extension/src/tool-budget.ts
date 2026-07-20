/**
 * Research-stage tool budget: count only `web_search`, soft-trip then hard-abort.
 * See docs/plans/2026-07-18-moa-research-soft-stop-design.md.
 */

export type ToolBudgetDecision = "ok" | "soft_trip" | "hard_abort";

export interface WebSearchToolBudgetOptions {
	/** Max allowed `web_search` starts. 0 = unlimited. */
	maxWebSearches: number;
	/** After soft_trip, abort if the agent has not finished within this window. */
	softAbortMs: number;
	onSoftAbort: () => void;
}

export interface WebSearchToolBudget {
	readonly exceeded: boolean;
	readonly searchCount: number;
	onToolStart(toolName: string): ToolBudgetDecision;
	dispose(): void;
}

const SEARCH_TOOL = "web_search";

export function createWebSearchToolBudget(options: WebSearchToolBudgetOptions): WebSearchToolBudget {
	const max = Math.max(0, Math.floor(options.maxWebSearches));
	const softAbortMs = Math.max(0, Math.floor(options.softAbortMs));
	let searchCount = 0;
	let exceeded = false;
	let softTimer: ReturnType<typeof setTimeout> | undefined;
	let disposed = false;

	const scheduleSoftAbort = () => {
		if (softAbortMs <= 0 || softTimer !== undefined || disposed) return;
		softTimer = setTimeout(() => {
			if (!disposed) options.onSoftAbort();
		}, softAbortMs);
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
			if (name !== SEARCH_TOOL) return "ok";

			searchCount += 1;
			if (searchCount <= max) return "ok";

			if (!exceeded) {
				exceeded = true;
				scheduleSoftAbort();
				return "soft_trip";
			}
			return "hard_abort";
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

/** Default soft window after the last allowed web_search — let the model emit the pack. */
export const RESEARCH_SOFT_ABORT_MS = 90_000;
