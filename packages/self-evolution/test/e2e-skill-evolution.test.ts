import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ActivityLogger } from "../src/logging/activity-logger";
import { SkillManager } from "../src/manager";
import { initSchema } from "../src/storage/db";
import { SqliteSkillStore, SqliteSkillVersionStore } from "../src/storage/skills";
import type { ExtractedSkill, SkillEffectiveness } from "../src/types";

describe("E2E: Skill evolution → graduation / deprecation", () => {
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
			{} as any,
			{ enableVersioning: true, maxVersions: 20 },
			undefined,
		);
	});

	afterEach(() => {
		db.close();
	});

	test("E2E-07: skill integrate creates version=1", async () => {
		const extracted = makeExtractedSkill("test-case-design");
		const result = await manager.integrate(extracted);

		expect(result.name).toBe("test-case-design");
		expect(result.version).toBe(1);
		expect(result.deprecated).toBeFalsy();

		const fromStore = await skillStore.get("test-case-design");
		expect(fromStore).toBeDefined();
	});

	test("E2E-08: quality score is computed by evaluator", async () => {
		const extracted = makeExtractedSkill("test-case-design", { qualityScore: 75 });
		const result = await manager.integrate(extracted);

		expect(result.qualityScore).toBe(75);
	});

	test("E2E-09 graduation placeholder: high quality skill is not auto-deprecated", async () => {
		const extracted = makeExtractedSkill("graduating-skill", { qualityScore: 85 });
		await manager.integrate(extracted);

		const skill = await skillStore.get("graduating-skill");
		expect(skill!.deprecated).toBeFalsy();
		expect(skill!.qualityScore).toBeGreaterThan(70);
	});

	test("E2E-10 deprecation: low quality + no usage gets archived", async () => {
		const lowSkill = {
			name: "junk-skill",
			description: "bad",
			taskPattern: "x",
			approach: "y",
			tools: [] as string[],
			pitfalls: [] as string[],
			createdAt: Date.now(),
			usageCount: 0,
			lastUsedAt: Date.now(),
			successCount: 0,
			failureCount: 0,
			version: 1,
			qualityScore: 20,
		};
		await skillStore.upsert(lowSkill);

		const archived = await manager.archiveLowQuality();
		expect(archived).toBe(1);

		const skill = await skillStore.get("junk-skill");
		expect(skill!.deprecated).toBe(true);
	});

	test("deprecated skills are not returned in active list", async () => {
		await manager.integrate(makeExtractedSkill("active-skill", { qualityScore: 80 }));
		await manager.integrate(makeExtractedSkill("deprecated-skill", { qualityScore: 20 }));
		await manager.deprecate("deprecated-skill", "low quality");

		const all = await skillStore.list();
		const active = all.filter(s => !s.deprecated);
		expect(active.length).toBe(1);
		expect(active[0]!.name).toBe("active-skill");
	});

	test("skill versioning on duplicate integrate", async () => {
		await manager.integrate(makeExtractedSkill("versioned-skill", { approach: "v1 approach".repeat(20) }));
		await manager.integrate(makeExtractedSkill("versioned-skill", { approach: "v2 better approach".repeat(20) }));

		const skill = await skillStore.get("versioned-skill");
		expect(skill!.version).toBe(2);
	});
});
