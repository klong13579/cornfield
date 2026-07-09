/**
 * Crash repro tests for the 2026-07-09 14:32 gateway incident.
 *
 * Production context: gateway pid 71070 died silently after the bridge
 * watchdog fired (60s no session event). No crash report, no error log,
 * no kernel kill signal. Crash handlers in commands/gateway.ts:149-188
 * were registered but never logged anything.
 *
 * These tests target the suspected crash paths at the bridge level. If a
 * test triggers an uncaughtException or unhandledRejection, we found the
 * root cause path. If all four pass clean, the bridge is not the culprit
 * and the root cause is in the channel layer (DingTalk SDK 'error' event
 * hypothesis).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentBridge, type ForwardStreamHandlers } from "../src/agent-bridge";
import type { InboundMessage, SessionRecord } from "../src/types";

// ═══════════════════════════════════════════════════════════════════════
// Uncaught exception / unhandled rejection tracking
//
// The gateway's own crash handler (commands/gateway.ts:161-188) only logs
// and continues. If the bridge leaks an unhandled error here, it would
// accumulate to 10/60s and trigger process.exit(1) in production. In a
// test, bun:test will surface the error — we capture it explicitly so the
// test fails with a clear message instead of an opaque crash dump.
// ═══════════════════════════════════════════════════════════════════════

const uncaughtExceptions: { err: unknown; stack?: string }[] = [];
const unhandledRejections: { reason: unknown; stack?: string }[] = [];
let uncaughtListener: ((err: Error) => void) | null = null;
let unhandledListener: ((reason: unknown) => void) | null = null;

beforeEach(() => {
	uncaughtExceptions.length = 0;
	unhandledRejections.length = 0;
	uncaughtListener = err => {
		uncaughtExceptions.push({
			err,
			stack: err instanceof Error ? err.stack : undefined,
		});
	};
	unhandledListener = reason => {
		const r = reason instanceof Error ? reason : new Error(String(reason));
		unhandledRejections.push({
			reason,
			stack: r.stack,
		});
	};
	process.on("uncaughtException", uncaughtListener);
	process.on("unhandledRejection", unhandledListener);
});

afterEach(() => {
	if (uncaughtListener) {
		process.removeListener("uncaughtException", uncaughtListener);
		uncaughtListener = null;
	}
	if (unhandledListener) {
		process.removeListener("unhandledRejection", unhandledListener);
		unhandledListener = null;
	}
});

// ═══════════════════════════════════════════════════════════════════════
// Fake RPC scripts
// ═══════════════════════════════════════════════════════════════════════

/** OMP child that receives the prompt but never emits any session events
 *  — simulates a long-running bash call blocking the agent event loop.
 *  This is the exact pattern from the 2026-07-09 14:31:22 → 14:32:28
 *  production sequence.
 *  Also handles `switch_session` and `set_model` so the bridge's
 *  pre-prompt commands don't hang. */
const LONG_INACTIVE_SCRIPT = `#!/usr/bin/env bun
process.stdout.write(JSON.stringify({ type: "ready" }) + "\\n");
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
    buffer += new TextDecoder().decode(chunk);
    let index = buffer.indexOf("\\n");
    while (index !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) {
            const frame = JSON.parse(line);
            if (frame.type === "switch_session") {
                process.stdout.write(JSON.stringify({ type: "response", id: frame.id, command: "switch_session", success: true, data: { cancelled: false } }) + "\\n");
            } else if (frame.type === "set_model") {
                process.stdout.write(JSON.stringify({ type: "response", id: frame.id, command: "set_model", success: true }) + "\\n");
            } else if (frame.type === "prompt") {
                process.stdout.write(JSON.stringify({ type: "response", id: frame.id, command: "prompt", success: true }) + "\\n");
            } else if (frame.type === "abort") {
                process.stdout.write(JSON.stringify({ type: "response", id: frame.id, command: "abort", success: true }) + "\\n");
            }
        }
        index = buffer.indexOf("\\n");
    }
}
`;

/** OMP child that exits cleanly after acknowledging the prompt — simulates
 *  an OMP child crash mid-prompt. The transport's `proc.exited` promise
 *  resolves, which fires the transport's `disconnected` event. */
