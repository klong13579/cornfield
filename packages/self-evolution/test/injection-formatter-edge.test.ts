import { describe, expect, test } from "bun:test";
import type { RetrievedEpisode } from "../src/context-aware-retriever";
import { InjectionFormatter } from "../src/injection-formatter";
import type { Episode, Learning } from "../src/types";

describe("InjectionFormatter edge cases (IF-02, IF-03)", () => {
	const formatter = new InjectionFormatter();

	function makeLearning(content: string): Learning {
		return {
			id: `l-${content.slice(0, 8)}`,
			cwd: "/test",
			kind: "preference",
			content,
			source: "manual_pin",
			confidence: 80,
			lifecycle: "active",
			sessionId: "s1",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			timesInjected: 0,
			timesHelped: 0,
			timesIgnored: 0,
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

	test("IF-02: output is truncated when exceeding token budget", () => {
		const learnings: Learning[] = [];
		for (let i = 0; i < 50; i++) {
			learnings.push(
				makeLearning(
					`This is a very long learning text that should eventually cause truncation when there are enough of them numbered ${i}`,
				),
			);
		}

		const result = formatter.formatInjection([], [], undefined, undefined, { maxTokens: 500 }, learnings);
		expect(result.length).toBeLessThanOrEqual(2100);
		expect(result).toContain("... (truncated");
	});

	test("IF-02: output is NOT truncated when under budget", () => {
		const learnings = [makeLearning("Short rule")];
		const result = formatter.formatInjection([], [], undefined, undefined, { maxTokens: 2000 }, learnings);
		expect(result.length).toBeLessThan(8000);
		expect(result).not.toContain("... (truncated");
	});

	test("IF-03: episode with relevanceScore=30 and helpRate=0.3 is excluded", () => {
		const episodes = [makeRetrievedEpisode(makeEpisode({ id: "ep-low" }), 30, 0.3)];
		const result = formatter.formatInjection(episodes, [], undefined, undefined, {}, []);
		expect(result).not.toContain("ep-low");
		expect(result).not.toContain("Episodic Context");
	});

	test("IF-03: episode with relevanceScore=50 and helpRate=0.3 is included (score >= 40)", () => {
		const episodes = [makeRetrievedEpisode(makeEpisode({ id: "ep-mid", summary: "Mid score episode" }), 50, 0.3)];
		const result = formatter.formatInjection(episodes, [], undefined, undefined, {}, []);
		expect(result).toContain("Episodic Context");
		expect(result).toContain("Mid score episode");
	});

	test("IF-03: episode with relevanceScore=30 and helpRate=0.6 is included (helpRate > 0.5)", () => {
		const episodes = [makeRetrievedEpisode(makeEpisode({ id: "ep-help", summary: "Helpful episode" }), 30, 0.6)];
		const result = formatter.formatInjection(episodes, [], undefined, undefined, {}, []);
		expect(result).toContain("Episodic Context");
		expect(result).toContain("Helpful episode");
	});

	test("IF-03: mixed episodes — some filtered, some included", () => {
		const episodes = [
			makeRetrievedEpisode(makeEpisode({ id: "ep-bad", summary: "Bad episode" }), 20, 0.1),
			makeRetrievedEpisode(makeEpisode({ id: "ep-good", summary: "Good episode" }), 80, 0.8),
		];
		const result = formatter.formatInjection(episodes, [], undefined, undefined, {}, []);
		expect(result).toContain("Good episode");
		expect(result).not.toContain("Bad episode");
	});
});
