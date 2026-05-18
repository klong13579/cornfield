import { describe, expect, test } from "bun:test";
import { refreshAdmissionAfterSessionEnd } from "../src/benefit-admission-refresh";
import { HeuristicRegressionReplayBackend } from "../src/regression/replay-backend";
import type {
	RegressionFixtureStore,
	RegressionTrialStore,
	SkillEffectivenessStore,
	SkillStore,
} from "../src/storage/types";
import type { EvolvedSkill, SkillEffectiveness } from "../src/types";

function emptyFixtureStore(): RegressionFixtureStore {
	return {
		list: async () => [],
	} as unknown as RegressionFixtureStore;
}

describe("refreshAdmissionAfterSessionEnd", () => {
	test("V3 session admission is skill-only (no convention reclassify)", async () => {
		const result = await refreshAdmissionAfterSessionEnd({
			skillStore: { list: async () => [] } as unknown as SkillStore,
			skillEffectivenessStore: { get: async () => undefined } as unknown as SkillEffectivenessStore,
			fixtureStore: emptyFixtureStore(),
			trialStore: { insert: async () => {} } as unknown as RegressionTrialStore,
			replayBackend: new HeuristicRegressionReplayBackend(),
			regressionReplayBackend: "llm",
			sessionOrdinal: 5,
		});

		expect(result.conventionsReclassified).toBe(0);
		expect(result.conventionsPromoted).toBe(0);
	});

	test("deprecates skills with poor injection stats", async () => {
		const skill: EvolvedSkill = {
			name: "bad-skill",
			description: "test",
			taskPattern: "test",
			approach: "x",
			tools: [],
			pitfalls: [],
			createdAt: Date.now(),
			usageCount: 0,
			lastUsedAt: 0,
			successCount: 0,
			failureCount: 0,
			version: 1,
			deprecated: false,
		};
		let upserted = false;
		const skillStore = {
			list: async () => [skill],
			upsert: async (s: EvolvedSkill) => {
				upserted = true;
				expect(s.deprecated).toBe(true);
			},
		} as unknown as SkillStore;
		const eff: SkillEffectiveness = {
			skillName: "bad-skill",
			timesInjected: 10,
			timesHelped: 1,
			timesFailed: 9,
			lastInjectedAt: Date.now(),
		};
		const skillEffectivenessStore = {
			get: async () => eff,
		} as unknown as SkillEffectivenessStore;

		const result = await refreshAdmissionAfterSessionEnd({
			skillStore,
			skillEffectivenessStore,
			regressionReplayBackend: "heuristic",
			sessionOrdinal: 1,
		});

		expect(upserted).toBe(true);
		expect(result.skillsDeprecated).toBe(1);
	});
});
