import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { closeEvolutionDb, getEvolutionDb } from "../src/storage/db";
import type { SessionTrace } from "../src/types";
import {
	computeRollingWindowStats,
	generateUserProfileMd,
	projectUserProfile,
	UserProfiler,
} from "../src/user-profiler";

function makeTrace(overrides: Partial<SessionTrace> = {}): SessionTrace {
	return {
		sessionId: "test-session",
		cwd: "/tmp",
		userPrompt: overrides.userPrompt ?? "test",
		startTime: Date.now(),
		endTime: Date.now(),
		toolCallCount: overrides.toolCallCount ?? 0,
		errorCount: overrides.errorCount ?? 0,
		hadRecovery: overrides.hadRecovery ?? false,
		completedSuccessfully: overrides.completedSuccessfully ?? true,
		entries: overrides.entries ?? [],
	};
}

describe("UserProfiler", () => {
	test("initial profile has empty stats", () => {
		const profiler = new UserProfiler();
		const profile = profiler.getProfile();
		expect(profile.sessionCount).toBe(0);
		expect(profile.errorRate).toBe(0);
		expect(Object.keys(profile.toolFrequency)).toHaveLength(0);
	});

	test("updateProfile increments tool frequency", () => {
		const profiler = new UserProfiler();
		const trace = makeTrace({
			entries: [
				{ type: "tool_call", timestamp: Date.now(), toolName: "read", args: {} },
				{ type: "tool_call", timestamp: Date.now(), toolName: "edit", args: {} },
				{ type: "tool_call", timestamp: Date.now(), toolName: "read", args: {} },
			],
		});
		profiler.updateProfile(trace, "refactoring");
		const profile = profiler.getProfile();
		expect(profile.toolFrequency.read).toBe(2);
		expect(profile.toolFrequency.edit).toBe(1);
		expect(profile.sessionCount).toBe(1);
	});

	test("updateProfile tracks tool transitions", () => {
		const profiler = new UserProfiler();
		const trace = makeTrace({
			entries: [
				{ type: "tool_call", timestamp: Date.now(), toolName: "read", args: {} },
				{ type: "tool_call", timestamp: Date.now(), toolName: "edit", args: {} },
			],
		});
		profiler.updateProfile(trace, "refactoring");
		const profile = profiler.getProfile();
		expect(profile.toolTransitions["read→edit"]).toBe(1);
	});

	test("updateProfile calculates error rate", () => {
		const profiler = new UserProfiler();
		profiler.updateProfile(makeTrace({ errorCount: 1 }), "bugfix");
		profiler.updateProfile(makeTrace({ errorCount: 0 }), "feature-add");
		const profile = profiler.getProfile();
		expect(profile.errorRate).toBe(0.5);
	});

	test("updateProfile tracks intent distribution", () => {
		const profiler = new UserProfiler();
		profiler.updateProfile(makeTrace(), "refactoring");
		profiler.updateProfile(makeTrace(), "refactoring");
		profiler.updateProfile(makeTrace(), "bugfix");
		const profile = profiler.getProfile();
		expect(profile.intentDistribution.refactoring).toBe(2);
		expect(profile.intentDistribution.bugfix).toBe(1);
	});

	test("updateProfile detects preferred languages from files", () => {
		const profiler = new UserProfiler();
		const trace = makeTrace({
			entries: [
				{ type: "tool_call", timestamp: Date.now(), toolName: "edit", args: { path: "src/auth.ts" } },
				{ type: "tool_call", timestamp: Date.now(), toolName: "edit", args: { path: "src/main.rs" } },
			],
		});
		profiler.updateProfile(trace, "feature-add");
		const profile = profiler.getProfile();
		expect(profile.preferredLanguages).toContain("typescript");
		expect(profile.preferredLanguages).toContain("rust");
	});

	test("serialize and deserialize preserves data", () => {
		const profiler = new UserProfiler();
		profiler.updateProfile(
			makeTrace({ entries: [{ type: "tool_call", timestamp: Date.now(), toolName: "read", args: {} }] }),
			"exploration",
		);
		const json = profiler.serialize();
		const restored = UserProfiler.deserialize(json);
		expect(restored.getProfile().toolFrequency.read).toBe(1);
		expect(restored.getProfile().sessionCount).toBe(1);
	});
});

