/**
 * ReplyTracker routing tests.
 *
 * Routing is correlation-id only: explicit replyTo always wins; implicit
 * resolution is unambiguous only when exactly one pending ask remains.
 * Multiple pending asks are an explicit error — the session-level turn-context
 * shortcut that previously routed replies to the wrong sender when a steering
 * message interleaved is gone.
 */
import { describe, expect, test } from "bun:test";
import { ReplyTracker } from "../../src/intercom-extension/reply-tracker";
import type { Message, SessionInfo } from "../../src/intercom-extension/types";

const ASK_TIMEOUT_MS = 60_000;

const sender = (id: string, name?: string): SessionInfo => ({
	id,
	...(name ? { name } : {}),
	cwd: "/tmp/project",
	model: "test-model",
	pid: 4242,
	startedAt: Date.now(),
	lastActivity: Date.now(),
	status: "idle",
});

const askMessage = (id: string, expectsReply = true): Message => ({
	id,
	timestamp: Date.now(),
	content: { text: `ask ${id}` },
	...(expectsReply ? { expectsReply: true } : {}),
});

const child1 = sender("child-session-1", "child-one");
const child2 = sender("child-session-2", "child-two");

function record(tracker: ReplyTracker, from: SessionInfo, message: Message, receivedAt = Date.now()): void {
	tracker.recordIncomingMessage(from, message, receivedAt);
}

