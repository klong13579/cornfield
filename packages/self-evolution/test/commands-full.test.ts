/**
 * Full command tests for all 12 evolution subcommands.
 *
 * Covers section 5.2 of the test plan: skills, rate, clear, archive,
 * history, rollback, audit, report, fit, population.
 */
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import type { AutocompleteItem } from "@oh-my-pi/pi-tui";
import { registerEpisodicCommands, registerSelfEvolutionCommands } from "../src/commands";
import { EpisodicManager } from "../src/episodic-manager";
import { initSchema } from "../src/storage/db";
import { SqliteEffectivenessStore } from "../src/storage/effectiveness";
import { SqliteEpisodeStore } from "../src/storage/episodes";
import { SqliteEvolutionEscalationStore } from "../src/storage/evolution-escalations";
import { SqliteLearningStore } from "../src/storage/learnings";
import { SqliteNudgeHistoryStore } from "../src/storage/nudge-history";
import { SqliteProfileStore } from "../src/storage/profiles";
import { SqliteRegressionFixtureStore } from "../src/storage/regression-fixtures";
import { SqliteRegressionTrialStore } from "../src/storage/regression-trials";
import { SqliteSkillStore, SqliteSkillVersionStore, SqliteStatsStore } from "../src/storage/skills";
import { SqliteWorkflowPatternStore } from "../src/storage/workflow-patterns";
import type { EvolvedSkill, SkillVersion } from "../src/types";

