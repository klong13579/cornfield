import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { EpisodicRecordRetriever } from "../src/retrieval";
import { closeEvolutionDb, getEvolutionDb } from "../src/storage/db";
import { SqliteEpisodicBackend } from "../src/storage/episodic-backend";

describe("EpisodicRecordRetriever", () => {
	let db: Database;
	let cwd: string;
	let backend: SqliteEpisodicBackend;
	let retriever: EpisodicRecordRetriever;

	beforeEach(() => {
		cwd = path.join(os.tmpdir(), `test-retrieval-${Date.now()}`);
		db = getEvolutionDb(cwd);
		backend = new SqliteEpisodicBackend(db);
		retriever = new EpisodicRecordRetriever(backend);
	});

	afterEach(() => {
		closeEvolutionDb(cwd);
	});

	async function seedRecord(
		sessionId: string,
		eventType: string,
		eventData: Record<string, unknown>,
		importance = 0.5,
	) {
		const now = Date.now();
		await backend.store({
			id: crypto.randomUUID(),
			sessionId,
			cwd,
			timestamp: now,
			eventType,
			eventData,
			importanceScore: importance,
			ttlSeconds: 3600,
			expirationTime: now + 3600 * 1000,
			archived: false,
		});
	}

	test("search finds records by event data", async () => {
		await seedRecord("s1", "tool_called", { toolName: "read", path: "src/auth.ts" }, 0.6);
		await seedRecord("s1", "error_occurred", { message: "file not found" }, 0.8);
		await seedRecord("s2", "tool_called", { toolName: "edit", path: "src/main.rs" }, 0.5);

		const results = await retriever.search("read", { limit: 10 });
		expect(results.length).toBeGreaterThanOrEqual(1);
		expect(results[0]!.record.eventData.toolName).toBe("read");
	});

	test("search scores by importance", async () => {
		await seedRecord("s1", "test", { msg: "hello world" }, 0.3);
		await seedRecord("s2", "test", { msg: "hello world" }, 0.9);

		const results = await retriever.search("hello", { limit: 10 });
		expect(results).toHaveLength(2);
		// Higher importance should rank first
		expect(results[0]!.record.importanceScore).toBeGreaterThan(results[1]!.record.importanceScore);
	});

	test("search respects limit", async () => {
		for (let i = 0; i < 5; i++) {
			await seedRecord(`s${i}`, "test", { msg: `hello ${i}` }, 0.5);
		}

		const results = await retriever.search("hello", { limit: 2 });
		expect(results).toHaveLength(2);
	});

	test("search respects minScore", async () => {
		await seedRecord("s1", "test", { msg: "hello world" }, 0.9);

		const results = await retriever.search("xyz-unrelated", { minScore: 50 });
		expect(results).toHaveLength(0);
	});

	test("getRecent returns most recent first", async () => {
		await seedRecord("s1", "old", { msg: "a" }, 0.5);
		await Bun.sleep(20);
		await seedRecord("s2", "new", { msg: "b" }, 0.5);

		const results = await retriever.getRecent(2);
		expect(results).toHaveLength(2);
		expect(results[0]!.eventType).toBe("new");
	});

	test("getBySession filters by session", async () => {
		await seedRecord("s1", "a", {}, 0.5);
		await seedRecord("s2", "b", {}, 0.5);

		const results = await retriever.getBySession("s1");
		expect(results).toHaveLength(1);
		expect(results[0]!.eventType).toBe("a");
	});
});
