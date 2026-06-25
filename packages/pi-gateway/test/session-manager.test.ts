/**
 * SessionManager queue contract tests.
 */
import { describe, expect, test } from "bun:test";
import type { AgentBridge } from "../src/agent-bridge";
import { SessionManager } from "../src/session-manager";
import type { AgentResponseMeta, InboundMessage, SessionRecord } from "../src/types";

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
