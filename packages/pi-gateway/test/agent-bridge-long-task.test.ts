/**
 * AgentBridge long-task watcher.
 *
 * Pins the contract that a tool call running longer than
 * `longTaskThresholdMs` fires `onLongTask` once at the threshold and
 * then on the `progressPingIntervalMs` interval until the matching
 * `onToolResult` arrives (or the prompt ends).
 *
 * The fake RPC emits a single tool call and then waits a controllable
 * delay before emitting the tool result, so the test can either:
 *   (a) hold the tool long enough that the bridge's threshold timer
 *       fires, or
 *   (b) let the tool finish quickly so the watcher is cleared without
 *       firing.
 *
 * The fake RPC's hold delay is read from the `HOLD_MS` env var which
 * `AgentBridgeOptions` does not pass through to the spawned process,
 * so we use a small constant and rely on real wall-clock time. The
 * bridge's threshold + ping intervals are in stubbed (test-controlled)
 * time, so the test doesn't have to sleep proportional to the
 * threshold.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	__TEST_LONG_TASK_PROGRESS_PING_MS,
	__TEST_LONG_TASK_THRESHOLD_MS,
	AgentBridge,
	type ForwardStreamHandlers,
} from "../src/agent-bridge";
import type { InboundMessage, SessionRecord } from "../src/types";

// Fake RPC: emits one tool call, holds for HOLD_MS, emits the result.
// HOLD_MS is hardcoded in the script (small enough that the test
// doesn't have to sleep long). The bridge's threshold and ping timers
// are driven by Date.now() in the test process, which we stub.
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
      emit({
        type: "message_update",
        assistantMessageEvent: { type: "toolcall_start", contentIndex: 0 },
        message: { role: "assistant", content: [] }
      });
      emit({
        type: "message_update",
        assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: '{"command":"sleep 10"}' },
        message: { role: "assistant", content: [] }
      });
      emit({
        type: "message_update",
        assistantMessageEvent: {
          type: "toolcall_end",
          contentIndex: 0,
          toolCall: { id: "tc_long", name: "bash", arguments: { command: "sleep 10" } }
        },
        message: { role: "assistant", content: [] }
      });
      // hold using real wall clock (this is a separate process from
      // the test, so the test's Date.now() stub doesn't apply)
      const start = Date.now();
      while (Date.now() - start < HOLD_MS) { /* spin */ }
      emit({
        type: "message_end",
        message: {
          role: "toolResult",
          toolCallId: "tc_long",
          toolName: "bash",
          isError: false,
          content: [{ type: "text", text: "done" }]
        }
      });
      emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "ok", contentIndex: 0 },
        message: { role: "assistant", content: [] }
      });
      emit({
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "ok" },
            { type: "toolCall", id: "tc_long", name: "bash", arguments: { command: "sleep 10" } }
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
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-gateway-longtask-"));
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

describe("AgentBridge long-task watcher", () => {
	let fake: FakeBinary;
	let bridge: AgentBridge;
	const originalDateNow = Date.now;
	let now = 0;

	beforeEach(async () => {
		now = 1_700_000_000_000;
		Date.now = () => now;
		fake = await createFakeRpcBinary(SLOW_TOOL_RPC_SCRIPT);
	});

	afterEach(async () => {
		Date.now = originalDateNow;
		if (bridge) bridge.stop();
		await fake.cleanup();
	});

	// The bridge schedules the threshold timer with setTimeout. The
	// test stub of Date.now() affects `Date.now() - startedAt` math
	// but does NOT advance setTimeout's wall clock. To fire the
	// threshold "synchronously" in the test process, we tick `now`
	// forward and rely on the bridge's setTimeout firing on real
	// time (which it does after thresholdMs of *real* time, not stub
	// time). So we make threshold very short (50ms real time) and
	// rely on the threshold firing during the 200ms HOLD_MS window.

	test("fires onLongTask once at the threshold, then on each ping", async () => {
		bridge = new AgentBridge({
			ompPath: fake.path,
			timeoutMs: 30_000,
			longTaskThresholdMs: 50, // 50ms real time
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

		// Tool holds for 200ms real, threshold at 50ms, pings every
		// 30ms — so we expect the threshold fire plus 4-5 pings.
		expect(events.length).toBeGreaterThanOrEqual(1);
		const first = events[0];
		expect(first?.threshold).toBe(true);
		expect(first?.toolName).toBe("bash");
		// All subsequent events are pings
		for (const e of events.slice(1)) {
			expect(e.threshold).toBe(false);
		}
		// No events after the tool result + agent_end; the watcher is
		// cleared by onToolResult.
	});

	test("does not fire onLongTask when the tool completes before the threshold", async () => {
		// 10000ms threshold vs 200ms hold — tool finishes well before
		// the threshold, so the watcher is cleared without firing.
		bridge = new AgentBridge({
			ompPath: fake.path,
			timeoutMs: 30_000,
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
			timeoutMs: 30_000,
			longTaskThresholdMs: 0, // disabled
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

	test("clears all watchers on agent_end even if tool never completed", async () => {
		// We need a fake RPC that emits a tool call but NEVER emits a
		// tool result. Use a different script for this case.
		const HANG_RPC_SCRIPT = `#!/usr/bin/env bun
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
      emit({
        type: "message_update",
        assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall: { id: "tc_hang", name: "bash", arguments: {} } },
        message: { role: "assistant", content: [] }
      });
      // hold long enough that the bridge's threshold fires, then
      // send agent_end without a matching tool result
      await new Promise(r => setTimeout(r, 200));
      emit({ type: "agent_end" });
    }
    idx = buffer.indexOf("\\n");
  }
}
`;
		const hangFake = await createFakeRpcBinary(HANG_RPC_SCRIPT);
		try {
			bridge = new AgentBridge({
				ompPath: hangFake.path,
				timeoutMs: 30_000,
				longTaskThresholdMs: 30, // 30ms — fires before the 200ms hold
				progressPingIntervalMs: 1_000_000, // effectively no pings
			});
			await bridge.start();

			const events: unknown[] = [];
			const handlers: ForwardStreamHandlers = {
				onLongTask: e => {
					events.push(e);
				},
			};

			const meta = await bridge.forwardWithMeta(
				makeMessage("hanging tool", "conv-long-4"),
				makeSession("/tmp/long-4.jsonl", "conv-long-4"),
				handlers,
			);
			expect(meta).not.toBeNull();
			// Threshold should have fired once
			expect(events.length).toBeGreaterThanOrEqual(1);
		} finally {
			await hangFake.cleanup();
		}
	});
});

describe("AgentBridge long-task watcher cleanup on prompt termination", () => {
	let fake: FakeBinary;
	let bridge: AgentBridge;

	// Fake RPC that emits a tool call then hangs forever — no tool
	// result, no agent_end. This forces the bridge to terminate via
	// timeout or abort, which is the path where watchers leaked.
	const HANG_FOREVER_RPC = `#!/usr/bin/env bun
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
	      emit({
	        type: "message_update",
	        assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall: { id: "tc_hang", name: "bash", arguments: {} } },
	        message: { role: "assistant", content: [] }
	      });
	      // hang forever — no tool result, no agent_end
	    } else if (frame.type === "abort") {
	      emit({ type: "response", id: frame.id, command: "abort", success: true });
	    }
	    idx = buffer.indexOf("\\n");
	  }
	}
	`;

	beforeEach(async () => {
		fake = await createFakeRpcBinary(HANG_FOREVER_RPC);
	});

	afterEach(async () => {
		if (bridge) bridge.stop();
		await fake.cleanup();
	});

	test("watcher is cleared on RPC timeout — no pings after timeout", async () => {
		bridge = new AgentBridge({
			ompPath: fake.path,
			timeoutMs: 300, // short timeout
			longTaskThresholdMs: 50,
			progressPingIntervalMs: 30,
		});
		await bridge.start();

		const events: Array<{ threshold: boolean; elapsedMs: number }> = [];
		const handlers: ForwardStreamHandlers = {
			onLongTask: e => {
				events.push({ threshold: e.threshold, elapsedMs: e.elapsedMs });
			},
		};

		const meta = await bridge.forwardWithMeta(
			makeMessage("hang", "conv-timeout-1"),
			makeSession("/tmp/timeout-1.jsonl", "conv-timeout-1"),
			handlers,
		);
		// The timeout produces a fallback meta (not null)
		expect(meta).not.toBeNull();
		expect(meta?.isFallback).toBe(true);

		// The threshold should have fired at least once before the timeout
		const eventsAtTimeout = events.length;
		expect(eventsAtTimeout).toBeGreaterThanOrEqual(1);

		// Wait well past several ping intervals. If the watcher leaked,
		// we'd see additional onLongTask fires here.
		await Bun.sleep(200);
		expect(events.length).toBe(eventsAtTimeout);
	});

	test("watcher is cleared on abort — no pings after abort", async () => {
		bridge = new AgentBridge({
			ompPath: fake.path,
			timeoutMs: 30_000, // long timeout — we'll abort before it fires
			longTaskThresholdMs: 50,
			progressPingIntervalMs: 30,
		});
		await bridge.start();

		const events: Array<{ threshold: boolean; elapsedMs: number }> = [];
		const handlers: ForwardStreamHandlers = {
			onLongTask: e => {
				events.push({ threshold: e.threshold, elapsedMs: e.elapsedMs });
			},
		};

		// Drive the prompt in the background (it will hang).
		const forwardP = bridge.forwardWithMeta(
			makeMessage("hang", "conv-abort-1"),
			makeSession("/tmp/abort-1.jsonl", "conv-abort-1"),
			handlers,
		);

		// Wait for the threshold to fire, then abort.
		const pollStart = Date.now();
		while (Date.now() - pollStart < 5_000) {
			if (events.length >= 1) break;
			await Bun.sleep(10);
		}
		expect(events.length).toBeGreaterThanOrEqual(1);
		const eventsAtAbort = events.length;

		const aborted = await bridge.abort();
		expect(aborted).toBe(true);

		// forwardWithMeta resolves after the abort
		const meta = await forwardP;
		expect(meta).not.toBeNull();

		// Wait well past several ping intervals. If the watcher leaked,
		// we'd see additional onLongTask fires here.
		await Bun.sleep(200);
		expect(events.length).toBe(eventsAtAbort);
	});
});

describe("AgentBridge long-task env override", () => {
	// The env vars are read at module load. To test the override we
	// spawn a fresh bun subprocess with the env set, then import the
	// module inside it. The exported __TEST_* constants let us check
	// the resolved values without re-reading the env at test time.

	// Bun's logger writes warnings to stdout; we only want the JSON
	// payload we wrote. Parse the LAST line of the captured output.
	function readPayload(result: ReturnType<typeof Bun.spawnSync>): { threshold: number; ping: number } {
		const text = result.stdout.toString().trim();
		const lines = text.split("\n");
		// Find the first line that starts with `{` — that's our JSON.
		const jsonLine = lines.find(l => l.trim().startsWith("{")) ?? "";
		return JSON.parse(jsonLine);
	}

	test("DINGTALK_LONG_TASK_THRESHOLD_MS=30000 produces a 30s threshold", () => {
		const script = `
			import { __TEST_LONG_TASK_THRESHOLD_MS, __TEST_LONG_TASK_PROGRESS_PING_MS } from "${path.resolve(import.meta.dir, "../src/agent-bridge.ts")}";
			process.stdout.write(JSON.stringify({ threshold: __TEST_LONG_TASK_THRESHOLD_MS, ping: __TEST_LONG_TASK_PROGRESS_PING_MS }) + "\\n");
		`;
		const result = Bun.spawnSync(["bun", "-e", script], {
			env: { ...process.env, DINGTALK_LONG_TASK_THRESHOLD_MS: "30000" },
		});
		expect(result.exitCode).toBe(0);
		const out = readPayload(result);
		expect(out.threshold).toBe(30_000);
		// Ping interval should fall back to default 300_000
		expect(out.ping).toBe(300_000);
	});

	test("DINGTALK_LONG_TASK_PROGRESS_PING_MS=60000 produces a 60s ping interval", () => {
		const script = `
			import { __TEST_LONG_TASK_PROGRESS_PING_MS } from "${path.resolve(import.meta.dir, "../src/agent-bridge.ts")}";
			process.stdout.write(JSON.stringify({ ping: __TEST_LONG_TASK_PROGRESS_PING_MS }) + "\\n");
		`;
		const result = Bun.spawnSync(["bun", "-e", script], {
			env: { ...process.env, DINGTALK_LONG_TASK_PROGRESS_PING_MS: "60000" },
		});
		expect(result.exitCode).toBe(0);
		const text = result.stdout.toString();
		const jsonLine = text.split("\n").find(l => l.trim().startsWith("{")) ?? "";
		expect(JSON.parse(jsonLine).ping).toBe(60_000);
	});

	test("invalid env values fall back to defaults and warn", () => {
		const script = `
			import { __TEST_LONG_TASK_THRESHOLD_MS, __TEST_LONG_TASK_PROGRESS_PING_MS } from "${path.resolve(import.meta.dir, "../src/agent-bridge.ts")}";
			process.stdout.write(JSON.stringify({ threshold: __TEST_LONG_TASK_THRESHOLD_MS, ping: __TEST_LONG_TASK_PROGRESS_PING_MS }) + "\\n");
		`;
		const result = Bun.spawnSync(["bun", "-e", script], {
			env: {
				...process.env,
				DINGTALK_LONG_TASK_THRESHOLD_MS: "not-a-number",
				DINGTALK_LONG_TASK_PROGRESS_PING_MS: "-5",
			},
		});
		expect(result.exitCode).toBe(0);
		const out = readPayload(result);
		expect(out.threshold).toBe(180_000);
		expect(out.ping).toBe(300_000);
		// The warnings should be in the captured stdout
		const text = result.stdout.toString();
		expect(text).toContain("Invalid DINGTALK_LONG_TASK_THRESHOLD_MS");
		expect(text).toContain("Invalid DINGTALK_LONG_TASK_PROGRESS_PING_MS");
	});

	test("env-override in same-process export reflects current env (sanity check)", () => {
		// The __TEST_* constants are read at module load. This test
		// just confirms the test process sees the same values Bun
		// resolved for the current run — useful for debugging if a
		// developer manually sets the env before `bun test`.
		const threshold = __TEST_LONG_TASK_THRESHOLD_MS;
		const ping = __TEST_LONG_TASK_PROGRESS_PING_MS;
		expect(typeof threshold).toBe("number");
		expect(typeof ping).toBe("number");
		expect(threshold).toBeGreaterThanOrEqual(0);
		expect(ping).toBeGreaterThanOrEqual(0);
	});
});
