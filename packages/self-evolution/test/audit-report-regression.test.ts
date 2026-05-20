import { describe, expect, test } from "bun:test";
import { type AuditReport, formatAuditReport } from "../src/audit-report";

function minimalReport(overrides: Partial<AuditReport> = {}): AuditReport {
	return {
		generatedAt: Date.now(),
		episodes: {
			total: 0,
			maxAllowed: 100,
			atCapacity: false,
			successRate: 0,
			avgToolCalls: 0,
			avgErrors: 0,
		},
		skills: { total: 0, deprecated: 0, names: [], qualityScores: [] },
		effectiveness: {
			episodesTracked: 0,
			totalInjections: 0,
			totalHelped: 0,
			helpRate: 0,
			skillsTracked: 0,
		},
		intents: [],
		workflows: { totalPatterns: 0, meaningfulPatterns: 0 },
		conventions: { total: 0, byType: {} },
		learnings: {
			total: 0,
			byLifecycle: {},
			active: 0,
			pinned: 0,
			totalInjected: 0,
			totalHelped: 0,
		},
		profile: { sessionCount: 0, errorRate: 0, topIntent: "—" },
		nudges: {
			total: 0,
			contextInjected: 0,
			outcomesRecorded: 0,
			helpRate: 0,
			repeatRate: 0,
		},
		escalations: { open: 0, total: 0, recent: [] },
		admission: {
			learningsByLifecycle: { active: 2 },
			conventionsByLifecycle: {},
			regressionKeep: 2,
			regressionDiscard: 1,
			regressionPending: 0,
			regressionFixtureCount: 5,
			sessionTraceCount: 10,
			trialsByTarget: {
				convention: { keep: 2, discard: 1 },
				skill: { keep: 0, discard: 0 },
			},
			trialsByReplayBackend: { heuristic: 1, llm: 1, subagent: 0 },
			regressionToolchainOverturns: 1,
			regressionToolchainConfirm: 2,
			regressionToolchainOnly: 0,
			recentTrials: [
				{
					id: "t1",
					targetType: "convention",
					targetId: "c1",
					verdict: "keep",
					reason: "[replay:llm] [toolchain:confirm] Matches ENOENT read failure",
					createdAt: Date.now(),
				},
			],
			skillsDeprecated: 0,
			nudgesDismissed: 0,
			nudgesAcknowledged: 0,
		},
		runtime: {
			regressionReplayBackend: "llm",
			admissionReclassifyInterval: 5,
		},
		issues: [],
		recommendations: [],
		...overrides,
	};
}

describe("formatAuditReport regression section", () => {
	test("includes backend, fixture counts, and recent trials", () => {
		const text = formatAuditReport(minimalReport());
		expect(text).toContain("### Regression");
		expect(text).toContain("Regression fixtures: 5");
		expect(text).toContain("Session traces");
	});
});
