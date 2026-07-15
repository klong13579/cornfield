import { describe, expect, it } from "bun:test";
import { DEFAULT_SETTINGS, resolveSettings } from "../src/settings";

describe("DEFAULT_SETTINGS (PR2 multi-round)", () => {
	it("exposes the design-locked multi-round defaults", () => {
		expect(DEFAULT_SETTINGS.maxRounds).toBe(1);
		expect(DEFAULT_SETTINGS.maxQuestionsPerRound).toBe(5);
		expect(DEFAULT_SETTINGS.qualityMinScore).toBe(40);
	});
});

describe("DEFAULT_SETTINGS — quality v2", () => {
	it("has judge disabled by default", () => {
		expect(DEFAULT_SETTINGS.quality.judge.enabled).toBe(false);
	});
	it("uses the design-locked judge model", () => {
		expect(DEFAULT_SETTINGS.quality.judge.model).toBe("narwal-plan/minimax-m3");
	});
});

describe("resolveSettings — quality judge clamping", () => {
	it("clamps negative grayMargin to 0", () => {
		expect(resolveSettings({ quality: { judge: { grayMargin: -5 } } }).quality.judge.grayMargin).toBe(0);
	});
	it("clamps negative timeoutMs to 0", () => {
		expect(resolveSettings({ quality: { judge: { timeoutMs: -1000 } } }).quality.judge.timeoutMs).toBe(0);
	});
	it("falls back unknown judge mode to hybrid", () => {
		const s = resolveSettings({
			quality: { judge: { mode: "unknown" as "hybrid" } },
		});
		expect(s.quality.judge.mode).toBe("hybrid");
	});
	it("partial quality merge keeps judge defaults", () => {
		const s = resolveSettings({ quality: { judge: { enabled: true } } });
		expect(s.quality.judge.enabled).toBe(true);
		expect(s.quality.judge.model).toBe("narwal-plan/minimax-m3");
		expect(s.quality.judge.grayMargin).toBe(10);
		expect(s.quality.judge.timeoutMs).toBe(60_000);
		expect(s.quality.judge.onError).toBe("keep_heuristic");
		expect(s.quality.judge.mode).toBe("hybrid");
	});
});

describe("resolveSettings — multi-round clamping", () => {
	it("clamps negative maxRounds to 0", () => {
		expect(resolveSettings({ maxRounds: -2 }).maxRounds).toBe(0);
	});
	it("rounds non-integer maxRounds down", () => {
		expect(resolveSettings({ maxRounds: 2.9 }).maxRounds).toBe(2);
	});
	it("clamps qualityMinScore into [0, 100]", () => {
		expect(resolveSettings({ qualityMinScore: -10 }).qualityMinScore).toBe(0);
		expect(resolveSettings({ qualityMinScore: 250 }).qualityMinScore).toBe(100);
		expect(resolveSettings({ qualityMinScore: 55 }).qualityMinScore).toBe(55);
	});
	it("respects a clean override", () => {
		const s = resolveSettings({ maxRounds: 1, maxQuestionsPerRound: 2, qualityMinScore: 80 });
		expect(s.maxRounds).toBe(1);
		expect(s.maxQuestionsPerRound).toBe(2);
		expect(s.qualityMinScore).toBe(80);
	});
});

// ----------------------------------------------------------------------------
// Priority: PI_MOA_SETTINGS_JSON (env) > moa.yml config file > defaults
//
// Regression: a user-level moa.yml on the developer's box was silently winning
// over the test's PI_MOA_SETTINGS_JSON override, because the spread in
// resolveSettings put the env-var first and the file override second. The
// documented priority is env > config > default.
// ----------------------------------------------------------------------------
describe("resolveSettings — priority (env > config file > default)", () => {
	const ORIGINAL_ENV = process.env.PI_MOA_SETTINGS_JSON;
	function setEnv(value: string | undefined): void {
		if (value === undefined) delete process.env.PI_MOA_SETTINGS_JSON;
		else process.env.PI_MOA_SETTINGS_JSON = value;
		Bun.env.PI_MOA_SETTINGS_JSON = value;
	}
	it("env wins over a config-file override on the same field", () => {
		setEnv(
			JSON.stringify({
				workers: [
					{ name: "divergent", model: "minimax-m3" },
					{ name: "grounded", model: "kimi-k2.5" },
					{ name: "critical", model: "glm-5-turbo" },
				],
			}),
		);
		try {
			const s = resolveSettings({
				workers: [
					{ name: "divergent", role: "x", model: "narwal-plan/qwen3.5-flash" },
					{ name: "grounded", role: "y", model: "alibaba-coding-plan/deepseek-v4-pro" },
					{ name: "critical", role: "z", model: "alibaba-coding-plan/kimi-k2.6" },
				],
			});
			expect(s.workers.map(w => w.model)).toEqual(["minimax-m3", "kimi-k2.5", "glm-5-turbo"]);
		} finally {
			setEnv(ORIGINAL_ENV);
		}
	});
	it("config-file override applies when env is absent", () => {
		setEnv(undefined);
		try {
			const s = resolveSettings({ synthesisModel: "alibaba-coding-plan/kimi-k2.6" });
			expect(s.synthesisModel).toBe("alibaba-coding-plan/kimi-k2.6");
		} finally {
			setEnv(ORIGINAL_ENV);
		}
	});
});
