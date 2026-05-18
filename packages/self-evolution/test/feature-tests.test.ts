/**
 * Feature-level integration tests for three evolution features:
 * 1. Real-time User Preference Extraction (UserProfiler)
 * 2. Instant Feedback Loop (FeedbackTracker + EffectivenessAnalyzer + CrossSessionNudgeEngine)
 * 3. Session-level Diagnosis Extraction (TraceAnalyzer + ErrorPatternExtractor)
 *
 * These are NOT unit tests — they simulate realistic user interaction scenarios
 * and verify the system's observable behavior matches expectations.
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { CrossSessionNudgeEngine } from "../src/cross-session-nudge";
import { EffectivenessAnalyzer } from "../src/effectiveness-analyzer";
import { ErrorPatternExtractor } from "../src/error-pattern-extractor";
import { FeedbackTracker } from "../src/feedback-tracker";
import { TraceAnalyzer } from "../src/trace-analyzer";
import type { Episode, SessionTrace, TraceEntry, UserProfile } from "../src/types";
import { computeRollingWindowStats, generateUserProfileMd, UserProfiler } from "../src/user-profiler";

// ============================================================================
// Helpers
// ============================================================================

function makeTrace(overrides: Partial<SessionTrace> & { entries: TraceEntry[] }): SessionTrace {
	return {
		sessionId: `test-session-${Date.now()}`,
		cwd: "/test/project",
		userPrompt: "test prompt",
		startTime: Date.now() - 60000,
		endTime: Date.now(),
		toolCallCount: overrides.entries.filter(e => e.type === "tool_call").length,
		errorCount: overrides.entries.filter(e => e.type === "tool_result" && e.isError).length,
		hadRecovery: false,
		completedSuccessfully: true,
		...overrides,
	};
}

function makeEpisode(overrides: Partial<Episode>): Episode {
	return {
		id: `ep-${Date.now()}`,
		sessionId: `session-${Date.now()}`,
		cwd: "/test/project",
		userPrompt: "test episode",
		timestamp: Date.now() - 3600000,
		durationMs: 30000,
		toolCallCount: 3,
		errorCount: 0,
		hadRecovery: false,
		completedSuccessfully: true,
		summary: "Test episode summary",
		toolsUsed: ["read", "edit", "write"],
		filesModified: ["src/test.ts"],
		...overrides,
	};
}

function makeInMemoryDb(): Database {
	const db = new Database(":memory:");

	// Create tables needed by stores
	db.run(`
		CREATE TABLE IF NOT EXISTS effectiveness (
			episode_id TEXT PRIMARY KEY,
			times_injected INTEGER DEFAULT 0,
			times_helped INTEGER DEFAULT 0,
			times_failed INTEGER DEFAULT 0
		)
	`);
	db.run(`
		CREATE TABLE IF NOT EXISTS skill_effectiveness (
			skill_name TEXT PRIMARY KEY,
			times_injected INTEGER DEFAULT 0,
			times_helped INTEGER DEFAULT 0,
			times_failed INTEGER DEFAULT 0,
			last_injected_at INTEGER DEFAULT 0
		)
	`);
	db.run(`
		CREATE TABLE IF NOT EXISTS detailed_outcomes (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			episode_id TEXT NOT NULL,
			helpfulness REAL NOT NULL,
			has_explicit_correction INTEGER DEFAULT 0,
			has_explicit_approval INTEGER DEFAULT 0,
			was_redundant INTEGER DEFAULT 0,
			avoided_previous_errors INTEGER DEFAULT 0,
			tool_efficiency REAL DEFAULT 0,
			recorded_at INTEGER NOT NULL
		)
	`);
	db.run(`
		CREATE TABLE IF NOT EXISTS episodes (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			cwd TEXT NOT NULL,
			user_prompt TEXT NOT NULL,
			timestamp INTEGER NOT NULL,
			duration_ms INTEGER DEFAULT 0,
			tool_call_count INTEGER DEFAULT 0,
			error_count INTEGER DEFAULT 0,
			had_recovery INTEGER DEFAULT 0,
			completed_successfully INTEGER DEFAULT 0,
			summary TEXT DEFAULT '',
			tools_used TEXT DEFAULT '',
			files_modified TEXT DEFAULT ''
		)
	`);
	db.run(`
		CREATE TABLE IF NOT EXISTS nudge_history (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			project TEXT NOT NULL,
			type TEXT NOT NULL,
			severity TEXT NOT NULL,
			message TEXT NOT NULL,
			suggestion TEXT NOT NULL,
			detected_at INTEGER NOT NULL,
			dismissed_at INTEGER,
			acknowledged INTEGER DEFAULT 0,
			context_injected INTEGER NOT NULL DEFAULT 0,
			injected_at INTEGER,
			post_tool_calls INTEGER NOT NULL DEFAULT 0,
			pattern_repeated INTEGER NOT NULL DEFAULT 0,
			outcome_score REAL,
			outcome_recorded_at INTEGER
		)
	`);
	db.run(`
		CREATE TABLE IF NOT EXISTS user_profiles (
			id TEXT PRIMARY KEY,
			profile_json TEXT NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`);
	db.run(`
		CREATE TABLE IF NOT EXISTS episode_diagnoses (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			diagnosis_json TEXT NOT NULL,
			recorded_at INTEGER NOT NULL
		)
	`);

	return db;
}

// ============================================================================
// Feature 1: Real-time User Preference Extraction
// ============================================================================

describe("Feature 1: Real-time User Preference Extraction (UserProfiler)", () => {
	test("1.1: Profile starts empty and accumulates data across sessions", () => {
		const profiler = new UserProfiler();
		const initial = profiler.getProfile();

		// Initial state: empty
		expect(initial.sessionCount).toBe(0);
		expect(initial.avgToolCallsPerSession).toBe(0);
		expect(initial.toolFrequency).toEqual({});
		expect(initial.preferredLanguages).toEqual([]);

		// Session 1: user does TypeScript refactoring
		const trace1 = makeTrace({
			entries: [
				{ type: "tool_call", timestamp: 1000, toolName: "read", args: { path: "src/old.ts" } },
				{ type: "tool_result", timestamp: 1100, isError: false },
				{ type: "tool_call", timestamp: 2000, toolName: "edit", args: { path: "src/old.ts" } },
				{ type: "tool_result", timestamp: 2100, isError: false },
				{ type: "tool_call", timestamp: 3000, toolName: "write", args: { path: "src/new.ts" } },
				{ type: "tool_result", timestamp: 3100, isError: false },
			],
			toolCallCount: 3,
			errorCount: 0,
		});
		profiler.updateProfile(trace1, "refactoring");

		let profile = profiler.getProfile();
		expect(profile.sessionCount).toBe(1);
		expect(profile.toolFrequency.edit).toBe(1);
		expect(profile.toolFrequency.edit).toBe(1);
		expect(profile.toolFrequency.write).toBe(1);
		expect(profile.intentDistribution.refactoring).toBe(1);
		expect(profile.preferredLanguages).toContain("typescript");
		expect(profile.avgToolCallsPerSession).toBe(3);

		// Session 2: user does bugfixing with errors
		const trace2 = makeTrace({
			entries: [
				{ type: "tool_call", timestamp: 4000, toolName: "search", args: { pattern: "bug" } },
				{ type: "tool_result", timestamp: 4100, isError: false },
				{ type: "tool_call", timestamp: 5000, toolName: "read", args: { path: "src/buggy.ts" } },
				{ type: "tool_result", timestamp: 5100, isError: false },
				{ type: "tool_call", timestamp: 6000, toolName: "edit", args: { path: "src/buggy.ts" } },
				{ type: "tool_result", timestamp: 6100, isError: true },
				{ type: "tool_call", timestamp: 7000, toolName: "read", args: { path: "src/buggy.ts" } },
				{ type: "tool_result", timestamp: 7100, isError: false },
				{ type: "tool_call", timestamp: 8000, toolName: "edit", args: { path: "src/buggy.ts" } },
				{ type: "tool_result", timestamp: 8100, isError: false },
			],
			toolCallCount: 5,
			errorCount: 1,
			hadRecovery: true,
		});
		profiler.updateProfile(trace2, "bugfix");

		profile = profiler.getProfile();
		expect(profile.sessionCount).toBe(2);
		expect(profile.toolFrequency.read).toBe(3); // 1 in session1 + 2 in session2
		expect(profile.toolFrequency.edit).toBe(3); // 1 in session1 + 2 in session2
		expect(profile.toolFrequency.search).toBe(1);
		expect(profile.intentDistribution.refactoring).toBe(1);
		expect(profile.intentDistribution.bugfix).toBe(1);
		expect(profile.avgToolCallsPerSession).toBe(4); // (3 + 5) / 2
		expect(profile.errorRate).toBe(0.5); // 1 error / 2 sessions
		expect(profile.recoveryRate).toBe(0.5); // 1 recovery / 2 sessions

		// Tool transitions should be tracked
		expect(Object.keys(profile.toolTransitions).length).toBeGreaterThan(0);
	});

	test("1.2: Tool transitions are tracked correctly", () => {
		const profiler = new UserProfiler();
		const trace = makeTrace({
			entries: [
				{ type: "tool_call", timestamp: 1000, toolName: "search", args: {} },
				{ type: "tool_result", timestamp: 1100, isError: false },
				{ type: "tool_call", timestamp: 2000, toolName: "read", args: {} },
				{ type: "tool_result", timestamp: 2100, isError: false },
				{ type: "tool_call", timestamp: 3000, toolName: "edit", args: {} },
				{ type: "tool_result", timestamp: 3100, isError: false },
			],
		});
		profiler.updateProfile(trace, "exploration");

		const profile = profiler.getProfile();
		expect(profile.toolTransitions["search→read"]).toBe(1);
		expect(profile.toolTransitions["read→edit"]).toBe(1);
	});

	test("1.3: Serialize/deserialize preserves all data", () => {
		const profiler = new UserProfiler();
		const trace = makeTrace({
			entries: [
				{ type: "tool_call", timestamp: 1000, toolName: "edit", args: { path: "a.ts" } },
				{ type: "tool_result", timestamp: 1100, isError: false },
				{ type: "tool_call", timestamp: 2000, toolName: "write", args: { path: "b.py" } },
				{ type: "tool_result", timestamp: 2100, isError: false },
			],
		});
		profiler.updateProfile(trace, "feature-add");

		const json = profiler.serialize();
		const restored = UserProfiler.deserialize(json);
		const profile = restored.getProfile();

		expect(profile.sessionCount).toBe(1);
		expect(profile.toolFrequency.edit).toBe(1);
		expect(profile.toolFrequency.write).toBe(1);
		expect(profile.intentDistribution["feature-add"]).toBe(1);
		expect(profile.preferredLanguages).toContain("typescript");
		expect(profile.preferredLanguages).toContain("python");
	});

	test("1.4: Rolling window stats from DB", () => {
		const db = makeInMemoryDb();

		// Insert episodes across different time windows
		const now = Date.now();
		const day = 86400000;

		// Episode 7 days ago (should appear in 7d, 30d, 90d windows)
		db.run(
			`INSERT INTO episodes (id, session_id, cwd, user_prompt, timestamp, duration_ms, tool_call_count, error_count, had_recovery, completed_successfully, summary, tools_used)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				"ep-7d",
				"s1",
				"/test",
				"fix bug",
				now - 6 * day,
				120000,
				10,
				2,
				1,
				1,
				"Fixed bug",
				"read,edit,write,bash,search",
			],
		);

		// Episode 60 days ago (should appear in 90d but not 7d or 30d)
		db.run(
			`INSERT INTO episodes (id, session_id, cwd, user_prompt, timestamp, duration_ms, tool_call_count, error_count, had_recovery, completed_successfully, summary, tools_used)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			["ep-60d", "s2", "/test", "add feature", now - 60 * day, 60000, 5, 0, 0, 1, "Added feature", "read,write"],
		);

		// Insert intent for episode
		db.run(`CREATE TABLE IF NOT EXISTS episode_intents (episode_id TEXT, intent TEXT)`);
		db.run("INSERT INTO episode_intents (episode_id, intent) VALUES (?, ?)", ["ep-7d", "bugfix"]);
		db.run("INSERT INTO episode_intents (episode_id, intent) VALUES (?, ?)", ["ep-60d", "feature-add"]);

		// Test 7-day window
		const stats7d = computeRollingWindowStats(db, 7);
		expect(stats7d.sessionCount).toBe(1);
		expect(stats7d.topIntents.length).toBeGreaterThan(0);
		expect(stats7d.topIntents[0].intent).toBe("bugfix");

		// Test 90-day window
		const stats90d = computeRollingWindowStats(db, 90);
		expect(stats90d.sessionCount).toBe(2);
		expect(stats90d.topIntents.length).toBe(2);

		db.close();
	});

	test("1.5: User profile markdown generation", () => {
		const profile: UserProfile = {
			toolFrequency: { read: 10, edit: 8, write: 5, search: 3 },
			toolTransitions: { "search→read": 3, "read→edit": 5 },
			intentDistribution: { bugfix: 4, refactoring: 3, "feature-add": 2 },
			avgToolCallsPerSession: 8.5,
			avgFilesModifiedPerSession: 2.3,
			errorRate: 0.15,
			recoveryRate: 0.1,
			preferredLanguages: ["typescript", "python"],
			sessionCount: 9,
			updatedAt: Date.now(),
		};

		const md = generateUserProfileMd(profile);
		expect(md).toContain("User Profile");
		expect(md).toContain("Total sessions: 9");
		expect(md).toContain("typescript, python");
		expect(md).toContain("Tool Frequency");
		expect(md).toContain("read: 10");
		expect(md).toContain("edit: 8");
		expect(md).toContain("Intent Distribution");
		expect(md).toContain("bugfix: 4");
	});
});

// ============================================================================
// Feature 2: Instant Feedback Loop
// ============================================================================

describe("Feature 2: Instant Feedback Loop", () => {
	describe("2.1: FeedbackTracker - Explicit feedback parsing", () => {
		test("Approval keywords are detected", () => {
			const db = makeInMemoryDb();
			const { SqliteEffectivenessStore } = require("../src/storage/effectiveness");
			const { SqliteSkillEffectivenessStore } = require("../src/storage/skill-effectiveness");
			const { SqliteDetailedOutcomeStore } = require("../src/storage/detailed-outcomes");
			const effStore = new SqliteEffectivenessStore(db);
			const skillEffStore = new SqliteSkillEffectivenessStore(db);
			const detailedStore = new SqliteDetailedOutcomeStore(db);
			const tracker = new FeedbackTracker(effStore, skillEffStore, detailedStore);

			const result = tracker.parseUserFeedback("好的，这个方案不错", {
				injectedEpisodeIds: ["ep-1"],
				injectedConventionIds: [],
			});

			expect(result.type).toBe("approval");
			expect(result.outcomeDelta).toBe(0.1);
			expect(result.triggerContradictionCheck).toBe(false);

			db.close();
		});

		test("Correction keywords extract convention content", () => {
			const db = makeInMemoryDb();
			const { SqliteEffectivenessStore } = require("../src/storage/effectiveness");
			const { SqliteSkillEffectivenessStore } = require("../src/storage/skill-effectiveness");
			const { SqliteDetailedOutcomeStore } = require("../src/storage/detailed-outcomes");
			const effStore = new SqliteEffectivenessStore(db);
			const skillEffStore = new SqliteSkillEffectivenessStore(db);
			const detailedStore = new SqliteDetailedOutcomeStore(db);
			const tracker = new FeedbackTracker(effStore, skillEffStore, detailedStore);

			const result = tracker.parseUserFeedback("不对，这里不应该用箭头函数", {
				injectedEpisodeIds: ["ep-1"],
				injectedConventionIds: [],
			});

			expect(result.type).toBe("correction");
			expect(result.outcomeDelta).toBe(-0.2);
			expect(result.triggerContradictionCheck).toBe(true);
			expect(result.newConvention).toBeDefined();
			expect(result.newConvention!.type).toBe("preference");
			expect(result.newConvention!.content).toContain("不应该用箭头函数");

			db.close();
		});

		test("Negative rule keywords create negative_rule convention", () => {
			const db = makeInMemoryDb();
			const { SqliteEffectivenessStore } = require("../src/storage/effectiveness");
			const { SqliteSkillEffectivenessStore } = require("../src/storage/skill-effectiveness");
			const { SqliteDetailedOutcomeStore } = require("../src/storage/detailed-outcomes");
			const effStore = new SqliteEffectivenessStore(db);
			const skillEffStore = new SqliteSkillEffectivenessStore(db);
			const detailedStore = new SqliteDetailedOutcomeStore(db);
			const tracker = new FeedbackTracker(effStore, skillEffStore, detailedStore);

			const result = tracker.parseUserFeedback("不要用全局变量，用模块作用域", {
				injectedEpisodeIds: ["ep-1"],
				injectedConventionIds: [],
			});

			expect(result.type).toBe("new_negative_rule");
			expect(result.newConvention).toBeDefined();
			expect(result.newConvention!.type).toBe("negative_rule");
			expect(result.newConvention!.content).toContain("用模块作用域");

			db.close();
		});

		test("Preference keywords create preference convention", () => {
			const db = makeInMemoryDb();
			const { SqliteEffectivenessStore } = require("../src/storage/effectiveness");
			const { SqliteSkillEffectivenessStore } = require("../src/storage/skill-effectiveness");
			const { SqliteDetailedOutcomeStore } = require("../src/storage/detailed-outcomes");
			const effStore = new SqliteEffectivenessStore(db);
			const skillEffStore = new SqliteSkillEffectivenessStore(db);
			const detailedStore = new SqliteDetailedOutcomeStore(db);
			const tracker = new FeedbackTracker(effStore, skillEffStore, detailedStore);

			const result = tracker.parseUserFeedback("记住这个，我喜欢用 const 而不是 let", {
				injectedEpisodeIds: ["ep-1"],
				injectedConventionIds: [],
			});

			expect(result.type).toBe("new_preference");
			expect(result.newConvention).toBeDefined();
			expect(result.newConvention!.content).toContain("用 const 而不是 let");

			db.close();
		});

		test("Unrecognized feedback returns type 'none'", () => {
			const db = makeInMemoryDb();
			const { SqliteEffectivenessStore } = require("../src/storage/effectiveness");
			const { SqliteSkillEffectivenessStore } = require("../src/storage/skill-effectiveness");
			const { SqliteDetailedOutcomeStore } = require("../src/storage/detailed-outcomes");
			const effStore = new SqliteEffectivenessStore(db);
			const skillEffStore = new SqliteSkillEffectivenessStore(db);
			const detailedStore = new SqliteDetailedOutcomeStore(db);
			const tracker = new FeedbackTracker(effStore, skillEffStore, detailedStore);

			const result = tracker.parseUserFeedback("今天天气很好", {
				injectedEpisodeIds: ["ep-1"],
				injectedConventionIds: [],
			});

			expect(result.type).toBe("none");
			expect(result.outcomeDelta).toBe(0);

			db.close();
		});
	});

	describe("2.2: FeedbackTracker - Implicit signal detection", () => {
		test("User accepts modifications without correction → positive delta", () => {
			const db = makeInMemoryDb();
			const { SqliteEffectivenessStore } = require("../src/storage/effectiveness");
			const { SqliteSkillEffectivenessStore } = require("../src/storage/skill-effectiveness");
			const { SqliteDetailedOutcomeStore } = require("../src/storage/detailed-outcomes");
			const effStore = new SqliteEffectivenessStore(db);
			const skillEffStore = new SqliteSkillEffectivenessStore(db);
			const detailedStore = new SqliteDetailedOutcomeStore(db);
			const tracker = new FeedbackTracker(effStore, skillEffStore, detailedStore);

			const trace = makeTrace({
				entries: [
					{ type: "tool_call", timestamp: 1000, toolName: "edit", args: { path: "src/test.ts" } },
					{ type: "tool_result", timestamp: 1100, isError: false },
					{ type: "tool_call", timestamp: 2000, toolName: "write", args: { path: "src/new.ts" } },
					{ type: "tool_result", timestamp: 2100, isError: false },
				],
			});

			const result = tracker.detectImplicitSignals(trace, ["ep-1"]);
			expect(result.outcomeDeltas.length).toBeGreaterThan(0);
			expect(result.outcomeDeltas[0].delta).toBe(0.05);
			expect(result.outcomeDeltas[0].reason).toContain("accepted modifications");

			db.close();
		});

		test("User reverts edits → negative delta", () => {
			const db = makeInMemoryDb();
			const { SqliteEffectivenessStore } = require("../src/storage/effectiveness");
			const { SqliteSkillEffectivenessStore } = require("../src/storage/skill-effectiveness");
			const { SqliteDetailedOutcomeStore } = require("../src/storage/detailed-outcomes");
			const effStore = new SqliteEffectivenessStore(db);
			const skillEffStore = new SqliteSkillEffectivenessStore(db);
			const detailedStore = new SqliteDetailedOutcomeStore(db);
			const tracker = new FeedbackTracker(effStore, skillEffStore, detailedStore);

			// Same file edited twice → looks like a revert
			const trace = makeTrace({
				entries: [
					{ type: "tool_call", timestamp: 1000, toolName: "edit", args: { path: "src/test.ts" } },
					{ type: "tool_result", timestamp: 1100, isError: false },
					{ type: "tool_call", timestamp: 2000, toolName: "edit", args: { path: "src/test.ts" } },
					{ type: "tool_result", timestamp: 2100, isError: false },
				],
			});

			const result = tracker.detectImplicitSignals(trace, ["ep-1"]);
			expect(result.outcomeDeltas.length).toBeGreaterThan(0);
			const revertDelta = result.outcomeDeltas.find(d => d.delta === -0.15);
			expect(revertDelta).toBeDefined();
			expect(revertDelta!.reason).toContain("reverted");

			db.close();
		});

		test("Duplicate user requests trigger mutation signal", () => {
			const db = makeInMemoryDb();
			const { SqliteEffectivenessStore } = require("../src/storage/effectiveness");
			const { SqliteSkillEffectivenessStore } = require("../src/storage/skill-effectiveness");
			const { SqliteDetailedOutcomeStore } = require("../src/storage/detailed-outcomes");
			const effStore = new SqliteEffectivenessStore(db);
			const skillEffStore = new SqliteSkillEffectivenessStore(db);
			const detailedStore = new SqliteDetailedOutcomeStore(db);
			const tracker = new FeedbackTracker(effStore, skillEffStore, detailedStore);

			const trace = makeTrace({
				entries: [
					{ type: "user_input", timestamp: 1000, content: "add error handling to the API route" },
					{ type: "tool_call", timestamp: 2000, toolName: "read", args: {} },
					{ type: "tool_result", timestamp: 2100, isError: false },
					{ type: "user_input", timestamp: 3000, content: "add error handling to the API route" },
				],
			});

			const result = tracker.detectImplicitSignals(trace, ["ep-1"]);
			expect(result.triggerMutation).toBe(true);
			expect(result.mutationReason).toContain("Duplicate request");

			db.close();
		});
	});

	describe("2.3: EffectivenessAnalyzer - Multi-dimensional scoring", () => {
		test("Successful session with approval → positive helpfulness", () => {
			const analyzer = new EffectivenessAnalyzer();
			const trace = makeTrace({
				entries: [
					{ type: "user_input", timestamp: 1000, content: "好的，这个方案很好" },
					{ type: "tool_call", timestamp: 2000, toolName: "edit", args: {} },
					{ type: "tool_result", timestamp: 2100, isError: false },
				],
				completedSuccessfully: true,
				errorCount: 0,
			});
			const episode = makeEpisode({ toolsUsed: ["read", "edit"] });

			const outcome = analyzer.analyze(trace, episode);
			expect(outcome.hasExplicitApproval).toBe(true);
			expect(outcome.helpfulness).toBeGreaterThan(0);
		});

		test("Session with explicit correction → negative helpfulness", () => {
			const analyzer = new EffectivenessAnalyzer();
			const trace = makeTrace({
				entries: [
					{ type: "user_input", timestamp: 1000, content: "不对，这里错了" },
					{ type: "tool_call", timestamp: 2000, toolName: "edit", args: {} },
					{ type: "tool_result", timestamp: 2100, isError: true },
				],
				completedSuccessfully: false,
				errorCount: 1,
			});
			const episode = makeEpisode({ toolsUsed: ["read", "edit"] });

			const outcome = analyzer.analyze(trace, episode);
			expect(outcome.hasExplicitCorrection).toBe(true);
			expect(outcome.helpfulness).toBeLessThan(0);
		});

		test("Redundant injection (high keyword overlap) → penalty", () => {
			const analyzer = new EffectivenessAnalyzer();
			const trace = makeTrace({
				userPrompt: "fix the authentication bug in the login handler",
				entries: [
					{ type: "tool_call", timestamp: 1000, toolName: "read", args: {} },
					{ type: "tool_result", timestamp: 1100, isError: false },
				],
			});
			const episode = makeEpisode({
				userPrompt: "fix the authentication bug in the login handler please",
				toolsUsed: ["read"],
			});

			const outcome = analyzer.analyze(trace, episode);
			expect(outcome.wasRedundant).toBe(true);
		});

		test("Error avoidance: same tools used without errors → bonus", () => {
			const analyzer = new EffectivenessAnalyzer();
			const trace = makeTrace({
				entries: [
					{ type: "tool_call", timestamp: 1000, toolName: "read", args: {} },
					{ type: "tool_result", timestamp: 1100, isError: false },
					{ type: "tool_call", timestamp: 2000, toolName: "edit", args: {} },
					{ type: "tool_result", timestamp: 2100, isError: false },
				],
				completedSuccessfully: true,
				errorCount: 0,
			});
			const episode = makeEpisode({ toolsUsed: ["read", "edit"] });

			const outcome = analyzer.analyze(trace, episode);
			expect(outcome.avoidedPreviousErrors).toBe(true);
		});
	});

	describe("2.4: CrossSessionNudgeEngine - Feedback-aware nudge delivery", () => {
		test("Nudge is suppressed if same type was recently dismissed", async () => {
			const db = makeInMemoryDb();
			const { SqliteNudgeHistoryStore } = require("../src/storage/nudge-history");
			const { SqliteEpisodeStore } = require("../src/storage/episodes");
			const { SqliteProfileStore } = require("../src/storage/profiles");
			const nudgeStore = new SqliteNudgeHistoryStore(db);
			const episodeStore = new SqliteEpisodeStore(db);
			const profileStore = new SqliteProfileStore(db);

			// Insert a dismissed nudge record
			nudgeStore.insert({
				id: "nudge-1",
				sessionId: "prev-session",
				project: "/test",
				type: "cross-session-high-error-rate",
				severity: "warn",
				message: "test",
				suggestion: "test",
				detectedAt: Date.now() - 1000,
				dismissedAt: Date.now() - 500,
			});

			const engine = new CrossSessionNudgeEngine(nudgeStore, episodeStore, profileStore);

			// Should be suppressed because the same type was dismissed within 7 days
			const nudge = await engine.analyze("/test", "fix bug");
			expect(nudge).toBeUndefined();

			db.close();
		});

		test("Nudge is auto-dismissed after 3 deliveries without ack", async () => {
			const db = makeInMemoryDb();
			const { SqliteNudgeHistoryStore } = require("../src/storage/nudge-history");
			const { SqliteEpisodeStore } = require("../src/storage/episodes");
			const { SqliteProfileStore } = require("../src/storage/profiles");
			const nudgeStore = new SqliteNudgeHistoryStore(db);
			const episodeStore = new SqliteEpisodeStore(db);
			const profileStore = new SqliteProfileStore(db);

			// Insert 3 undelivered nudge records of the same type within 30 days
			const now = Date.now();
			for (let i = 0; i < 3; i++) {
				nudgeStore.insert({
					id: `nudge-auto-${i}`,
					sessionId: `session-${i}`,
					project: "/test",
					type: "cross-session-redundant-search",
					severity: "info",
					message: "test",
					suggestion: "test",
					detectedAt: now - i * 60000,
				});
			}

			const engine = new CrossSessionNudgeEngine(nudgeStore, episodeStore, profileStore);

			// The 4th delivery should trigger auto-dismiss
			const nudge = await engine.analyze("/test", "search for something");
			expect(nudge).toBeUndefined();

			db.close();
		});
	});
});

// ============================================================================
// Feature 3: Session-level Diagnosis Extraction
// ============================================================================

describe("Feature 3: Session-level Diagnosis Extraction", () => {
	describe("3.1: TraceAnalyzer - Causal tool-chain diagnosis", () => {
		test("Read failure with path_not_found is detected", () => {
			const analyzer = new TraceAnalyzer();
			const trace = makeTrace({
				entries: [
					{ type: "tool_call", timestamp: 1000, toolName: "read", args: { path: "/nonexistent/file.ts" } },
					{ type: "tool_result", timestamp: 1100, isError: true, result: "ENOENT: no such file or directory" },
				],
				errorCount: 1,
			});

			const diagnosis = analyzer.analyze(trace);
			expect(diagnosis.readFailures.length).toBe(1);
			expect(diagnosis.readFailures[0].failureType).toBe("path_not_found");
			expect(diagnosis.readFailures[0].attemptedPath).toBe("/nonexistent/file.ts");
		});

		test("Edit failure → read verification cascade is detected", () => {
			const analyzer = new TraceAnalyzer();
			const trace = makeTrace({
				entries: [
					{ type: "tool_call", timestamp: 1000, toolName: "edit", args: { path: "src/test.ts" } },
					{ type: "tool_result", timestamp: 1100, isError: true, result: "anchor not found" },
					{ type: "tool_call", timestamp: 2000, toolName: "read", args: { path: "src/test.ts" } },
					{ type: "tool_result", timestamp: 2100, isError: true, result: "ENOENT: no such file" },
				],
				errorCount: 2,
			});

			const diagnosis = analyzer.analyze(trace);
			expect(diagnosis.readFailures.length).toBe(1);
			expect(diagnosis.readFailures[0].failureType).toBe("verify_after_edit_failure");
			expect(diagnosis.readFailures[0].precedingTool).toBe("edit");
		});

		test("Search failure → read cascade is detected as search_misled", () => {
			const analyzer = new TraceAnalyzer();
			const trace = makeTrace({
				entries: [
					{ type: "tool_call", timestamp: 1000, toolName: "search", args: { pattern: "missingFunc" } },
					{ type: "tool_result", timestamp: 1100, isError: true, result: "no matches found" },
					{ type: "tool_call", timestamp: 2000, toolName: "read", args: { path: "src/missing.ts" } },
					{ type: "tool_result", timestamp: 2100, isError: true, result: "ENOENT: no such file" },
				],
				errorCount: 2,
			});

			const diagnosis = analyzer.analyze(trace);
			expect(diagnosis.readFailures.length).toBe(1);
			expect(diagnosis.readFailures[0].failureType).toBe("search_misled");
			expect(diagnosis.readFailures[0].precedingTool).toBe("search");
		});

		test("Redundant search chain (3+ consecutive reads) is flagged", () => {
			const analyzer = new TraceAnalyzer();
			const trace = makeTrace({
				entries: [
					{ type: "tool_call", timestamp: 1000, toolName: "read", args: { path: "a.ts" } },
					{ type: "tool_result", timestamp: 1100, isError: false },
					{ type: "tool_call", timestamp: 2000, toolName: "read", args: { path: "b.ts" } },
					{ type: "tool_result", timestamp: 2100, isError: false },
					{ type: "tool_call", timestamp: 3000, toolName: "read", args: { path: "c.ts" } },
					{ type: "tool_result", timestamp: 3100, isError: false },
				],
			});

			const diagnosis = analyzer.analyze(trace);
			expect(diagnosis.redundantSearches).toBe(true);
		});

		test("Slow loop (many calls, no successful modification) is detected", () => {
			const analyzer = new TraceAnalyzer();
			const trace = makeTrace({
				entries: [
					{ type: "tool_call", timestamp: 1000, toolName: "read", args: { path: "a.ts" } },
					{ type: "tool_result", timestamp: 1100, isError: true },
					{ type: "tool_call", timestamp: 2000, toolName: "search", args: { pattern: "x" } },
					{ type: "tool_result", timestamp: 2100, isError: true },
					{ type: "tool_call", timestamp: 3000, toolName: "read", args: { path: "b.ts" } },
					{ type: "tool_result", timestamp: 3100, isError: true },
					{ type: "tool_call", timestamp: 4000, toolName: "bash", args: { command: "ls" } },
					{ type: "tool_result", timestamp: 4100, isError: true },
					{ type: "tool_call", timestamp: 5000, toolName: "read", args: { path: "c.ts" } },
					{ type: "tool_result", timestamp: 5100, isError: true },
				],
				errorCount: 5,
			});

			const diagnosis = analyzer.analyze(trace);
			expect(diagnosis.slowLoop).toBe(true);
			expect(diagnosis.toolEfficiency).toBe(1); // no mod calls, defaults to 1
		});

		test("Tool efficiency is computed correctly", () => {
			const analyzer = new TraceAnalyzer();
			const trace = makeTrace({
				entries: [
					{ type: "tool_call", timestamp: 1000, toolName: "edit", args: { path: "a.ts" } },
					{ type: "tool_result", timestamp: 1100, isError: false },
					{ type: "tool_call", timestamp: 2000, toolName: "edit", args: { path: "b.ts" } },
					{ type: "tool_result", timestamp: 2100, isError: true },
					{ type: "tool_call", timestamp: 3000, toolName: "write", args: { path: "c.ts" } },
					{ type: "tool_result", timestamp: 3100, isError: false },
				],
				errorCount: 1,
			});

			const diagnosis = analyzer.analyze(trace);
			expect(diagnosis.toolEfficiency).toBe(2 / 3); // 2 successful out of 3 mod calls
		});

		test("Dominant error tool is identified", () => {
			const analyzer = new TraceAnalyzer();
			const trace = makeTrace({
				entries: [
					{ type: "tool_call", timestamp: 1000, toolName: "read", args: {} },
					{ type: "tool_result", timestamp: 1100, isError: true },
					{ type: "tool_call", timestamp: 2000, toolName: "read", args: {} },
					{ type: "tool_result", timestamp: 2100, isError: true },
					{ type: "tool_call", timestamp: 3000, toolName: "edit", args: {} },
					{ type: "tool_result", timestamp: 3100, isError: false },
				],
				errorCount: 2,
			});

			const diagnosis = analyzer.analyze(trace);
			expect(diagnosis.dominantErrorTool).toBe("read");
		});
	});

	describe("3.2: ErrorPatternExtractor - Error pattern extraction", () => {
		test("Base error patterns are matched from error details", () => {
			const extractor = new ErrorPatternExtractor();
			const trace = makeTrace({
				entries: [
					{ type: "tool_call", timestamp: 1000, toolName: "read", args: {} },
					{ type: "tool_result", timestamp: 1100, isError: true, result: "ENOENT: no such file" },
				],
				errorCount: 1,
				errorDetails: ["ENOENT: no such file or directory"],
			});

			const patterns = extractor.extract(trace);
			expect(patterns.length).toBeGreaterThan(0);
			const fileNotFound = patterns.find(p => p.id === "file-not-found");
			expect(fileNotFound).toBeDefined();
			expect(fileNotFound!.category).toBe("not_found");
			expect(fileNotFound!.extractedConventions.length).toBeGreaterThan(0);
		});

		test("TypeError patterns are matched", () => {
			const extractor = new ErrorPatternExtractor();
			const trace = makeTrace({
				entries: [
					{ type: "tool_call", timestamp: 1000, toolName: "bash", args: {} },
					{ type: "tool_result", timestamp: 1100, isError: true, result: "TypeError: Cannot read property" },
				],
				errorCount: 1,
				errorDetails: ["TypeError: Cannot read property 'x' of undefined"],
			});

			const patterns = extractor.extract(trace);
			const typeError = patterns.find(p => p.id === "type-error");
			expect(typeError).toBeDefined();
			expect(typeError!.category).toBe("type");
		});

		test("Cascade patterns are extracted from tool chains", () => {
			const extractor = new ErrorPatternExtractor();
			const trace = makeTrace({
				entries: [
					{ type: "tool_call", timestamp: 1000, toolName: "edit", args: { path: "a.ts" } },
					{ type: "tool_result", timestamp: 1100, isError: true, result: "anchor not found" },
					{ type: "tool_call", timestamp: 2000, toolName: "read", args: { path: "a.ts" } },
					{ type: "tool_result", timestamp: 2100, isError: true, result: "ENOENT" },
				],
				errorCount: 2,
				errorDetails: ["anchor not found", "ENOENT"],
			});

			const patterns = extractor.extract(trace);
			const cascade = patterns.find(p => p.id === "cascade-edit-read");
			expect(cascade).toBeDefined();
			expect(cascade!.count).toBeGreaterThanOrEqual(1);
		});

		test("Read failure patterns include contextual conventions", () => {
			const extractor = new ErrorPatternExtractor();
			const trace = makeTrace({
				entries: [
					{ type: "tool_call", timestamp: 1000, toolName: "read", args: { path: "/missing/file.ts" } },
					{ type: "tool_result", timestamp: 1100, isError: true, result: "ENOENT: no such file or directory" },
				],
				errorCount: 1,
				errorDetails: ["ENOENT: no such file or directory"],
			});

			const patterns = extractor.extract(trace);
			const readFailure = patterns.find(p => p.id === "read-failure-path_not_found");
			expect(readFailure).toBeDefined();
			expect(readFailure!.extractedConventions.length).toBeGreaterThanOrEqual(2);
			expect(readFailure!.extractedConventions[0]).toContain("操作文件前先确认路径存在");
		});

		test("Multiple error types in one session are all extracted", () => {
			const extractor = new ErrorPatternExtractor();
			const trace = makeTrace({
				entries: [
					{ type: "tool_call", timestamp: 1000, toolName: "read", args: {} },
					{ type: "tool_result", timestamp: 1100, isError: true, result: "ENOENT" },
					{ type: "tool_call", timestamp: 2000, toolName: "bash", args: {} },
					{ type: "tool_result", timestamp: 2100, isError: true, result: "SyntaxError: Unexpected token" },
				],
				errorCount: 2,
				errorDetails: ["ENOENT: no such file", "SyntaxError: Unexpected token"],
			});

			const patterns = extractor.extract(trace);
			const ids = patterns.map(p => p.id);
			expect(ids).toContain("file-not-found");
			expect(ids).toContain("syntax-error");
		});
	});

	describe("3.3: End-to-end diagnosis pipeline", () => {
		test("Full pipeline: trace → diagnosis → error patterns", () => {
			const analyzer = new TraceAnalyzer();
			const extractor = new ErrorPatternExtractor();

			// Simulate a realistic session: user asks to fix a bug,
			// agent searches, reads, edits (fails), reads again (fails)
			const trace = makeTrace({
				sessionId: "e2e-session-1",
				userPrompt: "fix the type error in src/handler.ts",
				entries: [
					{ type: "user_input", timestamp: 1000, content: "fix the type error in src/handler.ts" },
					{ type: "tool_call", timestamp: 2000, toolName: "search", args: { pattern: "handler" } },
					{ type: "tool_result", timestamp: 2100, isError: false, result: "found in src/handler.ts" },
					{ type: "tool_call", timestamp: 3000, toolName: "read", args: { path: "src/handler.ts" } },
					{ type: "tool_result", timestamp: 3100, isError: false, result: "file content..." },
					{ type: "tool_call", timestamp: 4000, toolName: "edit", args: { path: "src/handler.ts" } },
					{ type: "tool_result", timestamp: 4100, isError: true, result: "anchor not found" },
					{ type: "tool_call", timestamp: 5000, toolName: "read", args: { path: "src/handler.ts" } },
					{ type: "tool_result", timestamp: 5100, isError: true, result: "ENOENT: no such file" },
				],
				toolCallCount: 4,
				errorCount: 2,
				errorDetails: ["anchor not found", "ENOENT: no such file"],
			});

			// Step 1: TraceAnalyzer produces diagnosis
			const diagnosis = analyzer.analyze(trace);
			expect(diagnosis.readFailures.length).toBe(1);
			expect(diagnosis.readFailures[0].failureType).toBe("verify_after_edit_failure");
			expect(diagnosis.cascadePatterns.length).toBeGreaterThan(0);
			expect(diagnosis.suggestedAction).toBeTruthy();

			// Step 2: ErrorPatternExtractor produces patterns
			const patterns = extractor.extract(trace);
			expect(patterns.length).toBeGreaterThanOrEqual(2);

			// Should have: file-not-found (from errorDetails), cascade-edit-read (from trace)
			const ids = patterns.map(p => p.id);
			expect(ids).toContain("file-not-found");
			expect(ids).toContain("cascade-edit-read");

			// Cascade pattern should have root cause about anchor mismatch
			const cascade = patterns.find(p => p.id === "cascade-edit-read");
			expect(cascade).toBeDefined();
			expect(cascade!.extractedConventions[0]).toContain("edit");
		});

		test("Clean session produces minimal diagnosis", () => {
			const analyzer = new TraceAnalyzer();
			const extractor = new ErrorPatternExtractor();

			const trace = makeTrace({
				entries: [
					{ type: "tool_call", timestamp: 1000, toolName: "read", args: { path: "src/a.ts" } },
					{ type: "tool_result", timestamp: 1100, isError: false },
					{ type: "tool_call", timestamp: 2000, toolName: "edit", args: { path: "src/a.ts" } },
					{ type: "tool_result", timestamp: 2100, isError: false },
					{ type: "tool_call", timestamp: 3000, toolName: "write", args: { path: "src/b.ts" } },
					{ type: "tool_result", timestamp: 3100, isError: false },
				],
				completedSuccessfully: true,
				errorCount: 0,
			});

			const diagnosis = analyzer.analyze(trace);
			expect(diagnosis.readFailures).toHaveLength(0);
			expect(diagnosis.cascadePatterns).toHaveLength(0);
			expect(diagnosis.redundantSearches).toBe(false);
			expect(diagnosis.slowLoop).toBe(false);
			expect(diagnosis.toolEfficiency).toBe(1);

			const patterns = extractor.extract(trace);
			expect(patterns).toHaveLength(0);
		});
	});
});
