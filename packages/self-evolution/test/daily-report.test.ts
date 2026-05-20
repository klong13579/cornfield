import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { DailyReportGenerator } from "../src/daily-report";
import { initSchema } from "../src/storage/db";
import { SqliteEffectivenessStore } from "../src/storage/effectiveness";
import { SqliteEpisodeStore } from "../src/storage/episodes";
import { SqliteLearningStore } from "../src/storage/learnings";
import { SqliteSkillStore } from "../src/storage/skills";
import type { Episode, Learning } from "../src/types";

	describe("DailyReportGenerator", () => {
	let db: Database;
	let episodeStore: SqliteEpisodeStore;
	let learningStore: SqliteLearningStore;
	let effectivenessStore: SqliteEffectivenessStore;
	let skillStore: SqliteSkillStore;
	let generator: DailyReportGenerator;

	beforeEach(() => {
		db = new Database(":memory:");
		initSchema(db);
		episodeStore = new SqliteEpisodeStore(db);
		learningStore = new SqliteLearningStore(db);
		effectivenessStore = new SqliteEffectivenessStore(db);
		skillStore = new SqliteSkillStore(db);
		generator = new DailyReportGenerator(episodeStore, learningStore, effectivenessStore, skillStore);
	});

	function makeEpisode(overrides: Partial<Episode> = {}): Episode {
		const now = Date.now();
		return {
			id: `ep-${now}-${Math.random().toString(36).slice(2)}`,
			sessionId: `session-${now}`,
			cwd: "/test",
			userPrompt: overrides.userPrompt ?? "Test prompt",
			timestamp: overrides.timestamp ?? now,
			durationMs: 1000,
			toolCallCount: overrides.toolCallCount ?? 3,
			errorCount: overrides.errorCount ?? 0,
			hadRecovery: overrides.hadRecovery ?? false,
			completedSuccessfully: overrides.completedSuccessfully ?? true,
			summary: overrides.summary ?? "Task: Test | Tools: read, edit | Outcome: completed successfully",
			toolsUsed: overrides.toolsUsed ?? ["read", "edit"],
			filesModified: overrides.filesModified ?? [],
			...overrides,
		};
	}

	test("generate produces report with correct date", async () => {
		const today = new Date();
		const report = await generator.generate(today);

		const y = today.getFullYear();
		const m = String(today.getMonth() + 1).padStart(2, "0");
		const d = String(today.getDate()).padStart(2, "0");
		expect(report.date).toBe(`${y}-${m}-${d}`);
		expect(report.totalSessions).toBe(0);
		expect(report.successfulSessions).toBe(0);
		expect(report.failedSessions).toBe(0);
	});

	test("generate filters episodes by date", async () => {
		const today = new Date();
		const yesterday = new Date(today.getTime() - 86_400_000);

		const todayEpisode = makeEpisode({
			timestamp: today.getTime(),
			completedSuccessfully: true,
		});
		const yesterdayEpisode = makeEpisode({
			timestamp: yesterday.getTime(),
			completedSuccessfully: false,
			errorCount: 1,
			summary: "Task: Test | Tools: read | Outcome: failed with 1 error(s)",
		});

		await episodeStore.insert(todayEpisode);
		await episodeStore.insert(yesterdayEpisode);

		const report = await generator.generate(today);
		expect(report.totalSessions).toBe(1);
		expect(report.successfulSessions).toBe(1);
		expect(report.failedSessions).toBe(0);
		expect(report.sessions[0]?.sessionId).toBe(todayEpisode.sessionId);
	});

	test("generate counts successful and failed sessions", async () => {
		const now = Date.now();
		await episodeStore.insert(
			makeEpisode({
				timestamp: now,
				completedSuccessfully: true,
			}),
		);
		await episodeStore.insert(
			makeEpisode({
				timestamp: now,
				completedSuccessfully: false,
				errorCount: 2,
				summary: "Task: Test | Tools: read | Outcome: failed with 2 error(s)",
			}),
		);
		await episodeStore.insert(
			makeEpisode({
				timestamp: now,
				completedSuccessfully: true,
				hadRecovery: true,
				errorCount: 1,
			}),
		);

		const report = await generator.generate(new Date(now));
		expect(report.totalSessions).toBe(3);
		expect(report.successfulSessions).toBe(2);
		expect(report.failedSessions).toBe(1);
	});

	test("generate extracts errors from summary", async () => {
		const now = Date.now();
		await episodeStore.insert(
			makeEpisode({
				timestamp: now,
				completedSuccessfully: false,
				errorCount: 1,
				summary: "Task: Test | Tools: read | Outcome: failed with 1 error(s)",
			}),
		);

		const report = await generator.generate(new Date(now));
		expect(report.sessions[0]?.errors).toContain("failed with 1 error(s)");
	});

	test("generate builds key moments", async () => {
		const now = Date.now();
		await episodeStore.insert(
			makeEpisode({
				timestamp: now,
				completedSuccessfully: false,
				errorCount: 1,
				userPrompt: "fix the bug",
				summary: "Task: fix the bug | Tools: read | Outcome: failed with 1 error(s)",
			}),
		);
		await episodeStore.insert(
			makeEpisode({
				timestamp: now + 1,
				completedSuccessfully: true,
				hadRecovery: true,
				userPrompt: "resolve the issue",
			}),
		);

		const report = await generator.generate(new Date(now));
		expect(report.keyMoments.length).toBeGreaterThan(0);
		expect(report.keyMoments.some(m => m.type === "error")).toBe(true);
		expect(report.keyMoments.some(m => m.type === "recovery")).toBe(true);
		expect(report.keyMoments.some(m => m.type === "correction")).toBe(true);
	});

	test("generate includes new learnings from the day", async () => {
		const now = Date.now();
		const item: Learning = {
			id: "learn-1",
			cwd: "/test",
			kind: "preference",
			content: "Always use async/await",
			source: "session_llm",
			confidence: 4,
			lifecycle: "active",
			scope: "project" as const,
			sessionId: "ep-1",
			createdAt: now,
			updatedAt: now,
			timesInjected: 0,
			timesHelped: 0,
			timesIgnored: 0,
		};
		await learningStore.insert(item);

		const report = await generator.generate(new Date(now));
		expect(report.newLearnings.length).toBe(1);
		expect(report.newLearnings[0]?.content).toBe("Always use async/await");
	});

	test("generate builds top tools", async () => {
		const now = Date.now();
		await episodeStore.insert(
			makeEpisode({
				timestamp: now,
				toolsUsed: ["read", "edit", "read"],
			}),
		);
		await episodeStore.insert(
			makeEpisode({
				timestamp: now,
				toolsUsed: ["read", "bash"],
			}),
		);

		const report = await generator.generate(new Date(now));
		expect(report.topTools.length).toBeGreaterThan(0);
		expect(report.topTools[0]?.tool).toBe("read");
		expect(report.topTools[0]?.count).toBe(3);
	});

	test("formatReport produces markdown", async () => {
		const now = Date.now();
		await episodeStore.insert(
			makeEpisode({
				timestamp: now,
				completedSuccessfully: true,
				userPrompt: "Test task",
				toolsUsed: ["read"],
			}),
		);

		const report = await generator.generate(new Date(now));
		const markdown = generator.formatReport(report);

		expect(markdown).toContain("# 进化日报:");
		expect(markdown).toContain("## 会话概览:");
		expect(markdown).toContain("## 3. 关键事件");
		expect(markdown).toContain("## 2. 已采纳进化的收益");
		expect(markdown).toContain("## 5. 会话明细");
		expect(markdown).toContain("Test task");
	});

	test("formatReport handles empty report", async () => {
		const report = await generator.generate(new Date());
		const markdown = generator.formatReport(report);

		expect(markdown).toContain("# 进化日报:");
		expect(markdown).toContain("_今日无关键事件。_");
		expect(markdown).toContain("尚无学习被注入过");
	});
});
