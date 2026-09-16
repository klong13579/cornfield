import { afterEach, describe, expect, it, vi } from "bun:test";
import { callExaTool } from "@cornfield/coding-agent/exa/mcp-client";
import { callMCP, DEFAULT_MCP_TIMEOUT_MS } from "@cornfield/coding-agent/mcp/json-rpc";
import { hookFetch } from "@cornfield/utils";

/** Cloudflare's blocked-client envelope, as `mcp.exa.ai` returns it. */
const BLOCKED_CLIENT_BODY = JSON.stringify({
	type: "https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1010/",
	title: "Error 1010: Access denied",
	status: 403,
	detail: "The site owner has blocked access based on your browser's signature.",
	error_code: 1010,
	error_name: "browser_signature_banned",
	retryable: false,
	what_you_should_do: "**Do not retry.** Your user-agent has been banned by the site owner.",
});

/** A fetch that only settles when the signal aborts, like a real transport. */
function abortAwareFetch() {
	return hookFetch(
		(_input, init) =>
			new Promise<Response>((_resolve, reject) => {
				const signal = init?.signal;
				if (!signal) return;
				if (signal.aborted) {
					reject(signal.reason);
					return;
				}
				signal.addEventListener("abort", () => reject(signal.reason));
			}),
	);
}

describe("callMCP transport ceiling", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("settles on its own ceiling and names it", async () => {
		using _hook = abortAwareFetch();

		await expect(callMCP("https://mcp.example/mcp", "tools/list", undefined, { timeoutMs: 30 })).rejects.toThrow(
			"timed out after 30ms",
		);
	});

	it("defaults to the built-in ceiling when none is given", () => {
		expect(DEFAULT_MCP_TIMEOUT_MS).toBe(30_000);
	});

	it("surfaces a caller cancel as the cancel, not as the ceiling", async () => {
		using _hook = abortAwareFetch();
		const controller = new AbortController();
		const call = callMCP("https://mcp.example/mcp", "tools/list", undefined, {
			signal: controller.signal,
			timeoutMs: 5_000,
		});
		setTimeout(() => controller.abort(), 20);

		const error = await call.then(
			() => null,
			(err: unknown) => err,
		);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).not.toContain("timed out after");
	});

	it("keeps the response body when the endpoint refuses the request", async () => {
		using _hook = hookFetch(() => new Response(BLOCKED_CLIENT_BODY, { status: 403 }));

		await expect(callMCP("https://mcp.example/mcp", "tools/call")).rejects.toThrow(/browser_signature_banned/);
	});
});

describe("Exa MCP failure reporting", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("turns a Cloudflare block into an actionable message", async () => {
		using _hook = hookFetch(() => new Response(BLOCKED_CLIENT_BODY, { status: 403 }));

		await expect(callExaTool("web_search_exa", { query: "x" }, null)).rejects.toThrow(
			/mcp\.exa\.ai blocked this client.*Store an Exa API key/s,
		);
	});

	it("leaves an unrelated MCP failure alone", async () => {
		using _hook = hookFetch(() => new Response("upstream on fire", { status: 500 }));

		const error = await callExaTool("web_search_exa", { query: "x" }, null).then(
			() => null,
			(err: unknown) => err,
		);

		expect((error as Error).message).toContain("upstream on fire");
		expect((error as Error).message).not.toContain("Store an Exa API key");
	});

	it("passes its cancellation signal down to the transport", async () => {
		using _hook = abortAwareFetch();
		const controller = new AbortController();
		controller.abort();

		await expect(
			callExaTool("web_search_exa", { query: "x" }, null, { signal: controller.signal, timeoutMs: 5_000 }),
		).rejects.toThrow();
	});
});
