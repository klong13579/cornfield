/**
 * Inbound delivery policy tests for the intercom extension.
 *
 * The concurrency contract (industry-documented failures: interrupt races,
 * cross-talk, silent turn-stealing):
 *   - busy sessions queue inbound messages as follow-ups by default; they must
 *     never abort in-flight tools, skip remaining tool calls, or walk over a
 *     blocking ask (inboundMode: "interrupt" is the explicit opt-in).
 *   - the reply hint always carries the explicit replyTo (correlation id).
 *   - non-interactive busy sessions queue as followUp (headless agents can
 *     collaborate via intercom instead of leaving ask-waiters to time out).
 */
import { describe, expect, test } from "bun:test";
import {
	buildInboundDeliveryOptions,
	buildReplyCommand,
	resolveInboundDeliveryMode,
} from "../../src/intercom-extension/index";
import type { Message } from "../../src/intercom-extension/types";

const askMessage = (id: string): Message => ({
	id,
	timestamp: Date.now(),
	content: { text: `ask ${id}` },
	expectsReply: true,
});

const plainMessage = (id: string): Message => ({
	id,
	timestamp: Date.now(),
	content: { text: `plain ${id}` },
});

describe("resolveInboundDeliveryMode", () => {
	test("idle always triggers a turn, even without UI", () => {
		expect(resolveInboundDeliveryMode({ isIdle: true, hasUI: false, inboundMode: "queue" })).toBe("trigger");
		expect(resolveInboundDeliveryMode({ isIdle: true, hasUI: true, inboundMode: "queue" })).toBe("trigger");
	});

	test("busy + UI + queue (default) queues as a follow-up, never interrupts", () => {
		expect(resolveInboundDeliveryMode({ isIdle: false, hasUI: true, inboundMode: "queue" })).toBe("followUp");
	});

	test("busy + UI + interrupt opt-in steers (legacy interrupting behavior)", () => {
		expect(resolveInboundDeliveryMode({ isIdle: false, hasUI: true, inboundMode: "interrupt" })).toBe("steer");
	});

	test("busy + no UI queues as followUp (headless agents can collaborate)", () => {
		expect(resolveInboundDeliveryMode({ isIdle: false, hasUI: false, inboundMode: "queue" })).toBe("followUp");
		expect(resolveInboundDeliveryMode({ isIdle: false, hasUI: false, inboundMode: "interrupt" })).toBe("followUp");
	});
});

describe("buildInboundDeliveryOptions", () => {
	test("trigger + policy wants turn → triggerTurn only", () => {
		expect(buildInboundDeliveryOptions("trigger", true)).toEqual({ triggerTurn: true });
	});

	test("trigger + policy does not want a turn → non-interrupting append", () => {
		expect(buildInboundDeliveryOptions("trigger", false)).toEqual({ deliverAs: "steer" });
	});

	test("followUp always queues with triggerTurn so an idle window still starts the turn", () => {
		expect(buildInboundDeliveryOptions("followUp", true)).toEqual({ deliverAs: "followUp", triggerTurn: true });
		expect(buildInboundDeliveryOptions("followUp", false)).toEqual({ deliverAs: "followUp", triggerTurn: true });
	});

	test("steer keeps the legacy interrupting delivery", () => {
		expect(buildInboundDeliveryOptions("steer", true)).toEqual({ deliverAs: "steer" });
	});
});

describe("buildReplyCommand", () => {
	test("expectsReply + replyHint → hint carries the explicit replyTo", () => {
		const command = buildReplyCommand(askMessage("msg-abc"), true);
		expect(command).toContain('replyTo: "msg-abc"');
		expect(command).toContain('action: "reply"');
	});

	test("no expectsReply → no hint", () => {
		expect(buildReplyCommand(plainMessage("msg-xyz"), true)).toBeUndefined();
	});

	test("replyHint disabled → no hint", () => {
		expect(buildReplyCommand(askMessage("msg-abc"), false)).toBeUndefined();
	});
});
