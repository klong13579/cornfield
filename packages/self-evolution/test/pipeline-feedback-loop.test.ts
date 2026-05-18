import { describe, expect, test } from "bun:test";
import { FeedbackTracker } from "../src/feedback-tracker";
import type { DetailedOutcomeStore, EffectivenessStore, SkillEffectivenessStore } from "../src/storage/types";
import type { InjectionOutcome, SessionTrace } from "../src/types";

class MockEffectivenessStore implements EffectivenessStore {
	#data = new Map<string, { injected: number; helped: number; failed: number }>();

	async get(episodeId: string) {
		const d = this.#data.get(episodeId);
		if (!d) return undefined;
		return {
			episodeId,
			timesInjected: d.injected,
			timesHelped: d.helped,
			timesFailed: d.failed,
		};
	}

	async recordInjection(episodeId: string): Promise<void> {
		const d = this.#data.get(episodeId) ?? { injected: 0, helped: 0, failed: 0 };
		d.injected++;
		this.#data.set(episodeId, d);
	}

	async recordOutcome(episodeId: string, helped: boolean): Promise<void> {
		const d = this.#data.get(episodeId) ?? { injected: 0, helped: 0, failed: 0 };
		if (helped) d.helped++;
		else d.failed++;
		this.#data.set(episodeId, d);
	}

	async getMany(episodeIds: string[]) {
		const results = [];
		for (const episodeId of episodeIds) {
			const row = await this.get(episodeId);
			if (row) results.push(row);
		}
		return results;
	}
}

class MockSkillEffectivenessStore implements SkillEffectivenessStore {
	#data = new Map<string, { injected: number; helped: number; failed: number }>();

	async get(skillName: string) {
		const d = this.#data.get(skillName);
		if (!d) return undefined;
		return {
			skillName,
			timesInjected: d.injected,
			timesHelped: d.helped,
			timesFailed: d.failed,
			lastInjectedAt: 0,
		};
	}

	async recordInjection(skillName: string): Promise<void> {
		const d = this.#data.get(skillName) ?? { injected: 0, helped: 0, failed: 0 };
		d.injected++;
		this.#data.set(skillName, d);
	}

	async recordOutcome(skillName: string, succeeded: boolean): Promise<void> {
		const d = this.#data.get(skillName) ?? { injected: 0, helped: 0, failed: 0 };
		if (succeeded) d.helped++;
		else d.failed++;
		this.#data.set(skillName, d);
	}
}

class MockDetailedOutcomeStore implements DetailedOutcomeStore {
	#records: InjectionOutcome[] = [];

	async record(outcome: InjectionOutcome): Promise<void> {
		this.#records.push(outcome);
	}

	async query(episodeId: string): Promise<InjectionOutcome[]> {
		return this.#records.filter(r => r.episodeId === episodeId);
	}

	async get(episodeId: string): Promise<InjectionOutcome | undefined> {
		return this.#records.find(r => r.episodeId === episodeId);
	}

	async listRecent(limit: number): Promise<InjectionOutcome[]> {
		return this.#records.slice(-limit);
	}
}

