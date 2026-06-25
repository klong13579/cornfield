/**
 * Card action callback integration test.
 *
 * The DingTalk channel's TOPIC_CARD listener parses a `DWClientDownStream`
 * frame and forwards it to the installed `#cardActionHandler`. Tests
 * pin the parsing path (outTrackId, content.cardPrivateData, actionIds,
 * params, userId, corpId) and the error paths (no handler installed,
 * non-JSON body, missing fields).
 *
 * We can't drive the full Stream SDK in a unit test, so we go through
 * the public `setCardActionHandler` and then directly invoke
 * `#handleCardCallback` (accessible via a test seam that wraps the
 * Stream SDK frame). The channel's `setConfig` test seam lets us
 * skip the WebSocket connect step.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { DingTalkChannel, type DingTalkCardActionEvent } from "../src/channels/dingtalk";
import type { DingTalkConfig } from "../src/types";

/** Subset of the Stream SDK's DWClientDownStream the channel reads. */
interface CardCallbackFrame {
	headers?: { messageId?: string };
	data: string;
}

const HR_CONFIG: DingTalkConfig = {
	enabled: true,
	appKey: "ding8yvoithqnrrz0kz5",
	appSecret: "secret",
	robotCode: "ding8yvoithqnrrz0kz5",
};

describe("DingTalkChannel card action callback", () => {
	let channel: DingTalkChannel;
	let received: DingTalkCardActionEvent[];

	beforeEach(() => {
		channel = new DingTalkChannel();
		channel.setAccountId("hr");
		channel.setConfig(HR_CONFIG);
		received = [];
		channel.setCardActionHandler(async event => {
			received.push(event);
		});
	});

	test("parses a well-formed action callback frame", async () => {
		const frame: CardCallbackFrame = {
			headers: { messageId: "msg-1" },
			data: JSON.stringify({
				type: "actionCallback",
				outTrackId: "card_123",
				corpId: "dingcorp1",
				userId: "user-1",
				content: JSON.stringify({
					cardPrivateData: {
						actionIds: ["1"],
						params: { type: "stop", sessionId: "sess-1", toolName: "bash" },
					},
				}),
			}),
		};
		// Bypass the private method by casting through unknown — the
		// channel is a class instance and TypeScript's private keyword
		// is a soft check at runtime.
		await channel.__testHandleCardCallback(frame);

		expect(received).toHaveLength(1);
		const ev = received[0]!;
		expect(ev.cardInstanceId).toBe("card_123");
		expect(ev.userId).toBe("user-1");
		expect(ev.corpId).toBe("dingcorp1");
		expect(ev.actionIds).toEqual(["1"]);
		expect(ev.params).toEqual({ type: "stop", sessionId: "sess-1", toolName: "bash" });
	});

	test("parses when `data` is a JSON string of the body (SDK may wrap)", async () => {
		const frame: CardCallbackFrame = {
			data: JSON.stringify({
				outTrackId: "card_xyz",
				corpId: "dingcorp2",
				userId: "user-2",
				content: JSON.stringify({
					cardPrivateData: { actionIds: ["stop-btn"], params: { type: "stop" } },
				}),
			}),
		};
		await channel.__testHandleCardCallback(frame);
		expect(received).toHaveLength(1);
		expect(received[0]?.cardInstanceId).toBe("card_xyz");
		expect(received[0]?.actionIds).toEqual(["stop-btn"]);
		expect(received[0]?.params.type).toBe("stop");
	});

	test("parses the OpenClaw 675cde2f schema's btn_stop click shape", async () => {
		// The schema's static top-right "中止" button fires a
		// dtActionSheet -> dtSendOutData callback that lands here as
		// `actionIds: ["btn_stop"]` with `params: {action: "true"}`
		// (no `type` field). `Gateway.#handleCardAction` recognises
		// this shape as a stop action even without `params.type`,
		// so the channel MUST surface both fields correctly to the
		// installed handler.
		const frame: CardCallbackFrame = {
			headers: { messageId: "msg-btn-stop" },
			data: JSON.stringify({
				type: "actionCallback",
				outTrackId: "card_openclaw",
				corpId: "ding2ed7bb2061fa510a",
				userIdType: 1,
				userId: "601590212",
				spaceType: "im",
				spaceId: "cidz1b3B6/01GDW+OQU/6RjiWbhu83I6Vlr6WJkl06VJDo=",
				content: JSON.stringify({
					cardPrivateData: {
						actionIds: ["btn_stop"],
						params: { action: "true" },
					},
				}),
			}),
		};
		await channel.__testHandleCardCallback(frame);
		expect(received).toHaveLength(1);
		const ev = received[0]!;
		expect(ev.cardInstanceId).toBe("card_openclaw");
		expect(ev.actionIds).toEqual(["btn_stop"]);
		// Note: no `type` field — the handler must check `actionIds`
		expect(ev.params.type).toBeUndefined();
		expect(ev.params.action).toBe("true");
	});

	test("silently drops the callback if no handler is installed", async () => {
		// New channel without a handler
		const ch2 = new DingTalkChannel();
		ch2.setConfig(HR_CONFIG);
		const frame: CardCallbackFrame = {
			data: JSON.stringify({
				outTrackId: "card_1",
				content: JSON.stringify({ cardPrivateData: { actionIds: [], params: {} } }),
			}),
		};
		// Should not throw
		await ch2.__testHandleCardCallback(frame);
		// Nothing to assert besides the absence of an exception
	});

	test("ignores non-JSON body and does not invoke the handler", async () => {
		const frame: CardCallbackFrame = { data: "not json" };
		await channel.__testHandleCardCallback(frame);
		expect(received).toHaveLength(0);
	});

	test("ignores body missing outTrackId and does not invoke the handler", async () => {
		const frame: CardCallbackFrame = {
			data: JSON.stringify({ content: JSON.stringify({ cardPrivateData: {} }) }),
		};
		await channel.__testHandleCardCallback(frame);
		expect(received).toHaveLength(0);
	});

	test("ignores body missing content and does not invoke the handler", async () => {
		const frame: CardCallbackFrame = { data: JSON.stringify({ outTrackId: "card_1" }) };
		await channel.__testHandleCardCallback(frame);
		expect(received).toHaveLength(0);
	});

	test("handles missing cardPrivateData gracefully (empty actionIds / params)", async () => {
		const frame: CardCallbackFrame = {
			data: JSON.stringify({
				outTrackId: "card_1",
				userId: "u",
				corpId: "c",
				content: JSON.stringify({}),
			}),
		};
		await channel.__testHandleCardCallback(frame);
		expect(received).toHaveLength(1);
		expect(received[0]?.actionIds).toEqual([]);
		expect(received[0]?.params).toEqual({});
	});

	test("handler exceptions are caught and logged (not propagated)", async () => {
		channel.setCardActionHandler(async () => {
			throw new Error("synthetic handler error");
		});
		const frame: CardCallbackFrame = {
			data: JSON.stringify({
				outTrackId: "card_1",
				userId: "u",
				corpId: "c",
				content: JSON.stringify({ cardPrivateData: { actionIds: ["1"], params: {} } }),
			}),
		};
		// Should not throw — the channel swallows the handler error
		await channel.__testHandleCardCallback(frame);
	});
});
