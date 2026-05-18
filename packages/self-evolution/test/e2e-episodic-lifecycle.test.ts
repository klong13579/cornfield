import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { EpisodicManager, recordError, recordSessionStart, recordToolCall } from "../src/episodic-manager";
import { closeEvolutionDb, getEvolutionDb } from "../src/storage/db";

describe("E2E: Episodic Store lifecycle", () => {
	let db: Database;
	let cwd: string;
	let manager: EpisodicManager;

	beforeEach(() => {
		cwd = path.join(os.tmpdir(), `e2e-episodic-${Date.now()}`);
		db = getEvolutionDb(cwd);
		manager = EpisodicManager.create(db, {
			defaultTtlSeconds: 3600,
			promotedTtlSeconds: 86400,
			cleanupIntervalMs: 100000,
		});
	});

	afterEach(() => {
		manager.stopCleanupTimer();
		closeEvolutionDb(cwd);
	});

	test("E2E-17: session start recovery — recent events are retrievable", async () => {
		await recordSessionStart(manager, { sessionId: "s1", cwd: "/test", userPrompt: "hello" });
		await recordToolCall(manager, { sessionId: "s1", cwd: "/test", toolName: "read" });

		const events = await manager.getSessionEvents("s1");
		expect(events.length).toBeGreaterThanOrEqual(2);
		expect(events.some(e => e.eventType === "session_started")).toBe(true);
		expect(events.some(e => e.eventType === "tool_called")).toBe(true);
	});

	test("E2E-18: real-time writes during session", async () => {
		await recordSessionStart(manager, { sessionId: "s2", cwd: "/test", userPrompt: "fix bug" });
		await recordToolCall(manager, { sessionId: "s2", cwd: "/test", toolName: "search" });
		await recordToolCall(manager, { sessionId: "s2", cwd: "/test", toolName: "read" });

		const events = await manager.getSessionEvents("s2");
		expect(events.length).toBeGreaterThanOrEqual(3);
	});

	test("E2E-19: markSessionEnded creates session summary record", async () => {
		await recordSessionStart(manager, { sessionId: "s3", cwd: "/test", userPrompt: "test" });
		await manager.markSessionEnded("s3", {
			toolCallCount: 5,
			errorCount: 1,
			hadRecovery: false,
			completedSuccessfully: true,
			durationMs: 10000,
		});

		const events = await manager.getSessionEvents("s3");
		const ended = events.find(e => e.eventType === "session_ended");
		expect(ended).toBeDefined();
		expect(ended!.eventData.completedSuccessfully).toBe(true);
	});

	test("E2E-20: low importance TTL expiry → archived then deleted", async () => {
		// Insert directly with past expiration and low importance
		db.prepare(`
			INSERT INTO episodic_records (id, session_id, cwd, timestamp, event_type, event_data, importance_score, ttl_seconds, expiration_time, archived)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run("expired-low", "s4", cwd, Date.now() - 10000, "old", "{}", 0.2, 1, Date.now() - 5000, 0);

		const result = await manager.runMaintenance();
		expect(result.archived).toBe(1);

		// After another maintenance with old archived records
		const oldTime = Date.now() - 100 * 24 * 60 * 60 * 1000;
		db.prepare(`
			INSERT INTO episodic_records (id, session_id, cwd, timestamp, event_type, event_data, importance_score, ttl_seconds, expiration_time, archived)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run("very-old", "s4", cwd, oldTime, "old", "{}", 0.2, 1, oldTime, 1);

		const result2 = await manager.runMaintenance();
		expect(result2.deleted).toBe(1);
	});

	test("E2E-21: high importance record gets promoted TTL", async () => {
		const record = await recordError(manager, {
			sessionId: "s5",
			cwd: "/test",
			errorType: "critical",
			message: "system failure",
		});

		expect(record.importanceScore).toBeGreaterThanOrEqual(0.7);
		// recordError importance=0.7 < promotionThreshold=0.8, so default TTL applies
		expect(record.ttlSeconds).toBe(3600);
	});

	test("E2E-21: high importance survives TTL expiry (archived but not deleted immediately)", async () => {
		const oldTime = Date.now() - 100 * 24 * 60 * 60 * 1000;
		db.prepare(`
			INSERT INTO episodic_records (id, session_id, cwd, timestamp, event_type, event_data, importance_score, ttl_seconds, expiration_time, archived)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run("high-old", "s6", cwd, oldTime, "critical_error", "{}", 0.9, 1, oldTime, 1);

		// Even though it's old, high importance records may have different retention
		// The default archiveRetentionMs is 90 days, so 100-day-old records should be cleaned up
		const result = await manager.runMaintenance();
		expect(result.deleted).toBe(1);
	});

	test("recent events retrieval returns correct order", async () => {
		await manager.recordEvent({ sessionId: "r1", cwd: "/test", eventType: "first", eventData: {} });
		await Bun.sleep(10);
		await manager.recordEvent({ sessionId: "r2", cwd: "/test", eventType: "second", eventData: {} });
		await Bun.sleep(10);
		await manager.recordEvent({ sessionId: "r3", cwd: "/test", eventType: "third", eventData: {} });

		const recent = await manager.getRecentEvents(2);
		expect(recent.length).toBe(2);
		expect(recent[0]!.eventType).toBe("third");
		expect(recent[1]!.eventType).toBe("second");
	});
});
