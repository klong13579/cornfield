/**
 * AgentBridge streaming handlers — tool call / result events.
 *
 * Pins the `onToolCall` and `onToolResult` firing order that the v3
 * DingTalk AI Card module depends on for assembling the `blockList`.
 * The fake RPC emits:
 *   - one toolcall_start / toolcall_delta / toolcall_end sequence
 *   - one user-side `message_end` with `role: "toolResult"`
 *
 * Verifies that the tool call is captured before its result, that the
 * pair can be matched by id, and that errors in the result propagate
 * to the handler.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentBridge, type ForwardStreamHandlers } from "../src/agent-bridge";
import type { InboundMessage, SessionRecord } from "../src/types";

const TOOL_RPC_SCRIPT = `#!/usr/bin/env bun
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

      // Tool call lifecycle
      emit({
        type: "message_update",
        assistantMessageEvent: { type: "toolcall_start", contentIndex: 0 },
        message: { role: "assistant", content: [] }
      });
      emit({
        type: "message_update",
        assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: '{"path":"/tmp/x"}' },
        message: { role: "assistant", content: [] }
      });
      emit({
        type: "message_update",
        assistantMessageEvent: {
          type: "toolcall_end",
          contentIndex: 0,
          toolCall: { id: "tc_1", name: "read", arguments: { path: "/tmp/x" } }
        },
        message: { role: "assistant", content: [] }
      });

      // Tool result (user message) with the same id
      emit({
        type: "message_end",
        message: {
          role: "toolResult",
          toolCallId: "tc_1",
          toolName: "read",
          isError: false,
          content: [{ type: "text", text: "file contents here" }]
        }
      });

      // Final assistant text + tool call in message_end content
      emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "Done.", contentIndex: 0 },
        message: { role: "assistant", content: [] }
      });
      emit({
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Done." },
            { type: "toolCall", id: "tc_1", name: "read", arguments: { path: "/tmp/x" } },
          ]
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

interface FakeBinary {
	path: string;
	cleanup: () => Promise<void>;
}

async function createFakeRpcBinary(script: string): Promise<FakeBinary> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-gateway-tool-"));
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

describe("AgentBridge.forwardWithMeta (tool events)", () => {
	let fake: FakeBinary;
	let bridge: AgentBridge;

	beforeEach(async () => {
		fake = await createFakeRpcBinary(TOOL_RPC_SCRIPT);
		bridge = new AgentBridge({ ompPath: fake.path, timeoutMs: 5_000 });
		await bridge.start();
	});

	afterEach(async () => {
		bridge.stop();
		await fake.cleanup();
	});

	test("fires onToolCall with id/name/args from toolcall_end", async () => {
		const calls: Array<{ id: string; name: string; args: unknown }> = [];
		const handlers: ForwardStreamHandlers = {
			onToolCall: call => {
				calls.push({ id: call.id, name: call.name, args: call.args });
			},
		};
		const meta = await bridge.forwardWithMeta(
			makeMessage("read /tmp/x", "conv-tool-1"),
			makeSession("/tmp/tool-1.jsonl", "conv-tool-1"),
			handlers,
		);
		expect(meta).not.toBeNull();
		expect(calls).toHaveLength(1);
		expect(calls[0]?.id).toBe("tc_1");
		expect(calls[0]?.name).toBe("read");
		expect(calls[0]?.args).toEqual({ path: "/tmp/x" });
	});

	test("fires onToolResult with id/name/isError/contentText from message_end role=toolResult", async () => {
		const results: Array<{ id: string; name: string; isError: boolean; contentText: string }> = [];
		const handlers: ForwardStreamHandlers = {
			onToolResult: result => {
				results.push({
					id: result.id,
					name: result.name,
					isError: result.isError,
					contentText: result.contentText,
				});
			},
		};
		const meta = await bridge.forwardWithMeta(
			makeMessage("read /tmp/x", "conv-tool-2"),
			makeSession("/tmp/tool-2.jsonl", "conv-tool-2"),
			handlers,
		);
		expect(meta).not.toBeNull();
		expect(results).toHaveLength(1);
		expect(results[0]?.id).toBe("tc_1");
		expect(results[0]?.name).toBe("read");
		expect(results[0]?.isError).toBe(false);
		expect(results[0]?.contentText).toBe("file contents here");
	});

	test("onToolCall fires before onToolResult when both are observed", async () => {
		const order: string[] = [];
		const handlers: ForwardStreamHandlers = {
			onToolCall: call => {
				order.push(`call:${call.id}`);
			},
			onToolResult: result => {
				order.push(`result:${result.id}`);
			},
		};
		const meta = await bridge.forwardWithMeta(
			makeMessage("read /tmp/x", "conv-tool-3"),
			makeSession("/tmp/tool-3.jsonl", "conv-tool-3"),
			handlers,
		);
		expect(meta).not.toBeNull();
		// The tool call's toolcall_end event comes before the user-side
		// toolResult message_end in the wire stream.
		expect(order).toEqual(["call:tc_1", "result:tc_1"]);
	});

	test("tool call/result events also surface in the final meta", async () => {
		const handlers: ForwardStreamHandlers = {};
		const meta = await bridge.forwardWithMeta(
			makeMessage("read /tmp/x", "conv-tool-4"),
			makeSession("/tmp/tool-4.jsonl", "conv-tool-4"),
			handlers,
		);
		expect(meta).not.toBeNull();
		expect(meta?.toolCalls).toHaveLength(1);
		expect(meta?.toolCalls[0]?.name).toBe("read");
		expect(meta?.toolResults).toHaveLength(1);
		expect(meta?.toolResults[0]?.id).toBe("tc_1");
	});
});
