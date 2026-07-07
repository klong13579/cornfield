/**
 * Session subsystem tests.
 *
 *   - `session-manager.test.ts` — SessionManager queue contract:
 *     per-account serialization, parallel across accounts, queue depth
 *     limit, waitForAllDrained, abort(accountId), abortByUser fallback.
 *   - `session-paths.test.ts` — Per-agent session path utilities:
 *     encodeCwd, cronSessionPath, interactiveSessionPath,
 *     findAgentSessionPath, enumerateAgentSessions.
 *   - `session-store.test.ts` — SQLiteSessionStore createSession /
 *     getSession / getActiveSessions.
 *
 * Three layers of the session stack: queue (manager), file layout
 * (paths), persistence (store). Co-located here.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentBridge } from "../src/agent-bridge";
import { SessionManager } from "../src/session-manager";
import {
	cronSessionPath,
	encodeCwd,
	enumerateAgentSessions,
	findAgentSessionPath,
	interactiveSessionPath,
} from "../src/session-paths";
import { SQLiteSessionStore } from "../src/session-store";
import type { AgentResponseMeta, InboundMessage, SessionRecord } from "../src/types";

// ===========================================================================
// SessionManager queue contract
// ===========================================================================

class FakeBridge {
	isRunning = true;
	active = 0;
	maxActive = 0;
	calls: string[] = [];

	abortCalls = 0;
	constructor(readonly delayMs: number = 0) {}

	async forward(msg: InboundMessage, session: SessionRecord): Promise<string> {
		this.active++;
		this.maxActive = Math.max(this.maxActive, this.active);
		this.calls.push(
			`${session.accountId}:${msg.conversationId}:${msg.content.type === "text" ? msg.content.text : ""}`,
		);
		try {
			if (this.delayMs > 0) await Bun.sleep(this.delayMs);
			return `${session.accountId}:${msg.conversationId}`;
		} finally {
			this.active--;
		}
	}

	async forwardWithMeta(msg: InboundMessage, session: SessionRecord): Promise<AgentResponseMeta | null> {
		const text = await this.forward(msg, session);
		return {
			text,
			rawText: text,
			model: null,
			provider: null,
			usage: null,
			agentDurationMs: null,
			taskDurationMs: 0,
			effort: null,
			toolCalls: [],
			toolResults: [],
			error: null,
			aborted: false,
			isFallback: false,
		};
	}

	abort(): Promise<boolean> {
		this.abortCalls++;
		return Promise.resolve(this.active > 0);
	}

	getSnapshot() {
		return {
			state: this.active > 0 ? "busy" : "idle",
			running: this.isRunning,
			ready: this.isRunning,
			pendingPrompts: this.active,
			pendingCommands: 0,
			circuitState: "closed",
			circuitFailures: 0,
			crashCount: 0,
			crashWindowCount: 0,
			crashSuppressed: false,
			reconnecting: false,
		};
	}
}

function asBridge(bridge: FakeBridge): AgentBridge {
	return bridge as unknown as AgentBridge;
}

function makeMessage(accountId: string, conversationId: string, text: string): InboundMessage {
	return {
		channelId: "dingtalk",
		accountId,
		userId: "user",
		conversationId,
		isGroup: false,
		content: { type: "text", text },
		timestamp: new Date(),
	};
}

function makeSession(accountId: string, conversationId: string): SessionRecord {
	return {
		id: `${accountId}:${conversationId}`,
		channelId: "dingtalk",
		accountId,
		userId: "user",
		conversationId,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		status: "active",
	};
}

describe("SessionManager", () => {
	test("serializes work within one account", async () => {
		const ops = new FakeBridge(20);
		const manager = new SessionManager({ bridges: new Map([["ops", asBridge(ops)]]) });

		const first = manager.enqueue(makeMessage("ops", "a", "1"), makeSession("ops", "a"));
		const second = manager.enqueue(makeMessage("ops", "b", "2"), makeSession("ops", "b"));
		await Promise.all([first, second]);

		expect(ops.maxActive).toBe(1);
		expect(ops.calls).toEqual(["ops:a:1", "ops:b:2"]);
	});

	test("allows different accounts to run in parallel", async () => {
		const ops = new FakeBridge(40);
		const hr = new FakeBridge(40);
		const manager = new SessionManager({
			bridges: new Map([
				["ops", asBridge(ops)],
				["hr", asBridge(hr)],
			]),
		});

		const startedAt = Date.now();
		await Promise.all([
			manager.enqueue(makeMessage("ops", "a", "1"), makeSession("ops", "a")),
			manager.enqueue(makeMessage("hr", "b", "2"), makeSession("hr", "b")),
		]);
		const elapsedMs = Date.now() - startedAt;

		expect(ops.maxActive).toBe(1);
		expect(hr.maxActive).toBe(1);
		expect(elapsedMs).toBeLessThan(75);
	});

	test("rejects when an account queue reaches max depth", async () => {
		const ops = new FakeBridge(50);
		const manager = new SessionManager({ bridges: new Map([["ops", asBridge(ops)]]), maxQueueDepth: 1 });

		const first = manager.enqueue(makeMessage("ops", "a", "1"), makeSession("ops", "a"));
		const second = await manager.enqueue(makeMessage("ops", "b", "2"), makeSession("ops", "b"));
		await first;

		expect(second).toBe("系统繁忙，请稍后重试。");
		expect(ops.calls).toEqual(["ops:a:1"]);
	});

	test("waits for queued work to drain", async () => {
		const ops = new FakeBridge(20);
		const manager = new SessionManager({ bridges: new Map([["ops", asBridge(ops)]]) });

		const pending = manager.enqueue(makeMessage("ops", "a", "1"), makeSession("ops", "a"));
		const drained = await manager.waitForAllDrained(200);
		await pending;

		expect(drained).toBe(true);
		expect(manager.getQueueStats()).toEqual([]);
	});

	test("aborts the bridge for the selected account", async () => {
		const ops = new FakeBridge(50);
		const hr = new FakeBridge(50);
		const manager = new SessionManager({
			bridges: new Map([
				["ops", asBridge(ops)],
				["hr", asBridge(hr)],
			]),
		});

		const pending = manager.enqueue(makeMessage("ops", "a", "1"), makeSession("ops", "a"));
		await Bun.sleep(10);
		expect(await manager.abort("ops")).toBe(true);
		expect(ops.abortCalls).toBe(1);
		expect(hr.abortCalls).toBe(0);
		await pending;
	});

	describe("abortByUser fallback", () => {
		// The OpenClaw 675cde2f schema's btn_stop click fires the
		// TOPIC_CARD callback even for cards we never registered with
		// the ActionRegistry. `Gateway.#handleCardAction` falls back
		// to `SessionManager.abortByUser(userId)` when the registry
		// lookup misses, so the user still kills the work they meant
		// to kill. The fallback prefers a `defaultBridge` (the common
		// single-account deployment); in multi-account mode without a
		// default it tries every bridge and returns true if any abort
		// took.

		test("returns true when default bridge has an active prompt", async () => {
			const ops = new FakeBridge(50);
			const defaultBridge = new FakeBridge(50);
			const manager = new SessionManager({
				bridges: new Map([["ops", asBridge(ops)]]),
				defaultBridge: asBridge(defaultBridge),
			});
			// The defaultBridge is a separate agent from the
			// accountId-keyed bridges (used as a fallback for
			// ambiguous lookups). Simulate an in-flight prompt on it
			// by running forward() directly — that bumps `active` so
			// the bridge's abort() returns true.
			const defaultPending = defaultBridge.forward(makeMessage("default", "a", "1"), makeSession("default", "a"));
			await Bun.sleep(10);
			expect(await manager.abortByUser("user-1")).toBe(true);
			expect(defaultBridge.abortCalls).toBe(1);
			// ops bridge was NOT asked to abort — default bridge wins
			expect(ops.abortCalls).toBe(0);
			await defaultPending;
		});

		test("returns false when default bridge is idle", async () => {
			const defaultBridge = new FakeBridge(0);
			const manager = new SessionManager({
				bridges: new Map(),
				defaultBridge: asBridge(defaultBridge),
			});
			// No active work, default bridge abort returns false
			expect(await manager.abortByUser("user-1")).toBe(false);
			expect(defaultBridge.abortCalls).toBe(1);
		});

		test("in multi-account mode without default, tries every bridge", async () => {
			const ops = new FakeBridge(0); // idle
			const hr = new FakeBridge(50); // busy
			const manager = new SessionManager({
				bridges: new Map([
					["ops", asBridge(ops)],
					["hr", asBridge(hr)],
				]),
			});
			const pending = manager.enqueue(makeMessage("hr", "a", "1"), makeSession("hr", "a"));
			await Bun.sleep(10);
			expect(await manager.abortByUser("user-1")).toBe(true);
			expect(ops.abortCalls).toBe(1);
			expect(hr.abortCalls).toBe(1);
			await pending;
		});

		test("returns false in multi-account mode when all bridges are idle", async () => {
			const ops = new FakeBridge(0);
			const hr = new FakeBridge(0);
			const manager = new SessionManager({
				bridges: new Map([
					["ops", asBridge(ops)],
					["hr", asBridge(hr)],
				]),
			});
			expect(await manager.abortByUser("user-1")).toBe(false);
			expect(ops.abortCalls).toBe(1);
			expect(hr.abortCalls).toBe(1);
		});

		test("continues trying other bridges when one throws", async () => {
			const ops = new FakeBridge(50);
			const hr = new FakeBridge(50);
			// First call to ops abort throws; second call (used by the
			// fallback loop) returns based on active count.
			let opsCalls = 0;
			const originalOpsAbort = ops.abort.bind(ops);
			ops.abort = () => {
				opsCalls++;
				if (opsCalls === 1) throw new Error("synthetic bridge fault");
				return originalOpsAbort();
			};
			const manager = new SessionManager({
				bridges: new Map([
					["ops", asBridge(ops)],
					["hr", asBridge(hr)],
				]),
			});
			const pending = manager.enqueue(makeMessage("hr", "a", "1"), makeSession("hr", "a"));
			await Bun.sleep(10);
			// hr is busy, ops throws, fallback should still return true
			expect(await manager.abortByUser("user-1")).toBe(true);
			await pending;
		});
	});

	test("reports bridge snapshots by account", () => {
		const ops = new FakeBridge();
		const manager = new SessionManager({ bridges: new Map([["ops", asBridge(ops)]]) });

		expect(manager.getBridgeStats()).toMatchObject([{ accountId: "ops", state: "idle", running: true }]);
	});

	test("abortByUser routes precisely via user→account map", async () => {
		const ops = new FakeBridge(50); // busy
		const hr = new FakeBridge(50); // busy
		const manager = new SessionManager({
			bridges: new Map([
				["ops", asBridge(ops)],
				["hr", asBridge(hr)],
			]),
		});

		// User alice sends to hr; user bob sends to ops.
		const hrMsg = { ...makeMessage("hr", "a", "1"), userId: "alice" };
		const opsMsg = { ...makeMessage("ops", "b", "2"), userId: "bob" };
		const hrPending = manager.enqueueWithMeta(hrMsg, makeSession("hr", "a"));
		const opsPending = manager.enqueueWithMeta(opsMsg, makeSession("ops", "b"));
		await Bun.sleep(10);

		// Alice clicks stop → should only abort hr, not ops.
		expect(await manager.abortByUser("alice")).toBe(true);
		expect(hr.abortCalls).toBe(1);
		expect(ops.abortCalls).toBe(0);

		// Bob clicks stop → should only abort ops.
		expect(await manager.abortByUser("bob")).toBe(true);
		expect(ops.abortCalls).toBe(1);
		expect(hr.abortCalls).toBe(1); // unchanged from alice's abort

		await Promise.all([hrPending, opsPending]);
	});
});

// ===========================================================================
// session-paths — encodeCwd, cronSessionPath, interactiveSessionPath,
// findAgentSessionPath, enumerateAgentSessions
// ===========================================================================

describe("encodeCwd", () => {
	it("replaces / with - and lowercases nothing (preserves case)", () => {
		expect(encodeCwd("/Users/Foo/Bar")).toBe("-Users-Foo-Bar");
	});

	it("normalises to absolute path before encoding", () => {
		// `path.resolve` of a relative cwd is process-cwd-based; just
		// assert the result is a leading-dash string with no embedded /.
		const out = encodeCwd("relative/path");
		expect(out.startsWith("-")).toBe(true);
		expect(out.includes("/")).toBe(false);
	});

	it("throws on empty cwd", () => {
		expect(() => encodeCwd("")).toThrow(/cwd required/);
	});
});

describe("cronSessionPath", () => {
	it("builds <agentDir>/sessions/cron_<ts>.jsonl", () => {
		const agentDir = "/tmp/agent/hr";
		const fixed = 1_700_000_000_000;
		expect(cronSessionPath(agentDir, fixed)).toBe("/tmp/agent/hr/sessions/cron_1700000000000.jsonl");
	});

	it("uses Date.now() by default and produces a parseable filename", () => {
		const out = cronSessionPath("/tmp/agent/hr");
		expect(out.startsWith("/tmp/agent/hr/sessions/cron_")).toBe(true);
		const tail = path.basename(out);
		const m = /^cron_(\d+)\.jsonl$/.exec(tail);
		expect(m).not.toBeNull();
		expect(Number.parseInt(m![1]!, 10)).toBeGreaterThan(0);
	});

	it("throws on empty agentDir", () => {
		expect(() => cronSessionPath("", 1)).toThrow(/agentDir required/);
	});

	it("throws on non-positive now", () => {
		expect(() => cronSessionPath("/x", 0)).toThrow(/invalid now/);
		expect(() => cronSessionPath("/x", -1)).toThrow(/invalid now/);
	});
});

describe("interactiveSessionPath", () => {
	it("encodes cwd into the path and matches OMP by-date layout", () => {
		const agentDir = "/tmp/agent/hr";
		const cwd = "/Users/sz/Desktop/Narwal/OMP-workspace-test/hr3";
		// Pin a known date so the assertion doesn't depend on the test clock.
		const fixed = new Date("2026-06-30T12:34:56");
		const out = interactiveSessionPath(agentDir, cwd, fixed);
		// Path components: <agentDir>/sessions/<encoded>/by-date/YYYYMMDD/HHMMSS__<8hex>.jsonl
		const expectedEncoded = "-Users-sz-Desktop-Narwal-OMP-workspace-test-hr3";
		const re = new RegExp(
			`^${escapeRe(agentDir)}/sessions/${escapeRe(expectedEncoded)}/by-date/20260630/123456__[0-9a-f]{8}\\.jsonl$`,
		);
		expect(out).toMatch(re);
		// Sanity: file basename pattern
		const base = path.basename(out);
		expect(base).toMatch(/^123456__[0-9a-f]{8}\.jsonl$/);
	});

	it("throws on empty agentDir", () => {
		expect(() => interactiveSessionPath("", "/x")).toThrow(/agentDir required/);
	});

	it("throws on empty cwd", () => {
		expect(() => interactiveSessionPath("/x", "")).toThrow(/cwd required/);
	});
});

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("findAgentSessionPath (per-agent)", () => {
	let agentDir: string;
	beforeEach(() => {
		agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-paths-"));
	});
	afterEach(() => {
		fs.rmSync(agentDir, { recursive: true, force: true });
	});

	/** Create <agentDir>/sessions/<rel> with explicit mtime. */
	function touch(rel: string, mtimeMs: number, content: string = "{}\n"): string {
		const full = path.join(agentDir, "sessions", rel);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, content);
		fs.utimesSync(full, new Date(mtimeMs), new Date(mtimeMs));
		return full;
	}

	it("returns undefined when the agent's sessions dir does not exist", () => {
		expect(findAgentSessionPath(agentDir, 0, Date.now())).toBeUndefined();
	});

	it("finds a cron file at the root of <agentDir>/sessions/", () => {
		const t = 1_700_000_000_000;
		const file = touch("cron_1700000000000.jsonl", t);
		expect(findAgentSessionPath(agentDir, t - 100, t + 100)).toBe(file);
	});

	it("finds an interactive file under <encoded-cwd>/by-date/<date>/", () => {
		const t = 1_700_000_000_000;
		const file = touch("-p/by-date/2023-11-14/120000__12345678.jsonl", t);
		expect(findAgentSessionPath(agentDir, t - 100, t + 100)).toBe(file);
	});

	it("scopes to the given agentDir — does NOT cross into a sibling agent", () => {
		// Create a sibling agent dir with a file in the same time window.
		const sibling = fs.mkdtempSync(path.join(os.tmpdir(), "session-paths-sibling-"));
		try {
			const t = 1_700_000_000_000;
			fs.mkdirSync(path.join(sibling, "sessions"), { recursive: true });
			const siblingFile = path.join(sibling, "sessions", "cron_1700000000000.jsonl");
			fs.writeFileSync(siblingFile, "{}\n");
			fs.utimesSync(siblingFile, new Date(t), new Date(t));

			// Agent A has no files; the sibling's file must not bleed in.
			expect(findAgentSessionPath(agentDir, t - 100, t + 100)).toBeUndefined();
		} finally {
			fs.rmSync(sibling, { recursive: true, force: true });
		}
	});

	it("prefers the most recent mtime within the window", () => {
		const t = 1_700_000_000_000;
		const older = touch("cron_1700000000001.jsonl", t - 1_000);
		const newer = touch("cron_1700000000002.jsonl", t);
		expect(findAgentSessionPath(agentDir, t - 5_000, t + 5_000)).toBe(newer);
		// Sanity: the older file is real and on disk
		expect(fs.existsSync(older!)).toBe(true);
	});

	it("tolerates ±5s on the window edges", () => {
		const t = 1_700_000_000_000;
		const before = touch("cron_1699999995000.jsonl", t - 5_000);
		const after = touch("cron_1700000005000.jsonl", t + 5_000);
		// window is [t, t]; ±5s tolerance includes both edges
		const r1 = findAgentSessionPath(agentDir, t, t);
		const r2 = findAgentSessionPath(agentDir, t - 100, t);
		const r3 = findAgentSessionPath(agentDir, t, t + 100);
		// Either one could win depending on mtime tie-break; just assert
		// that the result is one of the two in-window files.
		for (const r of [r1, r2, r3]) {
			expect([before, after]).toContain(r);
		}
	});

	it("rejects files outside the ±5s window", () => {
		const t = 1_700_000_000_000;
		touch("cron_too_old.jsonl", t - 5_001);
		touch("cron_too_new.jsonl", t + 5_001);
		expect(findAgentSessionPath(agentDir, t, t)).toBeUndefined();
	});

	it("rejects files that don't match the cron or interactive filename grammar", () => {
		const t = 1_700_000_000_000;
		touch("notes.jsonl", t);
		touch("readme.jsonl", t);
		touch("cron_bogus.txt", t);
		touch("cron_abc.jsonl", t); // not all digits
		expect(findAgentSessionPath(agentDir, t - 100, t + 100)).toBeUndefined();
	});

	it("does not descend into hidden directories", () => {
		const t = 1_700_000_000_000;
		touch(".git/cron_1700000000000.jsonl", t);
		touch(".DS_Store/cron_1700000000000.jsonl", t);
		expect(findAgentSessionPath(agentDir, t - 100, t + 100)).toBeUndefined();
	});

	it("ignores empty agentDir", () => {
		expect(findAgentSessionPath("", 0, Date.now())).toBeUndefined();
	});
});

