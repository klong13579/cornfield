/**
 * Contract test: DingTalk permission policy must not fail open.
 *
 * Contract: When dmPolicy is "allowlist" and allowedUsers is empty,
 * the channel MUST deny all DM messages. An empty allowlist means
 * "nobody is allowed", not "everybody is allowed".
 *
 * Same contract applies to groupPolicy with empty allowedGroups.
 *
 * This test exists because #checkPermission returned `true` when
 * the allowlist was empty, silently turning "allowlist" mode into
 * "open" mode.
 */
import { describe, expect, test } from "bun:test";
import { DingTalkChannel } from "../src/channels/dingtalk";
import type { DingTalkConfig, InboundMessage } from "../src/types";

function makeDM(userId: string): InboundMessage {
	return {
		userId,
		conversationId: "cid001",
		messageId: "msg001",
		isGroup: false,
		content: { type: "text", text: "hello" },
		raw: {},
		channel: "dingtalk",
		accountId: "__default__",
	};
}

function makeGroup(userId: string, conversationId: string): InboundMessage {
	return {
		userId,
		conversationId,
		messageId: "msg002",
		isGroup: true,
		content: { type: "text", text: "hello" },
		raw: {},
		channel: "dingtalk",
		accountId: "__default__",
	};
}

describe("DingTalk permission policy — fail-open fix", () => {
	test("DM allowlist with empty allowedUsers denies all", () => {
		const channel = new DingTalkChannel();
		channel.__testSetConfig({
			enabled: true,
			dmPolicy: "allowlist",
			allowedUsers: [],
		} as DingTalkConfig);

		// Bug: empty allowlist returned true (open). Fix: return false.
		expect(channel.__testCheckPermission(makeDM("user1"))).toBe(false);
	});

	test("DM allowlist with no allowedUsers field denies all", () => {
		const channel = new DingTalkChannel();
		channel.__testSetConfig({
			enabled: true,
			dmPolicy: "allowlist",
		} as DingTalkConfig);

		expect(channel.__testCheckPermission(makeDM("user1"))).toBe(false);
	});

	test("DM allowlist with populated allowedUsers allows listed user", () => {
		const channel = new DingTalkChannel();
		channel.__testSetConfig({
			enabled: true,
			dmPolicy: "allowlist",
			allowedUsers: ["user1", "user2"],
		} as DingTalkConfig);

		expect(channel.__testCheckPermission(makeDM("user1"))).toBe(true);
	});

	test("DM allowlist with populated allowedUsers denies unlisted user", () => {
		const channel = new DingTalkChannel();
		channel.__testSetConfig({
			enabled: true,
			dmPolicy: "allowlist",
			allowedUsers: ["user1"],
		} as DingTalkConfig);

		expect(channel.__testCheckPermission(makeDM("attacker"))).toBe(false);
	});

	test("group allowlist with empty allowedGroups denies all", () => {
		const channel = new DingTalkChannel();
		channel.__testSetConfig({
			enabled: true,
			groupPolicy: "allowlist",
			allowedGroups: [],
		} as DingTalkConfig);

		expect(channel.__testCheckPermission(makeGroup("user1", "grp001"))).toBe(false);
	});

	test("group allowlist with no allowedGroups field denies all", () => {
		const channel = new DingTalkChannel();
		channel.__testSetConfig({
			enabled: true,
			groupPolicy: "allowlist",
		} as DingTalkConfig);

		expect(channel.__testCheckPermission(makeGroup("user1", "grp001"))).toBe(false);
	});

	test("DM open policy allows all", () => {
		const channel = new DingTalkChannel();
		channel.__testSetConfig({
			enabled: true,
			dmPolicy: "open",
		} as DingTalkConfig);

		expect(channel.__testCheckPermission(makeDM("anyone"))).toBe(true);
	});

	test("DM closed policy denies all", () => {
		const channel = new DingTalkChannel();
		channel.__testSetConfig({
			enabled: true,
			dmPolicy: "closed",
		} as DingTalkConfig);

		expect(channel.__testCheckPermission(makeDM("anyone"))).toBe(false);
	});
});
