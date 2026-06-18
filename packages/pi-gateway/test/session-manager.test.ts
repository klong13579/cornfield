/**
 * SessionManager queue contract tests.
 */
import { describe, expect, test } from "bun:test";
import type { AgentBridge } from "../src/agent-bridge";
import { SessionManager } from "../src/session-manager";
import type { InboundMessage, SessionRecord } from "../src/types";

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
		this.calls.push(`${session.accountId}:${msg.conversationId}:${msg.content.type === "text" ? msg.content.text : ""}`);
		try {
			if (this.delayMs > 0) await Bun.sleep(this.delayMs);
			return `${session.accountId}:${msg.conversationId}`;
		} finally {
			this.active--;
		}
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

	test("reports bridge snapshots by account", () => {
		const ops = new FakeBridge();
		const manager = new SessionManager({ bridges: new Map([["ops", asBridge(ops)]]) });

		expect(manager.getBridgeStats()).toMatchObject([{ accountId: "ops", state: "idle", running: true }]);
	});
});
