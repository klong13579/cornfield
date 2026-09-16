import { afterEach, describe, expect, it, vi } from "bun:test";
import { _resetSettingsForTest, Settings } from "@cornfield/coding-agent/config/settings";
import { AgentStorage } from "@cornfield/coding-agent/session/agent-storage";
import { runSearchQuery } from "@cornfield/coding-agent/web/search/index";
import { searchGemini } from "@cornfield/coding-agent/web/search/providers/gemini";
import { searchTavily } from "@cornfield/coding-agent/web/search/providers/tavily";
import {
	MAX_SEARCH_ERROR_BYTES,
	readLimitedText,
	SEARCH_HARD_TIMEOUT_MS,
	withHardTimeout,
} from "@cornfield/coding-agent/web/search/providers/utils";
import { SearchProviderError } from "@cornfield/coding-agent/web/search/types";
import { hookFetch } from "@cornfield/utils";

describe("withHardTimeout", () => {
	it("cuts a real connection that stalls after the headers arrived", async () => {
		// The providers that stream (codex, gemini, perplexity) depend on the
		// ceiling bounding the body phase too, not just the handshake. A stubbed
		// fetch cannot show that, so this drives a real socket.
		const encoder = new TextEncoder();
		const server = Bun.serve({
			port: 0,
			fetch: () =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(encoder.encode('data: "first"\n\n'));
							// Then stall: no further chunk, no close.
						},
					}),
					{ headers: { "Content-Type": "text/event-stream" } },
				),
		});

		try {
			const response = await fetch(server.url, { signal: withHardTimeout(undefined, 100) });
			const reader = response.body?.getReader();
			expect(reader).toBeDefined();
			expect((await reader?.read())?.done).toBe(false);
			await expect(reader?.read()).rejects.toThrow();
		} finally {
			await server.stop(true);
		}
	});

	it("aborts on its own timer when the caller supplies no signal", async () => {
		const signal = withHardTimeout(undefined, 20);

		expect(signal.aborted).toBe(false);
		await Bun.sleep(60);
		expect(signal.aborted).toBe(true);
	});

	it("aborts as soon as the caller's signal aborts, before the ceiling", () => {
		const controller = new AbortController();
		const signal = withHardTimeout(controller.signal, SEARCH_HARD_TIMEOUT_MS);

		expect(signal.aborted).toBe(false);
		controller.abort();
		expect(signal.aborted).toBe(true);
	});
});

describe("readLimitedText", () => {
	it("returns the whole body when it fits under the cap", async () => {
		const body = "x".repeat(1000);
		await expect(readLimitedText(new Response(body), "tavily", 1024)).resolves.toBe(body);
	});

	it("throws when the body exceeds the cap and truncation is off", async () => {
		const response = new Response("x".repeat(2048));

		try {
			await readLimitedText(response, "tavily", 1024);
			expect.unreachable("expected readLimitedText to throw");
		} catch (error) {
			expect(error).toBeInstanceOf(SearchProviderError);
			expect(error).toMatchObject({ provider: "tavily", status: 500 });
			expect((error as Error).message).toContain("1024");
		}
	});

	it("returns the truncated body instead of throwing when truncation is on", async () => {
		const text = await readLimitedText(new Response("x".repeat(2048)), "tavily", 1024, true);

		expect(text).toHaveLength(1024);
	});

	it("returns an empty string when the response carries no body", async () => {
		await expect(readLimitedText(new Response(null, { status: 204 }), "tavily", 1024)).resolves.toBe("");
	});
});

describe("provider hard timeout wiring", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.TAVILY_API_KEY;
	});

	it("bounds the request with the ceiling the caller passed", async () => {
		process.env.TAVILY_API_KEY = "test-key";
		let captured: AbortSignal | undefined;
		using _hook = hookFetch((_input, init) => {
			captured = init?.signal ?? undefined;
			return new Response(JSON.stringify({ answer: "a", results: [], request_id: "r" }), { status: 200 });
		});

		await searchTavily({ query: "q", timeoutMs: 30 });

		expect(captured).toBeDefined();
		expect(captured?.aborted).toBe(false);
		await Bun.sleep(60);
		expect(captured?.aborted).toBe(true);
	});

	it("still aborts when the caller's signal aborts first", async () => {
		process.env.TAVILY_API_KEY = "test-key";
		let captured: AbortSignal | undefined;
		using _hook = hookFetch((_input, init) => {
			captured = init?.signal ?? undefined;
			return new Response(JSON.stringify({ answer: "a", results: [], request_id: "r" }), { status: 200 });
		});
		const controller = new AbortController();
		controller.abort();

		await searchTavily({ query: "q", signal: controller.signal, timeoutMs: SEARCH_HARD_TIMEOUT_MS });

		expect(captured?.aborted).toBe(true);
	});

	it("keeps an oversized error body out of the thrown message", async () => {
		process.env.TAVILY_API_KEY = "test-key";
		const hugeBody = "e".repeat(MAX_SEARCH_ERROR_BYTES + 8192);
		using _hook = hookFetch(() => new Response(hugeBody, { status: 503 }));

		try {
			await searchTavily({ query: "q" });
			expect.unreachable("expected searchTavily to throw");
		} catch (error) {
			expect(error).toBeInstanceOf(SearchProviderError);
			const message = (error as Error).message;
			expect(message).toContain("Tavily API error (503)");
			expect(message.length).toBeLessThanOrEqual(MAX_SEARCH_ERROR_BYTES + 64);
		}
	});
});

