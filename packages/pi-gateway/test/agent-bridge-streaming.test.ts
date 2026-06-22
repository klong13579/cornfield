/**
 * AgentBridge streaming handlers (`forwardWithMeta` with `handlers` option)
 * contract tests.
 *
 * Pins the callback firing order / cumulative-text tracking / per-event
 * routing that downstream consumers (e.g. the DingTalk AI Card wiring in
 * gateway.ts) depend on. The fake RPC emits the same event shape that
 * `omp --mode rpc` produces (`message_update` carrying
 * `assistantMessageEvent` deltas, then `message_end`, then `agent_end`).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentBridge, type ForwardStreamHandlers } from "../src/agent-bridge";
import type { InboundMessage, SessionRecord } from "../src/types";

const STREAMING_RPC_SCRIPT = `#!/usr/bin/env bun
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
      // Emit three text deltas with the assistantMessageEvent shape
      // (matches the @oh-my-pi/pi-agent contract documented in
      // packages/coding-agent/src/internal-urls/.../rpc.md).
      emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "Hello", contentIndex: 0 },
        message: { role: "assistant", content: [] }
      });
      emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: ", world", contentIndex: 0 },
        message: { role: "assistant", content: [] }
      });
      emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "!", contentIndex: 0 },
        message: { role: "assistant", content: [] }
      });
      // Then a thinking_delta to verify routing of the other delta type.
      emit({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", delta: "model thought a bit" },
        message: { role: "assistant", content: [] }
      });
      // Then message_end with the final assembled assistant text.
      emit({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "Hello, world!" }] }
      });
      emit({ type: "agent_end" });
    } else if (frame.type === "abort") {
      emit({ type: "response", id: frame.id, command: "abort", success: true });
    }
    idx = buffer.indexOf("\\n");
  }
}
`;

interface FakeBinary {
	path: string;
	cleanup: () => Promise<void>;
}

async function createFakeRpcBinary(script: string): Promise<FakeBinary> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-gateway-stream-"));
	const scriptPath = path.join(dir, "fake-rpc");
	await Bun.write(scriptPath, script);
	await fs.chmod(scriptPath, 0o755);
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
		userId: "user",
		conversationId,
		isGroup: false,
		content: { type: "text", text },
		timestamp: new Date(),
	};
}

function makeSession(sessionPath: string, conversationId: string): SessionRecord {
	return {
		id: conversationId,
		channelId: "dingtalk",
		accountId: "ops",
		userId: "user",
		conversationId,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		ompSessionPath: sessionPath,
		status: "active",
	};
}

describe("AgentBridge.forwardWithMeta (streaming)", () => {
	let fake: FakeBinary;
	let bridge: AgentBridge;

	beforeEach(async () => {
		fake = await createFakeRpcBinary(STREAMING_RPC_SCRIPT);
		bridge = new AgentBridge({ ompPath: fake.path, timeoutMs: 5_000 });
		await bridge.start();
	});

	afterEach(async () => {
		bridge.stop();
		await fake.cleanup();
	});

	test("fires onTextDelta for each text_delta event with cumulative text", async () => {
		const deltas: Array<{ delta: string; cumulative: string }> = [];
		const thinkingDeltas: string[] = [];
		let messageEndCount = 0;
		let agentEndCount = 0;
		const handlers: ForwardStreamHandlers = {
			onTextDelta: (delta, cumulative) => {
				deltas.push({ delta, cumulative });
			},
			onThinkingDelta: delta => {
				thinkingDeltas.push(delta);
			},
			onAssistantMessageEnd: () => {
				messageEndCount++;
			},
			onAgentEnd: () => {
				agentEndCount++;
			},
		};

		const meta = await bridge.forwardWithMeta(
			makeMessage("hi", "conv-stream-1"),
			makeSession("/tmp/stream-1.jsonl", "conv-stream-1"),
			handlers,
		);

		expect(meta).not.toBeNull();
		expect(meta?.text).toContain("Hello, world!");
		// Three text deltas, in order, with cumulative concat.
		expect(deltas).toEqual([
			{ delta: "Hello", cumulative: "Hello" },
			{ delta: ", world", cumulative: "Hello, world" },
			{ delta: "!", cumulative: "Hello, world!" },
		]);
		// Thinking delta routed separately.
		expect(thinkingDeltas).toEqual(["model thought a bit"]);
		// One assistant message_end and one agent_end.
		expect(messageEndCount).toBe(1);
		expect(agentEndCount).toBe(1);
	});

	test("handlers are optional (backward compatible — no handlers still returns meta)", async () => {
		const meta = await bridge.forwardWithMeta(
			makeMessage("hi", "conv-stream-2"),
			makeSession("/tmp/stream-2.jsonl", "conv-stream-2"),
		);
		expect(meta).not.toBeNull();
		expect(meta?.text).toContain("Hello, world!");
	});

	test("handler that throws does not break the run or the meta result", async () => {
		const handlers: ForwardStreamHandlers = {
			onTextDelta: () => {
				throw new Error("synthetic handler crash");
			},
		};
		// Bridge logs the handler error and keeps going — the run still
		// completes with the correct meta.
		const meta = await bridge.forwardWithMeta(
			makeMessage("hi", "conv-stream-3"),
			makeSession("/tmp/stream-3.jsonl", "conv-stream-3"),
			handlers,
		);
		expect(meta).not.toBeNull();
		expect(meta?.text).toContain("Hello, world!");
	});
});
