import { describe, expect, test } from "bun:test";
import type { RetrievedEpisode } from "../src/context-aware-retriever";
import { InjectionFormatter } from "../src/injection-formatter";
import type { Convention, Episode } from "../src/types";

describe("InjectionFormatter edge cases (IF-02, IF-03)", () => {
	const formatter = new InjectionFormatter();

	function makeConvention(content: string, confidence: number): Convention {
		return {
			id: `c-${content.slice(0, 10)}`,
			type: "preference",
			content,
			sourceEpisodeId: "ep1",
			confidence,
			timesApplied: 0,
			timesViolated: 0,
			createdAt: Date.now(),
			lastSeenAt: Date.now(),
		};
	}

	function makeEpisode(overrides: Partial<Episode> = {}): Episode {
		return {
			id: "ep-1",
			sessionId: "s1",
			cwd: "/test",
			userPrompt: "fix bug",
			timestamp: Date.now(),
			durationMs: 1000,
			toolCallCount: 2,
			errorCount: 0,
			hadRecovery: false,
			completedSuccessfully: true,
			summary: "Fixed the bug",
			toolsUsed: ["read", "edit"],
			filesModified: ["src/foo.ts"],
			...overrides,
		};
	}

	function makeRetrievedEpisode(episode: Episode, relevanceScore: number, helpRate: number): RetrievedEpisode {
		return {
			episode,
			relevanceScore,
			reason: "test",
			timesInjected: 5,
			helpRate,
		};
	}

	// IF-02: Token guard — 截断至 2000 字符
	test("IF-02: output is truncated when exceeding 2000 chars", () => {
		const conventions: Convention[] = [];
		for (let i = 0; i < 50; i++) {
			conventions.push(
				makeConvention(
					`This is a very long convention text that should eventually cause truncation when there are enough of them numbered ${i}`,
					80,
				),
			);
		}

		const result = formatter.formatInjection([], conventions, []);
		expect(result.length).toBeLessThanOrEqual(2050); // ~2000 + truncation suffix
		expect(result).toContain("... (truncated");
	});

	test("IF-02: output is NOT truncated when under 2000 chars", () => {
		const conventions = [makeConvention("Short rule", 90)];
		const result = formatter.formatInjection([], conventions, []);
		expect(result.length).toBeLessThan(2000);
		expect(result).not.toContain("... (truncated");
	});
	// IF-03: episodes 过滤 — relevanceScore < 40 且 helpRate < 0.5 的被过滤
	test("IF-03: episode with relevanceScore=30 and helpRate=0.3 is excluded", () => {
		const episodes = [makeRetrievedEpisode(makeEpisode({ id: "ep-low" }), 30, 0.3)];
		const result = formatter.formatInjection(episodes, [], []);
		expect(result).not.toContain("ep-low");
		expect(result).not.toContain("Relevant Past Experiences");
	});

	test("IF-03: episode with relevanceScore=50 and helpRate=0.3 is included (score >= 40)", () => {
		const episodes = [makeRetrievedEpisode(makeEpisode({ id: "ep-mid", summary: "Mid score episode" }), 50, 0.3)];
		const result = formatter.formatInjection(episodes, [], []);
		expect(result).toContain("Relevant Past Experiences");
		expect(result).toContain("Mid score episode");
	});

	test("IF-03: episode with relevanceScore=30 and helpRate=0.6 is included (helpRate > 0.5)", () => {
		const episodes = [makeRetrievedEpisode(makeEpisode({ id: "ep-help", summary: "Helpful episode" }), 30, 0.6)];
		const result = formatter.formatInjection(episodes, [], []);
		expect(result).toContain("Relevant Past Experiences");
		expect(result).toContain("Helpful episode");
	});

	test("IF-03: mixed episodes — some filtered, some included", () => {
		const episodes = [
			makeRetrievedEpisode(makeEpisode({ id: "ep-bad", summary: "Bad episode" }), 20, 0.1),
			makeRetrievedEpisode(makeEpisode({ id: "ep-good", summary: "Good episode" }), 80, 0.8),
		];
		const result = formatter.formatInjection(episodes, [], []);
		expect(result).toContain("Good episode");
		expect(result).not.toContain("Bad episode");
	});
});
