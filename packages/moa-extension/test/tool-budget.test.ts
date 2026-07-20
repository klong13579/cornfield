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

	it("maxWebSearches=0 disables the budget", () => {
		const onSoftAbort = vi.fn();
		const ctl = createWebSearchToolBudget({ maxWebSearches: 0, softAbortMs: 10, onSoftAbort });
		for (let i = 0; i < 20; i++) expect(ctl.onToolStart("web_search")).toBe("ok");
		expect(ctl.exceeded).toBe(false);
		ctl.dispose();
	});
});