describe("Pipeline: Feedback loop", () => {
	test("FB-01: episode injection → track → outcome(true) → timesHelped=1", async () => {
		const store = new MockEffectivenessStore();
		const tracker = new FeedbackTracker(store, new MockSkillEffectivenessStore());

		await tracker.trackInjection(["ep-1"]);
		await tracker.recordOutcome(["ep-1"], true);

		const e1 = await store.get("ep-1");
		expect(e1!.timesInjected).toBe(1);
		expect(e1!.timesHelped).toBe(1);
		expect(e1!.timesFailed).toBe(0);
	});

	test("FB-02: episode injection → track → outcome(false) → timesFailed=1", async () => {
		const store = new MockEffectivenessStore();
		const tracker = new FeedbackTracker(store, new MockSkillEffectivenessStore());

		await tracker.trackInjection(["ep-1"]);
		await tracker.recordOutcome(["ep-1"], false);

		const e1 = await store.get("ep-1");
		expect(e1!.timesInjected).toBe(1);
		expect(e1!.timesHelped).toBe(0);
		expect(e1!.timesFailed).toBe(1);
	});

	test("multiple episodes tracked independently", async () => {
		const store = new MockEffectivenessStore();
		const tracker = new FeedbackTracker(store, new MockSkillEffectivenessStore());

		await tracker.trackInjection(["ep-1", "ep-2"]);
		await tracker.recordOutcome(["ep-1"], true);
		await tracker.recordOutcome(["ep-2"], false);

		const e1 = await store.get("ep-1");
		const e2 = await store.get("ep-2");
		expect(e1!.timesHelped).toBe(1);
		expect(e2!.timesFailed).toBe(1);
	});

	test("recordDetailedOutcome maps helpfulness>0 to boolean true", async () => {
		const store = new MockEffectivenessStore();
		const detailed = new MockDetailedOutcomeStore();
		const tracker = new FeedbackTracker(store, new MockSkillEffectivenessStore(), detailed);

		await tracker.recordDetailedOutcome([
			{
				episodeId: "ep-1",
				helpfulness: 0.8,
				hasExplicitCorrection: false,
				hasExplicitApproval: true,
				wasRedundant: false,
				avoidedPreviousErrors: true,
				toolEfficiency: 0.9,
			},
		]);

		const e1 = await store.get("ep-1");
		expect(e1!.timesHelped).toBe(1);
		expect(e1!.timesFailed).toBe(0);

		const detailedRecords = await detailed.query("ep-1");
		expect(detailedRecords.length).toBe(1);
		expect(detailedRecords[0]!.helpfulness).toBe(0.8);
	});

	test("recordDetailedOutcome maps helpfulness<=0 to boolean false", async () => {
		const store = new MockEffectivenessStore();
		const detailed = new MockDetailedOutcomeStore();
		const tracker = new FeedbackTracker(store, new MockSkillEffectivenessStore(), detailed);

		await tracker.recordDetailedOutcome([
			{
				episodeId: "ep-1",
				helpfulness: -0.2,
				hasExplicitCorrection: true,
				hasExplicitApproval: false,
				wasRedundant: false,
				avoidedPreviousErrors: false,
				toolEfficiency: 0.3,
			},
		]);

		const e1 = await store.get("ep-1");
		expect(e1!.timesHelped).toBe(0);
		expect(e1!.timesFailed).toBe(1);
	});

	test("skill injection + outcome updates skill effectiveness", async () => {
		const skillStore = new MockSkillEffectivenessStore();
		const tracker = new FeedbackTracker(new MockEffectivenessStore(), skillStore);

		await tracker.trackSkillInjection(["skill-a"]);

		const trace: SessionTrace = {
			sessionId: "s1",
			cwd: "/test",
			userPrompt: "test",
			startTime: Date.now(),
			endTime: Date.now(),
			toolCallCount: 2,
			errorCount: 0,
			hadRecovery: false,
			completedSuccessfully: true,
			entries: [
				{ type: "tool_call", timestamp: 1, toolName: "read", args: { path: "a.ts" } },
				{ type: "tool_result", timestamp: 2, toolName: "read", result: "ok" },
			],
		};

		await tracker.recordSkillOutcome(["skill-a"], trace);

		const s1 = await skillStore.get("skill-a");
		expect(s1!.timesInjected).toBe(1);
		expect(s1!.timesHelped).toBe(1);
		expect(s1!.timesFailed).toBe(0);
	});

	test("skill outcome falls back to session-level on failure", async () => {
		const skillStore = new MockSkillEffectivenessStore();
		const tracker = new FeedbackTracker(new MockEffectivenessStore(), skillStore);

		await tracker.trackSkillInjection(["skill-b"]);

		const trace: SessionTrace = {
			sessionId: "s1",
			cwd: "/test",
			userPrompt: "test",
			startTime: Date.now(),
			endTime: Date.now(),
			toolCallCount: 2,
			errorCount: 1,
			hadRecovery: false,
			completedSuccessfully: false,
			entries: [
				{ type: "tool_call", timestamp: 1, toolName: "read", args: { path: "a.ts" } },
				{ type: "tool_result", timestamp: 2, toolName: "read", result: "fail", isError: true },
			],
		};

		await tracker.recordSkillOutcome(["skill-b"], trace);

		const s1 = await skillStore.get("skill-b");
		expect(s1!.timesInjected).toBe(1);
		expect(s1!.timesHelped).toBe(0);
		expect(s1!.timesFailed).toBe(1);
	});
});
