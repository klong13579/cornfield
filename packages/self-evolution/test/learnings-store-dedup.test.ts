import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { initSchema } from "../src/storage/db";
import { SqliteLearningStore } from "../src/storage/learnings";
import type { Learning } from "../src/types";

function makeLearning(overrides: Partial<Learning> = {}): Learning {
	return {
		id: "lrn_" + Math.random().toString(36).slice(2),
		cwd: "/test",
		kind: "fact",
		content: "default content",
		source: "session_llm",
		confidence: 4,
		lifecycle: "active",
		scope: "project",
		sessionId: "sess-1",
		createdAt: Date.now(),
		updatedAt: Date.now(),
		timesInjected: 1,
		timesHelped: 0,
		timesIgnored: 0,
		...overrides,
	};
}

function createStore(): SqliteLearningStore {
	const db = new Database(":memory:");
	initSchema(db);
	return new SqliteLearningStore(db);
}

describe("SqliteLearningStore semantic dedup", () => {
	it("inserts new learning when no duplicate exists", async () => {
		const store = createStore();
		const l = makeLearning({ content: "Unique learning about project structure" });
		await store.insert(l);
		const all = await store.listAll();
		expect(all.length).toBe(1);
		expect(all[0]!.content).toBe("Unique learning about project structure");
	});

	it("merges duplicate with exact same content", async () => {
		const store = createStore();
		const l1 = makeLearning({ content: "DingTalk doc workflow", timesInjected: 5, timesHelped: 2 });
		await store.insert(l1);
		const l2 = makeLearning({ content: "DingTalk doc workflow", timesInjected: 3, timesHelped: 1 });
		await store.insert(l2);
		const all = await store.listAll();
		expect(all.length).toBe(1);
		expect(all[0]!.timesInjected).toBe(8);
		expect(all[0]!.timesHelped).toBe(3);
	});

	it("merges duplicate with similar content (reworded)", async () => {
		const store = createStore();
		const l1 = makeLearning({ content: "User: 彭梦龙, GM of 云鲸事业部" });
		await store.insert(l1);
		const l2 = makeLearning({ content: "用户身份：彭梦龙，云鲸事业部 GM" });
		await store.insert(l2);
		const all = await store.listAll();
		expect(all.length).toBe(1);
	});

	it("keeps separate entries for different kinds", async () => {
		const store = createStore();
		const l1 = makeLearning({
			kind: "fact",
			content: "This is a long fact text about something important in the project",
		});
		const l2 = makeLearning({
			kind: "preference",
			content: "This is a long fact text about something important in the project",
		});
		await store.insert(l1);
		await store.insert(l2);
		const all = await store.listAll();
		expect(all.length).toBe(2);
	});

	it("promotes scope to global when merging", async () => {
		const store = createStore();
		const l1 = makeLearning({
			content: "This is a global rule that should apply to all projects and sessions",
			scope: "project",
		});
		await store.insert(l1);
		const l2 = makeLearning({
			content: "This is a global rule that should apply to all projects and sessions",
			scope: "global",
		});
		await store.insert(l2);
		const all = await store.listAll();
		expect(all.length).toBe(1);
		expect(all[0]!.scope).toBe("global");
	});

	it("promotes lifecycle to active when merging candidate into active", async () => {
		const store = createStore();
		const l1 = makeLearning({
			content: "Rule X is a very important coding convention for this codebase",
			lifecycle: "candidate",
		});
		await store.insert(l1);
		const l2 = makeLearning({
			content: "Rule X is a very important coding convention for this codebase",
			lifecycle: "active",
		});
		await store.insert(l2);
		const all = await store.listAll();
		expect(all.length).toBe(1);
		expect(all[0]!.lifecycle).toBe("active");
	});
});
