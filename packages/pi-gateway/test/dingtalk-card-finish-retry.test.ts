/**
 * Tests for finishAICard retry behavior on transient DingTalk failures
 * (e.g. HTTP 500 system.busy that previously left the card stuck in
 * INPUTING and the user staring at a spinner).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { finishAICard } from "../src/channels/dingtalk-card";
import type { DingTalkConfig } from "../src/types";

interface RecordedCall {
	path: string;
	method: string;
	body: any;
}

function startFakeCardServer(handler: (call: RecordedCall, callIndex: number) => Response): Promise<{
	host: string;
	port: number;
	calls: RecordedCall[];
	stop: () => void;
}> {
	const calls: RecordedCall[] = [];
	const server = Bun.serve({
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			const body = req.method === "GET" ? null : await req.json().catch(() => null);
			const call: RecordedCall = { path: url.pathname, method: req.method, body };
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

function makeConfig(cardServerPort: number): DingTalkConfig {
	return {
		enabled: true,
		appKey: "test-key",
		appSecret: "test-secret",
		robotCode: "test-robot",
	};
}

const SAMPLE_CARD_DATA: any = {
	content: "test answer",
	blockList: [],
	quoteContent: "",
	statusLine: "",
	copyContent: "test answer",
	hasAction: false,
	version: 1,
};

const SAMPLE_CARD: any = {
	cardInstanceId: "card_test",
	accessToken: "test-token",
	inputingStarted: true,
};

describe("finishAICard retry behavior", () => {
	let realFetch: typeof globalThis.fetch;
	let restoreFetch: (() => void) | undefined;
	let fakeServer: Awaited<ReturnType<typeof startFakeCardServer>>;

	beforeEach(() => {
		realFetch = globalThis.fetch;
	});

	afterEach(() => {
		if (restoreFetch) restoreFetch();
		globalThis.fetch = realFetch;
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
		fakeServer = await startFakeCardServer(call => {
			// streaming PUT (called from streamAICard) — return OK
			if (call.path === "/v1.0/card/streaming") {
				return new Response(JSON.stringify({}), {
					headers: { "Content-Type": "application/json" },
				});
			}
			// FINISHED PUT — first 2 attempts return 500, 3rd succeeds
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

		await finishAICard(SAMPLE_CARD, SAMPLE_CARD_DATA, makeConfig(fakeServer.port));

		// First 2 attempts are 500, 3rd succeeds
		const finishedCalls = fakeServer.calls.filter(c => c.path === "/v1.0/card/instances" && c.method === "PUT");
		expect(finishedCalls.length).toBe(3);
	});

	test("throws after max retries when 500 persists, so bridge fallback fires", async () => {
		fakeServer = await startFakeCardServer(call => {
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

		await expect(finishAICard(SAMPLE_CARD, SAMPLE_CARD_DATA, makeConfig(fakeServer.port))).rejects.toThrow(
			/FINISHED update failed after 3 retries/,
		);

		const finishedCalls = fakeServer.calls.filter(c => c.path === "/v1.0/card/instances" && c.method === "PUT");
		expect(finishedCalls.length).toBe(3);
	});

	test("throws immediately on non-retryable 4xx (no retries)", async () => {
		fakeServer = await startFakeCardServer(call => {
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

		await expect(finishAICard(SAMPLE_CARD, SAMPLE_CARD_DATA, makeConfig(fakeServer.port))).rejects.toThrow(
			/FINISHED non-retryable failure: status=400/,
		);

		const finishedCalls = fakeServer.calls.filter(c => c.path === "/v1.0/card/instances" && c.method === "PUT");
		expect(finishedCalls.length).toBe(1);
	});

	test("retries on 429 too many requests", async () => {
		let attempt = 0;
		fakeServer = await startFakeCardServer(call => {
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

		await finishAICard(SAMPLE_CARD, SAMPLE_CARD_DATA, makeConfig(fakeServer.port));

		const finishedCalls = fakeServer.calls.filter(c => c.path === "/v1.0/card/instances" && c.method === "PUT");
		expect(finishedCalls.length).toBe(2);
	});
});
