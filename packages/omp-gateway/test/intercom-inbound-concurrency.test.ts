/**
 * Intercom inbound-concurrency closed loop (integration, no LLM, no extension).
 *
 * Registers a real IntercomBroker (isolated socket via the injectable
 * listenTarget) and drives it with real IntercomClients from the coding-agent
 * extension — one parent and two children. This locks the broker-side
 * concurrency contract that the extension's routing layer (ReplyTracker,
 * multi-slot reply waiters) builds on, end to end over a real socket:
 *
 *   1. two children asking the parent concurrently arrive as two independent
 *      messages (distinct ids, both asks)
 *   2. explicit replyTo replies are demultiplexed per ask — answers can never
 *      cross (the "user asked child1, answer went to child2" failure mode)
 *   3. symmetric ask deadlock is refused by the broker (mutual-ask guard)
 *   4. two asks from the SAME sender to the SAME receiver are independent
 *      edges, each correctly answered via its own replyTo
 *   5. a reply with a stale/unknown replyTo is rejected (never silently
 *      delivered to a wrong receiver)
 *   6. cancelling one ask does not disturb another in-flight ask
 *   7. a parent asking two children in parallel demultiplexes both replies by
 *      correlation id (the broker-side guarantee behind the multi-slot
 *      waitForReply map)
 *
 * Unit-level routing decisions live in coding-agent's
 * test/intercom-extension/{reply-tracker,inbound-concurrency}.test.ts; the
 * E2E=1 gated intercom-parent-child-e2e.test.ts covers the real-LLM path.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { IntercomClient } from "../../coding-agent/src/intercom-extension/broker/client";
import type { Message, SessionInfo } from "../../coding-agent/src/intercom-extension/types";
import { IntercomBroker } from "../src/intercom/broker-server";

const PARENT_ID = "parent-session-id";
const CHILD1_ID = "child-1-session-id";
const CHILD2_ID = "child-2-session-id";

let runtimeDir: string;
let previousAgentDir: string | undefined;
let broker: IntercomBroker;
let parent: IntercomClient;
let child1: IntercomClient;
let child2: IntercomClient;
let parentInbox: ReturnType<typeof collector>;
let child1Inbox: ReturnType<typeof collector>;
let child2Inbox: ReturnType<typeof collector>;

function registration(name: string, extra?: Record<string, unknown>) {
	return {
		name,
		runtimeFallbackAlias: false,
		cwd: process.cwd(),
		model: "test-model",
		pid: process.pid,
		startedAt: Date.now(),
		lastActivity: Date.now(),
		status: "idle",
		...extra,
	};
}

/** Collects inbound messages per client so tests can assert on real delivery. */
function collector(client: IntercomClient): {
	events: Array<{ from: SessionInfo; message: Message }>;
	wait: (count: number, timeoutMs?: number) => Promise<void>;
	clear: () => void;
} {
	const events: Array<{ from: SessionInfo; message: Message }> = [];
	const handler = (from: SessionInfo, message: Message) => {
		events.push({ from, message });
	};
	client.on("message", handler);
	return {
		events,
		wait: async (count: number, timeoutMs = 3_000) => {
			const deadline = Date.now() + timeoutMs;
			while (events.length < count) {
				if (Date.now() > deadline) {
					throw new Error(
						`timed out waiting for ${count} messages (got ${events.length}: ${events
							.map(e => e.message.id)
							.join(", ")})`,
					);
				}
				await Bun.sleep(20);
			}
		},
		clear: () => {
			events.length = 0;
		},
	};
}

beforeAll(async () => {
	runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-intercom-concurrency-"));
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = path.join(runtimeDir, "agent");
	broker = new IntercomBroker({
		intercomDir: path.join(runtimeDir, "intercom"),
		listenTarget: path.join(runtimeDir, "intercom", "broker.sock"),
	});
	await broker.start();
	await Bun.sleep(50);

	parent = new IntercomClient();
	await parent.connect(registration("parent-session"), PARENT_ID);
	child1 = new IntercomClient();
	await child1.connect(registration("child-1"), CHILD1_ID);
	child2 = new IntercomClient();
	await child2.connect(registration("child-2"), CHILD2_ID);

	parentInbox = collector(parent);
	child1Inbox = collector(child1);
	child2Inbox = collector(child2);
});

