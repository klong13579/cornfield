import { describe, expect, it } from "bun:test";
import { formatDuration, formatTimingSummary, StageClock } from "../src/timing";

describe("formatDuration", () => {
	it("formats sub-second as tenths", () => {
		expect(formatDuration(0)).toBe("0.0s");
		expect(formatDuration(320)).toBe("0.3s");
		expect(formatDuration(1230)).toBe("1.2s");
	});

	it("formats whole seconds without unnecessary noise", () => {
		expect(formatDuration(12_300)).toBe("12.3s");
		expect(formatDuration(81_200)).toBe("81.2s");
	});
});

describe("StageClock", () => {
	it("records elapsed per stage and total", () => {
		const clock = new StageClock(() => 1_000);
		clock.start("discovery");
		clock.now = () => 1_000 + 12_300;
		expect(clock.elapsedMs("discovery")).toBe(12_300);
		clock.stop("discovery");
		expect(clock.get("discovery")).toBe(12_300);

		clock.start("ask");
		clock.now = () => 1_000 + 12_300 + 4_000;
		clock.stop("ask");
		expect(clock.get("ask")).toBe(4_000);

		clock.markTotalStart(1_000);
		clock.now = () => 1_000 + 81_200;
		clock.stopTotal();
		expect(clock.get("total")).toBe(81_200);
	});

	it("accumulates workers_rN into workers", () => {
		const clock = new StageClock(() => 0);
		clock.start("workers_r1");
		clock.now = () => 22_000;
		clock.stop("workers_r1");
		clock.start("workers_r2");
		clock.now = () => 22_000 + 19_200;
		clock.stop("workers_r2");
		expect(clock.get("workers_r1")).toBe(22_000);
		expect(clock.get("workers_r2")).toBe(19_200);
		expect(clock.get("workers")).toBe(41_200);
	});
});

describe("formatTimingSummary", () => {
	it("renders the design summary block", () => {
		const text = formatTimingSummary({
			discovery: 12_300,
			ask: 4_000,
			rewrite: 8_100,
			workers: 41_200,
			workers_r1: 22_000,
			workers_r2: 19_200,
			synthesis: 15_600,
			total: 81_200,
		});
		expect(text).toContain("MOA 耗时");
		expect(text).toContain("discovery");
		expect(text).toContain("12.3s");
		expect(text).toContain("workers");
		expect(text).toContain("41.2s");
		expect(text).toContain("r1 22.0s");
		expect(text).toContain("r2 19.2s");
		expect(text).toContain("total");
		expect(text).toContain("81.2s");
	});

	it("omits round breakdown when only one workers round", () => {
		const text = formatTimingSummary({
			discovery: 1_000,
			ask: 0,
			rewrite: 0,
			workers: 5_000,
			workers_r1: 5_000,
			synthesis: 2_000,
			total: 8_000,
		});
		expect(text).toContain("workers");
		expect(text).not.toContain("r1");
	});
});
