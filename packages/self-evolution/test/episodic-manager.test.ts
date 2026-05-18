import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { EpisodicManager, recordError, recordSessionStart, recordToolCall } from "../src/episodic-manager";
import { closeEvolutionDb, getEvolutionDb } from "../src/storage/db";

describe("EpisodicManager", () => {
	let db: Database;
	let cwd: string;
	let manager: EpisodicManager;

	beforeEach(() => {
		cwd = path.join(os.tmpdir(), `test-episodic-${Date.now()}`);
		db = getEvolutionDb(cwd);
		manager = EpisodicManager.create(db, {
			defaultTtlSeconds: 3600,
			promotedTtlSeconds: 86400,
			cleanupIntervalMs: 100000, // long interval so it doesn't fire during tests
		});
	});

	afterEach(() => {
		manager.stopCleanupTimer();
		closeEvolutionDb(cwd);
	});

	test("recordEvent stores a record", async () => {
		const record = await manager.recordEvent({
			sessionId: "s1",
			cwd: "/tmp",
			eventType: "test_event",
			eventData: { foo: "bar" },
			importanceScore: 0.5,
		});
		expect(record.id).toBeDefined();
		expect(record.eventType).toBe("test_event");
		expect(record.archived).toBe(false);

		const events = await manager.getSessionEvents("s1");
		expect(events).toHaveLength(1);
		expect(events[0]!.eventData.foo).toBe("bar");
	});

	test("markSessionEnded computes importance", async () => {
		await manager.markSessionEnded("s1", {
			toolCallCount: 15,
			errorCount: 2,
			hadRecovery: true,
			completedSuccessfully: false,
			durationMs: 30000,
		});

		const events = await manager.getSessionEvents("s1");
		expect(events).toHaveLength(1);
		// Failed + errors + recovery + many tools = high importance
		expect(events[0]!.importanceScore).toBeGreaterThan(0.7);
		expect(events[0]!.eventType).toBe("session_ended");
	});

	test("high importance gets promoted TTL", async () => {
		const record = await manager.recordEvent({
			sessionId: "s1",
			cwd: "/tmp",
			eventType: "critical",
			eventData: {},
			importanceScore: 0.9,
		});
		expect(record.ttlSeconds).toBe(86400); // promoted TTL
	});

	test("low importance gets default TTL", async () => {
		const record = await manager.recordEvent({
			sessionId: "s1",
			cwd: "/tmp",
			eventType: "minor",
			eventData: {},
			importanceScore: 0.3,
		});
		expect(record.ttlSeconds).toBe(3600); // default TTL
	});

	test("runMaintenance archives expired records", async () => {
		// Insert a record with past expiration
		db.prepare(`
			INSERT INTO episodic_records (id, session_id, cwd, timestamp, event_type, event_data, importance_score, ttl_seconds, expiration_time, archived)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run("old1", "s1", cwd, Date.now() - 10000, "old", "{}", 0.5, 1, Date.now() - 5000, 0);

		const result = await manager.runMaintenance();
		expect(result.archived).toBe(1);
	});

	test("runMaintenance cleans up old archived records", async () => {
		const oldTime = Date.now() - 100 * 24 * 60 * 60 * 1000; // 100 days ago
		db.prepare(`
			INSERT INTO episodic_records (id, session_id, cwd, timestamp, event_type, event_data, importance_score, ttl_seconds, expiration_time, archived)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run("old1", "s1", cwd, oldTime, "old", "{}", 0.5, 1, oldTime, 1);

		const result = await manager.runMaintenance();
		expect(result.deleted).toBe(1);
	});
});

describe("convenience helpers", () => {
	let db: Database;
	let cwd: string;
	let manager: EpisodicManager;

	beforeEach(() => {
		cwd = path.join(os.tmpdir(), `test-episodic-helpers-${Date.now()}`);
		db = getEvolutionDb(cwd);
		manager = EpisodicManager.create(db, { cleanupIntervalMs: 100000 });
	});

	afterEach(() => {
		manager.stopCleanupTimer();
		closeEvolutionDb(cwd);
	});

	test("recordSessionStart", async () => {
		const record = await recordSessionStart(manager, { sessionId: "s1", cwd: "/tmp", userPrompt: "hello" });
		expect(record.eventType).toBe("session_started");
		expect(record.eventData.userPrompt).toBe("hello");
	});

	test("recordToolCall", async () => {
		const record = await recordToolCall(manager, { sessionId: "s1", cwd: "/tmp", toolName: "read" });
		expect(record.eventType).toBe("tool_called");
		expect(record.eventData.toolName).toBe("read");
	});

	test("recordError", async () => {
		const record = await recordError(manager, {
			sessionId: "s1",
			cwd: "/tmp",
			errorType: "ENOENT",
			message: "file not found",
		});
		expect(record.eventType).toBe("error_occurred");
		expect(record.importanceScore).toBeGreaterThan(0.5);
	});
});

describe("EpisodicManager retrieval", () => {
	let db: Database;
	let cwd: string;
	let manager: EpisodicManager;

	beforeEach(() => {
		cwd = path.join(os.tmpdir(), `test-episodic-retrieval-${Date.now()}`);
		db = getEvolutionDb(cwd);
		manager = EpisodicManager.create(db, { cleanupIntervalMs: 100000 });
	});

	afterEach(() => {
		manager.stopCleanupTimer();
		closeEvolutionDb(cwd);
	});

	test("getRecentEvents returns most recent first", async () => {
		await manager.recordEvent({ sessionId: "s1", cwd: "/tmp", eventType: "a", eventData: {} });
		await Bun.sleep(10);
		await manager.recordEvent({ sessionId: "s2", cwd: "/tmp", eventType: "b", eventData: {} });

		const recent = await manager.getRecentEvents(2);
		expect(recent).toHaveLength(2);
		expect(recent[0]!.eventType).toBe("b");
	});

	test("searchEvents finds by event_data content", async () => {
		await manager.recordEvent({ sessionId: "s1", cwd: "/tmp", eventType: "a", eventData: { msg: "hello world" } });
		await manager.recordEvent({ sessionId: "s2", cwd: "/tmp", eventType: "b", eventData: { msg: "goodbye" } });

		const results = await manager.searchEvents("hello", 10);
		expect(results).toHaveLength(1);
		expect(results[0]!.eventType).toBe("a");
	});
});
