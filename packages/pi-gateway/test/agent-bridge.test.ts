/**
 * AgentBridge RPC contract tests.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentBridge } from "../src/agent-bridge";
import type { InboundMessage, SessionRecord } from "../src/types";

const FAKE_RPC_SCRIPT = `#!/usr/bin/env bun
process.stdout.write(JSON.stringify({ type: "ready" }) + "\\n");
let currentSession = "";
let buffer = "";
function emit(value) {
  process.stdout.write(JSON.stringify(value) + "\\n");
}
async function handleFrame(frame) {
  if (frame.type === "switch_session") {
    currentSession = frame.sessionPath;
    emit({ type: "response", id: frame.id, command: "switch_session", success: true, data: { cancelled: false } });
    return;
  }
  if (frame.type === "prompt") {
    if (String(frame.message).includes("fail")) {
      emit({ type: "response", id: frame.id, command: "prompt", success: false, error: "synthetic failure" });
      return;
    }
    emit({ type: "response", id: frame.id, command: "prompt", success: true });
    const sessionAtPrompt = currentSession;
    const delay = String(frame.message).includes("slow") ? 50 : 0;
    setTimeout(() => {
      emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: sessionAtPrompt + " :: " + frame.message }] } });
      emit({ type: "agent_end" });
    }, delay);
    return;
  }
  if (frame.type === "abort") {
    emit({ type: "response", id: frame.id, command: "abort", success: true });
  }
}
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk);
  let index = buffer.indexOf("\\n");
  while (index !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) await handleFrame(JSON.parse(line));
    index = buffer.indexOf("\\n");
  }
}
`;

async function createFakeRpcBinary(script = FAKE_RPC_SCRIPT): Promise<{ path: string; cleanup: () => Promise<void> }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-gateway-rpc-"));
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

describe("AgentBridge", () => {
	test("switches to the session path before prompting", async () => {
		const fake = await createFakeRpcBinary();
		const bridge = new AgentBridge({ ompPath: fake.path, timeoutMs: 2_000 });
		try {
			await bridge.start();
			const response = await bridge.forward(makeMessage("hello", "conv-a"), makeSession("/tmp/session-a.jsonl", "conv-a"));
			expect(response).toContain("/tmp/session-a.jsonl :: hello");
		} finally {
			bridge.stop();
			await fake.cleanup();
		}
	});

	test("serializes concurrent prompts so session events do not cross", async () => {
		const fake = await createFakeRpcBinary();
		const bridge = new AgentBridge({ ompPath: fake.path, timeoutMs: 2_000 });
		try {
			await bridge.start();
			const slow = bridge.forward(makeMessage("slow", "conv-a"), makeSession("/tmp/session-a.jsonl", "conv-a"));
			const fast = bridge.forward(makeMessage("fast", "conv-b"), makeSession("/tmp/session-b.jsonl", "conv-b"));
			const [slowResponse, fastResponse] = await Promise.all([slow, fast]);

			expect(slowResponse).toContain("/tmp/session-a.jsonl :: slow");
			expect(fastResponse).toContain("/tmp/session-b.jsonl :: fast");
		} finally {
			bridge.stop();
			await fake.cleanup();
		}
	});

	test("reports bridge lifecycle snapshot", async () => {
		const fake = await createFakeRpcBinary();
		const bridge = new AgentBridge({ ompPath: fake.path, timeoutMs: 2_000 });
		try {
			expect(bridge.getSnapshot().state).toBe("stopped");
			await bridge.start();
			const ready = bridge.getSnapshot();
			expect(ready.state).toBe("idle");
			expect(ready.running).toBe(true);
			expect(ready.ready).toBe(true);
			expect(ready.pid).toBeGreaterThan(0);

			const pending = bridge.forward(makeMessage("slow", "conv-a"), makeSession("/tmp/session-a.jsonl", "conv-a"));
			await Bun.sleep(10);
			const busy = bridge.getSnapshot();
			expect(busy.state).toBe("busy");
			expect(busy.pendingPrompts).toBe(1);
			await pending;
		} finally {
			bridge.stop();
			await fake.cleanup();
		}
	});

	test("sends abort while a prompt is active", async () => {
		const fake = await createFakeRpcBinary();
		const bridge = new AgentBridge({ ompPath: fake.path, timeoutMs: 2_000 });
		try {
			await bridge.start();
			expect(await bridge.abort()).toBe(false);
			const pending = bridge.forward(makeMessage("slow", "conv-a"), makeSession("/tmp/session-a.jsonl", "conv-a"));
			await Bun.sleep(10);
			expect(await bridge.abort()).toBe(true);
			expect(await pending).toBe("（已停止）");
		} finally {
			bridge.stop();
			await fake.cleanup();
		}
	});

	test("opens the circuit after repeated prompt failures", async () => {
		const fake = await createFakeRpcBinary();
		const bridge = new AgentBridge({ ompPath: fake.path, timeoutMs: 500 });
		try {
			await bridge.start();
			for (let i = 0; i < 10; i++) {
				const response = await bridge.forward(makeMessage("fail", `conv-${i}`), makeSession(`/tmp/session-${i}.jsonl`, `conv-${i}`));
				expect(response).toContain("系统错误");
			}
			const rejected = await bridge.forward(makeMessage("hello", "conv-open"), makeSession("/tmp/session-open.jsonl", "conv-open"));
			expect(rejected).toBe("系统繁忙，请稍后再试。");
		} finally {
			bridge.stop();
			await fake.cleanup();
		}
	});

	test("enters error state after repeated startup crashes", async () => {
		const fake = await createFakeRpcBinary("#!/usr/bin/env bun\nprocess.exit(1);\n");
		const bridge = new AgentBridge({ ompPath: fake.path, timeoutMs: 500, crashBackoffMs: 1, maxCrashRetries: 0 });
		try {
			for (let i = 0; i < 6; i++) {
				await expect(bridge.start()).rejects.toThrow("before ready");
			}
			await expect(bridge.start()).rejects.toThrow("ERROR state");
		} finally {
			bridge.stop();
			await fake.cleanup();
		}
	});
});
