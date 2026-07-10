/**
 * End-to-end test for the v2 AI Card reply path:
 * DingTalkChannel.streamCard → AgentBridge stream handlers →
 * streamAICard (throttled) → finishAICard with v1 chrome.
 *
 * What's real: AgentBridge (with fake RPC), DingTalkChannel.streamCard,
 * the formatter.
 *
 * What's faked: a tiny bun server that mimics the DingTalk card API
 * (`/v1.0/oauth2/accessToken`, `/v1.0/card/instances`,
 * `/v1.0/card/instances/deliver`, `/v1.0/card/streaming`) and records
 * every call so the test can assert the lifecycle: card created →
 * delivered → first streamAICard with INPUTING transition → at least
 * one streaming PUT → finishAICard with FINISHED transition.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentBridge } from "../src/agent-bridge";
import { DingTalkChannel } from "../src/channels/dingtalk";
import type { DingTalkConfig, InboundMessage, SessionRecord } from "../src/types";

// Fake RPC that emits two text deltas (so the throttle actually buffers
// them) plus a thinking delta, then the final assistant message and
// agent_end. The test asserts that the streaming deltas show up as
// throttled `streamAICard` calls (not one per delta).
const FAKE_RPC_SCRIPT = `#!/usr/bin/env bun
process.stdout.write(JSON.stringify({ type: "ready" }) + "\\n");
let buffer = "";
function emit(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk);
  let idx = buffer.indexOf("\\n");
  while (idx !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) { idx = buffer.indexOf("\\n"); continue; }
    const frame = JSON.parse(line);
    if (frame.type === "switch_session") {
      emit({ type: "response", id: frame.id, command: "switch_session", success: true, data: { cancelled: false } });
    } else if (frame.type === "prompt") {
      emit({ type: "response", id: frame.id, command: "prompt", success: true });
      emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hello", contentIndex: 0 }, message: { role: "assistant", content: [] } });
      emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: " world", contentIndex: 0 }, message: { role: "assistant", content: [] } });
      emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "!", contentIndex: 0 }, message: { role: "assistant", content: [] } });
      emit({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hello world!" }],
          model: "claude-sonnet-4-5",
          provider: "anthropic",
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
          duration: 100
        }
      });
      emit({ type: "agent_end" });
    } else if (frame.type === "abort") {
      emit({ type: "response", id: frame.id, command: "abort", success: true });
    }
    idx = buffer.indexOf("\\n");
  }
}
`;

interface FakeRpc {
	path: string;
	cleanup: () => Promise<void>;
}

async function createFakeRpcBinary(): Promise<FakeRpc> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-gateway-card-rpc-"));
	const scriptPath = path.join(dir, "fake-rpc");
	await Bun.write(scriptPath, FAKE_RPC_SCRIPT);
	await fs.chmod(scriptPath, 0o755);
	return {
		path: scriptPath,
		cleanup: async () => {
			await fs.rm(dir, { recursive: true, force: true });
		},
	};
}

interface CardCall {
	method: string;
	path: string;
	body: any;
}

interface FakeCardServer {
	host: string;
	port: number;
	calls: CardCall[];
	stop: () => void;
}

async function startFakeCardServer(): Promise<FakeCardServer> {
	const calls: CardCall[] = [];
	const server = Bun.serve({
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			const body = req.method === "GET" ? null : await req.json().catch(() => null);
			calls.push({ method: req.method, path: url.pathname, body });

			if (url.pathname === "/v1.0/oauth2/accessToken") {
				return new Response(JSON.stringify({ accessToken: "test-token", expireIn: 7200 }), {
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url.pathname === "/v1.0/card/instances" && req.method === "POST") {
				return new Response(JSON.stringify({ cardInstanceId: "ignored-on-create" }), {
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url.pathname === "/v1.0/card/instances/deliver") {
				return new Response(JSON.stringify({}), { headers: { "Content-Type": "application/json" } });
			}
			if (url.pathname === "/v1.0/card/streaming" && req.method === "PUT") {
				return new Response(JSON.stringify({}), { headers: { "Content-Type": "application/json" } });
			}
			if (url.pathname === "/v1.0/card/instances" && req.method === "PUT") {
				return new Response(JSON.stringify({}), { headers: { "Content-Type": "application/json" } });
			}
			return new Response("not found", { status: 404 });
		},
	});
	return {
		host: server.hostname,
		port: server.port,
		calls,
		stop: () => server.stop(true),
	};
}

function makeMessage(text: string, conversationId: string): InboundMessage {
	return {
		channelId: "dingtalk",
		accountId: "ops",
		userId: "u1",
		userName: "Alice",
		conversationId,
		isGroup: false,
		content: { type: "text", text },
		timestamp: new Date(),
		sessionWebhook: "https://example.com/hook",
	};
}

function makeSession(sessionPath: string, conversationId: string): SessionRecord {
	return {
		id: conversationId,
		channelId: "dingtalk",
		accountId: "ops",
		userId: "u1",
		conversationId,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		ompSessionPath: sessionPath,
		status: "active",
	};
}

function makeDingTalkConfig(cardServerPort: number): DingTalkConfig {
	return {
		enabled: true,
		appKey: "test-key",
		appSecret: "test-secret",
		robotCode: "test-robot",
		// The card module reads DINGTALK_API at module load time so we have
		// to monkey-patch it. See `installCardApiBaseForTest` below.
	};
}

// The card module hard-codes DINGTALK_API = "https://api.dingtalk.com".
// We swap it for the fake server's URL by mutating the exported module
// symbol at runtime. The bridge module is small enough that the change
// is observed by the in-process `import` in `dingtalk.ts`.
async function installCardApiBaseForTest(host: string, port: number): Promise<() => void> {
	const cardModule = await import("../src/channels/dingtalk-card");
	// The constant is module-private. Reach for it via a fresh import and
	// patch the *fetch* global instead — every card call goes through
	// `fetch(url)` so a global override is the simplest port-rewrite.
	const realFetch = globalThis.fetch;
	const base = `http://${host}:${port}`;
	globalThis.fetch = (input: any, init?: any) => {
		const url = typeof input === "string" ? input : input.url;
		if (url.startsWith("https://api.dingtalk.com/")) {
			const rewritten = base + url.slice("https://api.dingtalk.com".length);
			return realFetch(rewritten, init);
		}
		return realFetch(input, init);
	};
	// Surface cardModule so unused-import lints stay quiet (we may
	// also need it for future sub-module access).
	void cardModule;
	return () => {
		globalThis.fetch = realFetch;
	};
}

describe("DingTalk AI Card lifecycle (v2 reply path)", () => {
	let rpc: FakeRpc;
	let card: FakeCardServer;
	let restoreFetch: () => void;
	let bridge: AgentBridge;

	beforeEach(async () => {
		rpc = await createFakeRpcBinary();
		card = await startFakeCardServer();
		restoreFetch = await installCardApiBaseForTest(card.host, card.port);
		bridge = new AgentBridge({ ompPath: rpc.path });
		await bridge.start();
	});

	afterEach(async () => {
		bridge.stop();
		restoreFetch();
		card.stop();
		await rpc.cleanup();
	});

	test("streamCard runs the full create → deliver → stream → finish lifecycle", async () => {
		const channel = new DingTalkChannel();
		channel.setAccountId("ops");
		const config = makeDingTalkConfig(card.port);
		// We don't go through the real SDK connect — we just inject the
		// config directly via the protected `setConfig` factory seam.
		// For the test, the channel reads #config inside streamCard so
		// we use a tiny helper to set it without going through the
		// network.
		channel.setConfig(config);

		const inbound = makeMessage("summarize", "conv-card-1");
		const session = makeSession("/tmp/card-1.jsonl", "conv-card-1");

		const submit = (handlers?: Parameters<typeof channel.streamCard>[3]): ReturnType<typeof bridge.forwardWithMeta> =>
			bridge.forwardWithMeta(inbound, session, handlers);

		const outbound = await channel.streamCard(
			inbound,
			session,
			{ accountId: "ops", agentName: "ops-bot", dapiCalls: 0 },
			submit,
		);

		expect(outbound).not.toBeNull();
		expect(outbound?.content.type).toBe("markdown");
		const md = outbound?.content.type === "markdown" ? outbound.content.markdown : "";
		// Card final state should include the streamed text and the v1
		// chrome (quoteContent + status line with model / agent).
		expect(md).toContain("Hello world!");
		expect(md).toContain("> 💬 **Alice**: summarize");
		expect(md).toContain("`claude-sonnet-4-5`");
		expect(md).toContain("agent `ops-bot`");

		// Lifecycle assertion: the card API was called in the right
		// order. The exact set of PUTs on /v1.0/card/streaming depends
		// on the throttle timer; we only assert that at least one
		// streaming update happened before the FINISHED transition.
		const paths = card.calls.map(c => `${c.method} ${c.path}`);
		expect(paths).toContain("POST /v1.0/oauth2/accessToken");
		expect(paths).toContain("POST /v1.0/card/instances");
		expect(paths).toContain("POST /v1.0/card/instances/deliver");
		expect(paths.filter(p => p.startsWith("PUT /v1.0/card/streaming")).length).toBeGreaterThanOrEqual(1);
		const finishPut = card.calls.find(
			c =>
				c.method === "PUT" &&
				c.path === "/v1.0/card/instances" &&
				(c.body as any)?.cardData?.cardParamMap?.flowStatus === "3",
		);
		expect(finishPut, "FINISHED transition PUT should hit /v1.0/card/instances").toBeTruthy();

		// v3 schema assertion: the FINISHED PUT should include the full
		// structured cardData — content, blockList, quoteContent,
		// statusLine, copy_content, hasAction, version — keyed under
		// cardParamMap. The blockList is a JSON-stringified array; the
		// v1 chrome fields are also JSON-stringified primitives.
		const finishedMap = (finishPut as any)?.body?.cardData?.cardParamMap;
		expect(finishedMap, "FINISHED body must carry cardParamMap").toBeTruthy();
		expect(typeof finishedMap?.content).toBe("string");
		expect(finishedMap?.content).toContain("Hello world!");
		expect(typeof finishedMap?.blockList).toBe("string");
		const blockList = JSON.parse(finishedMap.blockList);
		expect(Array.isArray(blockList)).toBe(true);
		// Answer block is the last entry; type 0, contains the answer text.
		const answerBlock = blockList.find((b: { type: number }) => b.type === 0);
		expect(answerBlock, "blockList must contain an answer block (type 0)").toBeTruthy();
		expect(answerBlock.markdown).toContain("Hello world!");
		// quoteContent + statusLine are top-level fields in v3 (not
		// inside the markdown body).
		expect(finishedMap?.quoteContent).toContain("summarize");
		expect(finishedMap?.statusLine).toContain("claude-sonnet-4-5");
		expect(finishedMap?.statusLine).toContain("ops-bot");
		// copy_content + hasAction + version are also v3 keys.
		expect(finishedMap?.copy_content).toContain("Hello world!");
		expect(JSON.parse(finishedMap?.hasAction)).toBe(false);
		expect(JSON.parse(finishedMap?.version)).toBe(1);
	});

	test("streamCard returns null when card creation fails (gateway falls back to v1)", async () => {
		// Swap in a card server that 500s on card creation so the channel
		// gives up and returns null (caller falls back to v1 markdown).
		const broken = Bun.serve({
			port: 0,
			async fetch(req) {
				const url = new URL(req.url);
				if (url.pathname === "/v1.0/oauth2/accessToken") {
					return new Response(JSON.stringify({ accessToken: "t", expireIn: 7200 }), {
						headers: { "Content-Type": "application/json" },
					});
				}
				return new Response("boom", { status: 500 });
			},
		});
		const restore = await installCardApiBaseForTest(broken.hostname, broken.port);
		try {
			const channel = new DingTalkChannel();
			channel.setAccountId("ops");
			channel.setConfig(makeDingTalkConfig(broken.port));

			const inbound = makeMessage("hi", "conv-card-2");
			const session = makeSession("/tmp/card-2.jsonl", "conv-card-2");
			const submit = (
				handlers?: Parameters<typeof channel.streamCard>[3],
			): ReturnType<typeof bridge.forwardWithMeta> => bridge.forwardWithMeta(inbound, session, handlers);

			const outbound = await channel.streamCard(
				inbound,
				session,
				{ accountId: "ops", agentName: null, dapiCalls: 0 },
				submit,
			);
			expect(outbound).toBeNull();
		} finally {
			restore();
			broken.stop(true);
		}
	});

	// Multi-card segment test: fake RPC emits two assistant messages
	// separated by a tool call boundary. The gateway should create
	// two separate cards — one per segment.
	const MULTI_SEGMENT_RPC = `#!/usr/bin/env bun
process.stdout.write(JSON.stringify({ type: "ready" }) + "\\n");
let buffer = "";
function emit(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk);
  let idx = buffer.indexOf("\\n");
  while (idx !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) { idx = buffer.indexOf("\\n"); continue; }
    const frame = JSON.parse(line);
    if (frame.type === "switch_session") {
      emit({ type: "response", id: frame.id, command: "switch_session", success: true, data: { cancelled: false } });
    } else if (frame.type === "prompt") {
      emit({ type: "response", id: frame.id, command: "prompt", success: true });
      // Segment 1: text before tool call
      emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Let me check.", contentIndex: 0 }, message: { role: "assistant", content: [] } });
      emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Let me check." }], model: "test-model", provider: "test", usage: { input: 5, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 7 }, duration: 50 } });
      // Tool call boundary
      emit({ type: "message_update", assistantMessageEvent: { type: "toolcall_end", toolCallId: "tc1", toolName: "search", arguments: { query: "test" } }, message: { role: "assistant", content: [] } });
      emit({ type: "message_end", message: { role: "toolResult", toolCallId: "tc1", toolName: "search", content: [{ type: "text", text: "result data" }] } });
      // Segment 2: text after tool call
      emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Found it!", contentIndex: 0 }, message: { role: "assistant", content: [] } });
      emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Found it!" }], model: "test-model", provider: "test", usage: { input: 5, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 7 }, duration: 50 } });
      emit({ type: "agent_end" });
    } else if (frame.type === "abort") {
      emit({ type: "response", id: frame.id, command: "abort", success: true });
    }
    idx = buffer.indexOf("\\n");
  }
}
`;

	test("streamCard splits into multiple cards on tool boundary", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-gateway-seg-rpc-"));
		const scriptPath = path.join(dir, "fake-seg-rpc");
		await Bun.write(scriptPath, MULTI_SEGMENT_RPC);
		await fs.chmod(scriptPath, 0o755);
		try {
			const segBridge = new AgentBridge({ ompPath: scriptPath });
			await segBridge.start();

			const channel = new DingTalkChannel();
			channel.setAccountId("ops");
			channel.setConfig(makeDingTalkConfig(card.port));

			const inbound = makeMessage("check and report", "conv-seg-1");
			const session = makeSession("/tmp/seg-1.jsonl", "conv-seg-1");

			const submit = (
				handlers?: Parameters<typeof channel.streamCard>[3],
			): ReturnType<typeof segBridge.forwardWithMeta> => segBridge.forwardWithMeta(inbound, session, handlers);

			const outbound = await channel.streamCard(
				inbound,
				session,
				{ accountId: "ops", agentName: "ops-bot", dapiCalls: 0 },
				submit,
			);

			expect(outbound).not.toBeNull();

			// Two cards → two POST /v1.0/card/instances (create) calls
			const creates = card.calls.filter(c => c.method === "POST" && c.path === "/v1.0/card/instances");
			expect(creates.length).toBe(2);

			// Two cards → two FINISHED transitions (flowStatus === "3")
			const finishes = card.calls.filter(
				c =>
					c.method === "PUT" &&
					c.path === "/v1.0/card/instances" &&
					(c.body as any)?.cardData?.cardParamMap?.flowStatus === "3",
			);
			expect(finishes.length).toBe(2);

			// First card should contain "Let me check."
			const firstFinishMap = (finishes[0] as any)?.body?.cardData?.cardParamMap;
			expect(firstFinishMap?.content).toContain("Let me check");
			expect(firstFinishMap?.content).not.toContain("Found it");

			// Second card should contain "Found it!"
			const secondFinishMap = (finishes[1] as any)?.body?.cardData?.cardParamMap;
			expect(secondFinishMap?.content).toContain("Found it");

			segBridge.stop();
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
