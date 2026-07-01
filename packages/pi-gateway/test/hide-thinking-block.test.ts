/**
 * End-to-end test for the per-account `hideThinkingBlock` filter on
 * `DingTalkChannel`. Verifies that the THINK block (type 1) is:
 *   - emitted into the AI Card when `hideThinkingBlock = false`
 *   - suppressed from the AI Card when `hideThinkingBlock = true`
 *
 * The model still produces thinking; the transcript JSONL is unchanged
 * (omp owns the session log, not the gateway). This test only asserts
 * on the side-effect visible in the card — the captured
 * `finishAICard` body and the `patchAICardBlocks` updates.
 *
 * What's real: AgentBridge, DingTalkChannel.streamCard, the formatter.
 * What's faked: a tiny bun server that mimics the DingTalk card API
 * (`/v1.0/oauth2/accessToken`, `/v1.0/card/instances`,
 * `/v1.0/card/instances/deliver`, `/v1.0/card/streaming`) and records
 * every call.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentBridge } from "../src/agent-bridge";
import { DingTalkChannel } from "../src/channels/dingtalk";
import type { DingTalkConfig, InboundMessage, SessionRecord } from "../src/types";

// Fake RPC that emits the full event shape that a real
// `omp --mode rpc` produces for one turn: thinking stream, text stream,
// tool call, tool result, and the closing agent_end. We use two text
// deltas so the throttled streamAICard actually buffers, and two
// thinking deltas to give the filter something to drop.
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
      // Thinking stream
      emit({ type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 }, message: { role: "assistant", content: [] } });
      emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "用户问的是具身数据平台 JD。" }, message: { role: "assistant", content: [] } });
      emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "我应该答 X。" }, message: { role: "assistant", content: [] } });
      emit({ type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "用户问的是具身数据平台 JD。我应该答 X。" }, message: { role: "assistant", content: [] } });
      // Text stream
      emit({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 1 }, message: { role: "assistant", content: [] } });
      emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "这是答案。" }, message: { role: "assistant", content: [] } });
      // Tool call
      emit({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 2 }, message: { role: "assistant", content: [] } });
      emit({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 2, delta: '{"command":"echo hi"}' }, message: { role: "assistant", content: [] } });
      emit({ type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 2, toolCall: { id: "tc1", name: "bash", arguments: { command: "echo hi" } } }, message: { role: "assistant", content: [] } });
      // Tool result
      emit({ type: "message_end", message: { role: "toolResult", toolCallId: "tc1", toolName: "bash", isError: false, content: [{ type: "text", text: "hi" }] } });
      // Final assistant message
      emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "这是答案。" }], model: "test-model", provider: "test", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 }, duration: 100 } });
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
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-gateway-hide-thinking-rpc-"));
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
		accountId: "test",
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
		accountId: "test",
		userId: "u1",
		conversationId,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		ompSessionPath: sessionPath,
		status: "active",
	};
}

function makeDingTalkConfig(): DingTalkConfig {
	return {
		enabled: true,
		appKey: "test-key",
		appSecret: "test-secret",
		robotCode: "test-robot",
	};
}

/** Monkey-patch globalThis.fetch to rewrite DingTalk API URLs to the
 *  fake card server. The card module hard-codes its base URL, so the
 *  simplest port-rewrite is a fetch override that returns a real
 *  Response to the local bun.serve handler. */
async function installCardApiBaseForTest(host: string, port: number): Promise<() => void> {
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
	return () => {
		globalThis.fetch = realFetch;
	};
}

/** Pull the blockList from the FINISHED transition. Returns the array
 *  of CardBlock-like objects the gateway put in the card. */
function readFinishedBlockList(calls: CardCall[]): Array<{ type: number; text?: string; markdown?: string }> {
	const finish = calls.find(
		c =>
			c.method === "PUT" &&
			c.path === "/v1.0/card/instances" &&
			(c.body as any)?.cardData?.cardParamMap?.flowStatus === "3",
	);
	if (!finish) return [];
	const raw = (finish.body as any)?.cardData?.cardParamMap?.blockList;
	if (typeof raw !== "string") return [];
	return JSON.parse(raw) as Array<{ type: number; text?: string; markdown?: string }>;
}

