import { describe, expect, it, vi } from "bun:test";
import { createWebSearchToolBudget } from "../src/tool-budget";

describe("createWebSearchToolBudget", () => {
	it("does not count read/search toward the budget", () => {
		const onSoftAbort = vi.fn();
		const ctl = createWebSearchToolBudget({ maxWebSearches: 2, softAbortMs: 10_000, onSoftAbort });
		expect(ctl.onToolStart("read")).toBe("ok");
		expect(ctl.onToolStart("search")).toBe("ok");
		expect(ctl.onToolStart("find")).toBe("ok");
		expect(ctl.onToolStart("ast_grep")).toBe("ok");
		expect(ctl.exceeded).toBe(false);
		expect(ctl.searchCount).toBe(0);
		ctl.dispose();
	});

	it("soft-trips on the (max+1)th web_search without hard-abort yet", () => {
		const onSoftAbort = vi.fn();
		const ctl = createWebSearchToolBudget({ maxWebSearches: 2, softAbortMs: 10_000, onSoftAbort });
		expect(ctl.onToolStart("web_search")).toBe("ok");
		expect(ctl.onToolStart("web_search")).toBe("ok");
		expect(ctl.onToolStart("web_search")).toBe("soft_trip");
		expect(ctl.exceeded).toBe(true);
		expect(ctl.searchCount).toBe(3);
		expect(onSoftAbort).not.toHaveBeenCalled();
		ctl.dispose();
	});

	it("hard-aborts a further web_search after soft trip", () => {
		const onSoftAbort = vi.fn();
		const ctl = createWebSearchToolBudget({ maxWebSearches: 1, softAbortMs: 10_000, onSoftAbort });
		expect(ctl.onToolStart("web_search")).toBe("ok");
		expect(ctl.onToolStart("web_search")).toBe("soft_trip");
		expect(ctl.onToolStart("web_search")).toBe("hard_abort");
		ctl.dispose();
	});

	it("still allows read after soft trip", () => {
		const ctl = createWebSearchToolBudget({
			maxWebSearches: 1,
			softAbortMs: 10_000,
			onSoftAbort: () => {},
		});
		ctl.onToolStart("web_search");
		ctl.onToolStart("web_search"); // soft_trip
		expect(ctl.onToolStart("read")).toBe("ok");
		ctl.dispose();
	});

	it("fires soft abort after softAbortMs", async () => {
		const onSoftAbort = vi.fn();
		const ctl = createWebSearchToolBudget({ maxWebSearches: 1, softAbortMs: 25, onSoftAbort });
		ctl.onToolStart("web_search");
		ctl.onToolStart("web_search"); // soft_trip schedules abort
		await Bun.sleep(50);
		expect(onSoftAbort).toHaveBeenCalled();
		ctl.dispose();
	});

	it("fires onWebSearch for each web_search start", () => {
		const onWebSearch = vi.fn();
		const ctl = createWebSearchToolBudget({
			maxWebSearches: 2,
			softAbortMs: 10_000,
			onSoftAbort: () => {},
			onWebSearch,
		});
		ctl.onToolStart("read");
		ctl.onToolStart("web_search");
		ctl.onToolStart("web_search");
		expect(onWebSearch).toHaveBeenCalledTimes(2);
		expect(onWebSearch).toHaveBeenNthCalledWith(1, { count: 1, max: 2 });
		expect(onWebSearch).toHaveBeenNthCalledWith(2, { count: 2, max: 2 });
		ctl.dispose();
	});

	it("earlyStopAt soft-trips on the next search after the early cap", async () => {
		const onSoftAbort = vi.fn();
		const ctl = createWebSearchToolBudget({
			maxWebSearches: 8,
			earlyStopAt: 3,
			softAbortMs: 10_000,
			earlySoftAbortMs: 20,
			onSoftAbort,
		});
		expect(ctl.onToolStart("web_search")).toBe("ok");
		expect(ctl.onToolStart("web_search")).toBe("ok");
		expect(ctl.onToolStart("web_search")).toBe("ok");
		expect(ctl.exceeded).toBe(false);
		expect(ctl.onToolStart("web_search")).toBe("soft_trip");
		expect(ctl.exceeded).toBe(true);
		await Bun.sleep(40);
		expect(onSoftAbort).toHaveBeenCalled();
		ctl.dispose();
	});

	it("signalEnoughEvidence schedules soft abort without waiting for more searches", async () => {
		const onSoftAbort = vi.fn();
		const ctl = createWebSearchToolBudget({
			maxWebSearches: 8,
			earlyStopAt: 3,
			softAbortMs: 10_000,
			earlySoftAbortMs: 20,
			onSoftAbort,
		});
		ctl.onToolStart("web_search");
		ctl.signalEnoughEvidence();
		expect(ctl.exceeded).toBe(true);
		await Bun.sleep(40);
		expect(onSoftAbort).toHaveBeenCalled();
		expect(ctl.onToolStart("web_search")).toBe("hard_abort");
		ctl.dispose();
	});

	it("signalEnoughEvidence is a no-op when budget is disabled (maxWebSearches=0)", () => {
		const onSoftAbort = vi.fn();
		const ctl = createWebSearchToolBudget({ maxWebSearches: 0, softAbortMs: 10, onSoftAbort });
		ctl.signalEnoughEvidence();
		expect(ctl.exceeded).toBe(false);
		expect(onSoftAbort).not.toHaveBeenCalled();
		ctl.dispose();
	});

	it("maxWebSearches=0 disables the budget", () => {
		const onSoftAbort = vi.fn();
		const ctl = createWebSearchToolBudget({ maxWebSearches: 0, softAbortMs: 10, onSoftAbort });
		for (let i = 0; i < 20; i++) expect(ctl.onToolStart("web_search")).toBe("ok");
		expect(ctl.exceeded).toBe(false);
		ctl.dispose();
	});

	it("countedTool='*' counts every tool start (plan-worker caps)", () => {
		const ctl = createWebSearchToolBudget({
			maxWebSearches: 2,
			softAbortMs: 10_000,
			onSoftAbort: () => {},
			countedTool: "*",
		});
		expect(ctl.onToolStart("read")).toBe("ok");
		expect(ctl.onToolStart("search")).toBe("ok");
		expect(ctl.onToolStart("find")).toBe("soft_trip");
		expect(ctl.searchCount).toBe(3);
		ctl.dispose();
	});
});
