import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
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
import type { UserProfile, WorkflowPattern } from "../src/types";

describe("Self-evolution commands", () => {
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
	let ensureInitCalled: boolean;

	function makeCtx(cwd = "/test") {
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
		ensureInitCalled = false;
		commands = new Map();

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

		registerSelfEvolutionCommands(api as never, {
			ensureInit: () => {
				ensureInitCalled = true;
			},
			episodeStore: () => episodeStore,
			skillStore: () => skillStore,
			versionStore: () => versionStore,
			statsStore: () => statsStore,
			skillManager: () =>
				({
					archiveLowQuality: async () => 0,
					rollback: async () => undefined,
					getHistory: async () => [],
				}) as never,
			activityLogger: () =>
				({
					log: async () => {},
					query: async (_options?: { event?: string; since?: number; limit?: number }) => [],
				}) as never,
			profileStore: () => profileStore,
			workflowPatternStore: () => workflowPatternStore,
			learningStore: () => learningStore,
			memoryDb: () => db,
			effectivenessStore: () => effectivenessStore,
			populationStore: () =>
				({
					insert: async () => {},
					get: async () => undefined,
					list: async () => [],
					update: async () => {},
					delete: async () => {},
					transitionState: async () => {},
					countByState: async () => 0,
				}) as never,
			populationEngine: () =>
				({
					evaluateAll: async () => ({ transitions: 0, evaluated: 0, eliminated: 0, graduated: 0 }),
					selectForInjection: async () => [],
					mutate: async () => false,
					eliminate: async () => ({ deprecated: 0, archived: 0 }),
					graduate: async () => false,
					register: async () => {},
					recordUsage: async () => {},
				}) as never,
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
					globalStore: true,
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
			embeddingGenerator: () => undefined,
		});

		registerEpisodicCommands(api as never, {
			ensureInit: () => {
				ensureInitCalled = true;
			},
			episodeStore: () => episodeStore,
			skillStore: () => skillStore,
			versionStore: () => versionStore,
			statsStore: () => statsStore,
			skillManager: () =>
				({
					archiveLowQuality: async () => 0,
					rollback: async () => undefined,
					getHistory: async () => [],
				}) as never,
			activityLogger: () => ({ log: async () => {} }) as never,
			profileStore: () => profileStore,
			workflowPatternStore: () => workflowPatternStore,
			learningStore: () => learningStore,
			memoryDb: () => db,
			effectivenessStore: () => effectivenessStore,
			populationStore: () =>
				({
					insert: async () => {},
					get: async () => undefined,
					list: async () => [],
					update: async () => {},
					delete: async () => {},
					transitionState: async () => {},
					countByState: async () => 0,
				}) as never,
			populationEngine: () =>
				({
					evaluateAll: async () => ({ transitions: 0, evaluated: 0, eliminated: 0, graduated: 0 }),
					selectForInjection: async () => [],
					mutate: async () => false,
					eliminate: async () => ({ deprecated: 0, archived: 0 }),
					graduate: async () => false,
					register: async () => {},
					recordUsage: async () => {},
				}) as never,
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
					globalStore: true,
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
			embeddingGenerator: () => undefined,
		});
	});

	// ── TUI autocomplete consumer layer ──

	describe("evolution (TUI autocomplete)", () => {
		const cmd = () => commands.get("evolution")!;

		test("registers getArgumentCompletions for TUI dropdown", () => {
			expect(cmd().getArgumentCompletions).toBeDefined();

			const all = cmd().getArgumentCompletions!("");
			expect(all).not.toBeNull();
			expect(all!.length).toBeGreaterThan(0);

			const st = cmd().getArgumentCompletions!("st");
			expect(st).not.toBeNull();
			expect(st!.every(item => item.label.startsWith("st"))).toBe(true);

			const past = cmd().getArgumentCompletions!("status arg");
			expect(past).toBeNull();
		});

		test("description is registered for help panel", () => {
			expect(cmd().description).toContain("Self-evolution");
		});
	});

	// ── Handler consumer layer: profile ──

	describe("evolution (subcommand: profile)", () => {
		const cmd = () => commands.get("evolution")!;

		test("displays formatted profile when data exists", async () => {
			const profile: UserProfile = {
				toolFrequency: { read: 5, bash: 3 },
				toolTransitions: { "read→bash": 2 },
				intentDistribution: { refactoring: 2, bugfix: 1 },
				avgToolCallsPerSession: 4.5,
				avgFilesModifiedPerSession: 1.2,
				errorRate: 0.1,
				recoveryRate: 0.5,
				preferredLanguages: ["typescript", "rust"],
				sessionCount: 3,
				updatedAt: Date.now(),
			};
			await profileStore.upsert("default", profile);

			await cmd().handler("profile", makeCtx());

			expect(ensureInitCalled).toBe(true);
			expect(notified.length).toBe(1);
			expect(notified[0]!.type).toBe("info");
			expect(notified[0]!.message).toContain("Sessions: 3");
			expect(notified[0]!.message).toContain("Tool calls/session: 4.5");
			expect(notified[0]!.message).toContain("Avg tool errors/session: 0.1");
			expect(notified[0]!.message).toContain("Recovery rate: 50%");
			expect(notified[0]!.message).toContain("Preferred languages: typescript, rust");
			expect(notified[0]!.message).toContain("Top tools: read(5), bash(3)");
			expect(notified[0]!.message).toContain("Intent distribution: refactoring(2), bugfix(1)");
		});

		test("notifies when no profile data exists", async () => {
			await cmd().handler("profile", makeCtx());

			expect(notified.length).toBe(1);
			expect(notified[0]!.type).toBe("info");
			expect(notified[0]!.message).toContain("No profile data yet");
		});

		test("notifies error when store throws", async () => {
			db.close();
			await cmd().handler("profile", makeCtx());

			expect(notified.length).toBe(1);
			expect(notified[0]!.type).toBe("error");
			expect(notified[0]!.message).toContain("Failed to load profile");
		});
	});

	// ── Handler consumer layer: workflows ──

	describe("evolution (subcommand: workflows)", () => {
		const cmd = () => commands.get("evolution")!;

		test("lists all workflow patterns when no filter is provided", async () => {
			const pattern1: WorkflowPattern = {
				id: "p1",
				intent: "refactoring",
				toolSequence: ["read", "edit", "test"],
				occurrenceCount: 3,
				avgQualityScore: 0.8,
				lastSeenAt: Date.now(),
			};
			const pattern2: WorkflowPattern = {
				id: "p2",
				intent: "bugfix",
				toolSequence: ["search", "read", "edit"],
				occurrenceCount: 2,
				avgQualityScore: 0.7,
				lastSeenAt: Date.now(),
			};
			await workflowPatternStore.upsert(pattern1);
			await workflowPatternStore.upsert(pattern2);

			await cmd().handler("workflows", makeCtx());

			expect(ensureInitCalled).toBe(true);
			expect(notified.length).toBe(1);
			expect(notified[0]!.type).toBe("info");
			expect(notified[0]!.message).toContain("refactoring: read → edit → test (seen 3x)");
			expect(notified[0]!.message).toContain("bugfix: search → read → edit (seen 2x)");
		});

		test("filters workflow patterns by intent", async () => {
			const pattern: WorkflowPattern = {
				id: "p1",
				intent: "refactoring",
				toolSequence: ["read", "edit"],
				occurrenceCount: 1,
				avgQualityScore: 0,
				lastSeenAt: Date.now(),
			};
			await workflowPatternStore.upsert(pattern);

			await cmd().handler("workflows refactoring", makeCtx());

			expect(notified[0]!.message).toContain("refactoring: read → edit (seen 1x)");
		});

		test("notifies when no workflow patterns exist", async () => {
			await cmd().handler("workflows", makeCtx());

			expect(notified.length).toBe(1);
			expect(notified[0]!.type).toBe("info");
			expect(notified[0]!.message).toContain("No workflow patterns mined yet");
		});

		test("notifies when filtered intent has no patterns", async () => {
			await cmd().handler("workflows nonexistent", makeCtx());

			expect(notified.length).toBe(1);
			expect(notified[0]!.type).toBe("info");
			expect(notified[0]!.message).toContain('No workflow patterns found for intent "nonexistent"');
		});

		test("notifies error when store throws", async () => {
			db.close();
			await cmd().handler("workflows", makeCtx());

			expect(notified.length).toBe(1);
			expect(notified[0]!.type).toBe("error");
			expect(notified[0]!.message).toContain("Failed to list workflow patterns");
		});
	});

	// ── Handler consumer layer: status ──

	describe("evolution (subcommand: status)", () => {
		const cmd = () => commands.get("evolution")!;

		test("shows statistics when stores are empty", async () => {
			await cmd().handler("status", makeCtx());

			expect(ensureInitCalled).toBe(true);
			expect(notified.length).toBe(1);
			expect(notified[0]!.type).toBe("info");
			expect(notified[0]!.message).toContain("Episodes: 0");
			expect(notified[0]!.message).toContain("Skills: 0");
			expect(notified[0]!.message).toContain("Versions: 0");
		});
	});

	// ── Handler consumer layer: memory hub ──

	describe("evolution (subcommand: memory)", () => {
		const cmd = () => commands.get("evolution")!;

		test("registers memory subcommand completions for TUI", () => {
			const completions = cmd().getArgumentCompletions?.("memory se");
			expect(completions).not.toBeNull();
			expect(completions!.some(c => c.value.startsWith("memory search"))).toBe(true);
		});

		test("reports error when memory DB is unavailable", async () => {
			const api = {
				registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
					if (name === "evolution") commands.set(name, options as never);
				},
			};
			registerSelfEvolutionCommands(
				api as never,
				{
					ensureInit: () => {},
					episodeStore: () => episodeStore,
					skillStore: () => skillStore,
					versionStore: () => versionStore,
					statsStore: () => statsStore,
					skillManager: () =>
						({
							archiveLowQuality: async () => 0,
							rollback: async () => undefined,
							getHistory: async () => [],
						}) as never,
					activityLogger: () => ({ log: async () => {}, query: async () => [] }) as never,
					profileStore: () => profileStore,
					workflowPatternStore: () => workflowPatternStore,
					learningStore: () => learningStore,
					effectivenessStore: () => effectivenessStore,
					populationStore: () =>
						({
							insert: async () => {},
							get: async () => undefined,
							list: async () => [],
							update: async () => {},
							delete: async () => {},
							transitionState: async () => {},
							countByState: async () => 0,
						}) as never,
					populationEngine: () =>
						({
							evaluateAll: async () => ({ transitions: 0, evaluated: 0, eliminated: 0, graduated: 0 }),
							selectForInjection: async () => [],
							mutate: async () => false,
							eliminate: async () => ({ deprecated: 0, archived: 0 }),
							graduate: async () => false,
							register: async () => {},
							recordUsage: async () => {},
						}) as never,
					nudgeHistoryStore: () => nudgeHistoryStore,
					db: () => db,
					flags: () => ({ enabled: true, globalStore: true, regressionReplayBackend: "heuristic" }) as never,
					episodicManager: () => episodicManager,
					escalationStore: () => escalationStore,
					regressionFixtureStore: () => regressionFixtureStore,
					regressionTrialStore: () => regressionTrialStore,
					sessionTraceStore: () => ({ upsert: async () => {}, get: async () => undefined }) as never,
					skillEffectivenessStore: () =>
						({
							get: async () => undefined,
							recordInjection: async () => {},
							recordOutcome: async () => {},
						}) as never,
					memoryDb: () => undefined,
					embeddingGenerator: () => undefined,
				} as never,
			);

			notified = [];
			await commands.get("evolution")!.handler("memory stats", makeCtx());
			expect(notified[0]!.type).toBe("error");
			expect(notified[0]!.message).toContain("Memory DB not available");
		});

		test("memory stats succeeds when DB is wired", async () => {
			await cmd().handler("memory stats", makeCtx());
			expect(notified.length).toBe(1);
			expect(notified[0]!.type).toBe("info");
		});
	});

	// ── Episodic command ──

	describe("episodic", () => {
		const cmd = () => commands.get("episodic")!;

		test("registers getArgumentCompletions for TUI dropdown", () => {
			expect(cmd().getArgumentCompletions).toBeDefined();

			const all = cmd().getArgumentCompletions!("");
			expect(all).not.toBeNull();
			expect(all!.length).toBe(3);

			const se = cmd().getArgumentCompletions!("se");
			expect(se).not.toBeNull();
			expect(se!.every(item => item.label.startsWith("se"))).toBe(true);

			const past = cmd().getArgumentCompletions!("sessions arg");
			expect(past).toBeNull();
		});

		test("description is registered", () => {
			expect(cmd().description).toContain("Episodic memory");
		});

		test("lists recent sessions when data exists", async () => {
			await episodicManager.recordEvent({
				sessionId: "sess-1",
				cwd: "/test",
				eventType: "session_started",
				eventData: { userPrompt: "hello" },
			});
			await episodicManager.recordEvent({
				sessionId: "sess-2",
				cwd: "/test",
				eventType: "tool_called",
				eventData: { toolName: "read" },
			});

			await cmd().handler("sessions", makeCtx());

			expect(notified.length).toBe(1);
			expect(notified[0]!.type).toBe("info");
			expect(notified[0]!.message).toContain("Session: sess-1");
			expect(notified[0]!.message).toContain("Session: sess-2");
		});

		test("notifies when no episodic data exists", async () => {
			await cmd().handler("sessions", makeCtx());

			expect(notified.length).toBe(1);
			expect(notified[0]!.type).toBe("info");
			expect(notified[0]!.message).toContain("No episodic records yet");
		});

		test("shows events for a session", async () => {
			await episodicManager.recordEvent({
				sessionId: "show-sess",
				cwd: "/test",
				eventType: "session_started",
				eventData: { userPrompt: "test prompt" },
			});

			await cmd().handler("show show-sess", makeCtx());

			expect(notified.length).toBe(1);
			expect(notified[0]!.type).toBe("info");
			expect(notified[0]!.message).toContain("session_started");
			expect(notified[0]!.message).toContain("test prompt");
		});

		test("warns when show has no session-id", async () => {
			await cmd().handler("show", makeCtx());

			expect(notified.length).toBe(1);
			expect(notified[0]!.type).toBe("warning");
			expect(notified[0]!.message).toContain("Usage: /episodic show");
		});

		test("notifies when session not found", async () => {
			await cmd().handler("show nonexistent-session", makeCtx());

			expect(notified.length).toBe(1);
			expect(notified[0]!.type).toBe("info");
			expect(notified[0]!.message).toContain('No events found for session "nonexistent-session"');
		});

		test("clears episodic data after confirmation", async () => {
			await episodicManager.recordEvent({
				sessionId: "to-clear",
				cwd: "/test",
				eventType: "session_started",
				eventData: {},
			});

			await cmd().handler("clear", makeCtx());

			expect(notified.length).toBe(1);
			expect(notified[0]!.type).toBe("info");
			expect(notified[0]!.message).toContain("Episodic data cleared");
		});

		test("defaults to sessions subcommand when empty", async () => {
			await cmd().handler("", makeCtx());

			expect(notified.length).toBe(1);
			expect(notified[0]!.type).toBe("info");
			expect(notified[0]!.message).toContain("No episodic records yet");
		});
	});

	// ── Handler consumer layer: log ──

	describe("evolution (subcommand: log)", () => {
		const cmd = () => commands.get("evolution")!;

		test("returns info when no activity log entries exist", async () => {
			await cmd().handler("log", makeCtx());

			expect(notified.length).toBe(1);
			expect(notified[0]!.type).toBe("info");
			expect(notified[0]!.message).toContain("No activity log entries yet");
		});
	});

	// ── Handler consumer layer: nudges ──

	describe("evolution (subcommand: nudges)", () => {
		const cmd = () => commands.get("evolution")!;

		test("lists recent nudges when data exists", async () => {
			await nudgeHistoryStore.insert({
				id: "n1",
				sessionId: "s1",
				project: "/test",
				type: "read_failure",
				severity: "warning",
				message: "File not found: config.json",
				suggestion: "Check file path",
				detectedAt: Date.now(),
			});
			await nudgeHistoryStore.insert({
				id: "n2",
				sessionId: "s1",
				project: "/test",
				type: "cascade_pattern",
				severity: "high",
				message: "Repeated search → read pattern",
				suggestion: "Use ast_grep instead of grep",
				detectedAt: Date.now() + 1,
			});

			await cmd().handler("nudges", makeCtx());

			expect(notified.length).toBe(1);
			expect(notified[0]!.type).toBe("info");
			expect(notified[0]!.message).toContain("n2");
			expect(notified[0]!.message).toContain("[cascade_pattern]");
			expect(notified[0]!.message).toContain("n1");
			expect(notified[0]!.message).toContain("ack <id>");
		});

		test("acknowledges nudge by id", async () => {
			await nudgeHistoryStore.insert({
				id: "ack-me",
				sessionId: "s1",
				project: "/test",
				type: "slow-loop",
				severity: "warn",
				message: "spinning",
				suggestion: "pause",
				detectedAt: Date.now(),
			});
			await cmd().handler("nudges ack ack-me", makeCtx());
			const row = await nudgeHistoryStore.get("ack-me");
			expect(row?.acknowledged).toBe(true);
		});

		test("dismisses nudge by id", async () => {
			await nudgeHistoryStore.insert({
				id: "dismiss-me",
				sessionId: "s1",
				project: "/test",
				type: "error-cascade",
				severity: "warn",
				message: "failures",
				suggestion: "fix paths",
				detectedAt: Date.now(),
			});
			await cmd().handler("nudges dismiss dismiss-me", makeCtx());
			const row = await nudgeHistoryStore.get("dismiss-me");
			expect(row?.dismissedAt).toBeDefined();
		});

		test("notifies when no nudges exist", async () => {
			await cmd().handler("nudges", makeCtx());

			expect(notified.length).toBe(1);
			expect(notified[0]!.type).toBe("info");
			expect(notified[0]!.message).toContain("No nudges recorded yet");
		});

		test("notifies error when store throws", async () => {
			db.close();
			await cmd().handler("nudges", makeCtx());

			expect(notified.length).toBe(1);
			expect(notified[0]!.type).toBe("error");
			expect(notified[0]!.message).toContain("Failed to list nudges");
		});
	});

	describe("evolution (subcommand: stuck)", () => {
		const cmd = () => commands.get("evolution")!;

		test("getArgumentCompletions includes stuck subcommand", () => {
			const items = cmd().getArgumentCompletions?.("st") ?? [];
			expect(items?.some(i => i.value.startsWith("stuck"))).toBe(true);
		});

		test("notifies when no open escalations", async () => {
			await cmd().handler("stuck", makeCtx());
			expect(notified[0]!.message).toContain("No open evolution deadlocks");
		});
	});
});
