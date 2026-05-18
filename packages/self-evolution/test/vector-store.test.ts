/**
 * Tests for VectorStore, EmbeddingGenerator, and vector retrieval.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EmbeddingGenerator } from "../src/embedding";
import { vectorCompositeScore } from "../src/vector-retrieval";
import { cosineSimilarity, VectorStore } from "../src/vector-store";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestDb(): { db: Database; store: VectorStore } {
	const db = new Database(":memory:");
	db.exec(`
		CREATE TABLE IF NOT EXISTS vec_embeddings (
			id TEXT PRIMARY KEY,
			namespace TEXT NOT NULL,
			content TEXT NOT NULL,
			embedding BLOB NOT NULL,
			metadata_json TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`);
	return { db, store: new VectorStore(db) };
}

function makeRandomVector(dim: number, seed: number = 0): Float32Array {
	const vec = new Float32Array(dim);
	// Simple deterministic "random" for reproducibility
	let s = seed;
	for (let i = 0; i < dim; i++) {
		s = (s * 1103515245 + 12345) & 0x7fffffff;
		vec[i] = (s / 0x7fffffff) * 2 - 1; // Normalize to [-1, 1]
	}
	// Normalize
	const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
	for (let i = 0; i < dim; i++) vec[i] /= norm;
	return vec;
}

// ---------------------------------------------------------------------------
// VectorStore tests
// ---------------------------------------------------------------------------

describe("VectorStore", () => {
	let db: Database;
	let store: VectorStore;

	beforeEach(() => {
		const test = createTestDb();
		db = test.db;
		store = test.store;
	});

	afterEach(() => {
		db.close();
	});

	test("upsert stores and retrieves embedding", () => {
		const vec = makeRandomVector(8);
		store.upsert({
			id: "test-1",
			namespace: "raw_memory",
			content: "test content",
			embedding: vec,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});

		expect(store.count()).toBe(1);
		expect(store.count("raw_memory")).toBe(1);
		expect(store.count("other")).toBe(0);
	});

	test("search returns similar entries sorted by cosine similarity", () => {
		// Store entries with known vectors
		const queryVec = makeRandomVector(8, 0);

		// Entry close to query
		const closeVec = new Float32Array(8);
		for (let i = 0; i < 8; i++) closeVec[i] = queryVec[i] + 0.01;
		const closeNorm = Math.sqrt(closeVec.reduce((s, v) => s + v * v, 0));
		for (let i = 0; i < 8; i++) closeVec[i] /= closeNorm;

		// Entry orthogonal to query
		const orthogonalVec = makeRandomVector(8, 999);

		store.upsert({
			id: "close",
			namespace: "test",
			content: "close match",
			embedding: closeVec,
			createdAt: 1,
			updatedAt: 1,
		});
		store.upsert({
			id: "far",
			namespace: "test",
			content: "far match",
			embedding: orthogonalVec,
			createdAt: 1,
			updatedAt: 1,
		});

		const results = store.search(queryVec, { namespace: "test", minSimilarity: 0, limit: 5 });
		expect(results.length).toBeGreaterThanOrEqual(1);
		expect(results[0].entry.id).toBe("close");
		expect(results[0].similarity).toBeGreaterThan(0.9); // close match
	});

	test("search respects minSimilarity threshold", () => {
		const queryVec = makeRandomVector(8, 0);
		const orthogonalVec = makeRandomVector(8, 999);

		store.upsert({
			id: "far",
			namespace: "test",
			content: "far",
			embedding: orthogonalVec,
			createdAt: 1,
			updatedAt: 1,
		});

		const results = store.search(queryVec, { minSimilarity: 0.5, limit: 5 });
		expect(results.length).toBe(0); // orthogonal vectors have ~0 similarity
	});

	test("search respects limit", () => {
		for (let i = 0; i < 10; i++) {
			store.upsert({
				id: `e-${i}`,
				namespace: "test",
				content: `content ${i}`,
				embedding: makeRandomVector(8, i),
				createdAt: 1,
				updatedAt: 1,
			});
		}

		const queryVec = makeRandomVector(8, 0);
		const results = store.search(queryVec, { minSimilarity: 0, limit: 3 });
		expect(results.length).toBeLessThanOrEqual(3);
	});

	test("delete removes entry", () => {
		store.upsert({
			id: "del",
			namespace: "test",
			content: "delete me",
			embedding: makeRandomVector(8),
			createdAt: 1,
			updatedAt: 1,
		});
		expect(store.count()).toBe(1);

		store.delete("del");
		expect(store.count()).toBe(0);
	});

	test("deleteByNamespace removes all entries in namespace", () => {
		store.upsert({
			id: "a",
			namespace: "ns1",
			content: "a",
			embedding: makeRandomVector(8),
			createdAt: 1,
			updatedAt: 1,
		});
		store.upsert({
			id: "b",
			namespace: "ns1",
			content: "b",
			embedding: makeRandomVector(8),
			createdAt: 1,
			updatedAt: 1,
		});
		store.upsert({
			id: "c",
			namespace: "ns2",
			content: "c",
			embedding: makeRandomVector(8),
			createdAt: 1,
			updatedAt: 1,
		});

		store.deleteByNamespace("ns1");
		expect(store.count("ns1")).toBe(0);
		expect(store.count("ns2")).toBe(1);
	});

	test("namespaceStats returns correct counts", () => {
		store.upsert({
			id: "a",
			namespace: "memory",
			content: "a",
			embedding: makeRandomVector(8),
			createdAt: 1,
			updatedAt: 1,
		});
		store.upsert({
			id: "b",
			namespace: "skill",
			content: "b",
			embedding: makeRandomVector(8),
			createdAt: 1,
			updatedAt: 1,
		});
		store.upsert({
			id: "c",
			namespace: "skill",
			content: "c",
			embedding: makeRandomVector(8),
			createdAt: 1,
			updatedAt: 1,
		});

		const stats = store.namespaceStats();
		const skill = stats.find(s => s.namespace === "skill");
		expect(skill?.count).toBe(2);
	});

	test("allEntries returns all stored entries", () => {
		store.upsert({
			id: "a",
			namespace: "test",
			content: "a",
			embedding: makeRandomVector(8),
			createdAt: 1,
			updatedAt: 1,
		});
		store.upsert({
			id: "b",
			namespace: "test",
			content: "b",
			embedding: makeRandomVector(8),
			createdAt: 1,
			updatedAt: 1,
		});

		const entries = store.allEntries();
		expect(entries).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------
// Cosine similarity tests
// ---------------------------------------------------------------------------

describe("cosineSimilarity", () => {
	test("identical vectors have similarity 1.0", () => {
		const _vec = new Float32Array([1, 2, 3]);
		const norm = Math.sqrt(14);
		const normalized = new Float32Array([1 / norm, 2 / norm, 3 / norm]);
		expect(cosineSimilarity(normalized, normalized)).toBeCloseTo(1.0, 5);
	});

	test("orthogonal vectors have similarity 0", () => {
		const a = new Float32Array([1, 0, 0]);
		const b = new Float32Array([0, 1, 0]);
		expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5);
	});

	test("opposite vectors have similarity -1.0", () => {
		const a = new Float32Array([1, 0, 0]);
		const b = new Float32Array([-1, 0, 0]);
		expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 5);
	});

	test("subarray serialization roundtrip preserves correct data", () => {
		// Create a larger buffer and take a subarray view
		const full = new Float32Array(20);
		full.fill(99); // Fill with garbage
		const sub = full.subarray(5, 10); // bytes 20-40, only 5 floats
		sub.set([1, 2, 3, 4, 5]);

		// Serialize and deserialize the subarray
		const buf = Buffer.from(sub.buffer, sub.byteOffset, sub.byteLength);
		const restored = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);

		expect(restored).toHaveLength(5);
		expect(restored[0]).toBe(1);
		expect(restored[1]).toBe(2);
		expect(restored[2]).toBe(3);
		expect(restored[3]).toBe(4);
		expect(restored[4]).toBe(5);
	});
});

// ---------------------------------------------------------------------------
// EmbeddingGenerator tests
// ---------------------------------------------------------------------------

describe("EmbeddingGenerator", () => {
	test("default dimension is 1536 (text-embedding-3-small)", () => {
		const gen = new EmbeddingGenerator();
		expect(gen.dimension).toBe(1536);
		expect(gen.modelId).toBe("text-embedding-3-small");
	});

	test("returns zero vectors when no API key configured", async () => {
		const gen = new EmbeddingGenerator({ modelId: "test-model" });
		const result = await gen.embed("hello world");
		expect(result.embedding.every(v => v === 0)).toBe(true);
	});

	test("embedBatch returns correct count of zero vectors without API", async () => {
		const gen = new EmbeddingGenerator();
		const result = await gen.embedBatch(["a", "b", "c"]);
		expect(result.embeddings).toHaveLength(3);
		expect(result.embeddings.every(v => v.every(x => x === 0))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Vector composite score tests
// ---------------------------------------------------------------------------

describe("vectorCompositeScore", () => {
	test("returns score in [0, 1] range with embeddings", () => {
		const qVec = makeRandomVector(8, 0);
		const cVec = makeRandomVector(8, 0); // identical seed → same vector
		const score = vectorCompositeScore(qVec, cVec, [], "", Date.now(), 100);
		expect(score).toBeGreaterThanOrEqual(0);
		expect(score).toBeLessThanOrEqual(1);
	});

	test("high similarity vectors produce higher score", () => {
		const qVec = makeRandomVector(8, 0);
		const closeVec = new Float32Array(8);
		for (let i = 0; i < 8; i++) closeVec[i] = qVec[i] + 0.001;
		const norm = Math.sqrt(closeVec.reduce((s, v) => s + v * v, 0));
		for (let i = 0; i < 8; i++) closeVec[i] /= norm;

		const farVec = makeRandomVector(8, 999);

		const closeScore = vectorCompositeScore(qVec, closeVec, [], "", Date.now(), 100);
		const farScore = vectorCompositeScore(qVec, farVec, [], "", Date.now(), 100);

		expect(closeScore).toBeGreaterThan(farScore);
	});

	test("falls back to Jaccard when no embeddings", () => {
		const score = vectorCompositeScore(
			undefined,
			undefined,
			["test", "vector"],
			"this is a test vector",
			Date.now(),
			100,
		);
		expect(score).toBeGreaterThan(0);
	});

	test("recency decay reduces score for old entries", () => {
		const vec = makeRandomVector(8, 0);
		const recentScore = vectorCompositeScore(vec, vec, [], "", Date.now(), 100);
		const oldScore = vectorCompositeScore(
			vec,
			vec,
			[],
			"",
			Date.now() - 365 * 24 * 60 * 60 * 1000, // 1 year ago
			100,
		);
		expect(recentScore).toBeGreaterThan(oldScore);
	});
});