afterAll(async () => {
	if (child2) await child2.disconnect();
	if (child1) await child1.disconnect();
	if (parent) await parent.disconnect();
	if (broker) broker.stop();
	process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	await fs.rm(runtimeDir, { recursive: true, force: true });
});

describe("intercom inbound concurrency (real broker + real clients)", () => {
	afterEach(() => {
		parentInbox.clear();
		child1Inbox.clear();
		child2Inbox.clear();
	});

	test("two children asking the parent concurrently arrive as two independent asks", async () => {
		const [r1, r2] = await Promise.all([
			child1.send(PARENT_ID, { text: "q1: what model are we on?", messageId: "q1", expectsReply: true }),
			child2.send(PARENT_ID, { text: "q2: why did the cron miss?", messageId: "q2", expectsReply: true }),
		]);
		expect(r1.delivered).toBe(true);
		expect(r2.delivered).toBe(true);

		await parentInbox.wait(2);
		const ids = parentInbox.events.map(e => e.message.id).sort();
		expect(ids).toEqual(["q1", "q2"]);
		expect(parentInbox.events.every(e => e.message.expectsReply === true)).toBe(true);
		// Both asks are visible regardless of arrival order — the receiver
		// builds one pending per ask, never folds them together.
		const texts = parentInbox.events.map(e => e.message.content.text).sort();
		expect(texts).toEqual(["q1: what model are we on?", "q2: why did the cron miss?"]);
	});

	test("explicit replyTo replies are demultiplexed per ask — answers never cross", async () => {
		// Seed two independent pending asks (one from each child).
		await child1.send(PARENT_ID, { text: "q1", messageId: "q1", expectsReply: true });
		await child2.send(PARENT_ID, { text: "q2", messageId: "q2", expectsReply: true });
		await parentInbox.wait(2);

		// Parent answers each via its own replyTo — deliberately answering in
		// reverse of arrival to prove routing is by correlation id, not order.
		const [a2, a1] = await Promise.all([
			parent.send(CHILD2_ID, { text: "answer-for-q2", replyTo: "q2" }),
			parent.send(CHILD1_ID, { text: "answer-for-q1", replyTo: "q1" }),
		]);
		expect(a1.delivered).toBe(true);
		expect(a2.delivered).toBe(true);

		await child1Inbox.wait(1);
		await child2Inbox.wait(1);
		// Child1 got only its own answer, tagged with its own ask id...
		expect(child1Inbox.events[0]!.message.content.text).toBe("answer-for-q1");
		expect(child1Inbox.events[0]!.message.replyTo).toBe("q1");
		expect(child1Inbox.events).toHaveLength(1);
		// ...and child2 got only its own (no cross-talk in either direction).
		expect(child2Inbox.events[0]!.message.content.text).toBe("answer-for-q2");
		expect(child2Inbox.events[0]!.message.replyTo).toBe("q2");
		expect(child2Inbox.events).toHaveLength(1);
	});

	test("symmetric ask deadlock is refused — a third ask cannot straddle two open asks", async () => {
		// Parent asks child1 (edge p→c1).
		const pAsk = await parent.send(CHILD1_ID, { text: "p-ask", messageId: "p-ask-1", expectsReply: true });
		expect(pAsk.delivered).toBe(true);
		// Child1 answers — the p→c1 edge is consumed.
		await child1.send(PARENT_ID, { text: "p-ask-answer", replyTo: "p-ask-1" });

		// Child1 asks the parent and the parent does NOT answer yet (edge c1→p
		// stays open) — parent then asking child1 again would deadlock both on
		// each other's replies, so the broker refuses the second ask.
		const cAsk = await child1.send(PARENT_ID, { text: "c1-open-ask", messageId: "c1-open-ask", expectsReply: true });
		expect(cAsk.delivered).toBe(true);
		const straddle = await parent.send(CHILD1_ID, {
			text: "would-deadlock",
			messageId: "straddle",
			expectsReply: true,
		});
		expect(straddle.delivered).toBe(false);
		expect(straddle.reason).toContain("Mutual ask refused");

		// Cleanup: answer the still-open c1→p ask.
		const done = await parent.send(CHILD1_ID, { text: "c1-answer", replyTo: "c1-open-ask" });
		expect(done.delivered).toBe(true);
	});

	test("two asks from the same sender to the same receiver keep independent edges", async () => {
		const [rA, rB] = await Promise.all([
			child1.send(PARENT_ID, { text: "qA", messageId: "qA", expectsReply: true }),
			child1.send(PARENT_ID, { text: "qB", messageId: "qB", expectsReply: true }),
		]);
		expect(rA.delivered).toBe(true);
		expect(rB.delivered).toBe(true);
		await parentInbox.wait(2);

		await parent.send(CHILD1_ID, { text: "answer-A", replyTo: "qA" });
		await parent.send(CHILD1_ID, { text: "answer-B", replyTo: "qB" });
		await child1Inbox.wait(2);

		const byReplyTo = new Map(child1Inbox.events.map(e => [e.message.replyTo, e.message.content.text]));
		expect(byReplyTo.get("qA")).toBe("answer-A");
		expect(byReplyTo.get("qB")).toBe("answer-B");
	});

	test("a reply with a stale or unknown replyTo is rejected, never misdelivered", async () => {
		const rogue = await parent.send(CHILD1_ID, { text: "rogue-answer", replyTo: "never-existed" });
		expect(rogue.delivered).toBe(false);
		expect(rogue.reason).toContain("Reply target does not match a pending ask");
		// Nothing arrives at the child.
		await Bun.sleep(100);
		expect(child1Inbox.events).toHaveLength(0);

		// Same after an ask was answered: re-answering the consumed ask is a
		// stale reply and must also be rejected (one answer per ask).
		await child1.send(PARENT_ID, { text: "q-stale", messageId: "q-stale", expectsReply: true });
		await parentInbox.wait(1);
		await parent.send(CHILD1_ID, { text: "first-answer", replyTo: "q-stale" });
		const second = await parent.send(CHILD1_ID, { text: "second-answer", replyTo: "q-stale" });
		expect(second.delivered).toBe(false);
	});

	test("cancelling one ask does not disturb another in-flight ask", async () => {
		// Parent asks both children.
		await parent.send(CHILD1_ID, { text: "ask-c1", messageId: "p-c1", expectsReply: true });
		await parent.send(CHILD2_ID, { text: "ask-c2", messageId: "p-c2", expectsReply: true });

		// Child1 answers normally; parent cancels the c2 ask before child2 replies.
		await child1.send(PARENT_ID, { text: "c1-answer", replyTo: "p-c1" });
		parent.cancelAsk("p-c2");

		// The cancelled reply comes back rejected ("no pending ask"), while the
		// kept ask's answer was delivered — cancel is per-ask, not per-session.
		const lateC2 = await child2.send(PARENT_ID, { text: "late-c2-answer", replyTo: "p-c2" });
		expect(lateC2.delivered).toBe(false);
		expect(lateC2.reason).toContain("Reply target does not match a pending ask");

		await parentInbox.wait(1);
		expect(parentInbox.events[0]!.message.content.text).toBe("c1-answer");
		expect(parentInbox.events[0]!.message.replyTo).toBe("p-c1");
	});

	test("a parent asking two children in parallel demultiplexes both replies by correlation id", async () => {
		// The broker-side guarantee behind the extension's multi-slot
		// waitForReply map: two open asks to two different receivers coexist,
		// and each reply resolves only its own slot.
		await parent.send(CHILD1_ID, { text: "p-ask-1", messageId: "p-ask-1", expectsReply: true });
		await parent.send(CHILD2_ID, { text: "p-ask-2", messageId: "p-ask-2", expectsReply: true });

		// Children answer concurrently, each with its own correlation id.
		const [s1, s2] = await Promise.all([
			child1.send(PARENT_ID, { text: "p-1-answer", replyTo: "p-ask-1" }),
			child2.send(PARENT_ID, { text: "p-2-answer", replyTo: "p-ask-2" }),
		]);
		expect(s1.delivered).toBe(true);
		expect(s2.delivered).toBe(true);

		await parentInbox.wait(2);
		const byReplyTo = new Map(parentInbox.events.map(e => [e.message.replyTo, e.message.content.text]));
		expect(byReplyTo.get("p-ask-1")).toBe("p-1-answer");
		expect(byReplyTo.get("p-ask-2")).toBe("p-2-answer");
	});
});