const CRASH_MID_PROMPT_SCRIPT = `#!/usr/bin/env bun
process.stdout.write(JSON.stringify({ type: "ready" }) + "\\n");
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
    buffer += new TextDecoder().decode(chunk);
    let index = buffer.indexOf("\\n");
    while (index !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) {
            const frame = JSON.parse(line);
            if (frame.type === "switch_session") {
                process.stdout.write(JSON.stringify({ type: "response", id: frame.id, command: "switch_session", success: true, data: { cancelled: false } }) + "\\n");
            } else if (frame.type === "set_model") {
                process.stdout.write(JSON.stringify({ type: "response", id: frame.id, command: "set_model", success: true }) + "\\n");
            } else if (frame.type === "prompt") {
                process.stdout.write(JSON.stringify({ type: "response", id: frame.id, command: "prompt", success: true }) + "\\n");
                process.exit(1);
            }
        }
        index = buffer.indexOf("\\n");
    }
}
`;

/** OMP child that emits a normal response — used to test the handler-throw
 *  path (Test 4) where the RPC works fine but a registered handler throws. */
const NORMAL_RESPONSE_SCRIPT = `#!/usr/bin/env bun
process.stdout.write(JSON.stringify({ type: "ready" }) + "\\n");
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
    buffer += new TextDecoder().decode(chunk);
    let index = buffer.indexOf("\\n");
    while (index !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) {
            const frame = JSON.parse(line);
            if (frame.type === "switch_session") {
                process.stdout.write(JSON.stringify({ type: "response", id: frame.id, command: "switch_session", success: true, data: { cancelled: false } }) + "\\n");
            } else if (frame.type === "set_model") {
                process.stdout.write(JSON.stringify({ type: "response", id: frame.id, command: "set_model", success: true }) + "\\n");
            } else if (frame.type === "prompt") {
                process.stdout.write(JSON.stringify({ type: "response", id: frame.id, command: "prompt", success: true }) + "\\n");
                setTimeout(() => {
                    process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }) + "\\n");
                    process.stdout.write(JSON.stringify({ type: "agent_end" }) + "\\n");
                }, 10);
            }
        }
        index = buffer.indexOf("\\n");
    }
}
`;

// ═══════════════════════════════════════════════════════════════════════
// Helpers (modeled on packages/pi-gateway/test/agent-bridge.test.ts)
// ═══════════════════════════════════════════════════════════════════════

interface FakeBinary {
	path: string;
	cleanup: () => Promise<void>;
}

async function createFakeRpcBinary(script: string, prefix = "pi-gateway-crash-"): Promise<FakeBinary> {
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
		accountId: "test",
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
		accountId: "test",
		userId: "user",
		conversationId,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		ompSessionPath: sessionPath,
		status: "active",
	};
}

// ═══════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════

