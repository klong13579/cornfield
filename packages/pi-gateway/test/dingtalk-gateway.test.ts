/**
 * DingTalk gateway — bridge → formatter end-to-end (v1 reply path).
 *
 * Merged:
 *   - dingtalk-reply-e2e.test.ts  (bridge.forwardWithMeta → formatReply)
 *
 * The full gateway end-to-end test (dingtalk-gateway-end-to-end) stays
 * separate — it spins up a real DingTalkStream fake client + capture
 * server + SQLiteSessionStore + SessionManager pipeline (~555 LOC) and
 * covers inbound WebSocket → parse → dedup → allowlist → enqueue →
 * reply, which is its own test surface.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentBridge } from "../src/agent-bridge";
import { DingTalkChannel } from "../src/channels/dingtalk";
import type { InboundMessage, OutboundMessage, SessionRecord } from "../src/types";

// Fake omp --mode rpc that emits a rich AssistantMessage with all the
// fields the bridge meta extraction looks for.
const FAKE_RPC_SCRIPT = `#!/usr/bin/env bun
process.stdout.write(JSON.stringify({ type: "ready" }) + "\\n");
let buffer = "";
function emit(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
process.stdin.on("data", chunk => {
  buffer += chunk.toString("utf8");
  let idx;
  while ((idx = buffer.indexOf("\\n")) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let frame;
    try { frame = JSON.parse(line); } catch { continue; }
    if (frame.type === "switch_session") {
      emit({ type: "response", id: frame.id, command: "switch_session", success: true, data: { cancelled: false } });
    } else if (frame.type === "prompt") {
      emit({ type: "response", id: frame.id, command: "prompt", success: true });
      emit({ type: "message_end", message: { role: "toolResult", toolCallId: "tc1", toolName: "read", content: [{ type: "text", text: "file contents" }], isError: false } });
      emit({
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", id: "tc1", name: "read", arguments: { path: "/tmp/example" } },
            { type: "text", text: "I read the file. It contains: " + frame.message }
          ],
          api: "anthropic",
          provider: "anthropic",
          model: "claude-sonnet-4-5",
          usage: { input: 120, output: 80, cacheRead: 0, cacheWrite: 0, totalTokens: 200 },
          stopReason: "stop",
          duration: 1500,
          timestamp: Date.now()
        }
      });
      emit({ type: "agent_end" });
    } else if (frame.type === "abort") {
      emit({ type: "response", id: frame.id, command: "abort", success: true });
    }
  }
});
`;

interface FakeBinary {
	path: string;
	cleanup: () => Promise<void>;
}

async function createFakeRpcBinary(script: string = FAKE_RPC_SCRIPT): Promise<FakeBinary> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-fake-rpc-"));
	const scriptPath = path.join(dir, "omp-fake");
	await fs.writeFile(scriptPath, script, { mode: 0o755 });
	return {
		path: scriptPath,
		cleanup: async () => {
			await fs.rm(dir, { recursive: true, force: true });
		},
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

describe("Bridge → formatter end-to-end (v1 reply path)", () => {
	let fake: FakeBinary;
	let bridge: AgentBridge;

	beforeEach(async () => {
		fake = await createFakeRpcBinary();
		bridge = new AgentBridge({ ompPath: fake.path, timeoutMs: 5_000 });
		await bridge.start();
	});

	afterEach(async () => {
		bridge.stop();
		await fake.cleanup();
	});

	test("forwardWithMeta returns a populated meta for a successful run", async () => {
		const meta = await bridge.forwardWithMeta(
			makeMessage("summarize", "conv-e2e-1"),
			makeSession("/tmp/e2e-1.jsonl", "conv-e2e-1"),
		);

		expect(meta).not.toBeNull();
		expect(meta?.isFallback).toBe(false);
		expect(meta?.text).toContain("I read the file");
		expect(meta?.model).toBe("claude-sonnet-4-5");
		expect(meta?.provider).toBe("anthropic");
		expect(meta?.usage).not.toBeNull();
		expect(meta?.usage?.input).toBe(120);
		expect(meta?.usage?.output).toBe(80);
		expect(meta?.agentDurationMs).toBe(1500);
		expect(meta?.taskDurationMs).toBeGreaterThanOrEqual(0);
		expect(meta?.toolCalls.length).toBe(1);
		expect(meta?.toolCalls[0]?.name).toBe("read");
		expect(meta?.toolResults.length).toBe(1);
		expect(meta?.toolResults[0]?.name).toBe("read");
		expect(meta?.toolResults[0]?.isError).toBe(false);
	});

	test("formatted reply (via DingTalkChannel.formatReply) contains every section", async () => {
		const meta = await bridge.forwardWithMeta(
			makeMessage("summarize", "conv-e2e-2"),
			makeSession("/tmp/e2e-2.jsonl", "conv-e2e-2"),
		);
		expect(meta).not.toBeNull();
		if (!meta) return;

		const channel = new DingTalkChannel();
		channel.setAccountId("ops");
		const inbound = makeMessage("summarize", "conv-e2e-2");
		const outbound = channel.formatReply(meta, inbound, {
			accountId: "ops",
			agentName: "ops-bot",
			dapiCalls: 2,
		});

		expect(outbound).not.toBeNull();
		const md =
			(outbound as OutboundMessage).content.type === "markdown"
				? (outbound as OutboundMessage).content.type === "markdown" &&
					(outbound as OutboundMessage).content.markdown
				: "";
		expect(md).toBeTruthy();

		expect(md).toContain("> 💬 **Alice**: summarize");
		expect(md).toContain("**工具**: read");
		expect(md).toContain("I read the file");
		expect(md).toContain("`claude-sonnet-4-5`");
		expect(md).toContain("200 tok");
		expect(md).toContain("2 dapi");
		expect(md).toContain("agent `ops-bot`");

		const headerIdx = md.indexOf("> 💬");
		const toolIdx = md.indexOf("**工具**");
		const answerIdx = md.indexOf("I read the file");
		const statusIdx = md.indexOf("---");
		expect(headerIdx).toBeGreaterThanOrEqual(0);
		expect(toolIdx).toBeGreaterThan(headerIdx);
		expect(answerIdx).toBeGreaterThan(toolIdx);
		expect(statusIdx).toBeGreaterThan(answerIdx);
	});

	test("fallback strings skip chrome entirely", async () => {
		// Fake RPC that responds to the prompt with an empty agent_end (no
		// assistant message_end) — the bridge treats this as "agent did not
		// return content" and returns a fallback meta (isFallback: true).
		const empty = await createFakeRpcBinary(`#!/usr/bin/env bun
process.stdout.write(JSON.stringify({ type: "ready" }) + "\\n");
let buffer = "";
process.stdin.on("data", chunk => {
  buffer += chunk.toString("utf8");
  let idx;
  while ((idx = buffer.indexOf("\\n")) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let frame;
    try { frame = JSON.parse(line); } catch { continue; }
    if (frame.type === "prompt") {
      process.stdout.write(JSON.stringify({ type: "response", id: frame.id, command: "prompt", success: true }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "agent_end" }) + "\\n");
    } else if (frame.type === "switch_session") {
      process.stdout.write(JSON.stringify({ type: "response", id: frame.id, command: "switch_session", success: true, data: { cancelled: false } }) + "\\n");
    }
  }
});
`);
		try {
			const emptyBridge = new AgentBridge({ ompPath: empty.path, timeoutMs: 2_000 });
			await emptyBridge.start();
			const meta = await emptyBridge.forwardWithMeta(
				makeMessage("hi", "conv-fail"),
				makeSession("/tmp/fail.jsonl", "conv-fail"),
			);
			expect(meta?.isFallback).toBe(true);
			expect(meta?.text).toContain("未返回内容");

			const channel = new DingTalkChannel();
			channel.setAccountId("ops");
			const outbound = channel.formatReply(meta!, makeMessage("hi", "conv-fail"), {
				accountId: "ops",
				agentName: null,
				dapiCalls: 0,
			});
			const md = outbound && outbound.content.type === "markdown" ? outbound.content.markdown : "";
			expect(md).toBeTruthy();
			expect(md).not.toContain("**工具**");
			expect(md).not.toContain("`claude-sonnet-4-5`");
			expect(md).toContain("（Agent 未返回内容）");
		} finally {
			await empty.cleanup();
		}
	});
});
