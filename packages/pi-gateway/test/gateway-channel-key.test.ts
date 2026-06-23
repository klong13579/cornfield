/**
 * Regression test for the multi-account channel-lookup bug.
 *
 * Symptom (pre-fix): `#registry.getChannel(msg.channelId)` was called
 * in `handleInbound` even though `ChannelRegistry` exposes `get(id)`,
 * not `getChannel(id)`. The call site also passed only `msg.channelId`
 * (e.g. `dingtalk`) instead of the multi-account key (`dingtalk:hr`).
 * Both the v1 markdown fallback path and the v2 AI Card path looked up
 * the wrong entry, and the second site threw `getChannel is not a
 * function` on every inbound.
 *
 * The fix introduces `buildChannelKey(channelId, accountId?)` and uses
 * it at both sites. This test pins the helper's contract.
 */
import { describe, expect, test } from "bun:test";
import { buildChannelKey } from "../src/gateway";

describe("buildChannelKey", () => {
	test("returns just channelId when accountId is undefined (single-account mode)", () => {
		expect(buildChannelKey("dingtalk")).toBe("dingtalk");
		expect(buildChannelKey("dingtalk", undefined)).toBe("dingtalk");
	});

	test("joins channelId and accountId with ':' for multi-account mode", () => {
		expect(buildChannelKey("dingtalk", "hr")).toBe("dingtalk:hr");
		expect(buildChannelKey("dingtalk", "opencode")).toBe("dingtalk:opencode");
	});

	test("treats empty string accountId as single-account (matches registry.register behavior)", () => {
		// ChannelRegistry.register with no explicit `key` uses `channel.id`
		// (no `:` suffix). The inbound parseRobotMessage sets `accountId`
		// from `this.#accountId`, which is set via setAccountId at register
		// time — single-account mode leaves it undefined. The helper treats
		// empty string the same as undefined (truthy check) and returns
		// just the channelId.
		expect(buildChannelKey("dingtalk", "")).toBe("dingtalk");
	});
});