describe("generateUserProfileMd", () => {
	test("renders profile with rolling windows", () => {
		const profile: import("../src/types").UserProfile = {
			toolFrequency: { read: 10, edit: 5 },
			toolTransitions: { "read→edit": 3 },
			intentDistribution: { refactoring: 5, bugfix: 2 },
			avgToolCallsPerSession: 4.5,
			avgFilesModifiedPerSession: 2.1,
			errorRate: 0.1,
			recoveryRate: 0.8,
			preferredLanguages: ["typescript", "rust"],
			sessionCount: 20,
			updatedAt: Date.now(),
		};
		const rolling = [
			{
				days: 7,
				sessionCount: 5,
				successRate: 0.8,
				errorRate: 0.2,
				recoveryRate: 0.5,
				avgToolCalls: 3,
				avgDurationMs: 12000,
				topIntents: [],
				topTools: [],
			},
		];
		const md = generateUserProfileMd(profile, rolling);
		expect(md).toContain("# User Profile");
		expect(md).toContain("Total sessions: 20");
		expect(md).toContain("Last 7 days");
		expect(md).toContain(" typescript, rust");
	});

	test("renders empty profile", () => {
		const profile: import("../src/types").UserProfile = {
			toolFrequency: {},
			toolTransitions: {},
			intentDistribution: {},
			avgToolCallsPerSession: 0,
			avgFilesModifiedPerSession: 0,
			errorRate: 0,
			recoveryRate: 0,
			preferredLanguages: [],
			sessionCount: 0,
			updatedAt: Date.now(),
		};
		const md = generateUserProfileMd(profile);
		expect(md).toContain("# User Profile");
		expect(md).toContain("none");
	});
});

describe("computeRollingWindowStats", () => {
	let db: Database;
	let cwd: string;

	beforeEach(() => {
		cwd = path.join(os.tmpdir(), `test-profiler-${Date.now()}`);
		db = getEvolutionDb(cwd);
	});

	afterEach(() => {
		closeEvolutionDb(cwd);
	});

	test("computes stats from episodes", () => {
		const now = Date.now();
		db.prepare(`
			INSERT INTO episodes (id, session_id, cwd, user_prompt, timestamp, duration_ms, tool_call_count, error_count, had_recovery, completed_successfully, summary, tools_used, files_modified)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run("ep1", "s1", cwd, "test", now, 10000, 5, 1, 1, 0, "summary", "read,edit", "a.ts");
		db.prepare(`
			INSERT INTO episodes (id, session_id, cwd, user_prompt, timestamp, duration_ms, tool_call_count, error_count, had_recovery, completed_successfully, summary, tools_used, files_modified)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run("ep2", "s2", cwd, "test", now, 5000, 3, 0, 0, 1, "summary", "read,test", "b.ts");

		const stats = computeRollingWindowStats(db, 7);
		expect(stats.sessionCount).toBe(2);
		expect(stats.successRate).toBe(0.5);
		expect(stats.errorRate).toBe(0.5);
		expect(stats.recoveryRate).toBe(0.5);
		expect(stats.avgToolCalls).toBe(4);
	});

	test("returns zero stats when no episodes", () => {
		const stats = computeRollingWindowStats(db, 7);
		expect(stats.sessionCount).toBe(0);
		expect(stats.successRate).toBe(0);
	});
});

describe("projectUserProfile", () => {
	let db: Database;
	let cwd: string;
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = os.tmpdir();
		cwd = path.join(tmpDir, `test-proj-profile-${Date.now()}`);
		db = getEvolutionDb(cwd);
	});

	afterEach(() => {
		closeEvolutionDb(cwd);
	});

	test("writes user_profile.md with rolling windows", async () => {
		const now = Date.now();
		db.prepare(`
			INSERT INTO episodes (id, session_id, cwd, user_prompt, timestamp, duration_ms, tool_call_count, error_count, had_recovery, completed_successfully, summary, tools_used, files_modified)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run("ep1", "s1", cwd, "test", now, 10000, 5, 0, 0, 1, "summary", "read,edit", "a.ts");
		db.prepare(`
			INSERT INTO user_profiles (id, profile_json, updated_at)
			VALUES (?, ?, ?)
		`).run(
			"default",
			JSON.stringify({
				toolFrequency: {},
				toolTransitions: {},
				intentDistribution: {},
				avgToolCallsPerSession: 0,
				avgFilesModifiedPerSession: 0,
				errorRate: 0,
				recoveryRate: 0,
				preferredLanguages: [],
				sessionCount: 1,
				updatedAt: now,
			}),
			now,
		);

		const outPath = await projectUserProfile(db, { outputDir: tmpDir, windows: [7] });
		expect(outPath).toEndWith("user_profile.md");

		const md = await Bun.file(outPath).text();
		expect(md).toContain("# User Profile");
		expect(md).toContain("Last 7 days");
		expect(md).toContain("Sessions: 1");
	});
});