describe("the hard ceiling is not retried away", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("gemini makes one attempt when the ceiling fires, not MAX_RETRIES of them", async () => {
		vi.spyOn(AgentStorage, "open").mockResolvedValue({
			listAuthCredentials: () => [
				{
					id: 1,
					credential: {
						type: "oauth",
						access: "test-access-token",
						expires: Date.now() + 600_000,
						projectId: "test-project",
					},
				},
			],
			updateAuthCredential: () => undefined,
		} as unknown as AgentStorage);

		let calls = 0;
		using _hook = hookFetch((_input, init) => {
			calls += 1;
			const signal = init?.signal;
			// Never settles on its own; only the composed signal can end it.
			return new Promise<Response>((_resolve, reject) => {
				signal?.addEventListener("abort", () => reject(signal.reason));
			});
		});

		await expect(searchGemini({ query: "stalled", timeoutMs: 30 })).rejects.toThrow();
		expect(calls).toBe(1);
	});
});

describe("the configured ceiling", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.TAVILY_API_KEY;
		// Leave the global singleton uninitialized for the next file in this process.
		_resetSettingsForTest();
	});

	it("gives an index-backed provider the short ceiling", async () => {
		process.env.TAVILY_API_KEY = "test-key";
		_resetSettingsForTest();
		await Settings.init({ inMemory: true, overrides: { "providers.webSearchIndexTimeoutSeconds": 1 } });
		let captured: AbortSignal | undefined;
		using _hook = hookFetch((_input, init) => {
			captured = init?.signal ?? undefined;
			return new Response(JSON.stringify({ answer: "ok", results: [], request_id: "req-settings" }), {
				status: 200,
			});
		});

		await runSearchQuery({ query: "q", provider: "tavily" });

		expect(captured).toBeDefined();
		expect(captured?.aborted).toBe(false);
		await Bun.sleep(1200);
		expect(captured?.aborted).toBe(true);
	});

	it("gives a synthesizing provider the long ceiling instead of the index one", async () => {
		process.env.MOONSHOT_SEARCH_API_KEY = "test-key";
		_resetSettingsForTest();
		await Settings.init({ inMemory: true, overrides: { "providers.webSearchIndexTimeoutSeconds": 1 } });
		let captured: AbortSignal | undefined;
		using _hook = hookFetch((_input, init) => {
			captured = init?.signal ?? undefined;
			return new Response(JSON.stringify({ data: { results: [] } }), { status: 200 });
		});

		await runSearchQuery({ query: "q", provider: "kimi" });

		// The index override is 1s; a synthesizing provider must not pick it up.
		expect(captured?.aborted).toBe(false);
		await Bun.sleep(1200);
		expect(captured?.aborted).toBe(false);
	});

	it("ignores a ceiling of zero and keeps the built-in default", async () => {
		process.env.TAVILY_API_KEY = "test-key";
		_resetSettingsForTest();
		await Settings.init({ inMemory: true, overrides: { "providers.webSearchIndexTimeoutSeconds": 0 } });
		let captured: AbortSignal | undefined;
		using _hook = hookFetch((_input, init) => {
			captured = init?.signal ?? undefined;
			return new Response(JSON.stringify({ answer: "ok", results: [], request_id: "req-zero" }), { status: 200 });
		});

		await runSearchQuery({ query: "q", provider: "tavily" });

		// A ceiling of 0 would abort every search immediately; the default must win.
		expect(captured?.aborted).toBe(false);
		await Bun.sleep(300);
		expect(captured?.aborted).toBe(false);
	});
});

describe("provider chain failure reporting", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.TAVILY_API_KEY;
		delete process.env.MOONSHOT_SEARCH_API_KEY;
	});

	it("names the providers that failed before one answered", async () => {
		process.env.TAVILY_API_KEY = "test-key";
		const exaOk = JSON.stringify({
			jsonrpc: "2.0",
			id: "1",
			result: {
				content: [
					{
						type: "text",
						text: JSON.stringify({ results: [{ title: "t", url: "https://example.com/a", summary: "s" }] }),
					},
				],
			},
		});
		using _hook = hookFetch(input => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			return url.includes("mcp.exa.ai")
				? new Response(exaOk, { status: 200 })
				: new Response("nope", { status: 503 });
		});

		const result = await runSearchQuery({ query: "q" });

		// The first provider in the order fails and exa answers; the failure must
		// not be swallowed, or a dead provider hides for months.
		expect(result.details?.error).toBeUndefined();
		expect(result.content[0]?.text).toContain("tavily did not answer");
	});

	it("reports a 200 with no usable content as a failure, not an empty success", async () => {
		process.env.TAVILY_API_KEY = "test-key";
		using _hook = hookFetch(
			() => new Response(JSON.stringify({ answer: "", results: [], request_id: "req-empty" }), { status: 200 }),
		);

		const result = await runSearchQuery({ query: "matches nothing", provider: "tavily" });

		expect(result.details?.error).toContain("no usable results");
		expect(result.details?.response.provider).toBe("tavily");
		expect(result.content[0]?.text).toStartWith("Error:");
	});

	it("names the failing provider and its reason when the chain has one provider", async () => {
		process.env.TAVILY_API_KEY = "test-key";
		using _hook = hookFetch(() => new Response("upstream on fire", { status: 503 }));

		const result = await runSearchQuery({ query: "q", provider: "tavily" });

		expect(result.details?.error).toContain("Tavily API error (503)");
		expect(result.details?.error).toContain("upstream on fire");
	});

	it("gives the pipeline a ceiling that is not already expired", async () => {
		process.env.TAVILY_API_KEY = "test-key";
		let captured: AbortSignal | undefined;
		using _hook = hookFetch((_input, init) => {
			captured = init?.signal ?? undefined;
			return new Response(JSON.stringify({ answer: "ok", results: [], request_id: "req-ok" }), { status: 200 });
		});

		await runSearchQuery({ query: "q", provider: "tavily" });

		expect(captured).toBeDefined();
		expect(captured?.aborted).toBe(false);
	});
});
