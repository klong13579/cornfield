import { describe, expect, it } from "bun:test";
import { formatMoaStatusBar, formatWorkerStatusLabel } from "../src/status-bar";

describe("formatMoaStatusBar", () => {
	it("matches design §7.3 asking format with worker labels", () => {
		const text = formatMoaStatusBar({
			round: 2,
			maxRounds: 3,
			phase: "asking",
			questionIndex: 3,
			questionTotal: 5,
			workers: [
				{ name: "divergent", ok: true },
				{ name: "grounded", ok: true },
				{ name: "critical", ok: true, qualityDropped: true },
			],
		});
		expect(text).toBe("Round 2/3 · asking question 3/5 · divergent OK · grounded OK · critical BLOCKED");
	});

	it("formats workers phase", () => {
		const text = formatMoaStatusBar({
			round: 1,
			maxRounds: 3,
			phase: "workers",
			workers: [{ name: "divergent", ok: true }],
		});
		expect(text).toBe("Round 1/3 · running workers · divergent OK");
	});

	it("formats FAIL when worker is not ok and not dropped", () => {
		expect(formatWorkerStatusLabel({ name: "grounded", ok: false })).toBe("grounded FAIL");
	});

	it("appends elapsed duration when elapsedMs is set", () => {
		const text = formatMoaStatusBar({
			round: 1,
			maxRounds: 3,
			phase: "discovery",
			elapsedMs: 3_200,
		});
		expect(text).toBe("Round 1/3 · discovery · 3.2s");
	});
});
