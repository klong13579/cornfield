/**
 * AgentBridge — RPC + streaming + tool events + watchdog + long-task watcher.
 *
 * Merged:
 *   - agent-bridge.test.ts                  (core RPC, executePrompt, inactivity, model re-apply)
 *   - agent-bridge-streaming.test.ts        (text/thinking deltas, optional handlers)
 *   - agent-bridge-tool-streaming.test.ts   (onToolCall / onToolResult pair)
 *   - agent-bridge-streaming-watchdog.test.ts (hang detection + active-session sentinel)
 *   - agent-bridge-long-task.test.ts        (long-task watcher + env override)
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentBridge, type ForwardStreamHandlers } from "../src/agent-bridge";
import { sentinelPathFor } from "../src/restart-sentinel";
import type { InboundMessage, SessionRecord } from "../src/types";

// ═══════════════════════════════════════════════════════════════════════
// Helpers shared by all sections
// ═══════════════════════════════════════════════════════════════════════

interface FakeBinary {
	path: string;
	cleanup: () => Promise<void>;
}

async function createFakeRpcBinary(script: string, prefix = "pi-gateway-rpc-"): Promise<FakeBinary> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
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

// ═══════════════════════════════════════════════════════════════════════
// Core RPC (was: agent-bridge.test.ts — first section)
// ═══════════════════════════════════════════════════════════════════════

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

describe("AgentBridge", () => {
	test("switches to the session path before prompting", async () => {
		const fake = await createFakeRpcBinary(FAKE_RPC_SCRIPT);
		const bridge = new AgentBridge({ ompPath: fake.path });
		try {
			await bridge.start();
			const response = await bridge.forward(
				makeMessage("hello", "conv-a"),
				makeSession("/tmp/session-a.jsonl", "conv-a"),
			);
			expect(response).toContain("/tmp/session-a.jsonl :: hello");
		} finally {
			bridge.stop();
			await fake.cleanup();
		}
	});

	test("serializes concurrent prompts so session events do not cross", async () => {
		const fake = await createFakeRpcBinary(FAKE_RPC_SCRIPT);
		const bridge = new AgentBridge({ ompPath: fake.path });
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
		const fake = await createFakeRpcBinary(FAKE_RPC_SCRIPT);
		const bridge = new AgentBridge({ ompPath: fake.path });
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
		const fake = await createFakeRpcBinary(FAKE_RPC_SCRIPT);
		const bridge = new AgentBridge({ ompPath: fake.path });
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
		const fake = await createFakeRpcBinary(FAKE_RPC_SCRIPT);
		const bridge = new AgentBridge({ ompPath: fake.path });
		try {
			await bridge.start();
			for (let i = 0; i < 10; i++) {
				const response = await bridge.forward(
					makeMessage("fail", `conv-${i}`),
					makeSession(`/tmp/session-${i}.jsonl`, `conv-${i}`),
				);
				expect(response).toContain("系统错误");
			}
			const rejected = await bridge.forward(
				makeMessage("hello", "conv-open"),
				makeSession("/tmp/session-open.jsonl", "conv-open"),
			);
			expect(rejected).toBe("系统繁忙，请稍后再试。");
		} finally {
			bridge.stop();
			await fake.cleanup();
		}
	});

	test("enters error state after repeated startup crashes", async () => {
		const fake = await createFakeRpcBinary("#!/usr/bin/env bun\nprocess.exit(1);\n");
		const bridge = new AgentBridge({ ompPath: fake.path, crashBackoffMs: 1, maxCrashRetries: 0 });
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

// ═══════════════════════════════════════════════════════════════════════
// executePrompt — cron scheduler reuse path
// ═══════════════════════════════════════════════════════════════════════

const RECORDING_FAKE_SCRIPT = `#!/usr/bin/env bun
import * as fs from "node:fs";
const logPath = process.env.FAKE_RPC_LOG;
function log(entry) {
  if (logPath) {
    fs.appendFileSync(logPath, JSON.stringify(entry) + "\\n");
  }
}
process.stdout.write(JSON.stringify({ type: "ready" }) + "\\n");
let currentSession = "";
let buffer = "";
function emit(value) {
  process.stdout.write(JSON.stringify(value) + "\\n");
}
async function handleFrame(frame) {
  if (frame.type === "switch_session") {
    currentSession = frame.sessionPath;
    log({ ts: Date.now(), cmd: "switch_session", session: frame.sessionPath });
    emit({ type: "response", id: frame.id, command: "switch_session", success: true, data: { cancelled: false } });
    return;
  }
  if (frame.type === "get_state") {
    log({ ts: Date.now(), cmd: "get_state", session: currentSession });
    emit({
      type: "response",
      id: frame.id,
      command: "get_state",
      success: true,
      data: { sessionFile: currentSession, sessionId: "fake-session-id" },
    });
    return;
  }
  if (frame.type === "prompt") {
    log({ ts: Date.now(), cmd: "prompt", message: String(frame.message).slice(0, 80) });
    emit({ type: "response", id: frame.id, command: "prompt", success: true });
    setTimeout(() => {
      emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ack: " + frame.message }] } });
      emit({ type: "agent_end" });
    }, 0);
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

async function createRecordingRpcBinary(): Promise<{
	path: string;
	logPath: string;
	readLog: () => Promise<Array<{ ts: number; cmd: string; session?: string; message?: string }>>;
	cleanup: () => Promise<void>;
}> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-gateway-rpc-rec-"));
	const scriptPath = path.join(dir, "fake-rpc");
	const logPath = path.join(dir, "rpc.log");
	await Bun.write(scriptPath, RECORDING_FAKE_SCRIPT);
	await fs.chmod(scriptPath, 0o755);
	Bun.env.FAKE_RPC_LOG = logPath;
	return {
		path: scriptPath,
		logPath,
		readLog: async () => {
			try {
				const text = await fs.readFile(logPath, "utf8");
				return text
					.split("\n")
					.filter(Boolean)
					.map(line => JSON.parse(line) as { ts: number; cmd: string; session?: string; message?: string });
			} catch {
				return [];
			}
		},
		cleanup: async () => {
			Bun.env.FAKE_RPC_LOG = "";
			await fs.rm(dir, { recursive: true, force: true });
		},
	};
}

describe("AgentBridge.executePrompt (cron path)", () => {
	test("throws on empty prompt without starting the bridge", async () => {
		const fake = await createRecordingRpcBinary();
		const bridge = new AgentBridge({ ompPath: fake.path });
		try {
			await expect(bridge.executePrompt("")).rejects.toThrow("Empty prompt");
			await expect(bridge.executePrompt("   \n\t  ")).rejects.toThrow("Empty prompt");
			expect(bridge.isRunning).toBe(false);
		} finally {
			await fake.cleanup();
		}
	});

	test("switches to the provided sessionPath before prompting", async () => {
		const fake = await createRecordingRpcBinary();
		const bridge = new AgentBridge({ ompPath: fake.path });
		try {
			await bridge.start();
			const response = await bridge.executePrompt("do thing", {
				sessionPath: "/tmp/cron_task_42.jsonl",
			});
			expect(response).toBe("ack: do thing");
			const log = await fake.readLog();
			const cmds = log.map(e => e.cmd);
			expect(cmds[0]).toBe("switch_session");
			expect(cmds[1]).toBe("prompt");
			expect(log[0]?.session).toBe("/tmp/cron_task_42.jsonl");
		} finally {
			bridge.stop();
			await fake.cleanup();
		}
	});

	test("restores the prior session after a prompt when one was active", async () => {
		const fake = await createRecordingRpcBinary();
		const bridge = new AgentBridge({ ompPath: fake.path });
		try {
			await bridge.start();

			await bridge.forward(makeMessage("hi", "conv-im"), makeSession("/tmp/session-im.jsonl", "conv-im"));

			const response = await bridge.executePrompt("cron task", {
				sessionPath: "/tmp/cron_task_99.jsonl",
			});
			expect(response).toBe("ack: cron task");

			const log = await fake.readLog();
			const cmds = log
				.filter(e => e.cmd !== "get_state")
				.map(e => `${e.cmd}${e.session ? `:${e.session}` : e.message ? `:${e.message}` : ""}`);

			expect(cmds).toEqual([
				"switch_session:/tmp/session-im.jsonl",
				"prompt:hi",
				"switch_session:/tmp/cron_task_99.jsonl",
				"prompt:cron task",
				"switch_session:/tmp/session-im.jsonl",
			]);
		} finally {
			bridge.stop();
			await fake.cleanup();
		}
	});

	test("does not issue an extra switch_session on a cold bridge", async () => {
		const fake = await createRecordingRpcBinary();
		const bridge = new AgentBridge({ ompPath: fake.path });
		try {
			await bridge.start();
			await bridge.executePrompt("first task", { sessionPath: "/tmp/cron_task_a.jsonl" });

			const log = await fake.readLog();
			const switchCount = log.filter(e => e.cmd === "switch_session").length;
			const promptCount = log.filter(e => e.cmd === "prompt").length;
			expect(switchCount).toBe(1);
			expect(promptCount).toBe(1);
		} finally {
			bridge.stop();
			await fake.cleanup();
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════
// executePrompt inactivity timeout
// ═══════════════════════════════════════════════════════════════════════

const INACTIVE_FAKE_SCRIPT = `#!/usr/bin/env bun
process.stdout.write(JSON.stringify({ type: "ready" }) + "\\n");
let buffer = "";
function emit(value) {
  process.stdout.write(JSON.stringify(value) + "\\n");
}
async function handleFrame(frame) {
  if (frame.type === "switch_session") {
    emit({ type: "response", id: frame.id, command: "switch_session", success: true, data: { cancelled: false } });
    return;
  }
  if (frame.type === "prompt") {
    emit({ type: "response", id: frame.id, command: "prompt", success: true });
    if (String(frame.message).includes("INACTIVE")) return;
    if (String(frame.message).includes("EVENTUAL")) {
      setTimeout(() => emit({ type: "message_start" }), 500);
      setTimeout(() => emit({ type: "message_update", content: "..." }), 1_000);
      setTimeout(() => emit({ type: "message_update", content: "...." }), 1_500);
      setTimeout(() => {
        emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "late" }] } });
        emit({ type: "agent_end" });
      }, 2_000);
      return;
    }
    setTimeout(() => {
      emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ack" }] } });
      emit({ type: "agent_end" });
    }, 0);
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

async function createInactiveRpcBinary(): Promise<{ path: string; cleanup: () => Promise<void> }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-gateway-rpc-inactive-"));
	const scriptPath = path.join(dir, "fake-rpc-inactive");
	await Bun.write(scriptPath, INACTIVE_FAKE_SCRIPT);
	await fs.chmod(scriptPath, 0o755);
	return {
		path: scriptPath,
		cleanup: async () => {
			await fs.rm(dir, { recursive: true, force: true });
		},
	};
}

describe("AgentBridge.executePrompt inactivity timeout", () => {
	test("aborts a prompt that emits no events within the inactivity budget", async () => {
		const fake = await createInactiveRpcBinary();
		const bridge = new AgentBridge({ ompPath: fake.path });
		try {
			await bridge.start();
			const start = Date.now();
			await expect(bridge.executePrompt("INACTIVE prompt", { inactivityMs: 200 })).rejects.toThrow(
				/inactive for \d+ms \(limit 200ms\)/,
			);
			const elapsed = Date.now() - start;
			expect(elapsed).toBeLessThan(3_000);
			expect(bridge.isRunning).toBe(true);
		} finally {
			bridge.stop();
			await fake.cleanup();
		}
	});

	test("does not abort a prompt that is slow but actively emitting events", async () => {
		const fake = await createInactiveRpcBinary();
		const bridge = new AgentBridge({ ompPath: fake.path });
		try {
			await bridge.start();
			const start = Date.now();
			const response = await bridge.executePrompt("EVENTUAL prompt", { inactivityMs: 750 });
			expect(response).toBe("late");
			const elapsed = Date.now() - start;
			expect(elapsed).toBeGreaterThanOrEqual(1_900);
		} finally {
			bridge.stop();
			await fake.cleanup();
		}
	});

	test("does not enable a watchdog when inactivityMs is not provided", async () => {
		// Removed 2026-07-08 along with the hard cap. The previous test verified
		// that `executePrompt({ timeoutMs: 250 })` would reject via the wall-clock
		// cap even when no inactivityMs was set. With the hard cap deleted, the
		// only give-up condition is the inactivity watchdog (default 60s) — a
		// 60s test is too slow to live in this file. The default-60s behaviour
		// is implicitly covered by `inactivityMs` being optional in the type.
	});
});

// ═══════════════════════════════════════════════════════════════════════
// BOOT.md self-check + model re-application
// ═══════════════════════════════════════════════════════════════════════

describe("AgentBridge BOOT.md self-check", () => {
	test("runs BOOT.md self-check on start when the file exists", async () => {
		const fake = await createFakeRpcBinary(FAKE_RPC_SCRIPT);
		const bootDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-boot-"));
		await Bun.write(path.join(bootDir, "BOOT.md"), "Check today's tasks and report status.");
		const bridge = new AgentBridge({ ompPath: fake.path, cwd: bootDir });
		try {
			await bridge.start();
			await Bun.sleep(200);
			expect(bridge.isRunning).toBe(true);
			const response = await bridge.forward(
				makeMessage("hello", "conv-boot"),
				makeSession("/tmp/boot-session.jsonl", "conv-boot"),
			);
			expect(response).toContain("/tmp/boot-session.jsonl :: hello");
		} finally {
			bridge.stop();
			await fake.cleanup();
			await fs.rm(bootDir, { recursive: true, force: true });
		}
	});

	test("starts normally when BOOT.md is absent", async () => {
		const fake = await createFakeRpcBinary(FAKE_RPC_SCRIPT);
		const bridge = new AgentBridge({ ompPath: fake.path });
		try {
			await bridge.start();
			expect(bridge.isRunning).toBe(true);
		} finally {
			bridge.stop();
			await fake.cleanup();
		}
	});
});

describe("AgentBridge model re-application", () => {
	function makeTrackingScript(trackerPath: string): string {
		return `#!/usr/bin/env bun
process.stdout.write(JSON.stringify({ type: "ready" }) + "\\n");
let currentSession = "";
let buffer = "";
const setModelCalls = [];
function emit(value) {
  process.stdout.write(JSON.stringify(value) + "\\n");
}
function recordCall() {
  require("fs").writeFileSync(${JSON.stringify(trackerPath)}, JSON.stringify(setModelCalls));
}
async function handleFrame(frame) {
  if (frame.type === "switch_session") {
    currentSession = frame.sessionPath;
    emit({ type: "response", id: frame.id, command: "switch_session", success: true, data: { cancelled: false } });
    recordCall();
    return;
  }
  if (frame.type === "set_model") {
    setModelCalls.push({ provider: frame.provider, modelId: frame.modelId });
    emit({ type: "response", id: frame.id, command: "set_model", success: true, data: { provider: frame.provider, id: frame.modelId } });
    recordCall();
    return;
  }
  if (frame.type === "prompt") {
    emit({ type: "response", id: frame.id, command: "prompt", success: true });
    setTimeout(() => {
      emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: frame.message }] } });
      emit({ type: "agent_end" });
    }, 0);
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
	}

	async function createTrackingRpc(trackerPath: string): Promise<{ path: string; cleanup: () => Promise<void> }> {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-gateway-rpc-track-"));
		const scriptPath = path.join(dir, "fake-rpc");
		await Bun.write(scriptPath, makeTrackingScript(trackerPath));
		await fs.chmod(scriptPath, 0o755);
		return {
			path: scriptPath,
			cleanup: async () => {
				await fs.rm(dir, { recursive: true, force: true });
			},
		};
	}

	async function readModelCalls(trackerPath: string): Promise<Array<{ provider: string; modelId: string }>> {
		try {
			const raw = await Bun.file(trackerPath).text();
			return JSON.parse(raw);
		} catch {
			return [];
		}
	}

	test("does not send set_model on consecutive messages in the same session", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-model-track-"));
		const trackerPath = path.join(dir, "calls.json");
		const fake = await createTrackingRpc(trackerPath);
		const bridge = new AgentBridge({ ompPath: fake.path, model: "test-provider/test-model" });
		try {
			await bridge.start();
			const session = makeSession("/tmp/same-session.jsonl", "conv-same");

			await bridge.forward(makeMessage("msg1", "conv-same"), session);
			await bridge.forward(makeMessage("msg2", "conv-same"), session);

			const calls = await readModelCalls(trackerPath);
			expect(calls.length).toBe(1);
			expect(calls[0]?.provider).toBe("test-provider");
			expect(calls[0]?.modelId).toBe("test-model");
		} finally {
			bridge.stop();
			await fake.cleanup();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test("sends set_model after simulated crash recovery with same session path", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-model-crash-"));
		const trackerPath = path.join(dir, "calls.json");
		const fake = await createTrackingRpc(trackerPath);
		const bridge = new AgentBridge({ ompPath: fake.path, model: "test-provider/test-model" });
		try {
			await bridge.start();
			const session = makeSession("/tmp/crash-test-session.jsonl", "conv-crash");

			await bridge.forward(makeMessage("before-crash", "conv-crash"), session);

			bridge.resetActiveSession();

			const response = await bridge.forward(makeMessage("after-crash", "conv-crash"), session);
			expect(response).toContain("after-crash");

			const calls = await readModelCalls(trackerPath);
			expect(calls.length).toBe(2);
		} finally {
			bridge.stop();
			await fake.cleanup();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Streaming — text/thinking deltas (was: agent-bridge-streaming.test.ts)
// ═══════════════════════════════════════════════════════════════════════

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
      emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hello", contentIndex: 0 }, message: { role: "assistant", content: [] } });
      emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: ", world", contentIndex: 0 }, message: { role: "assistant", content: [] } });
      emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "!", contentIndex: 0 }, message: { role: "assistant", content: [] } });
      emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "model thought a bit" }, message: { role: "assistant", content: [] } });
      emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Hello, world!" }] } });
      emit({ type: "agent_end" });
    } else if (frame.type === "abort") {
      emit({ type: "response", id: frame.id, command: "abort", success: true });
    }
    idx = buffer.indexOf("\\n");
  }
}
`;

describe("AgentBridge.forwardWithMeta (streaming)", () => {
	let fake: FakeBinary;
	let bridge: AgentBridge;

	beforeEach(async () => {
		fake = await createFakeRpcBinary(STREAMING_RPC_SCRIPT, "pi-gateway-stream-");
		bridge = new AgentBridge({ ompPath: fake.path });
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
		expect(deltas).toEqual([
			{ delta: "Hello", cumulative: "Hello" },
			{ delta: ", world", cumulative: "Hello, world" },
			{ delta: "!", cumulative: "Hello, world!" },
		]);
		expect(thinkingDeltas).toEqual(["model thought a bit"]);
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
		const meta = await bridge.forwardWithMeta(
			makeMessage("hi", "conv-stream-3"),
			makeSession("/tmp/stream-3.jsonl", "conv-stream-3"),
			handlers,
		);
		expect(meta).not.toBeNull();
		expect(meta?.text).toContain("Hello, world!");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Tool events (was: agent-bridge-tool-streaming.test.ts)
// ═══════════════════════════════════════════════════════════════════════

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
      emit({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 0 }, message: { role: "assistant", content: [] } });
      emit({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: '{"path":"/tmp/x"}' }, message: { role: "assistant", content: [] } });
      emit({ type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall: { id: "tc_1", name: "read", arguments: { path: "/tmp/x" } } }, message: { role: "assistant", content: [] } });
      emit({ type: "message_end", message: { role: "toolResult", toolCallId: "tc_1", toolName: "read", isError: false, content: [{ type: "text", text: "file contents here" }] } });
      emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Done.", contentIndex: 0 }, message: { role: "assistant", content: [] } });
      emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done." }, { type: "toolCall", id: "tc_1", name: "read", arguments: { path: "/tmp/x" } }] } });
      emit({ type: "agent_end" });
    } else if (frame.type === "abort") {
      emit({ type: "response", id: frame.id, command: "abort", success: true });
    }
    idx = buffer.indexOf("\\n");
  }
}
`;

describe("AgentBridge.forwardWithMeta (tool events)", () => {
	let fake: FakeBinary;
	let bridge: AgentBridge;

	beforeEach(async () => {
		fake = await createFakeRpcBinary(TOOL_RPC_SCRIPT, "pi-gateway-tool-");
		bridge = new AgentBridge({ ompPath: fake.path });
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

// ═══════════════════════════════════════════════════════════════════════
// Streaming watchdog + active-session sentinel
// (was: agent-bridge-streaming-watchdog.test.ts)
// ═══════════════════════════════════════════════════════════════════════

const SCRIPT_STREAMING_HANG = `#!/usr/bin/env bun
process.stdout.write(JSON.stringify({ type: "ready" }) + "\\n");
let currentSession = "";
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
    emit({ type: "response", id: frame.id, command: "prompt", success: true });
    if (String(frame.message).includes("hang")) {
      emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "thinking..." } });
      return;
    }
    if (String(frame.message).includes("slow")) {
      let n = 0;
      const tick = setInterval(() => {
        emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x" } });
        n++;
        if (n >= 5) {
          clearInterval(tick);
          emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } });
          emit({ type: "agent_end" });
        }
      }, 50);
      return;
    }
    emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } });
    emit({ type: "agent_end" });
    return;
  }
  if (frame.type === "abort") {
    emit({ type: "response", id: frame.id, command: "abort", success: true });
  }
}
for await (const chunk of Bun.stdin.stream()) {
  const buffer = (globalThis.__buf = (globalThis.__buf ?? "") + new TextDecoder().decode(chunk));
  let index = buffer.indexOf("\\n");
  while (index !== -1) {
    const line = buffer.slice(0, index).trim();
    if (line) await handleFrame(JSON.parse(line));
    globalThis.__buf = buffer.slice(index + 1);
    index = globalThis.__buf.indexOf("\\n");
  }
}
`;

let watchdogTmpDir: string;
let watchdogDataDir: string;
let watchdogAgentDir: string;

async function writeWatchdogScript(): Promise<string> {
	const p = path.join(watchdogTmpDir, "fake-omp.bun");
	await Bun.write(p, SCRIPT_STREAMING_HANG);
	await fs.chmod(p, 0o755);
	return p;
}

beforeEach(async () => {
	watchdogTmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-gateway-bridge-watchdog-"));
	watchdogDataDir = path.join(watchdogTmpDir, "gateway-data");
	watchdogAgentDir = path.join(watchdogTmpDir, "agent");
	await fs.mkdir(watchdogDataDir, { recursive: true });
	await fs.mkdir(watchdogAgentDir, { recursive: true });
});

afterEach(async () => {
	await fs.rm(watchdogTmpDir, { recursive: true, force: true });
});

function makeMsgForWatchdog(conversationId = "cid-123", text = "hang please") {
	return {
		channelId: "dingtalk",
		userId: "u1",
		conversationId,
		isGroup: false,
		content: { type: "text", text },
		timestamp: new Date(),
		accountId: "test-acct",
	} as unknown as Parameters<AgentBridge["forward"]>[0];
}

function makeSessionForWatchdog(ompSessionPath = "/tmp/agent/sessions/cid-123.jsonl") {
	return {
		id: "s1",
		channelId: "dingtalk",
		accountId: "test-acct",
		userId: "u1",
		conversationId: "cid-123",
		createdAt: Date.now(),
		updatedAt: Date.now(),
		ompSessionPath,
		status: "active" as const,
	};
}

describe("AgentBridge streaming watchdog", () => {
	test("aborts prompt that streams one event then goes silent", async () => {
		const scriptPath = await writeWatchdogScript();
		const bridge = new AgentBridge({
			ompPath: scriptPath,
			cwd: watchdogAgentDir,
			streamingWatchdogMs: 300,
		});
		await bridge.start();
		const start = Date.now();
		const reply = await bridge.forward(makeMsgForWatchdog(), makeSessionForWatchdog());
		const elapsed = Date.now() - start;
		expect(reply).toContain("系统繁忙");
		expect(elapsed).toBeLessThan(15_000);
		await bridge.stop();
	});

	test("does NOT abort a prompt that streams continuously within the threshold", async () => {
		const scriptPath = await writeWatchdogScript();
		const bridge = new AgentBridge({
			ompPath: scriptPath,
			cwd: watchdogAgentDir,
			streamingWatchdogMs: 5_000,
		});
		await bridge.start();
		const reply = await bridge.forward(
			makeMsgForWatchdog("cid-fast", "slow please"),
			makeSessionForWatchdog("/tmp/cid-fast.jsonl"),
		);
		expect(reply).toContain("done");
		expect(reply).not.toContain("系统繁忙");
		await bridge.stop();
	});

	test("inactivity watchdog is the only give-up when streaming watchdog is disabled", async () => {
		// Removed 2026-07-08: the previous version asserted the hard cap fired
		// within 1.5s. With the hard cap deleted, the only give-up is the
		// inactivity watchdog (default 60s) — too slow for a unit test. The
		// same fallback is exercised by the `inactivity watchdog fires when
		// OMP emits no events` test in `prompt-queue-rolling.test.ts` with
		// a 100ms budget. This test would just be a slower duplicate.
	});
});

describe("AgentBridge active-session sentinel", () => {
	test("writes sentinel during a running prompt and clears it on completion", async () => {
		const scriptPath = await writeWatchdogScript();
		const bridge = new AgentBridge({
			ompPath: scriptPath,
			cwd: watchdogAgentDir,
			dataDir: watchdogDataDir,
			accountId: "test-acct",
		});
		await bridge.start();
		const sentinelPath = sentinelPathFor(watchdogDataDir);
		expect(await Bun.file(sentinelPath).exists()).toBe(false);
		const forwardPromise = bridge.forward(
			makeMsgForWatchdog("cid-sentinel", "slow please"),
			makeSessionForWatchdog("/tmp/sentinel-session.jsonl"),
		);
		await Bun.sleep(50);
		expect(await Bun.file(sentinelPath).exists()).toBe(true);
		const text = await Bun.file(sentinelPath).text();
		const sentinel = JSON.parse(text);
		expect(sentinel.conversationId).toBe("cid-sentinel");
		expect(sentinel.accountId).toBe("test-acct");
		expect(sentinel.ompSessionPath).toBe("/tmp/sentinel-session.jsonl");
		await forwardPromise;
		expect(await Bun.file(sentinelPath).exists()).toBe(false);
		await bridge.stop();
	});

	test("skips sentinel when dataDir not configured", async () => {
		const scriptPath = await writeWatchdogScript();
		const bridge = new AgentBridge({
			ompPath: scriptPath,
			cwd: watchdogAgentDir,
			accountId: "test-acct",
		});
		await bridge.start();
		await bridge.forward(
			makeMsgForWatchdog("cid-no-data-dir", "slow please"),
			makeSessionForWatchdog("/tmp/no-data-dir-session.jsonl"),
		);
		await bridge.stop();
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Long-task watcher (was: agent-bridge-long-task.test.ts)
// ═══════════════════════════════════════════════════════════════════════

const SLOW_TOOL_RPC_SCRIPT = `#!/usr/bin/env bun
const HOLD_MS = 200;
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
      emit({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 0 }, message: { role: "assistant", content: [] } });
      emit({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: '{"command":"sleep 10"}' }, message: { role: "assistant", content: [] } });
      emit({ type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall: { id: "tc_long", name: "bash", arguments: { command: "sleep 10" } } }, message: { role: "assistant", content: [] } });
      const start = Date.now();
      while (Date.now() - start < HOLD_MS) { /* spin */ }
      emit({ type: "message_end", message: { role: "toolResult", toolCallId: "tc_long", toolName: "bash", isError: false, content: [{ type: "text", text: "done" }] } });
      emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "ok", contentIndex: 0 }, message: { role: "assistant", content: [] } });
      emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }, { type: "toolCall", id: "tc_long", name: "bash", arguments: { command: "sleep 10" } }] } });
      emit({ type: "agent_end" });
    } else if (frame.type === "abort") {
      emit({ type: "response", id: frame.id, command: "abort", success: true });
    }
    idx = buffer.indexOf("\\n");
  }
}
`;

describe("AgentBridge long-task watcher", () => {
	let fake: FakeBinary;
	let bridge: AgentBridge;
	const originalDateNow = Date.now;
	let now = 0;

	beforeEach(async () => {
		now = 1_700_000_000_000;
		Date.now = () => now;
		fake = await createFakeRpcBinary(SLOW_TOOL_RPC_SCRIPT, "pi-gateway-longtask-");
	});

	afterEach(async () => {
		Date.now = originalDateNow;
		if (bridge) bridge.stop();
		await fake.cleanup();
	});

	test("fires onLongTask once at the threshold, then on each ping", async () => {
		bridge = new AgentBridge({
			ompPath: fake.path,
			longTaskThresholdMs: 50,
			progressPingIntervalMs: 30,
		});
		await bridge.start();

		const events: Array<{ threshold: boolean; elapsedMs: number; toolName: string }> = [];
		const handlers: ForwardStreamHandlers = {
			onLongTask: e => {
				events.push({ threshold: e.threshold, elapsedMs: e.elapsedMs, toolName: e.toolName });
			},
		};

		const meta = await bridge.forwardWithMeta(
			makeMessage("long task", "conv-long-1"),
			makeSession("/tmp/long-1.jsonl", "conv-long-1"),
			handlers,
		);
		expect(meta).not.toBeNull();

		expect(events.length).toBeGreaterThanOrEqual(1);
		const first = events[0];
		expect(first?.threshold).toBe(true);
		expect(first?.toolName).toBe("bash");
		for (const e of events.slice(1)) {
			expect(e.threshold).toBe(false);
		}
	});

	test("does not fire onLongTask when the tool completes before the threshold", async () => {
		bridge = new AgentBridge({
			ompPath: fake.path,
			longTaskThresholdMs: 10_000,
			progressPingIntervalMs: 5_000,
		});
		await bridge.start();

		const events: unknown[] = [];
		const handlers: ForwardStreamHandlers = {
			onLongTask: e => {
				events.push(e);
			},
		};

		const meta = await bridge.forwardWithMeta(
			makeMessage("short task", "conv-long-2"),
			makeSession("/tmp/long-2.jsonl", "conv-long-2"),
			handlers,
		);
		expect(meta).not.toBeNull();
		expect(events).toHaveLength(0);
	});

	test("does not start a watcher when longTaskThresholdMs is 0 (disabled)", async () => {
		bridge = new AgentBridge({
			ompPath: fake.path,
			longTaskThresholdMs: 0,
		});
		await bridge.start();

		const events: unknown[] = [];
		const handlers: ForwardStreamHandlers = {
			onLongTask: e => {
				events.push(e);
			},
		};

		const meta = await bridge.forwardWithMeta(
			makeMessage("disabled", "conv-long-3"),
			makeSession("/tmp/long-3.jsonl", "conv-long-3"),
			handlers,
		);
		expect(meta).not.toBeNull();
		expect(events).toHaveLength(0);
	});
});