describe("DingTalkChannel.hideThinkingBlock filter", () => {
	let rpc: FakeRpc;
	let card: FakeCardServer;
	let restoreFetch: () => void;
	let bridge: AgentBridge;

	beforeEach(async () => {
		rpc = await createFakeRpcBinary();
		card = await startFakeCardServer();
		restoreFetch = await installCardApiBaseForTest(card.host, card.port);
		bridge = new AgentBridge({ ompPath: rpc.path, timeoutMs: 5_000 });
		await bridge.start();
	});

	afterEach(async () => {
		bridge.stop();
		restoreFetch();
		card.stop();
		await rpc.cleanup();
	});

	async function runWithHide(hide: boolean): Promise<{
		blocks: Array<{ type: number; text?: string; markdown?: string }>;
		thinkBlocks: Array<{ type: number; text?: string; markdown?: string }>;
	}> {
		const channel = new DingTalkChannel();
		channel.setAccountId("test");
		channel.setConfig(makeDingTalkConfig());
		channel.setHideThinkingBlock(hide);
		// Sanity check: the setter is in effect.
		expect(channel.__testGetHideThinkingBlock()).toBe(hide);

		const inbound = makeMessage("summarize", `conv-hide-${hide ? "true" : "false"}`);
		const session = makeSession(`/tmp/hide-${hide}.jsonl`, inbound.conversationId);

		const submit = (handlers?: Parameters<typeof channel.streamCard>[3]): ReturnType<typeof bridge.forwardWithMeta> =>
			bridge.forwardWithMeta(inbound, session, handlers);

		const outbound = await channel.streamCard(
			inbound,
			session,
			{ accountId: "test", agentName: "test-bot", dapiCalls: 0 },
			submit,
		);
		expect(outbound).not.toBeNull();

		const blocks = readFinishedBlockList(card.calls);
		const thinkBlocks = blocks.filter(b => b.type === 1);
		return { blocks, thinkBlocks };
	}

	test("default (hide=false): THINK block is included in the finished card", async () => {
		const { blocks, thinkBlocks } = await runWithHide(false);

		// Sanity: the fake RPC actually produced a thinking stream and
		// a tool call, so we have something for the filter to gate.
		// ANSWER=0, THINK=1, TOOL=2.
		const typeCounts = blocks.reduce<Record<number, number>>((acc, b) => {
			acc[b.type] = (acc[b.type] ?? 0) + 1;
			return acc;
		}, {});
		expect(typeCounts[0]).toBe(1); // answer
		expect(typeCounts[2]).toBeGreaterThanOrEqual(1); // tool

		// The key assertion: with hide=false the THINK block is in the
		// final card.
		expect(thinkBlocks.length).toBe(1);
		expect(thinkBlocks[0].text).toContain("具身数据平台 JD");
	});

	test("hide=true: THINK block is suppressed from the finished card", async () => {
		const { blocks, thinkBlocks } = await runWithHide(true);

		// No THINK block in the final card.
		expect(thinkBlocks.length).toBe(0);
		// ANSWER and TOOL blocks are still present — the filter is
		// targeted at THINK only, not a blanket suppress.
		const typeCounts = blocks.reduce<Record<number, number>>((acc, b) => {
			acc[b.type] = (acc[b.type] ?? 0) + 1;
			return acc;
		}, {});
		expect(typeCounts[0]).toBe(1); // answer still in card
		expect(typeCounts[2]).toBeGreaterThanOrEqual(1); // tool still in card
		// And the model output is preserved: the answer text is the
		// full text the model produced.
		const answer = blocks.find(b => b.type === 0);
		expect(answer?.markdown).toContain("这是答案");
	});

	test("incremental patchAICardBlocks: no THINK block is ever pushed when hide=true", async () => {
		// Drive the same flow as the positive test, but inspect the
		// *incremental* block updates (the /v1.0/card/streaming PUTs
		// and the per-segment PUT /v1.0/card/instances that runs
		// before FINISHED) — not just the final body. This catches
		// regressions where the final state is clean but an
		// intermediate patch leaked the THINK block to the user's
		// screen.
		await runWithHide(true);

		// Every PUT body that carries a blockList should be empty of
		// type 1. (Some PUTs only carry `content`; we skip those.)
		const offending = card.calls.filter(c => {
			if (c.method !== "PUT") return false;
			const raw = (c.body as any)?.cardData?.cardParamMap?.blockList;
			if (typeof raw !== "string") return false;
			try {
				const blocks = JSON.parse(raw) as Array<{ type: number }>;
				return blocks.some(b => b.type === 1);
			} catch {
				return false;
			}
		});
		expect(offending, `Found PUT bodies with THINK blocks: ${JSON.stringify(offending, null, 2)}`).toHaveLength(0);
	});
});