describe("Self-evolution commands — full coverage", () => {
	let db: Database;
	let profileStore: SqliteProfileStore;
	let workflowPatternStore: SqliteWorkflowPatternStore;
	let episodeStore: SqliteEpisodeStore;
	let skillStore: SqliteSkillStore;
	let versionStore: SqliteSkillVersionStore;
	let statsStore: SqliteStatsStore;
	let learningStore: SqliteLearningStore;
	let effectivenessStore: SqliteEffectivenessStore;
	let episodicManager: EpisodicManager;
	let nudgeHistoryStore: SqliteNudgeHistoryStore;
	let escalationStore: SqliteEvolutionEscalationStore;
	let regressionFixtureStore: SqliteRegressionFixtureStore;
	let regressionTrialStore: SqliteRegressionTrialStore;
	let notified: Array<{ message: string; type?: string }>;
	let commands: Map<
		string,
		{
			description?: string;
			handler: (args: string, ctx: unknown) => Promise<void>;
			getArgumentCompletions?: (prefix: string) => AutocompleteItem[] | null;
		}
	>;
	let _ensureInitCalled: boolean;

	// Mutable mock objects so tests can control behavior
	let mockSkillManager: {
		archiveLowQuality: () => Promise<number>;
		rollback: (name: string, version: number) => Promise<EvolvedSkill | undefined>;
		getHistory: (name: string) => Promise<SkillVersion[]>;
	};
	let mockActivityLogger: {
		log: (event: string, details: Record<string, unknown>) => Promise<void>;
		query: (options?: { event?: string; since?: number; limit?: number }) => Promise<any[]>;
	};
	let mockPopulationStore: {
		insert: () => Promise<void>;
		get: () => Promise<undefined>;
		list: () => Promise<any[]>;
		update: () => Promise<void>;
		delete: () => Promise<void>;
		transitionState: () => Promise<void>;
		countByState: (state: string) => Promise<number>;
	};
	let mockPopulationEngine: {
		evaluateAll: () => Promise<{ transitions: number; evaluated: number; eliminated: number; graduated: number }>;
		selectForInjection: () => Promise<any[]>;
		mutate: () => Promise<boolean>;
		eliminate: () => Promise<{ deprecated: number; archived: number }>;
		graduate: () => Promise<boolean>;
		register: () => Promise<void>;
		recordUsage: () => Promise<void>;
	};

	function makeCtx(cwd = path.join(os.tmpdir(), "omp-evolution-cmd-test")) {
		return {
			cwd,
			ui: {
				notify: (message: string, type?: string) => {
					notified.push({ message, type });
				},
				confirm: async (_title: string, _message: string): Promise<boolean> => true,
			},
		} as never;
	}

	beforeEach(() => {
		db = new Database(":memory:");
		initSchema(db);
		profileStore = new SqliteProfileStore(db);
		workflowPatternStore = new SqliteWorkflowPatternStore(db);
		episodeStore = new SqliteEpisodeStore(db);
		skillStore = new SqliteSkillStore(db);
		versionStore = new SqliteSkillVersionStore(db);
		statsStore = new SqliteStatsStore(db);
		learningStore = new SqliteLearningStore(db);
		effectivenessStore = new SqliteEffectivenessStore(db);
		nudgeHistoryStore = new SqliteNudgeHistoryStore(db);
		escalationStore = new SqliteEvolutionEscalationStore(db);
		regressionFixtureStore = new SqliteRegressionFixtureStore(db);
		regressionTrialStore = new SqliteRegressionTrialStore(db);
		episodicManager = EpisodicManager.create(db);
		notified = [];
		_ensureInitCalled = false;
		commands = new Map();

		mockSkillManager = {
			archiveLowQuality: async () => 0,
			rollback: async (_name: string, _version: number) => undefined,
			getHistory: async (_name: string) => [],
		};

		mockActivityLogger = {
			log: async () => {},
			query: async (_options?: { event?: string; since?: number; limit?: number }) => [],
		};

		mockPopulationStore = {
			insert: async () => {},
			get: async () => undefined,
			list: async () => [],
			update: async () => {},
			delete: async () => {},
			transitionState: async () => {},
			countByState: async (_state: string) => 0,
		};

		mockPopulationEngine = {
			evaluateAll: async () => ({ transitions: 0, evaluated: 0, eliminated: 0, graduated: 0 }),
			selectForInjection: async () => [],
			mutate: async () => false,
			eliminate: async () => ({ deprecated: 0, archived: 0 }),
			graduate: async () => false,
			register: async () => {},
			recordUsage: async () => {},
		};

		const api = {
			registerCommand: (
				name: string,
				options: {
					description?: string;
					handler: (args: string, ctx: unknown) => Promise<void>;
					getArgumentCompletions?: (prefix: string) => AutocompleteItem[] | null;
				},
			) => {
				commands.set(name, options);
			},
		};

		const stores = {
			ensureInit: () => {
				_ensureInitCalled = true;
			},
			episodeStore: () => episodeStore,
			skillStore: () => skillStore,
			versionStore: () => versionStore,
			statsStore: () => statsStore,
			skillManager: () => mockSkillManager,
			activityLogger: () => mockActivityLogger,
			profileStore: () => profileStore,
			workflowPatternStore: () => workflowPatternStore,
			learningStore: () => learningStore,
			effectivenessStore: () => effectivenessStore,
			populationStore: () => mockPopulationStore,
			populationEngine: () => mockPopulationEngine,
			nudgeHistoryStore: () => nudgeHistoryStore,
			db: () => db,
			flags: () =>
				({
					enabled: true,
					skillThreshold: 5,
					maxEpisodes: 500,
					enablePromptInjection: true,
					enableNudgeContextInjection: true,
					llmRefinement: true,
					llmRerank: true,
					enableVersioning: true,
					enableActivityLog: true,
					globalStore: false,
					regressionReplayBackend: "heuristic",
					admissionReclassifyInterval: 5,
				}) as never,
			episodicManager: () => episodicManager,
			escalationStore: () => escalationStore,
			regressionFixtureStore: () => regressionFixtureStore,
			regressionTrialStore: () => regressionTrialStore,
			sessionTraceStore: () =>
				({
					upsert: async () => {},
					get: async () => undefined,
				}) as never,
			skillEffectivenessStore: () =>
				({
					get: async () => undefined,
					recordInjection: async () => {},
					recordOutcome: async () => {},
				}) as never,
			memoryDb: () => db,
			embeddingGenerator: () => undefined,
		};

		registerSelfEvolutionCommands(api as never, stores as never);
		registerEpisodicCommands(api as never, stores as never);
	});

	// ── CMD-01/02/03: skills ──

	describe("evolution (subcommand: skills)", () => {
		const cmd = () => commands.get("evolution")!;

		test("CMD-01: notifies when no skills exist", async () => {
			await cmd().handler("skills", makeCtx());

			expect(notified.length).toBe(1);
			expect(notified[0]!.type).toBe("info");
			expect(notified[0]!.message).toContain("No evolved skills yet");
		});

		test("CMD-02: lists skills with name, quality, success rate", async () => {
			const skill: EvolvedSkill = {
				name: "test-case-design",
				description: "Design test cases with boundary conditions",
				taskPattern: "testing",
				approach: "Always consider edge cases and boundary values when designing tests",
				tools: ["read", "edit", "test"],
				pitfalls: ["forgetting null inputs", "missing edge cases"],
				createdAt: Date.now(),
				usageCount: 5,
				lastUsedAt: Date.now(),
				successCount: 4,
				failureCount: 1,
				version: 2,
				qualityScore: 85,
			};
			const skill2: EvolvedSkill = {
				name: "code-review",
				description: "Review code for common issues",
				taskPattern: "review",
				approach: "Check for null safety, edge cases, and performance",
				tools: ["search", "read"],
				pitfalls: [],
				createdAt: Date.now(),
				usageCount: 3,
				lastUsedAt: Date.now(),
				successCount: 2,
				failureCount: 1,
				version: 1,
				qualityScore: 65,
			};
			await skillStore.upsert(skill);
			await skillStore.upsert(skill2);

			await cmd().handler("skills", makeCtx());

			expect(notified.length).toBe(1);
			expect(notified[0]!.type).toBe("info");
			const msg = notified[0]!.message;
			expect(msg).toContain("test-case-design");
			expect(msg).toContain("v2");
			expect(msg).toContain("quality: 85");
			expect(msg).toContain("80%"); // 4/5 = 80%
			expect(msg).toContain("code-review");
			expect(msg).toContain("v1");
			expect(msg).toContain("quality: 65");
			expect(msg).toContain("67%"); // 2/3 ≈ 67%
		});

		test("CMD-03: skills --detail shows breakdown", async () => {
			const skill: EvolvedSkill = {
				name: "test-case-design",
				description: "Design test cases with boundary conditions",
				taskPattern: "testing",
				approach: "Always consider edge cases and boundary values when designing tests",
				tools: ["read", "edit", "test"],
				pitfalls: ["forgetting null inputs", "missing edge cases"],
				createdAt: Date.now(),
				usageCount: 5,
				lastUsedAt: Date.now(),
				successCount: 4,
				failureCount: 1,
				version: 2,
				qualityScore: 85,
			};
			await skillStore.upsert(skill);

			await cmd().handler("skills --detail", makeCtx());

			expect(notified.length).toBe(1);
			const msg = notified[0]!.message;
			expect(msg).toContain("test-case-design");
			expect(msg).toContain("TOTAL=");
			// Breakdown dimensions should be present
			expect(msg).toContain("successRate=");
			expect(msg).toContain("diversity=");
			expect(msg).toContain("pitfalls=");
			expect(msg).toContain("approach=");
		});
	});

	// ── CMD-04/05/06: rate ──

	describe("evolution (subcommand: rate)", () => {
		const cmd = () => commands.get("evolution")!;

		beforeEach(async () => {
			const skill: EvolvedSkill = {
				name: "test-case-design",
				description: "Design test cases with boundary conditions",
				taskPattern: "testing",
				approach: "Always consider edge cases and boundary values when designing tests",
				tools: ["read", "edit", "test"],
				pitfalls: ["forgetting null inputs"],
				createdAt: Date.now(),
				usageCount: 5,
				lastUsedAt: Date.now(),
				successCount: 4,
				failureCount: 1,
				version: 2,
				qualityScore: 85,
			};
			await skillStore.upsert(skill);
		});

		test("CMD-04: rates a skill and updates quality score", async () => {
			await cmd().handler("rate test-case-design 4", makeCtx());

			expect(notified.length).toBe(1);
			expect(notified[0]!.type).toBe("info");
			const msg = notified[0]!.message;
			expect(msg).toContain('Rated "test-case-design"');
			expect(msg).toContain("★★★★☆");
			expect(msg).toContain("quality updated to");

			// Verify the skill was updated in the store
			const updated = await skillStore.get("test-case-design");
			expect(updated).toBeDefined();
			expect(updated!.userRating).toBe(4);
		});

		test("CMD-05: notifies when skill not found", async () => {
			await cmd().handler("rate nonexistent-skill 3", makeCtx());

			expect(notified.length).toBe(1);
			expect(notified[0]!.type).toBe("error");
			expect(notified[0]!.message).toContain('Skill "nonexistent-skill" not found');
		});

		test("CMD-06: rejects rating > 5", async () => {
			await cmd().handler("rate test-case-design 6", makeCtx());

			expect(notified.length).toBe(1);
			expect(notified[0]!.type).toBe("error");
			expect(notified[0]!.message).toContain("Rating must be a number between 1 and 5");
		});

		test("rejects rating < 1", async () => {
			await cmd().handler("rate test-case-design 0", makeCtx());

			expect(notified.length).toBe(1);
			expect(notified[0]!.type).toBe("error");
			expect(notified[0]!.message).toContain("Rating must be a number between 1 and 5");
		});

		test("rejects non-numeric rating", async () => {
			await cmd().handler("rate test-case-design abc", makeCtx());

			expect(notified.length).toBe(1);
			expect(notified[0]!.type).toBe("error");
			expect(notified[0]!.message).toContain("Rating must be a number between 1 and 5");
		});

		test("shows usage when missing args", async () => {
			await cmd().handler("rate", makeCtx());

			expect(notified.length).toBe(1);
			expect(notified[0]!.type).toBe("warning");
			expect(notified[0]!.message).toContain("Usage: /evolution rate");
		});

		test("shows usage when missing rating", async () => {
			await cmd().handler("rate test-case-design", makeCtx());

			expect(notified.length).toBe(1);
			expect(notified[0]!.type).toBe("warning");
			expect(notified[0]!.message).toContain("Usage: /evolution rate");
		});
	});

	// ── CMD-07: clear ──

	describe("evolution (subcommand: clear)", () => {
		const cmd = () => commands.get("evolution")!;

		test("CMD-07: clears project evolution dirs on confirm", async () => {
			await cmd().handler("clear", makeCtx());

			expect(notified.length).toBe(1);
			expect(notified[0]!.type).toBe("info");
			expect(notified[0]!.message).toContain("Cleared");
			expect(notified[0]!.message).toContain(".omp/evolution");
		});

		test("cancels when user declines", async () => {
			const ctx = {
				cwd: "/test",
				ui: {
					notify: (message: string, type?: string) => {
						notified.push({ message, type });
					},
					confirm: async (_title: string, _message: string): Promise<boolean> => false,
				},
			} as never;

			await cmd().handler("clear", ctx);

			expect(notified.length).toBe(1);
			expect(notified[0]!.type).toBe("info");
			expect(notified[0]!.message).toContain("Cancelled");
		});
	});

	// ── CMD-08: archive ──

	describe("evolution (subcommand: archive)", () => {
		const cmd = () => commands.get("evolution")!;

		test("CMD-08: archives low-quality skills and reports count", async () => {
			mockSkillManager.archiveLowQuality = async () => 2;

			await cmd().handler("archive", makeCtx());

			expect(notified.length).toBe(1);
			expect(notified[0]!.type).toBe("info");
			expect(notified[0]!.message).toContain("Archived 2 low-quality skill(s)");
		});

		test("reports 0 when no skills to archive", async () => {
			mockSkillManager.archiveLowQuality = async () => 0;

			await cmd().handler("archive", makeCtx());

			expect(notified.length).toBe(1);
			expect(notified[0]!.type).toBe("info");
			expect(notified[0]!.message).toContain("Archived 0 low-quality skill(s)");
		});

		test("notifies error when archive fails", async () => {
			mockSkillManager.archiveLowQuality = async () => {
				throw new Error("DB error");
			};

			await cmd().handler("archive", makeCtx());

			expect(notified.length).toBe(1);
			expect(notified[0]!.type).toBe("error");
			expect(notified[0]!.message).toContain("Failed to archive skills");
		});
	});

	// ── CMD-09/10: history ──

	describe("evolution (subcommand: history)", () => {
		const cmd = () => commands.get("evolution")!;

		test("CMD-09: shows version history for a skill", async () => {
			const now = Date.now();
			mockSkillManager.getHistory = async (_name: string) => [
				{
					name: "test-case-design",
					version: 2,
					skill: {} as EvolvedSkill,
					changedAt: now,
					changeType: "merged",
					changeReason: "merged with better approach",
				},
				{
					name: "test-case-design",
					version: 1,
					skill: {} as EvolvedSkill,
					changedAt: now - 86400000,
					changeType: "extracted",
					changeReason: "initial extraction",
				},
			];

			await cmd().handler("history test-case-design", makeCtx());

			expect(notified.length).toBe(1);
			expect(notified[0]!.type).toBe("info");
			const msg = notified[0]!.message;
			expect(msg).toContain("v2");
			expect(msg).toContain("merged");
			expect(msg).toContain("v1");
			expect(msg).toContain("extracted");
		});

		test("CMD-10: notifies when no history exists", async () => {
			mockSkillManager.getHistory = async () => [];

			await cmd().handler("history test-case-design", makeCtx());

			expect(notified.length).toBe(1);
			expect(notified[0]!.type).toBe("info");
			expect(notified[0]!.message).toContain('No history found for skill "test-case-design"');
		});

		test("shows usage when no skill name provided", async () => {
			await cmd().handler("history", makeCtx());

			expect(notified.length).toBe(1);
			expect(notified[0]!.type).toBe("warning");
			expect(notified[0]!.message).toContain("Usage: /evolution history");
		});

		test("notifies error when getHistory throws", async () => {
			mockSkillManager.getHistory = async () => {
				throw new Error("DB error");
			};

			await cmd().handler("history test-case-design", makeCtx());

			expect(notified.length).toBe(1);
			expect(notified[0]!.type).toBe("error");
			expect(notified[0]!.message).toContain("Failed to load skill history");
		});
	});

	// ── CMD-11/12: rollback ──

	describe("evolution (subcommand: rollback)", () => {
		const cmd = () => commands.get("evolution")!;

		test("CMD-11: rolls back to a valid version", async () => {
			mockSkillManager.rollback = async (_name: string, _version: number) =>
				({
					name: "test-case-design",
					version: 3,
					description: "Design test cases",
					taskPattern: "testing",
					approach: "Consider edge cases",
					tools: ["read", "edit"],
					pitfalls: [],
					createdAt: Date.now(),
					usageCount: 6,
					lastUsedAt: Date.now(),
					successCount: 4,
					failureCount: 2,
					qualityScore: 80,
				}) as EvolvedSkill;

			await cmd().handler("rollback test-case-design 1", makeCtx());

			expect(notified.length).toBe(1);
			expect(notified[0]!.type).toBe("info");
			expect(notified[0]!.message).toContain('Rolled back "test-case-design" to v1');
			expect(notified[0]!.message).toContain("new version: v3");
		});

		test("CMD-12: notifies when version not found", async () => {
			mockSkillManager.rollback = async () => undefined;

			await cmd().handler("rollback test-case-design 99", makeCtx());

			expect(notified.length).toBe(1);
			expect(notified[0]!.type).toBe("error");
			expect(notified[0]!.message).toContain('Version 99 of "test-case-design" not found');
		});

		test("shows usage when missing args", async () => {
			await cmd().handler("rollback", makeCtx());

			expect(notified.length).toBe(1);
			expect(notified[0]!.type).toBe("warning");
			expect(notified[0]!.message).toContain("Usage: /evolution rollback");
		});

		test("shows usage when missing version", async () => {
			await cmd().handler("rollback test-case-design", makeCtx());

			expect(notified.length).toBe(1);
			expect(notified[0]!.type).toBe("warning");
			expect(notified[0]!.message).toContain("Usage: /evolution rollback");
		});

		test("rejects non-numeric version", async () => {
			await cmd().handler("rollback test-case-design abc", makeCtx());

			expect(notified.length).toBe(1);
			expect(notified[0]!.type).toBe("error");
			expect(notified[0]!.message).toContain("Invalid version number");
		});

		test("notifies error when rollback throws", async () => {
			mockSkillManager.rollback = async () => {
				throw new Error("DB error");
			};

			await cmd().handler("rollback test-case-design 1", makeCtx());

			expect(notified.length).toBe(1);
			expect(notified[0]!.type).toBe("error");
			expect(notified[0]!.message).toContain("Rollback failed");
		});
	});

	// ── CMD-13: audit ──

	describe("evolution (subcommand: audit)", () => {
		const cmd = () => commands.get("evolution")!;

		test("CMD-13: generates formatted audit report with empty data", async () => {
			await cmd().handler("audit", makeCtx());

			expect(notified.length).toBe(1);
			expect(notified[0]!.type).toBe("info");
			const msg = notified[0]!.message;
			// Should contain report sections
			expect(msg).toContain("Self-Evolution Audit Report");
			expect(msg).toContain("## Episodes");
			expect(msg).toContain("## Skills");
			expect(msg).toContain("## Effectiveness");
			expect(msg).toContain("## Issues Found");
			expect(msg).toContain("No skills extracted yet");
		});

		test("generates audit report with data", async () => {
			// Insert some episodes
			const epStmt = db.prepare(`
				INSERT INTO episodes (id, session_id, cwd, user_prompt, timestamp, duration_ms, tool_call_count, error_count, had_recovery, completed_successfully, summary, tools_used, files_modified)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`);
			epStmt.run(
				"ep1",
				"s1",
				"/test",
				"Fix bug",
				Date.now(),
				1000,
				5,
				0,
				0,
				1,
				"Fixed bug successfully",
				'["read","edit"]',
				'["src/main.ts"]',
			);
			epStmt.run(
				"ep2",
				"s2",
				"/test",
				"Add feature",
				Date.now(),
				2000,
				8,
				2,
				1,
				0,
				"Failed to add feature",
				'["search","read","edit"]',
				'["src/feature.ts"]',
			);

			// Insert a skill
			await skillStore.upsert({
				name: "test-case-design",
				description: "Design test cases",
				taskPattern: "testing",
				approach: "Consider edge cases",
				tools: ["read", "edit"],
				pitfalls: [],
				createdAt: Date.now(),
				usageCount: 3,
				lastUsedAt: Date.now(),
				successCount: 2,
				failureCount: 1,
				version: 1,
				qualityScore: 75,
			});

			await cmd().handler("audit", makeCtx());

			expect(notified.length).toBe(1);
			const msg = notified[0]!.message;
			expect(msg).toContain("Self-Evolution Audit Report");
			expect(msg).toContain("Total: 2");
			expect(msg).toContain("Total: 1 (0 deprecated)");
			expect(msg).toContain("test-case-design");
		});

		test("notifies error when audit fails", async () => {
			db.close();
			await cmd().handler("audit", makeCtx());

			expect(notified.length).toBe(1);
			expect(notified[0]!.type).toBe("error");
			expect(notified[0]!.message).toContain("Failed to generate audit report");
		});
	});

	// ── CMD-14: report ──

	describe("evolution (subcommand: report)", () => {
		const cmd = () => commands.get("evolution")!;

		test("CMD-14: generates formatted daily report with empty data", async () => {
			await cmd().handler("report", makeCtx());

			expect(notified.length).toBe(1);
			expect(notified[0]!.type).toBe("info");
			const msg = notified[0]!.message;
			expect(msg).toContain("Daily Report");
			expect(msg).toContain("Summary: 0 total");
			expect(msg).toContain("Key Moments");
			expect(msg).toContain("Top Error Patterns");
			expect(msg).toContain("New Conventions");
			expect(msg).toContain("Top Tools");
		});

		test("generates daily report with session data", async () => {
			const now = Date.now();
			const epStmt = db.prepare(`
				INSERT INTO episodes (id, session_id, cwd, user_prompt, timestamp, duration_ms, tool_call_count, error_count, had_recovery, completed_successfully, summary, tools_used, files_modified)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`);
			epStmt.run(
				"ep1",
				"s1",
				"/test",
				"Fix bug",
				now,
				1000,
				5,
				0,
				0,
				1,
				"Fixed bug successfully",
				'["read","edit"]',
				'["src/main.ts"]',
			);

			await cmd().handler("report", makeCtx());

			expect(notified.length).toBe(1);
			const msg = notified[0]!.message;
			expect(msg).toContain("Daily Report");
			expect(msg).toContain("Summary: 1 total");
			expect(msg).toContain("1 success");
		});

		test("notifies error when report fails", async () => {
			db.close();
			await cmd().handler("report", makeCtx());

			expect(notified.length).toBe(1);
			expect(notified[0]!.type).toBe("error");
			expect(notified[0]!.message).toContain("Failed to generate daily report");
		});
	});

	// ── CMD-15: fit ──

	describe("evolution (subcommand: fit)", () => {
		const cmd = () => commands.get("evolution")!;

		test("CMD-15: generates fit evaluation report", async () => {
			// Insert a profile so heuristic responses are enriched
			await profileStore.upsert("default", {
				toolFrequency: { read: 5, edit: 3, search: 2 },
				toolTransitions: {},
				intentDistribution: { refactoring: 2, bugfix: 1 },
				avgToolCallsPerSession: 4.5,
				avgFilesModifiedPerSession: 1.2,
				errorRate: 0.1,
				recoveryRate: 0.5,
				preferredLanguages: ["typescript", "rust"],
				sessionCount: 3,
				updatedAt: Date.now(),
			});

			await cmd().handler("fit", makeCtx());

			expect(notified.length).toBe(1);
			expect(notified[0]!.type).toBe("info");
			const msg = notified[0]!.message;
			expect(msg).toContain("Agent「懂我程度」评分");
			expect(msg).toContain("总分:");
			expect(msg).toContain("维度得分");
			expect(msg).toContain("个人记忆留存");
			expect(msg).toContain("思维模式适配");
			expect(msg).toContain("输出风格贴合");
			expect(msg).toContain("隐含需求预判");
			expect(msg).toContain("历史对话联动");
			expect(msg).toContain("改进建议");
		});

		test("generates fit report without profile", async () => {
			await cmd().handler("fit", makeCtx());

			expect(notified.length).toBe(1);
			expect(notified[0]!.type).toBe("info");
			const msg = notified[0]!.message;
			expect(msg).toContain("Agent「懂我程度」评分");
			expect(msg).toContain("总分:");
		});

		test("notifies error when fit fails", async () => {
			db.close();
			await cmd().handler("fit", makeCtx());

			expect(notified.length).toBe(1);
			expect(notified[0]!.type).toBe("error");
			expect(notified[0]!.message).toContain("Failed to run fit evaluation");
		});
	});

	// ── population ──

	describe("evolution (subcommand: population)", () => {
		const cmd = () => commands.get("evolution")!;

		test("shows population status with empty data", async () => {
			await cmd().handler("population", makeCtx());

			expect(notified.length).toBe(1);
			expect(notified[0]!.type).toBe("info");
			const msg = notified[0]!.message;
			expect(msg).toContain("Skill Population Status");
			expect(msg).toContain("Evaluated: 0");
			expect(msg).toContain("candidate: 0");
			expect(msg).toContain("experimental: 0");
			expect(msg).toContain("graduated: 0");
			expect(msg).toContain("deprecated: 0");
			expect(msg).toContain("archived: 0");
		});

		test("shows population status with data", async () => {
			mockPopulationEngine.evaluateAll = async () => ({
				transitions: 3,
				evaluated: 10,
				eliminated: 1,
				graduated: 2,
			});
			mockPopulationStore.countByState = async (state: string) => {
				const counts: Record<string, number> = {
					candidate: 5,
					experimental: 3,
					graduated: 2,
					deprecated: 1,
					archived: 0,
				};
				return counts[state] ?? 0;
			};

			await cmd().handler("population", makeCtx());

			expect(notified.length).toBe(1);
			const msg = notified[0]!.message;
			expect(msg).toContain("Evaluated: 10");
			expect(msg).toContain("Transitions: 3");
			expect(msg).toContain("Graduated: 2");
			expect(msg).toContain("Eliminated: 1");
			expect(msg).toContain("candidate: 5");
			expect(msg).toContain("experimental: 3");
			expect(msg).toContain("graduated: 2");
			expect(msg).toContain("deprecated: 1");
		});

		test("notifies error when population fails", async () => {
			mockPopulationEngine.evaluateAll = async () => {
				throw new Error("Engine error");
			};

			await cmd().handler("population", makeCtx());

			expect(notified.length).toBe(1);
			expect(notified[0]!.type).toBe("error");
			expect(notified[0]!.message).toContain("Failed to evaluate skill population");
		});
	});

	// ── help ──

	describe("evolution (subcommand: help / default)", () => {
		const cmd = () => commands.get("evolution")!;

		test("shows help when no subcommand given", async () => {
			await cmd().handler("", makeCtx());

			expect(notified.length).toBe(1);
			expect(notified[0]!.type).toBe("info");
			const msg = notified[0]!.message;
			expect(msg).toContain("Usage: /evolution <subcommand>");
			expect(msg).toContain("status");
			expect(msg).toContain("skills");
			expect(msg).toContain("rate");
			expect(msg).toContain("clear");
			expect(msg).toContain("archive");
			expect(msg).toContain("history");
			expect(msg).toContain("rollback");
			expect(msg).toContain("profile");
			expect(msg).toContain("workflows");
			expect(msg).toContain("audit");
			expect(msg).toContain("report");
			expect(msg).toContain("fit");
			expect(msg).toContain("population");
			expect(msg).toContain("memory");
			expect(msg).toContain("learnings");
			expect(msg).toContain("log");
			expect(msg).toContain("nudges");
		});

		test("shows help for unknown subcommand", async () => {
			await cmd().handler("unknown-subcommand", makeCtx());

			expect(notified.length).toBe(1);
			expect(notified[0]!.type).toBe("info");
			expect(notified[0]!.message).toContain("Usage: /evolution <subcommand>");
		});
	});
});
