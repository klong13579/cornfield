/**
 * The ledger's persistence: a real `SessionManager`, a real file, and a real
 * reload.
 *
 * The restart path in `session-tree-manager.ts` is only as good as this store:
 * reconciliation reads what is on disk and nothing else, so "the ledger survives
 * the process that wrote it" is the claim under test here — including the
 * failures, because a ledger entry that cannot be read must not be silently
 * dropped from the parent's memory of what it delegated.
 */

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionNode } from "../../src/agent-domain/types";
import { SessionManager } from "../../src/session/session-manager";
import type { ChildSessionRecord } from "../../src/session/session-tree";
import {
	MemorySessionTreeStore,
	SESSION_TREE_CUSTOM_TYPE,
	SESSION_TREE_STORE_VERSION,
	SessionLogTreeStore,
	SessionTreeStoreError,
} from "../../src/session/session-tree-store";

const roots: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "session-tree-store-"));
	roots.push(dir);
	return dir;
}

afterEach(async () => {
	for (const dir of roots.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

function node(sessionId: string, status: SessionNode["status"] = "running"): SessionNode {
	return {
		sessionId,
		agentId: "coding",
		parentSessionId: "parent-1",
		rootSessionId: "parent-1",
		depth: 1,
		kind: "child",
		status,
		executionPolicy: "isolated-process",
	};
}

function record(sessionId: string, overrides: Partial<ChildSessionRecord> = {}): ChildSessionRecord {
	return {
		node: node(sessionId),
		runId: `run-${sessionId}`,
		createdAt: 1_000,
		updatedAt: 1_000,
		...overrides,
	};
}

async function sessionIn(dir: string): Promise<SessionManager> {
	return SessionManager.create(dir, path.join(dir, "sessions"));
}

describe("SessionLogTreeStore", () => {
	test("folds the log to the newest snapshot per child", async () => {
		const dir = await tempDir();
		const manager = await sessionIn(dir);
		const store = new SessionLogTreeStore(manager);

		await store.save(record("child-1"));
		await store.save(record("child-2"));
		await store.save(record("child-1", { node: node("child-1", "waiting_user"), updatedAt: 2_000 }));

		const loaded = await store.load();
		expect(loaded.map(entry => entry.node.sessionId)).toEqual(["child-1", "child-2"]);
		expect(loaded[0]?.node.status).toBe("waiting_user");
	});

	test("survives the process that wrote it: a reopened session reads the same ledger", async () => {
		const dir = await tempDir();
		const manager = await sessionIn(dir);
		const store = new SessionLogTreeStore(manager);
		await store.save(record("child-1", { lastPid: 4242, node: node("child-1", "waiting_user") }));

		// A restart is exactly this: nothing in memory, a session file on disk, and
		// a fresh manager reading it back.
		const reopened = await SessionManager.open(manager.getSessionFile()!);
		const reloaded = await new SessionLogTreeStore(reopened).load();

		expect(reloaded).toHaveLength(1);
		expect(reloaded[0]).toEqual(record("child-1", { lastPid: 4242, node: node("child-1", "waiting_user") }));
	});

	test("ignores custom entries that belong to another writer", async () => {
		const dir = await tempDir();
		const manager = await sessionIn(dir);
		manager.appendCustomEntry("user_todo_edit", { phases: [] });
		const store = new SessionLogTreeStore(manager);

		expect(await store.load()).toEqual([]);
	});

	test("fails loudly on a snapshot it cannot read", async () => {
		const dir = await tempDir();
		const manager = await sessionIn(dir);
		manager.appendCustomEntry(SESSION_TREE_CUSTOM_TYPE, {
			version: SESSION_TREE_STORE_VERSION,
			record: { runId: "r" },
		});

		const error = await new SessionLogTreeStore(manager).load().then(
			() => null,
			(cause: unknown) => cause as Error,
		);
		expect(error).toBeInstanceOf(SessionTreeStoreError);
		expect(error?.message).toContain("no session node");
	});

	test("fails loudly on a snapshot version it does not know", async () => {
		const dir = await tempDir();
		const manager = await sessionIn(dir);
		manager.appendCustomEntry(SESSION_TREE_CUSTOM_TYPE, { version: 99, record: record("child-1") });

		const error = await new SessionLogTreeStore(manager).load().then(
			() => null,
			(cause: unknown) => cause as Error,
		);
		expect(error).toBeInstanceOf(SessionTreeStoreError);
		expect(error?.message).toContain("not readable by version");
	});

	test("rejects a node whose status is not a session status", async () => {
		const dir = await tempDir();
		const manager = await sessionIn(dir);
		manager.appendCustomEntry(SESSION_TREE_CUSTOM_TYPE, {
			version: SESSION_TREE_STORE_VERSION,
			record: record("child-1", { node: { ...node("child-1"), status: "sleeping" as SessionNode["status"] } }),
		});

		const error = await new SessionLogTreeStore(manager).load().then(
			() => null,
			(cause: unknown) => cause as Error,
		);
		expect(error).toBeInstanceOf(SessionTreeStoreError);
		expect(error?.message).toContain("not a session status");
	});

	test("rejects an execution policy that is not an isolated process", async () => {
		const dir = await tempDir();
		const manager = await sessionIn(dir);
		manager.appendCustomEntry(SESSION_TREE_CUSTOM_TYPE, {
			version: SESSION_TREE_STORE_VERSION,
			record: record("child-1", {
				node: { ...node("child-1"), executionPolicy: "in-process" as SessionNode["executionPolicy"] },
			}),
		});

		const error = await new SessionLogTreeStore(manager).load().then(
			() => null,
			(cause: unknown) => cause as Error,
		);
		expect(error).toBeInstanceOf(SessionTreeStoreError);
		expect(error?.message).toContain("isolated-process");
	});
});

describe("MemorySessionTreeStore", () => {
	test("upserts by session id", async () => {
		const store = new MemorySessionTreeStore([record("child-1")]);
		await store.save(record("child-1", { node: node("child-1", "completed") }));
		const loaded = await store.load();
		expect(loaded).toHaveLength(1);
		expect(loaded[0]?.node.status).toBe("completed");
	});
});