describe("ReplyTracker", () => {
	describe("recordIncomingMessage", () => {
		test("only expectsReply messages become pending asks", () => {
			const tracker = new ReplyTracker(ASK_TIMEOUT_MS);
			record(tracker, child1, askMessage("ask-1", true));
			record(tracker, child1, askMessage("plain-1", false));
			expect(tracker.listPending()).toHaveLength(1);
			expect(tracker.listPending()[0]!.message.id).toBe("ask-1");
		});
	});

	describe("resolveReplyTarget with explicit replyTo", () => {
		test("resolves the matching pending ask", () => {
			const tracker = new ReplyTracker(ASK_TIMEOUT_MS);
			record(tracker, child1, askMessage("ask-1"));
			const target = tracker.resolveReplyTarget({ replyTo: "ask-1" });
			expect(target.message.id).toBe("ask-1");
			expect(target.from.id).toBe(child1.id);
		});

		test("unknown replyTo throws", () => {
			const tracker = new ReplyTracker(ASK_TIMEOUT_MS);
			record(tracker, child1, askMessage("ask-1"));
			expect(() => tracker.resolveReplyTarget({ replyTo: "nope" })).toThrow('No pending ask with message ID "nope"');
		});

		test("replyTo with a mismatching `to` throws", () => {
			const tracker = new ReplyTracker(ASK_TIMEOUT_MS);
			record(tracker, child1, askMessage("ask-1"));
			expect(() => tracker.resolveReplyTarget({ to: "child-two", replyTo: "ask-1" })).toThrow(
				'Pending ask "ask-1" is not from "child-two"',
			);
		});
	});

	describe("resolveReplyTarget with implicit resolution", () => {
		test("no pending ask throws", () => {
			const tracker = new ReplyTracker(ASK_TIMEOUT_MS);
			expect(() => tracker.resolveReplyTarget({})).toThrow("No active intercom context to reply to");
		});

		test("exactly one pending ask resolves to it", () => {
			const tracker = new ReplyTracker(ASK_TIMEOUT_MS);
			record(tracker, child1, askMessage("ask-1"));
			const target = tracker.resolveReplyTarget({});
			expect(target.message.id).toBe("ask-1");
		});

		test("two pending asks fail loud instead of guessing (regression: the old currentTurnContext shortcut silently picked one)", () => {
			const tracker = new ReplyTracker(ASK_TIMEOUT_MS);
			record(tracker, child1, askMessage("ask-1"));
			record(tracker, child2, askMessage("ask-2"));
			expect(() => tracker.resolveReplyTarget({})).toThrow("Multiple pending asks — specify `to` or `replyTo`");
		});

		test("`to` disambiguates multiple pending asks by exact id", () => {
			const tracker = new ReplyTracker(ASK_TIMEOUT_MS);
			record(tracker, child1, askMessage("ask-1"));
			record(tracker, child2, askMessage("ask-2"));
			const target = tracker.resolveReplyTarget({ to: child2.id });
			expect(target.message.id).toBe("ask-2");
		});

		test("`to` disambiguates by unique name", () => {
			const tracker = new ReplyTracker(ASK_TIMEOUT_MS);
			record(tracker, child1, askMessage("ask-1"));
			record(tracker, child2, askMessage("ask-2"));
			const target = tracker.resolveReplyTarget({ to: "child-one" });
			expect(target.message.id).toBe("ask-1");
		});

		test("`to` with two same-named senders throws", () => {
			const tracker = new ReplyTracker(ASK_TIMEOUT_MS);
			const dup1 = sender("child-session-a", "same-name");
			const dup2 = sender("child-session-b", "same-name");
			record(tracker, dup1, askMessage("ask-1"));
			record(tracker, dup2, askMessage("ask-2"));
			expect(() => tracker.resolveReplyTarget({ to: "same-name" })).toThrow(
				'Multiple pending asks match sender name "same-name"',
			);
		});

		test("`to` with an id prefix resolving uniquely works", () => {
			const tracker = new ReplyTracker(ASK_TIMEOUT_MS);
			record(tracker, child1, askMessage("ask-1"));
			record(tracker, child2, askMessage("ask-2"));
			const target = tracker.resolveReplyTarget({ to: "child-session-1" });
			expect(target.message.id).toBe("ask-1");
		});
	});

	describe("expiry", () => {
		test("expired asks are pruned and no longer resolve", () => {
			const tracker = new ReplyTracker(ASK_TIMEOUT_MS);
			const receivedAt = 1_000_000;
			record(tracker, child1, askMessage("ask-1"), receivedAt);
			expect(() => tracker.resolveReplyTarget({}, receivedAt + ASK_TIMEOUT_MS + 1)).toThrow(
				"No active intercom context to reply to",
			);
		});

		test("only the expired ask is pruned; the fresh one still resolves", () => {
			const tracker = new ReplyTracker(ASK_TIMEOUT_MS);
			const oldReceivedAt = 1_000_000;
			const freshReceivedAt = oldReceivedAt + 30_000;
			record(tracker, child1, askMessage("ask-old"), oldReceivedAt);
			record(tracker, child2, askMessage("ask-fresh"), freshReceivedAt);
			const target = tracker.resolveReplyTarget({}, oldReceivedAt + ASK_TIMEOUT_MS + 1);
			expect(target.message.id).toBe("ask-fresh");
		});

		test("listPending prunes expired asks", () => {
			const tracker = new ReplyTracker(ASK_TIMEOUT_MS);
			const receivedAt = 1_000_000;
			record(tracker, child1, askMessage("ask-1"), receivedAt);
			expect(tracker.listPending(receivedAt + ASK_TIMEOUT_MS + 1)).toHaveLength(0);
		});
	});

	describe("dismissPendingAsk and reset", () => {
		test("dismissing one of two pending asks leaves the other resolvable", () => {
			const tracker = new ReplyTracker(ASK_TIMEOUT_MS);
			record(tracker, child1, askMessage("ask-1"));
			record(tracker, child2, askMessage("ask-2"));
			tracker.dismissPendingAsk("ask-1");
			const target = tracker.resolveReplyTarget({});
			expect(target.message.id).toBe("ask-2");
		});

		test("dismissing the only pending ask makes implicit reply throw", () => {
			const tracker = new ReplyTracker(ASK_TIMEOUT_MS);
			record(tracker, child1, askMessage("ask-1"));
			tracker.dismissPendingAsk("ask-1");
			expect(() => tracker.resolveReplyTarget({})).toThrow("No active intercom context to reply to");
		});

		test("reset clears everything", () => {
			const tracker = new ReplyTracker(ASK_TIMEOUT_MS);
			record(tracker, child1, askMessage("ask-1"));
			tracker.reset();
			expect(tracker.listPending()).toHaveLength(0);
		});
	});

	describe("findUniquePendingAskFrom", () => {
		test("single matching ask from sender is returned", () => {
			const tracker = new ReplyTracker(ASK_TIMEOUT_MS);
			record(tracker, child1, askMessage("ask-1"));
			const found = tracker.findUniquePendingAskFrom(child1.id);
			expect(found?.message.id).toBe("ask-1");
		});

		test("two pending asks from the same sender return null (ambiguous)", () => {
			const tracker = new ReplyTracker(ASK_TIMEOUT_MS);
			record(tracker, child1, askMessage("ask-1"));
			record(tracker, child1, askMessage("ask-2"));
			expect(tracker.findUniquePendingAskFrom(child1.id)).toBeNull();
		});

		test("expired asks are excluded", () => {
			const tracker = new ReplyTracker(ASK_TIMEOUT_MS);
			const receivedAt = 1_000_000;
			record(tracker, child1, askMessage("ask-1"), receivedAt);
			expect(tracker.findUniquePendingAskFrom(child1.id, receivedAt + ASK_TIMEOUT_MS + 1)).toBeNull();
		});
	});
});
