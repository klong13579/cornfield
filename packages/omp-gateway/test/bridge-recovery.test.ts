/**
 * AgentBridge crash recovery + stderr tail diagnostics.
 *
 * Regression for the Aug 2026 incident: a bridge whose OMP subprocess died
 * (exit 133 / SIGTRAP) stayed `stopped` forever — the SessionManager
 * rejected inbound messages with "Agent bridge for account X is not
 * running" before the bridge's own restart path (`forwardWithMeta` →
 * `#restartTransport`) could run, and the child's stderr (panic output)
 * was discarded by the transport, so the crash root cause was unrecoverable.
 *
 * Covered here:
 *   - SessionManager + real AgentBridge: a crashed bridge is restarted on
 *     the next inbound message and the message is forwarded successfully.
 *   - after-ready crash: the child's stderr tail is persisted in the crash
 *     log alongside the exit code.
 *   - before-ready spawn failure: `start()` rejects with an error carrying
 *     the stderr tail, and it lands in the crash log too.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentBridge } from "../src/agent-bridge";
import { CrashLog } from "../src/crash-log";
import { SessionManager } from "../src/session-manager";
import type { InboundMessage, SessionRecord } from "../src/types";

// ═══════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════

interface FakeBinary {
	path: string;
	cleanup: () => Promise<void>;
}

async function createFakeRpcBinary(script: string, prefix: string): Promise<FakeBinary> {
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
// Crash-then-recover fake: spawn #1 emits ready and exits(5) (simulating
// the SIGTRAP death); subsequent spawns run a normal RPC loop so the
// bridge can recover and answer prompts.
// ═══════════════════════════════════════════════════════════════════════

const CRASH_ONCE_SCRIPT = `#!/usr/bin/env bun
import * as fs from "node:fs";
const stateFile = process.env.FAKE_RPC_STATE;
let spawns = 0;
try {
  spawns = Number(fs.readFileSync(stateFile, "utf8"));
} catch {}
fs.writeFileSync(stateFile, String(spawns + 1));
function emit(value) {
  process.stdout.write(JSON.stringify(value) + "\\n");
}
if (spawns === 0) {
  emit({ type: "ready", protocol_version: 1 });
  process.exit(5); // after-ready crash, like the 8/10 SIGTRAP
}
emit({ type: "ready", protocol_version: 1 });
let buffer = "";
async function handleFrame(frame) {
  if (frame.type === "switch_session") {
    emit({ type: "response", id: frame.id, command: "switch_session", success: true, data: { cancelled: false } });
    return;
  }
  if (frame.type === "prompt") {
    emit({ type: "response", id: frame.id, command: "prompt", success: true });
    setTimeout(() => {
      emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "recovered: " + frame.message }] } });
      emit({ type: "agent_end" });
    }, 0);
    return;
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

// After-ready crash that writes a panic-looking trace to stderr before dying.
const CRASH_WITH_STDERR_SCRIPT = `#!/usr/bin/env bun
function emit(value) {
  process.stdout.write(JSON.stringify(value) + "\\n");
}
emit({ type: "ready", protocol_version: 1 });
process.stderr.write("Bun panic: fake crash trace\\n  at fakeModule (fake:1:1)\\n  at secondFrame (fake:2:2)\\n");
await Bun.sleep(100);
process.exit(5);
`;

// Spawn-time failure (before ready) with a config error on stderr.
const FAIL_BEFORE_READY_SCRIPT = `#!/usr/bin/env bun
process.stderr.write("config error: unknown provider 'fake'\\n");
await Bun.sleep(100);
process.exit(1);
`;

describe("AgentBridge crash recovery via SessionManager", () => {
	test("restarts a crashed bridge on the next inbound message", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gateway-recover-"));
		const stateFile = path.join(dir, "spawn-count");
		Bun.env.FAKE_RPC_STATE = stateFile;
		const fake = await createFakeRpcBinary(CRASH_ONCE_SCRIPT, "omp-gateway-recover-rpc-");
		const bridge = new AgentBridge({ ompPath: fake.path, crashBackoffMs: 1, maxCrashRetries: 3 });
		const manager = new SessionManager({ bridges: new Map([["ops", bridge]]) });
		try {
			await bridge.start();
			// spawn #1 died right after ready — wait for the disconnected
			// event to land and the bridge to settle into `stopped`.
			await Bun.sleep(100);
			expect(bridge.isRunning).toBe(false);
			expect(bridge.getSnapshot().state).toBe("stopped");

			// The pre-fix behaviour rejected this message. Post-fix it must
			// restart the bridge and forward normally.
			const meta = await manager.enqueueWithMeta(
				makeMessage("hello", "conv-a"),
				makeSession("/tmp/session-a.jsonl", "conv-a"),
			);
			expect(meta?.text).toContain("recovered: hello");
			expect(bridge.isRunning).toBe(true);
			expect(bridge.getSnapshot().state).toBe("idle");
		} finally {
			bridge.stop();
			await fake.cleanup();
			Bun.env.FAKE_RPC_STATE = "";
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});

describe("AgentBridge stderr tail diagnostics", () => {
	test("persists the child stderr tail for an after-ready crash", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gateway-stderr-"));
		const crashLogPath = path.join(dir, "crash_log.jsonl");
		const crashLog = new CrashLog(crashLogPath);
		const fake = await createFakeRpcBinary(CRASH_WITH_STDERR_SCRIPT, "omp-gateway-stderr-rpc-");
		const bridge = new AgentBridge({ ompPath: fake.path, accountId: "ops", crashLog, crashBackoffMs: 1 });
		try {
			await bridge.start();
			await Bun.sleep(300); // disconnected → crash log write
			expect(bridge.isRunning).toBe(false);

			const entries = await crashLog.recent("ops");
			const crash = entries.find(e => e.kind === "crash");
			expect(crash).toBeDefined();
			expect(crash?.exitCode).toBe(5);
			expect(crash?.reason).toContain("exited with code 5 after ready");
			expect(crash?.stderrTail).toContain("Bun panic: fake crash trace");
			expect(crash?.stderrTail).toContain("secondFrame");
		} finally {
			bridge.stop();
			await fake.cleanup();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test("carries the stderr tail through a before-ready spawn failure", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gateway-beforeready-"));
		const crashLogPath = path.join(dir, "crash_log.jsonl");
		const crashLog = new CrashLog(crashLogPath);
		const fake = await createFakeRpcBinary(FAIL_BEFORE_READY_SCRIPT, "omp-gateway-beforeready-rpc-");
		const bridge = new AgentBridge({
			ompPath: fake.path,
			accountId: "ops",
			crashLog,
			crashBackoffMs: 1,
			maxCrashRetries: 0,
		});
		try {
			await expect(bridge.start()).rejects.toThrow("before ready");

			const entries = await crashLog.recent("ops");
			const crash = entries.find(e => e.kind === "crash");
			expect(crash).toBeDefined();
			expect(crash?.reason).toContain("bridge.start() failed");
			expect(crash?.stderrTail).toContain("unknown provider 'fake'");
		} finally {
			bridge.stop();
			await fake.cleanup();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});

// Child dies mid-prompt (like the 8/20 withModelFallback crash at turn
// finalize). Regression: the pending prompt used to sit unresolved until the
// inactivity/streaming watchdogs fired — 13-18 minutes in prod. The bridge
// must reject it on `disconnected`, then auto-restart on the next prompt.
const CRASH_ONCE_MID_PROMPT_SCRIPT = `#!/usr/bin/env bun
import * as fs from "node:fs";
const stateFile = process.env.FAKE_RPC_STATE;
let spawns = 0;
try {
  spawns = Number(fs.readFileSync(stateFile, "utf8"));
} catch {}
fs.writeFileSync(stateFile, String(spawns + 1));
function emit(value) {
  process.stdout.write(JSON.stringify(value) + "\\n");
}
emit({ type: "ready", protocol_version: 1 });
let buffer = "";
async function handleFrame(frame) {
  if (frame.type !== "prompt") return;
  emit({ type: "response", id: frame.id, command: "prompt", success: true });
  if (spawns === 0) {
    setTimeout(() => {
      emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "partial" }] } });
      process.exit(1); // die mid-turn, like the finalize crash
    }, 50);
    return;
  }
  setTimeout(() => {
    emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "recovered: " + frame.message }] } });
    emit({ type: "agent_end" });
  }, 0);
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

describe("AgentBridge fail-fast on mid-prompt child death", () => {
	test("rejects the in-flight prompt fast on disconnected, next prompt auto-restarts", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gateway-failfast-"));
		const stateFile = path.join(dir, "spawn-count");
		Bun.env.FAKE_RPC_STATE = stateFile;
		const fake = await createFakeRpcBinary(CRASH_ONCE_MID_PROMPT_SCRIPT, "omp-gateway-failfast-rpc-");
		const bridge = new AgentBridge({ ompPath: fake.path, crashBackoffMs: 1, maxCrashRetries: 3 });
		try {
			await bridge.start();

			const started = Date.now();
			// Fail-fast: rejects with the crash (not the 10s inactivity watchdog).
			await expect(bridge.executePrompt("hello", { inactivityMs: 10_000 })).rejects.toThrow(/exited/);
			const elapsed = Date.now() - started;
			expect(elapsed).toBeLessThan(5_000);
			expect(bridge.isRunning).toBe(false); // warm child died with the prompt

			// Next prompt restarts the child automatically and succeeds.
			const meta = await bridge.executePrompt("world", { inactivityMs: 10_000 });
			expect(meta).toContain("recovered: world");
			expect(bridge.isRunning).toBe(true);
		} finally {
			bridge.stop();
			await fake.cleanup();
			Bun.env.FAKE_RPC_STATE = "";
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
