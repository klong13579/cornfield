import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ActivityLogger } from "../src/logging/activity-logger";
import { SkillManager } from "../src/manager";
import { initSchema } from "../src/storage/db";
import { SqliteSkillStore, SqliteSkillVersionStore } from "../src/storage/skills";
import type { EvolvedSkill, ExtractedSkill, SkillEffectiveness } from "../src/types";

describe("SkillManager lifecycle", () => {
	let db: Database;
	let skillStore: SqliteSkillStore;
	let versionStore: SqliteSkillVersionStore;
	let manager: SkillManager;

	function makeMockActivityLogger(): ActivityLogger {
		return {
			log: async () => {},
			query: async () => [],
			close: async () => {},
		} as any;
	}

	function makeMockEffectivenessStore(
		overrides?: Partial<
			Pick<SkillEffectiveness, "skillName" | "timesInjected" | "timesHelped" | "timesFailed" | "lastInjectedAt">
		>,
	) {
		const baseResult = overrides ? (overrides as SkillEffectiveness) : undefined;
		return {
			get: async (_name: string) => baseResult,
			recordInjection: async () => {},
			recordOutcome: async () => {},
		} as any;
	}

	function makeExtractedSkill(name = "test-skill", overrides?: Partial<ExtractedSkill>): ExtractedSkill {
		return {
			name,
			description: "a test skill",
			taskPattern: "pattern",
			approach: "do this and that".repeat(30),
			tools: ["read", "edit"],
			pitfalls: ["pitfall1"],
			qualityScore: 80,
			llmRefined: false,
			...overrides,
		};
	}

	beforeEach(() => {
		db = new Database(":memory:");
		initSchema(db);
		skillStore = new SqliteSkillStore(db);
		versionStore = new SqliteSkillVersionStore(db);
		manager = new SkillManager(
			skillStore,
			versionStore,
			makeMockActivityLogger(),
			makeMockEffectivenessStore(),
			{} as any, // episodeStore (unused in these tests)
			{ enableVersioning: true, maxVersions: 20 },
			undefined, // populationEngine (unused)
		);
	});

	afterEach(() => {
		db.close();
	});

	// SM-01: New skill integrate creates version=1
	test("SM-01: integrate creates a new skill with version=1", async () => {
		const extracted = makeExtractedSkill("new-skill");
		const result = await manager.integrate(extracted);

		expect(result.name).toBe("new-skill");
		expect(result.version).toBe(1);
		expect(result.usageCount).toBe(1);
		expect(result.successCount).toBe(1);
		expect(result.failureCount).toBe(0);
		expect(result.qualityScore).toBe(80);
		expect(result.deprecated).toBeFalsy();

		const fromStore = await skillStore.get("new-skill");
		expect(fromStore).toBeDefined();
		expect(fromStore!.version).toBe(1);
	});

	// SM-02: Duplicate integrate merges and bumps version
	test("SM-02: duplicate integrate merges skills and bumps version", async () => {
		const extracted1 = makeExtractedSkill("merge-skill", { qualityScore: 70 });
		await manager.integrate(extracted1);

		const existing = await skillStore.get("merge-skill");
		expect(existing!.version).toBe(1);

		const extracted2 = makeExtractedSkill("merge-skill", {
			approach: "better approach string".repeat(50),
			tools: ["read", "edit", "ast_grep"],
			qualityScore: 90,
		});
		const merged = await manager.integrate(extracted2);

		expect(merged.version).toBe(2);
		expect(merged.usageCount).toBe(2);
		expect(merged.tools).toEqual(["read", "edit", "ast_grep"]);
		// Should prefer the longer approach
		expect(merged.approach.length).toBeGreaterThanOrEqual(existing!.approach.length);
	});

	// SM-03: archiveLowQuality deletes low-quality skills (qualityScore<30, usage<1)
	test("SM-03: archiveLowQuality archives skills with quality < 30 and usage < 1", async () => {
		const lowSkill: EvolvedSkill = {
			name: "junk-skill",
			description: "bad",
			taskPattern: "x",
			approach: "y",
			tools: [],
			pitfalls: [],
			createdAt: Date.now(),
			usageCount: 0,
			lastUsedAt: Date.now(),
			successCount: 0,
			failureCount: 0,
			version: 1,
			qualityScore: 20,
		};
		await skillStore.upsert(lowSkill);

		const goodSkill: EvolvedSkill = {
			name: "good-skill",
			description: "great",
			taskPattern: "z",
			approach: "w",
			tools: [],
			pitfalls: [],
			createdAt: Date.now(),
			usageCount: 5,
			lastUsedAt: Date.now(),
			successCount: 5,
			failureCount: 0,
			version: 1,
			qualityScore: 10,
		};
		await skillStore.upsert(goodSkill);

		const archived = await manager.archiveLowQuality();
		expect(archived).toBe(1);

		const junk = await skillStore.get("junk-skill");
		expect(junk!.deprecated).toBe(true);

		const good = await skillStore.get("good-skill");
		expect(good!.usageCount).toBe(5); // unchanged — not archived
	});

	test("archiveLowQuality skips deprecated skills", async () => {
		const depSkill: EvolvedSkill = {
			name: "old-skill",
			description: "ancient",
			taskPattern: "a",
			approach: "b",
			tools: [],
			pitfalls: [],
			createdAt: Date.now(),
			usageCount: 0,
			lastUsedAt: Date.now(),
			successCount: 0,
			failureCount: 0,
			version: 1,
			qualityScore: 10,
			deprecated: true,
		};
		await skillStore.upsert(depSkill);

		const archived = await manager.archiveLowQuality();
		expect(archived).toBe(0);
	});

	// SM-04: rollback restores from version history
	test("SM-04: rollback restores skill to a specific historical version", async () => {
		const extracted1 = makeExtractedSkill("rollback-skill", {
			description: "v1 description",
			approach: "v1 approach".repeat(20),
			qualityScore: 60,
		});
		await manager.integrate(extracted1);

		const extracted2 = makeExtractedSkill("rollback-skill", {
			description: "v2 description",
			approach: "v2 approach".repeat(20),
			qualityScore: 90,
		});
		await manager.integrate(extracted2);

		const current = await skillStore.get("rollback-skill");
		expect(current!.version).toBe(2);
		expect(current!.description).toBe("v2 description");

		const restored = await manager.rollback("rollback-skill", 1);
		expect(restored).toBeDefined();
		expect(restored!.version).toBe(3); // rolled back version + 1
		expect(restored!.description).toBe("v1 description");
		expect(restored!.deprecated).toBe(false);
	});

	test("rollback returns undefined for non-existent version", async () => {
		const result = await manager.rollback("nonexistent", 1);
		expect(result).toBeUndefined();
	});

	// SM-05: deprecate marks skill as deprecated
	test("SM-05: deprecate marks a skill as deprecated", async () => {
		const extracted = makeExtractedSkill("deprecate-me");
		await manager.integrate(extracted);

		await manager.deprecate("deprecate-me", "outdated API");

		const skill = await skillStore.get("deprecate-me");
		expect(skill!.deprecated).toBe(true);
		expect(skill!.deprecationReason).toBe("outdated API");
	});

	test("deprecate on non-existent skill is a no-op", async () => {
		await manager.deprecate("nope", "reason");
		// Should not throw
	});

	// SM-06: auto-deprecate on 3+ failures
	test("SM-06: auto-optimize deprecates when effectiveness shows 3+ failures", async () => {
		const extracted = makeExtractedSkill("fail-skill", { qualityScore: 60 });
		await manager.integrate(extracted);

		// Set up effectiveness store to indicate 3 failures
		const failStore = makeMockEffectivenessStore({
			timesInjected: 5,
			timesHelped: 1,
			timesFailed: 3,
			lastInjectedAt: Date.now(),
		});

		const failManager = new SkillManager(
			skillStore,
			versionStore,
			makeMockActivityLogger(),
			failStore,
			{} as any,
			{ enableVersioning: true, maxVersions: 20 },
			undefined,
		);

		await failManager.autoOptimizeIfNeeded("fail-skill", undefined);

		const skill = await skillStore.get("fail-skill");
		expect(skill!.deprecated).toBe(true);
		expect(skill!.deprecationReason).toContain("Auto-deprecated");
		expect(skill!.deprecationReason).toContain("3 failures");
	});

	// SM-07: Version snapshot on each change (when enableVersioning=true)
	test("SM-07: version snapshot created on initial integration", async () => {
		const extracted = makeExtractedSkill("snapshot-skill");
		await manager.integrate(extracted);

		const history = await manager.getHistory("snapshot-skill");
		expect(history.length).toBeGreaterThanOrEqual(1);
		const snapshot = history.find(h => h.changeType === "extracted");
		expect(snapshot).toBeDefined();
		expect(snapshot!.version).toBe(1);
	});

	test("SM-07: version snapshot created on merge", async () => {
		const extracted1 = makeExtractedSkill("snap-merge");
		await manager.integrate(extracted1);

		const extracted2 = makeExtractedSkill("snap-merge", { tools: ["new-tool"] });
		await manager.integrate(extracted2);

		const history = await manager.getHistory("snap-merge");
		const mergeSnapshots = history.filter(h => h.changeType === "merged");
		expect(mergeSnapshots.length).toBeGreaterThanOrEqual(1);
	});

	test("SM-07: version snapshot created on deprecation", async () => {
		const extracted = makeExtractedSkill("dep-snap");
		await manager.integrate(extracted);

		await manager.deprecate("dep-snap", "bad skill");

		const history = await manager.getHistory("dep-snap");
		const depSnapshot = history.find(h => h.changeType === "deprecated");
		expect(depSnapshot).toBeDefined();
	});

	test("SM-07: version snapshot created on rollback", async () => {
		const extracted1 = makeExtractedSkill("rb-snap", { description: "orig" });
		await manager.integrate(extracted1);
		await manager.integrate(makeExtractedSkill("rb-snap", { description: "new" }));

		await manager.rollback("rb-snap", 1);

		const history = await manager.getHistory("rb-snap");
		const rbSnapshots = history.filter(h => h.changeType === "rolled_back");
		expect(rbSnapshots.length).toBeGreaterThanOrEqual(1);
	});

	// Additional edge cases
	test("integrate without versioning disabled does not create snapshots", async () => {
		const noVerDb = new Database(":memory:");
		initSchema(noVerDb);
		const noVerSkillStore = new SqliteSkillStore(noVerDb);
		const noVerVersionStore = new SqliteSkillVersionStore(noVerDb);
		const noVerManager = new SkillManager(
			noVerSkillStore,
			noVerVersionStore,
			makeMockActivityLogger(),
			makeMockEffectivenessStore(),
			{} as any,
			{ enableVersioning: false, maxVersions: 20 },
			undefined,
		);

		await noVerManager.integrate(makeExtractedSkill("no-ver"));
		const history = await noVerManager.getHistory("no-ver");
		expect(history.length).toBe(0);
		noVerDb.close();
	});

	test("rollback to same version increments version correctly", async () => {
		const extracted = makeExtractedSkill("ver-inc");
		await manager.integrate(extracted);

		const before = await skillStore.get("ver-inc");
		expect(before!.version).toBe(1);

		// Introduce v2 then rollback
		await manager.integrate(makeExtractedSkill("ver-inc", { description: "v2" }));
		const afterIntegrate = await skillStore.get("ver-inc");
		expect(afterIntegrate!.version).toBe(2);

		const restored = await manager.rollback("ver-inc", 1);
		expect(restored!.version).toBe(3);
	});

	test("integrated skill has correct timestamps", async () => {
		const extracted = makeExtractedSkill("time-skill");
		const now = Date.now();
		const result = await manager.integrate(extracted);

		expect(result.createdAt).toBeGreaterThan(now - 10000);
		expect(result.lastUsedAt).toBeGreaterThan(now - 10000);
	});

	test("merge preserves user_rating if present", async () => {
		const extracted1: EvolvedSkill = {
			name: "rating-preserve",
			description: "d",
			taskPattern: "p",
			approach: "a".repeat(100),
			tools: ["read"],
			pitfalls: [],
			createdAt: 1000,
			usageCount: 1,
			lastUsedAt: 2000,
			successCount: 1,
			failureCount: 0,
			version: 1,
			qualityScore: 50,
			userRating: 5,
		};
		await skillStore.upsert(extracted1);

		const extracted2 = makeExtractedSkill("rating-preserve");
		await manager.integrate(extracted2);

		const merged = await skillStore.get("rating-preserve");
		expect(merged!.userRating).toBe(5);
		expect(merged!.version).toBe(2);
	});
});