describe("enumerateAgentSessions", () => {
	let agentDir: string;
	beforeEach(() => {
		agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-paths-enum-"));
	});
	afterEach(() => {
		fs.rmSync(agentDir, { recursive: true, force: true });
	});

	function touch(rel: string, size: number, mtimeMs: number): void {
		const full = path.join(agentDir, "sessions", rel);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, "x".repeat(size));
		fs.utimesSync(full, new Date(mtimeMs), new Date(mtimeMs));
	}

	it("returns [] when the sessions dir doesn't exist", () => {
		expect(enumerateAgentSessions(agentDir)).toEqual([]);
	});

	it("returns [] for an empty agentDir", () => {
		expect(enumerateAgentSessions("")).toEqual([]);
	});

	it("enumerates both cron and interactive files, tagging type correctly", () => {
		const t = 1_700_000_000_000;
		touch("cron_1700000000000.jsonl", 10, t);
		touch("-p/by-date/2023-11-14/120000__12345678.jsonl", 20, t + 1);
		touch("-p/by-date/2023-11-14/130000__87654321.jsonl", 30, t + 2);
		const entries = enumerateAgentSessions(agentDir);
		expect(entries.length).toBe(3);
		const cron = entries.find(e => e.type === "cron");
		const interactive = entries.filter(e => e.type === "interactive");
		expect(cron).toBeDefined();
		expect(cron?.size).toBe(10);
		expect(interactive.length).toBe(2);
		expect(interactive.every(e => e.size > 0)).toBe(true);
	});

	it("ignores files that don't match the filename grammar", () => {
		const t = 1_700_000_000_000;
		touch("cron_1700000000000.jsonl", 10, t);
		touch("notes.jsonl", 5, t);
		touch("readme.txt", 5, t);
		touch("cron_abc.jsonl", 5, t); // not all digits
		const entries = enumerateAgentSessions(agentDir);
		expect(entries.length).toBe(1);
		expect(entries[0]?.type).toBe("cron");
	});
});

// ===========================================================================
// SQLiteSessionStore
// ===========================================================================

describe("SQLiteSessionStore", () => {
	let store: SQLiteSessionStore;
	const dbPath = path.join(os.tmpdir(), `pi-gateway-test-${Date.now()}.db`);

	beforeAll(() => {
		store = new SQLiteSessionStore(dbPath);
	});

	afterAll(() => {
		store.close();
		Bun.file(dbPath).delete?.();
	});

	it("creates and retrieves a session", async () => {
		const session = await store.createSession({
			channelId: "dingtalk",
			accountId: "acc1",
			userId: "user1",
			conversationId: "conv1",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			status: "active",
		});

		expect(session.id).toBeDefined();
		expect(session.channelId).toBe("dingtalk");

		const retrieved = await store.getSession("dingtalk", "acc1", "conv1");
		expect(retrieved).not.toBeNull();
		expect(retrieved?.userId).toBe("user1");
	});

	it("returns null for non-existent session", async () => {
		const result = await store.getSession("none", "none");
		expect(result).toBeNull();
	});

	it("lists active sessions", async () => {
		const sessions = await store.getActiveSessions();
		expect(sessions.length).toBeGreaterThan(0);
	});
});
