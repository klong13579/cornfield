/**
 * Integration tests for session model stats store and model scorer.
 */
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { ModelEvaluator } from "../src/model-evaluator";
import { ModelScorer } from "../src/model-scorer";
import { initSchema } from "../src/storage/db";
import type { SessionModelStats } from "../src/storage/session-model-stats";
import { SqliteSessionModelStatsStore } from "../src/storage/session-model-stats";

describe("SqliteSessionModelStatsStore", () => {
	let db: Database;
	let store: SqliteSessionModelStatsStore;
	let dbPath: string;

	beforeAll(() => {
		dbPath = path.join(os.tmpdir(), `model-stats-test-${Date.now()}.db`);
		db = new Database(dbPath);
		initSchema(db);
		store = new SqliteSessionModelStatsStore(db);
	});

	afterAll(() => {
		db.close();
		try {
			require("node:fs").unlinkSync(dbPath);
		} catch {}
	});

	const sampleStats: SessionModelStats = {
		sessionId: "sess-1",
		modelName: "gpt-4o",
		promptTokens: 5000,
		completionTokens: 1000,
		durationMs: 30000,
		successCount: 8,
		errorCount: 2,
		timestamp: Date.now() - 86400000,
		taskType: "refactoring",
	};

	test("inserts a record", async () => {
		await store.insert(sampleStats);
		const aggs = await store.getAggregates("gpt-4o");
		expect(aggs.totalSessions).toBe(1);
		expect(aggs.successRate).toBeCloseTo(0.8, 2);
	});

	test("listByModel returns records ordered by timestamp desc", async () => {
		const older: SessionModelStats = {
			...sampleStats,
			sessionId: "sess-older",
			timestamp: Date.now() - 172800000,
		};
		await store.insert(older);
		const recent: SessionModelStats = {
			...sampleStats,
			sessionId: "sess-recent",
			timestamp: Date.now(),
		};
		await store.insert(recent);

		const results = await store.listByModel("gpt-4o", 2);
		expect(results.length).toBe(2);
		expect(results[0].sessionId).toBe("sess-recent");
		expect(results[1].sessionId).toBe("sess-1");
	});

	test("getAggregates with model filter isolates one model", async () => {
		// Insert an isolated model record for this test.
		const isolated: SessionModelStats = {
			sessionId: "filter-isolated",
			modelName: "filtered-model",
			promptTokens: 1000,
			completionTokens: 200,
			durationMs: 5000,
			successCount: 3,
			errorCount: 7,
			timestamp: Date.now(),
		};
		await store.insert(isolated);

		const aggs = await store.getAggregates("filtered-model");
		expect(aggs.totalSessions).toBe(1);
		expect(aggs.successRate).toBeCloseTo(0.3, 2);
	});

	test("getAggregates without filter sums across all models", async () => {
		// Insert a unique isolated model to verify cross-model aggregation.
		const other: SessionModelStats = {
			...sampleStats,
			sessionId: `sess-cross-${Date.now()}`,
			modelName: "cross-model",
			successCount: 5,
			errorCount: 5,
		};
		await store.insert(other);

		const all = await store.getAggregates();
		expect(all.totalSessions).toBeGreaterThan(0);
		expect(all.successRate).toBeGreaterThan(0);
	});

	test("taskType is optional (null stored)", async () => {
		const noTaskType: SessionModelStats = {
			...sampleStats,
			sessionId: "sess-no-task",
			taskType: undefined,
		};
		await store.insert(noTaskType);
		const rows = await store.listByModel("gpt-4o");
		const entry = rows.find(r => r.sessionId === "sess-no-task");
		expect(entry?.taskType).toBeUndefined();
	});
});

describe("ModelEvaluator", () => {
	let db: Database;
	let evaluator: ModelEvaluator;
	let dbPath: string;

	beforeAll(() => {
		dbPath = path.join(os.tmpdir(), `evaluator-test-${Date.now()}.db`);
		db = new Database(dbPath);
		initSchema(db);
		evaluator = new ModelEvaluator(new SqliteSessionModelStatsStore(db));
	});

	afterAll(() => {
		db.close();
		try {
			require("node:fs").unlinkSync(dbPath);
		} catch {}
	});

	test("recordSession inserts and getModelStats returns aggregates", async () => {
		const stats: SessionModelStats = {
			sessionId: "eval-sess",
			modelName: "test-model",
			promptTokens: 2000,
			completionTokens: 500,
			durationMs: 10000,
			successCount: 4,
			errorCount: 1,
			timestamp: Date.now(),
		};
		await evaluator.recordSession(stats);
		const aggs = await evaluator.getModelStats("test-model");
		expect(aggs.totalSessions).toBe(1);
	});

	test("getAllStats returns aggregate across all models", async () => {
		const aggs = await evaluator.getAllStats();
		expect(aggs.totalSessions).toBeGreaterThanOrEqual(1);
	});
});

describe("ModelScorer", () => {
	let db: Database;
	let scorer: ModelScorer;
	let dbPath: string;

	beforeAll(() => {
		dbPath = path.join(os.tmpdir(), `scorer-test-${Date.now()}.db`);
		db = new Database(dbPath);
		initSchema(db);
		scorer = new ModelScorer(new SqliteSessionModelStatsStore(db));
	});

	afterAll(() => {
		db.close();
		try {
			require("node:fs").unlinkSync(dbPath);
		} catch {}
	});

	test("scoreModel returns null when no data exists", async () => {
		const result = await scorer.scoreModel("nonexistent-model");
		expect(result).toBeNull();
	});

	test("scoreModel returns a valid score with data", async () => {
		for (let i = 0; i < 25; i++) {
			const stats: SessionModelStats = {
				sessionId: `scorer-sess-${i}`,
				modelName: "scored-model",
				promptTokens: 3000 + i * 10,
				completionTokens: 800 + i * 5,
				durationMs: 20000 + i * 100,
				successCount: Math.max(1, 10 - Math.floor(i / 5)),
				errorCount: Math.min(3, Math.floor(i / 8)),
				timestamp: Date.now() - i * 86400000,
			};
			const store = new SqliteSessionModelStatsStore(db);
			await store.insert(stats);
		}

		const score = await scorer.scoreModel("scored-model");
		expect(score).not.toBeNull();
		expect(score!.modelName).toBe("scored-model");
		expect(score!.totalSessions).toBe(25);
		expect(score!.overallScore).toBeGreaterThanOrEqual(0);
		expect(score!.overallScore).toBeLessThanOrEqual(100);
		expect(score!.dimensions.successRate).toBeGreaterThan(0);
		expect(score!.dimensions.efficiency).toBeGreaterThan(0);
		expect(score!.dimensions.recency).toBeGreaterThan(0);
		expect(score!.decayFactor).toBeGreaterThan(0);
		expect(score!.decayFactor).toBeLessThanOrEqual(1);
	});
});
