import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { ImmutableRuleStore } from "../src/immutable-rules";
import { appendAuditEntry } from "../src/logging/evolution-log";
import { SnapshotStore } from "../src/snapshot";
import { initSchema } from "../src/storage/db";

describe("ImmutableRuleStore", () => {
	let db: Database;
	let store: ImmutableRuleStore;

	beforeEach(() => {
		db = new Database(":memory:");
		initSchema(db);
		store = new ImmutableRuleStore(db);
	});

	test("adds a rule and returns it with generated id and timestamp", async () => {
		const rule = await store.add({
			content: "skill-frontend-auth",
			reason: "Core auth skill, protected from auto-deprecation",
		});

		expect(rule.id).toBeDefined();
		expect(rule.content).toBe("skill-frontend-auth");
		expect(rule.reason).toBe("Core auth skill, protected from auto-deprecation");
		expect(rule.createdAt).toBeGreaterThan(0);
	});

	test("list returns all rules ordered by creation time desc", async () => {
		await store.add({ content: "old-rule", reason: "older" });
		await new Promise(r => setTimeout(r, 2)); // ensure timestamp ordering
		await store.add({ content: "new-rule", reason: "newer" });

		const rules = await store.list();
		expect(rules.length).toBe(2);
		expect(rules[0]!.content).toBe("new-rule");
		expect(rules[1]!.content).toBe("old-rule");
	});

	test("isProtected returns true when stored rule content is a substring of query", async () => {
		await store.add({ content: "auth-util", reason: "Protected utility" });

		expect(await store.isProtected("auth-util")).toBe(true);
		expect(await store.isProtected("my-auth-util-helper")).toBe(true);
		expect(await store.isProtected("nothing-related")).toBe(false);
	});

	test("isProtected returns false when no rules exist", async () => {
		expect(await store.isProtected("anything")).toBe(false);
	});
});

describe("SnapshotStore", () => {
	let db: Database;
	let store: SnapshotStore;

	beforeEach(() => {
		db = new Database(":memory:");
		initSchema(db);
		store = new SnapshotStore(db);
	});

	test("creates a snapshot and serializes data as JSON", async () => {
		const snap = await store.create("profile", { sessionCount: 42, language: "ts" });

		expect(snap.id).toBeDefined();
		expect(snap.kind).toBe("profile");
		expect(snap.data).toBe('{"sessionCount":42,"language":"ts"}');
		expect(snap.createdAt).toBeGreaterThan(0);
	});

	test("getLatest returns the most recent snapshot for a kind", async () => {
		await store.create("config", { verbose: false });
		await new Promise(r => setTimeout(r, 2)); // ensure timestamp ordering
		await store.create("config", { verbose: true, debug: true });

		const latest = await store.getLatest("config");
		expect(latest).toBeDefined();
		expect(latest!.data).toBe('{"verbose":true,"debug":true}');
	});

	test("getLatest returns undefined for unknown kind", async () => {
		const result = await store.getLatest("nonexistent");
		expect(result).toBeUndefined();
	});

	test("list returns snapshots for a kind in reverse chronological order", async () => {
		await store.create("state", { version: 1 });
		await new Promise(r => setTimeout(r, 2)); // ensure timestamp ordering
		await store.create("state", { version: 2 });
		await new Promise(r => setTimeout(r, 2)); // ensure timestamp ordering
		await store.create("state", { version: 3 });

		const snaps = await store.list("state", 2);
		expect(snaps.length).toBe(2);
		expect(JSON.parse(snaps[0]!.data)).toEqual({ version: 3 });
		expect(JSON.parse(snaps[1]!.data)).toEqual({ version: 2 });
	});

	test("list enforces limit", async () => {
		for (let i = 0; i < 5; i++) {
			await store.create("log", { entry: i });
		}
		const snaps = await store.list("log", 3);
		expect(snaps.length).toBe(3);
	});

	test("different kinds are isolated", async () => {
		await store.create("a", { x: 1 });
		await store.create("b", { y: 2 });

		const aSnaps = await store.list("a", 10);
		const bSnaps = await store.list("b", 10);

		expect(aSnaps.length).toBe(1);
		expect(bSnaps.length).toBe(1);
	});
});

describe("appendAuditEntry", () => {
	function makeLogPath(): string {
		const tmpDir = path.join(os.tmpdir(), `evolution-log-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		return path.join(tmpDir, "activity.log");
	}

	test("appends a JSONL line to the log file", async () => {
		const logPath = makeLogPath();
		await appendAuditEntry(logPath, "test_event", { key: "value", num: 42 });

		const text = await Bun.file(logPath).text();
		const lines = text.split("\n").filter(Boolean);
		expect(lines.length).toBe(1);

		const entry = JSON.parse(lines[0]!);
		expect(entry.event).toBe("test_event");
		expect(entry.details).toEqual({ key: "value", num: 42 });
		expect(entry.timestamp).toBeGreaterThan(0);
	});

	test("appends multiple entries preserving order", async () => {
		const logPath = makeLogPath();
		await appendAuditEntry(logPath, "event_a", { index: 1 });
		await appendAuditEntry(logPath, "event_b", { index: 2 });

		const text = await Bun.file(logPath).text();
		const lines = text.split("\n").filter(Boolean);
		expect(lines.length).toBe(2);

		const a = JSON.parse(lines[0]!);
		const b = JSON.parse(lines[1]!);
		expect(a.event).toBe("event_a");
		expect(b.event).toBe("event_b");
	});
});
