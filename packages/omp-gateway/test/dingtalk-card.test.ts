/**
 * DingTalk card — block builders + action callback parsing + finish-retry.
 *
 * Merged:
 *   - dingtalk-card-blocks.test.ts       (schema + builders)
 *   - dingtalk-card-action.test.ts       (action callback parsing)
 *   - dingtalk-card-finish-retry.test.ts (transient-failure retry)
 *
 * The full e2e card streaming test (dingtalk-card-e2e) stays separate
 * because it needs a live card server + AgentBridge.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { type DingTalkCardActionEvent, DingTalkChannel } from "../src/channels/dingtalk";
import {
	BlockType,
	buildAnswerBlock,
	buildImageBlock,
	buildStopBlock,
	buildThinkBlock,
	buildToolBlock,
	cardParamMapForStreamStart,
	cardParamMapFromData,
	finishAICard,
	patchAICardBlocks,
	parseDingtalkError,
	scheduleDeferredFinishAICard,
} from "../src/channels/dingtalk-card";
import type { DingTalkConfig } from "../src/types";

// ═══════════════════════════════════════════════════════════════════════
// Block builders
// ═══════════════════════════════════════════════════════════════════════

describe("buildAnswerBlock", () => {
	test("wraps raw text in a type-0 block with normalized markdown", () => {
		const block = buildAnswerBlock("Hello world");
		expect(block.type).toBe(0);
		expect(block.text).toBe("Hello world");
		expect(block.markdown).toBe("Hello world");
	});

	test("preserves multi-line content", () => {
		const block = buildAnswerBlock("line 1\nline 2\n\nline 3");
		expect(block.markdown).toContain("line 1");
		expect(block.markdown).toContain("line 3");
	});
});

describe("buildThinkBlock", () => {
	test("wraps thinking text in a type-1 block with gray font tag", () => {
		const block = buildThinkBlock("Reasoning step");
		expect(block.type).toBe(1);
		expect(block.text).toBe("Reasoning step");
		expect(block.markdown).toContain("common_level2_base_color");
		expect(block.markdown).toContain("Reasoning step");
	});

	test("trims surrounding whitespace", () => {
		const block = buildThinkBlock("  think  \n");
		expect(block.text).toBe("think");
	});
});

describe("buildToolBlock", () => {
	test("emits emoji <name>(<args>) prefix and gray font tag, no result text", () => {
		const block = buildToolBlock({ name: "read", args: { path: "/tmp/x" } }, "file contents", false);
		expect(block.type).toBe(2);
		expect(block.text).toContain("📄 read");
		expect(block.text).not.toContain("file contents");
		expect(block.markdown).toContain("common_level2_base_color");
	});

	test("flags isError in the prefix", () => {
		const block = buildToolBlock({ name: "bash", args: "rm -rf /" }, "", true);
		expect(block.text).toContain("— error");
		expect(block.text).toContain("⚙️ bash(rm -rf /)");
	});

	test("truncates long args preview to 60 chars", () => {
		const longArgs = "x".repeat(200);
		const block = buildToolBlock({ name: "echo", args: longArgs }, "out", false);
		expect(block.text).toContain("…");
		expect(block.text.length).toBeLessThan(200);
	});
});

describe("buildImageBlock", () => {
	test("emits type-3 block with mediaId and caption", () => {
		const block = buildImageBlock("@lALPDfmVR_test", "my screenshot");
		expect(block.type).toBe(3);
		expect(block.mediaId).toBe("@lALPDfmVR_test");
		expect(block.text).toBe("my screenshot");
	});

	test("handles empty caption", () => {
		const block = buildImageBlock("@lALPDfmVR_test", "");
		expect(block.type).toBe(3);
		expect(block.mediaId).toBe("@lALPDfmVR_test");
	});
});

describe("buildStopBlock", () => {
	test("emits type-4 block with a single call_back stop button (Stream mode)", () => {
		const block = buildStopBlock({
			toolName: "bash",
			elapsedMs: 240_000,
			sessionId: "sess-123",
		});
		expect(block.type).toBe(BlockType.STOP);
		expect(block.type).toBe(4);
		expect(block.btns).toBeDefined();
		expect(block.btns).toHaveLength(1);
		const btn = block.btns?.[0];
		expect(btn?.text).toBe("停止");
		expect(btn?.actionType).toBe("call_back");
		expect(btn?.requestPath).toBeUndefined();
		expect(btn?.params).toEqual({
			type: "stop",
			sessionId: "sess-123",
			toolName: "bash",
		});
		expect(block.text).toContain("bash");
		expect(block.text).toContain("4");
	});

	test("accepts a custom button text", () => {
		const block = buildStopBlock({
			toolName: "browser",
			elapsedMs: 60_000,
			requestPath: "/dingtalk/action",
			sessionId: "sess-1",
			buttonText: "中止任务",
		});
		expect(block.btns?.[0]?.text).toBe("中止任务");
	});

	test("rounds elapsed time down to whole minutes", () => {
		const block = buildStopBlock({
			toolName: "bash",
			elapsedMs: 4 * 60_000 + 30_000,
			requestPath: "/dingtalk/action",
			sessionId: "sess-1",
		});
		expect(block.text).toContain("4");
	});
});

describe("CardBlock btns serialization", () => {
	test("cardParamMapFromData preserves btns inside blockList", () => {
		const blockList = [
			{
				type: BlockType.STOP,
				text: "long tool",
				markdown: "long tool",
				btns: [{ text: "停止", actionType: "request" as const, requestPath: "/dingtalk/action" }],
			},
		];
		const map = cardParamMapFromData(
			{ content: "", blockList, quoteContent: "", statusLine: "", copyContent: "", hasAction: true, version: 1 },
			"3",
		);
		const parsed = JSON.parse(map.blockList);
		expect(parsed).toHaveLength(1);
		expect(parsed[0].btns).toEqual([{ text: "停止", actionType: "request", requestPath: "/dingtalk/action" }]);
		expect(JSON.parse(map.hasAction)).toBe(true);
	});
});

describe("cardParamMapFromData", () => {
	test("serializes all v3 schema fields", () => {
		const map = cardParamMapFromData(
			{
				content: "answer text",
				blockList: [{ type: 0, text: "answer text", markdown: "answer text" }],
				quoteContent: "triggering message",
				statusLine: "model · agent",
				copyContent: "answer text",
				hasAction: false,
				version: 1,
			},
			"3",
		);
		expect(map.flowStatus).toBe("3");
		expect(map.content).toBe("answer text");
		expect(map.quoteContent).toBe("triggering message");
		expect(map.statusLine).toBe("model · agent");
		expect(map.copy_content).toBe("answer text");
		expect(JSON.parse(map.blockList)).toEqual([{ type: 0, text: "answer text", markdown: "answer text" }]);
		expect(JSON.parse(map.hasAction)).toBe(false);
		expect(JSON.parse(map.version)).toBe(1);
	});

	test("defaults all fields when data is empty", () => {
		const map = cardParamMapFromData({}, "1");
		expect(map.flowStatus).toBe("1");
		expect(map.content).toBe("");
		expect(JSON.parse(map.blockList)).toEqual([]);
		expect(map.quoteContent).toBe("");
		expect(map.statusLine).toBe("");
	});
});

describe("cardParamMapForStreamStart", () => {
	test("uses INPUTING status and includes content + blockList", () => {
		const map = cardParamMapForStreamStart("hello", [{ type: 0, text: "hello", markdown: "hello" }]);
		expect(map.flowStatus).toBe("2");
		expect(map.content).toBe("hello");
		expect(JSON.parse(map.blockList)).toEqual([{ type: 0, text: "hello", markdown: "hello" }]);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// parseDingtalkError
//
// Bug fix: DingTalk returns HTTP 200 with body `{"code":"system.busy",...}`
// to signal failure. The previous code only checked `resp.ok` and silently
// dropped these — the 7-10 long-task run showed 3 patchAICardBlocks
// events with zero error logs, leaving the user seeing streamed text but
// no blockList updates. parseDingtalkError extracts the error code so
// each card API call can treat 200+error-body as a logical failure.
// ═══════════════════════════════════════════════════════════════════════

describe("parseDingtalkError", () => {
	test("returns parsed error for a body with a non-ok code", () => {
		const err = parseDingtalkError('{"code":"system.busy","message":"system.busy","requestid":"abc-123"}');
		expect(err).toEqual({ code: "system.busy", message: "system.busy", requestid: "abc-123" });
	});

	test("returns parsed error for QpsLimit body", () => {
		const err = parseDingtalkError('{"code":"QpsLimit.exceeded","message":"too many requests"}');
		expect(err?.code).toBe("QpsLimit.exceeded");
		expect(err?.message).toBe("too many requests");
		expect(err?.requestid).toBeUndefined();
	});

	test("treats code 'ok' as success (returns null)", () => {
		expect(parseDingtalkError('{"code":"ok","message":"","data":{}}')).toBeNull();
	});

	test("treats code '0' as success (returns null)", () => {
		expect(parseDingtalkError('{"code":"0","message":"success"}')).toBeNull();
	});

	test("treats empty object as success (returns null)", () => {
		expect(parseDingtalkError("{}")).toBeNull();
	});

	test("treats non-JSON body as success (returns null)", () => {
		// Card streaming/patch success bodies are sometimes plain text or
		// empty. A non-JSON body must not be flagged as an error.
		expect(parseDingtalkError("")).toBeNull();
		expect(parseDingtalkError("ok")).toBeNull();
		expect(parseDingtalkError("<html>...</html>")).toBeNull();
	});

	test("handles missing message/requestid fields gracefully", () => {
		const err = parseDingtalkError('{"code":"invalid.param"}');
		expect(err).toEqual({ code: "invalid.param", message: "", requestid: undefined });
	});

	test("rejects non-object JSON (array, string, number)", () => {
		expect(parseDingtalkError('"system.busy"')).toBeNull();
		expect(parseDingtalkError("123")).toBeNull();
		expect(parseDingtalkError('["system.busy"]')).toBeNull();
	});
});

// ═══════════════════════════════════════════════════════════════════════
// patchAICardBlocks body-code handling
//
// Regression for the 7-10 long-task run: patchAICardBlocks was called
// 3 times, all 3 returned HTTP 200 with `{"code":"system.busy",...}` and
// the user saw the streamed text but none of the blockList patches. The
// new behavior must log a warn (so the failure is visible in service.log)
// but not throw — the next patch tick or the eventual finishAICard will
// recover, and the bridge's per-card catch handles unrecoverable cases.
// ═══════════════════════════════════════════════════════════════════════

describe("patchAICardBlocks body-code handling", () => {
	let realFetch: typeof globalThis.fetch;
	let restoreFetch: (() => void) | undefined;

	beforeEach(() => {
		realFetch = globalThis.fetch;
	});

	afterEach(() => {
		if (restoreFetch) restoreFetch();
		globalThis.fetch = realFetch;
	});

	async function installFetchRewrite(host: string, port: number) {
		const base = `http://${host}:${port}`;
		globalThis.fetch = ((input: any, init?: any) => {
			const url = typeof input === "string" ? input : input.url;
			if (url.startsWith("https://api.dingtalk.com/")) {
				const rewritten = base + url.slice("https://api.dingtalk.com".length);
				return realFetch(rewritten, init);
			}
			return realFetch(input, init);
		}) as typeof globalThis.fetch;
		restoreFetch = () => {
			globalThis.fetch = realFetch;
		};
	}

	const SAMPLE_CARD: any = {
		cardInstanceId: "card_patch_test",
		accessToken: "test-token",
		inputingStarted: true,
	};

	test("silently succeeds on HTTP 200 with empty body (no code field)", async () => {
		let callCount = 0;
		const fakeServer = await startRetryCardServer(call => {
			if (call.path === "/v1.0/card/instances" && call.method === "PUT") {
				callCount++;
				return new Response("{}", { headers: { "Content-Type": "application/json" } });
			}
			return new Response("not found", { status: 404 });
		});
		await installFetchRewrite(fakeServer.host, fakeServer.port);

		// Must not throw.
		await patchAICardBlocks(SAMPLE_CARD, { content: "x", blockList: [] });
		expect(callCount).toBe(1);
		fakeServer.stop();
	});

	test("does not throw on HTTP 200 with system.busy body (the regression)", async () => {
		// This is the exact failure mode that hid 3 patches on 7-10.
		// The new behavior logs a warn but does NOT throw, because the
		// channel's outer catch handles the per-card path. We only
		// assert here that the function returns (no throw) and that
		// the request still went out (so subsequent patches can be sent).
		const fakeServer = await startRetryCardServer(call => {
			if (call.path === "/v1.0/card/instances" && call.method === "PUT") {
				return new Response('{"code":"system.busy","message":"system.busy","requestid":"r-1"}', {
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response("not found", { status: 404 });
		});
		await installFetchRewrite(fakeServer.host, fakeServer.port);

		// The function must NOT throw — the bridge relies on the
		// per-card swallow so a single failed patch doesn't kill the
		// whole turn. A 200+system.busy is logged as warn but absorbed.
		await expect(patchAICardBlocks(SAMPLE_CARD, { content: "x", blockList: [] })).resolves.toBeUndefined();
		fakeServer.stop();
	});

	test("still warns on plain HTTP 500 (regression for the !resp.ok path)", async () => {
		const fakeServer = await startRetryCardServer(call => {
			if (call.path === "/v1.0/card/instances" && call.method === "PUT") {
				return new Response('{"code":"system.busy"}', { status: 500 });
			}
			return new Response("not found", { status: 404 });
		});
		await installFetchRewrite(fakeServer.host, fakeServer.port);

		await expect(patchAICardBlocks(SAMPLE_CARD, { content: "x", blockList: [] })).resolves.toBeUndefined();
		fakeServer.stop();
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Card action callback
// ═══════════════════════════════════════════════════════════════════════

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
		expect(ev.params.type).toBeUndefined();
		expect(ev.params.action).toBe("true");
	});

	test("silently drops the callback if no handler is installed", async () => {
		const ch2 = new DingTalkChannel();
		ch2.setConfig(HR_CONFIG);
		const frame: CardCallbackFrame = {
			data: JSON.stringify({
				outTrackId: "card_1",
				content: JSON.stringify({ cardPrivateData: { actionIds: [], params: {} } }),
			}),
		};
		await ch2.__testHandleCardCallback(frame);
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
		await channel.__testHandleCardCallback(frame);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// finishAICard retry behavior
//
// Bug fix: finishAICard used to give up on the first 500 response,
// leaving the user's card stuck in INPUTING with a spinner. We now
// retry transient failures (5xx, 429) up to 5 times; 4xx is still
// thrown immediately. Callers may schedule a deferred FINISHED retry
// after sync exhaustion — never re-run the agent for status-only fails.
// ═══════════════════════════════════════════════════════════════════════

interface RetryCardCall {
	path: string;
	method: string;
	body: any;
}

function startRetryCardServer(
	handler: (call: RetryCardCall, callIndex: number) => Response,
): Promise<{
	host: string;
	port: number;
	calls: RetryCardCall[];
	stop: () => void;
}> {
	const calls: RetryCardCall[] = [];
	const server = Bun.serve({
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			const body = req.method === "GET" ? null : await req.json().catch(() => null);
			const call: RetryCardCall = { path: url.pathname, method: req.method, body };
			calls.push(call);
			if (url.pathname === "/v1.0/oauth2/accessToken") {
				return new Response(JSON.stringify({ accessToken: "test-token", expireIn: 7200 }), {
					headers: { "Content-Type": "application/json" },
				});
			}
			return handler(call, calls.length - 1);
		},
	});
	return Promise.resolve({
		host: server.hostname,
		port: server.port,
		calls,
		stop: () => server.stop(true),
	});
}

function makeRetryConfig(_cardServerPort: number): DingTalkConfig {
	return {
		enabled: true,
		appKey: "test-key",
		appSecret: "test-secret",
		robotCode: "test-robot",
	};
}

const RETRY_SAMPLE_CARD_DATA: any = {
	content: "test answer",
	blockList: [],
	quoteContent: "",
	statusLine: "",
	copyContent: "test answer",
	hasAction: false,
	version: 1,
};

const RETRY_SAMPLE_CARD: any = {
	cardInstanceId: "card_test",
	accessToken: "test-token",
	inputingStarted: true,
};

describe("finishAICard retry behavior", () => {
	let realFetch: typeof globalThis.fetch;
	let restoreFetch: (() => void) | undefined;
	let fakeServer: Awaited<ReturnType<typeof startRetryCardServer>>;
	let sleepSpy: ReturnType<typeof spyOn> | undefined;

	beforeEach(() => {
		realFetch = globalThis.fetch;
		// Production backoff is 1s→2s→4s→8s; collapse sleeps so unit tests stay fast.
		sleepSpy = spyOn(Bun, "sleep").mockResolvedValue(undefined as never);
	});

	afterEach(() => {
		if (restoreFetch) restoreFetch();
		globalThis.fetch = realFetch;
		sleepSpy?.mockRestore();
		fakeServer?.stop();
	});

	async function installFetchRewrite(host: string, port: number) {
		const base = `http://${host}:${port}`;
		globalThis.fetch = ((input: any, init?: any) => {
			const url = typeof input === "string" ? input : input.url;
			if (url.startsWith("https://api.dingtalk.com/")) {
				const rewritten = base + url.slice("https://api.dingtalk.com".length);
				return realFetch(rewritten, init);
			}
			return realFetch(input, init);
		}) as typeof globalThis.fetch;
		restoreFetch = () => {
			globalThis.fetch = realFetch;
		};
	}

	test("retries on 500 system.busy and eventually succeeds", async () => {
		let attempt = 0;
		fakeServer = await startRetryCardServer(call => {
			if (call.path === "/v1.0/card/streaming") {
				return new Response(JSON.stringify({}), {
					headers: { "Content-Type": "application/json" },
				});
			}
			if (call.path === "/v1.0/card/instances" && call.method === "PUT") {
				attempt++;
				if (attempt <= 2) {
					return new Response('{"code":"system.busy","message":"system.busy"}', {
						status: 500,
						headers: { "Content-Type": "application/json" },
					});
				}
				return new Response(JSON.stringify({}), {
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response("not found", { status: 404 });
		});
		await installFetchRewrite(fakeServer.host, fakeServer.port);

		await finishAICard(RETRY_SAMPLE_CARD, RETRY_SAMPLE_CARD_DATA, makeRetryConfig(fakeServer.port));

		const finishedCalls = fakeServer.calls.filter(c => c.path === "/v1.0/card/instances" && c.method === "PUT");
		expect(finishedCalls.length).toBe(3);
	});

	test("throws after max retries when 500 persists, so bridge fallback fires", async () => {
		fakeServer = await startRetryCardServer(call => {
			if (call.path === "/v1.0/card/streaming") {
				return new Response(JSON.stringify({}), {
					headers: { "Content-Type": "application/json" },
				});
			}
			if (call.path === "/v1.0/card/instances" && call.method === "PUT") {
				return new Response('{"code":"system.busy"}', { status: 500 });
			}
			return new Response("not found", { status: 404 });
		});
		await installFetchRewrite(fakeServer.host, fakeServer.port);

		await expect(
			finishAICard(RETRY_SAMPLE_CARD, RETRY_SAMPLE_CARD_DATA, makeRetryConfig(fakeServer.port)),
		).rejects.toThrow(/FINISHED update failed after 5 retries/);

		const finishedCalls = fakeServer.calls.filter(c => c.path === "/v1.0/card/instances" && c.method === "PUT");
		expect(finishedCalls.length).toBe(5);
	});

	test("throws immediately on non-retryable 4xx (no retries)", async () => {
		fakeServer = await startRetryCardServer(call => {
			if (call.path === "/v1.0/card/streaming") {
				return new Response(JSON.stringify({}), {
					headers: { "Content-Type": "application/json" },
				});
			}
			if (call.path === "/v1.0/card/instances" && call.method === "PUT") {
				return new Response('{"code":"invalid.param"}', { status: 400 });
			}
			return new Response("not found", { status: 404 });
		});
		await installFetchRewrite(fakeServer.host, fakeServer.port);

		await expect(
			finishAICard(RETRY_SAMPLE_CARD, RETRY_SAMPLE_CARD_DATA, makeRetryConfig(fakeServer.port)),
		).rejects.toThrow(/FINISHED non-retryable failure: status=400/);

		const finishedCalls = fakeServer.calls.filter(c => c.path === "/v1.0/card/instances" && c.method === "PUT");
		expect(finishedCalls.length).toBe(1);
	});

	test("retries on 429 too many requests", async () => {
		let attempt = 0;
		fakeServer = await startRetryCardServer(call => {
			if (call.path === "/v1.0/card/streaming") {
				return new Response(JSON.stringify({}), {
					headers: { "Content-Type": "application/json" },
				});
			}
			if (call.path === "/v1.0/card/instances" && call.method === "PUT") {
				attempt++;
				if (attempt === 1) {
					return new Response('{"code":"throttled"}', { status: 429 });
				}
				return new Response(JSON.stringify({}), {
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response("not found", { status: 404 });
		});
		await installFetchRewrite(fakeServer.host, fakeServer.port);

		await finishAICard(RETRY_SAMPLE_CARD, RETRY_SAMPLE_CARD_DATA, makeRetryConfig(fakeServer.port));

		const finishedCalls = fakeServer.calls.filter(c => c.path === "/v1.0/card/instances" && c.method === "PUT");
		expect(finishedCalls.length).toBe(2);
	});

	// Body-code regression: 7-10 long-task run. DingTalk returns HTTP 200
	// with `{"code":"system.busy",...}` to signal failure; the previous
	// code treated 200 as success and the card got stuck in INPUTING.
	// Now body-code errors are treated as transient and routed through
	// the same retry/backoff path as a 5xx. Callers may then schedule a
	// deferred FINISHED retry; they must not re-enqueue the agent prompt.
	test("retries on HTTP 200 with system.busy body, then succeeds", async () => {
		let attempt = 0;
		fakeServer = await startRetryCardServer(call => {
			if (call.path === "/v1.0/card/streaming") {
				return new Response(JSON.stringify({}), {
					headers: { "Content-Type": "application/json" },
				});
			}
			if (call.path === "/v1.0/card/instances" && call.method === "PUT") {
				attempt++;
				if (attempt <= 2) {
					return new Response('{"code":"system.busy","message":"system.busy","requestid":"r-1"}', {
						headers: { "Content-Type": "application/json" },
					});
				}
				return new Response(JSON.stringify({}), {
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response("not found", { status: 404 });
		});
		await installFetchRewrite(fakeServer.host, fakeServer.port);

		await finishAICard(RETRY_SAMPLE_CARD, RETRY_SAMPLE_CARD_DATA, makeRetryConfig(fakeServer.port));

		const finishedCalls = fakeServer.calls.filter(c => c.path === "/v1.0/card/instances" && c.method === "PUT");
		expect(finishedCalls.length).toBe(3);
	});

	test("throws after max retries when HTTP 200 body-code error persists, so bridge fallback fires", async () => {
		fakeServer = await startRetryCardServer(call => {
			if (call.path === "/v1.0/card/streaming") {
				return new Response(JSON.stringify({}), {
					headers: { "Content-Type": "application/json" },
				});
			}
			if (call.path === "/v1.0/card/instances" && call.method === "PUT") {
				return new Response('{"code":"system.busy","message":"system.busy"}', {
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response("not found", { status: 404 });
		});
		await installFetchRewrite(fakeServer.host, fakeServer.port);

		await expect(
			finishAICard(RETRY_SAMPLE_CARD, RETRY_SAMPLE_CARD_DATA, makeRetryConfig(fakeServer.port)),
		).rejects.toThrow(/FINISHED update failed after 5 retries: status=200 body=/);

		const finishedCalls = fakeServer.calls.filter(c => c.path === "/v1.0/card/instances" && c.method === "PUT");
		expect(finishedCalls.length).toBe(5);
	});

	test("scheduleDeferredFinishAICard retries FINISHED after delay without throwing to caller", async () => {
		let attempt = 0;
		fakeServer = await startRetryCardServer(call => {
			if (call.path === "/v1.0/card/streaming") {
				return new Response(JSON.stringify({}), {
					headers: { "Content-Type": "application/json" },
				});
			}
			if (call.path === "/v1.0/card/instances" && call.method === "PUT") {
				attempt++;
				if (attempt === 1) {
					return new Response('{"code":"system.busy"}', { status: 500 });
				}
				return new Response(JSON.stringify({}), {
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response("not found", { status: 404 });
		});
		await installFetchRewrite(fakeServer.host, fakeServer.port);

		scheduleDeferredFinishAICard(
			RETRY_SAMPLE_CARD,
			RETRY_SAMPLE_CARD_DATA,
			makeRetryConfig(fakeServer.port),
			0,
		);
		// Wall-clock wait — Bun.sleep is mocked in this describe; setTimeout is not.
		await new Promise<void>(resolve => setTimeout(resolve, 50));

		const finishedCalls = fakeServer.calls.filter(c => c.path === "/v1.0/card/instances" && c.method === "PUT");
		expect(finishedCalls.length).toBeGreaterThanOrEqual(2);
		expect(attempt).toBeGreaterThanOrEqual(2);
	});
});