describe("Gateway crash repro: 2026-07-09 14:32", () => {
	test("Test 1: forward() with long-inactive RPC returns fallback, bridge survives, no unhandled errors", async () => {
		// Reproduces: OMP child doing a 2-min bash call, bridge watchdog fires.
		// Expected: bridge returns fallback text (don't hang), isRunning stays
		// true, no uncaughtException / unhandledRejection.
		// If this test fires an uncaughtException, the watchdog abort path
		// leaks an error — that's the production root cause.
		const fake = await createFakeRpcBinary(LONG_INACTIVE_SCRIPT);
		const bridge = new AgentBridge({
			ompPath: fake.path,
			streamingWatchdogMs: 300, // fire after 300ms of no events
		});
		try {
			await bridge.start();
			const start = Date.now();
			const result = await bridge.forward(
				makeMessage("test", "conv-1"),
				makeSession("/tmp/crash-session-1.jsonl", "conv-1"),
			);
			const elapsed = Date.now() - start;

			// Bridge must return a fallback, not hang
			expect(result).not.toBeNull();
			expect(typeof result).toBe("string");
			expect((result as string).length).toBeGreaterThan(0);
			// Streaming watchdog should have fired within 2s
			expect(elapsed).toBeLessThan(2_000);

			// Bridge must still be running
			expect(bridge.isRunning).toBe(true);

			// No leaked errors — this is the root-cause assertion
			expect(uncaughtExceptions).toHaveLength(0);
			expect(unhandledRejections).toHaveLength(0);
		} finally {
			bridge.stop();
			await fake.cleanup();
		}
	});

	test("Test 2: forward() with RPC that exits mid-prompt is handled gracefully", async () => {
		// Reproduces: OMP child crashes mid-prompt, transport emits
		// 'disconnected', bridge's #handleTransportEvent records the crash.
		// The streaming watchdog should still fire and return a fallback.
		// If transport's `void proc.exited.then(...)` (agent-transport.ts:368)
		// leaks an error from the emit handler, this test catches it.
		const fake = await createFakeRpcBinary(CRASH_MID_PROMPT_SCRIPT);
		const bridge = new AgentBridge({
			ompPath: fake.path,
			streamingWatchdogMs: 300,
		});
		try {
			await bridge.start();
			const start = Date.now();
			const result = await bridge.forward(
				makeMessage("test", "conv-2"),
				makeSession("/tmp/crash-session-2.jsonl", "conv-2"),
			);
			const elapsed = Date.now() - start;

			expect(result).not.toBeNull();
			expect(typeof result).toBe("string");
			expect(elapsed).toBeLessThan(2_000);

			// Transport disconnect must not leak an unhandled error
			expect(uncaughtExceptions).toHaveLength(0);
			expect(unhandledRejections).toHaveLength(0);
		} finally {
			bridge.stop();
			await fake.cleanup();
		}
	});

	test("Test 3: 15 consecutive forward() failures don't crash the process or hit uncaughtException threshold", async () => {
		// Reproduces: threshold scenario. The production crash hypothesis is
		// that the gateway's uncaughtException handler accumulates errors and
		// exits at 10/60s. This test triggers 15 consecutive failures in
		// quick succession — if any forward() leaks an error, we'd see it
		// here. Also stress-tests the circuit breaker (CIRCUIT_FAILURE_THRESHOLD=10).
		const fake = await createFakeRpcBinary(LONG_INACTIVE_SCRIPT);
		const bridge = new AgentBridge({
			ompPath: fake.path,
			streamingWatchdogMs: 200,
		});
		try {
			await bridge.start();
			for (let i = 0; i < 15; i++) {
				const result = await bridge.forward(
					makeMessage(`test-${i}`, `conv-${i}`),
					makeSession(`/tmp/crash-session-${i}.jsonl`, `conv-${i}`),
				);
				// Every call must return a string (fallback or circuit-open message)
				expect(result).not.toBeNull();
				expect(typeof result).toBe("string");
				expect((result as string).length).toBeGreaterThan(0);
			}

			// 15 failures must not leak a single unhandled error
			expect(uncaughtExceptions).toHaveLength(0);
			expect(unhandledRejections).toHaveLength(0);
		} finally {
			bridge.stop();
			await fake.cleanup();
		}
	});

	test("Test 4: forwardWithMeta() with a handler that throws is caught gracefully", async () => {
		// Reproduces: a streaming handler (the channel's `submit(handlers)`
		// callback) throws synchronously when the bridge calls it. In
		// production, this is the suspected path for the DingTalk SDK
		// 'error' event — the SDK throws `Unhandled "error" event`, which
		// the bridge calls handler might propagate.
		// If this test fires an uncaughtException, the handler-throw path
		// is unhandled — that's the production root cause.
		const fake = await createFakeRpcBinary(NORMAL_RESPONSE_SCRIPT);
		const bridge = new AgentBridge({ ompPath: fake.path });
		try {
			await bridge.start();
			const throwingHandlers: ForwardStreamHandlers = {
				onAgentEnd: () => {
					throw new Error("simulated SDK 'error' event from handler");
				},
			};
			const result = await bridge.forwardWithMeta(
				makeMessage("test", "conv-4"),
				makeSession("/tmp/crash-session-4.jsonl", "conv-4"),
				throwingHandlers,
			);

			// Bridge should still return a result (text or fallback)
			expect(result).not.toBeNull();
			expect(uncaughtExceptions).toHaveLength(0);
			expect(unhandledRejections).toHaveLength(0);
		} finally {
			bridge.stop();
			await fake.cleanup();
		}
	});
});
