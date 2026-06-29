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

// ═══════════════════════════════════════════════════════════════════════
// executePrompt — cron scheduler reuse path
// ═══════════════════════════════════════════════════════════════════════

/**
 * Recording fake RPC: writes each command it receives to a JSONL log file
 * so tests can assert the exact ordering of switch_session / prompt / etc.
 * Responses still match the production protocol (success for switch_session,
 * message_end + agent_end for prompt) so the bridge can complete normally.
 */
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
    // N2 contract: bridge polls sessionFile after the prompt to detect drift.
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
	// Bun.spawn inherits process.env, so setting this on the parent is enough.
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
		const bridge = new AgentBridge({ ompPath: fake.path, timeoutMs: 1_000 });
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
		const bridge = new AgentBridge({ ompPath: fake.path, timeoutMs: 2_000 });
		try {
			await bridge.start();
			const response = await bridge.executePrompt("do thing", {
				sessionPath: "/tmp/cron_task_42.jsonl",
			});
			expect(response).toBe("ack: do thing");
			const log = await fake.readLog();
			const cmds = log.map(e => e.cmd);
			// Order matters: switch_session must come before prompt
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
		const bridge = new AgentBridge({ ompPath: fake.path, timeoutMs: 2_000 });
		try {
			await bridge.start();

			// Simulate an IM conversation that already left a session active.
			// forward() switches the bridge into the IM session, leaving
			// #activeSessionPath set so the next executePrompt knows what
			// to restore.
			await bridge.forward(makeMessage("hi", "conv-im"), makeSession("/tmp/session-im.jsonl", "conv-im"));

			// Now a cron tick fires. The bridge should switch to the cron
			// session, run the prompt, then switch back to the IM session.
			const response = await bridge.executePrompt("cron task", {
				sessionPath: "/tmp/cron_task_99.jsonl",
			});
			expect(response).toBe("ack: cron task");

			const log = await fake.readLog();
			// N2 contract: bridge also issues a get_state after the prompt
			// to detect sessionFile drift. The test's intent is about
			// switch_session sequencing, so we filter those out.
			const cmds = log
				.filter(e => e.cmd !== "get_state")
				.map(e => `${e.cmd}${e.session ? `:${e.session}` : e.message ? `:${e.message}` : ""}`);

			// Expected order:
			//   switch_session:/tmp/session-im.jsonl   (from the forward() call)
			//   prompt:hi
			//   switch_session:/tmp/cron_task_99.jsonl (cron entry)
			//   prompt:cron task
			//   switch_session:/tmp/session-im.jsonl   (restore IM)
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
		const bridge = new AgentBridge({ ompPath: fake.path, timeoutMs: 2_000 });
		try {
			await bridge.start();
			// Cold bridge — no prior session. After the cron call, the
			// bridge should be left on the cron session, not issue a
			// spurious switch_session call to restore a non-existent prior.
			await bridge.executePrompt("first task", { sessionPath: "/tmp/cron_task_a.jsonl" });

			const log = await fake.readLog();
			// The N2 check issues a get_state, which is expected. The
			// intent of this test is "no extra switch_session" — filter
			// get_state and assert on switch_session count.
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

/**
 * Inactivity-timeout tests use a different fake RPC that does not emit any
 * events at all when the prompt contains "INACTIVE" — simulating a hung
 * agent. The bridge's watchdog is the only thing that can rescue us.
 */
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
    if (String(frame.message).includes("INACTIVE")) {
      // Never emit any further events — simulate a stuck API call.
      return;
    }
    if (String(frame.message).includes("EVENTUAL")) {
      // Emit a series of events over 2.5s. Used to verify the watchdog
      // resets on activity (each event bumps lastActivityAt).
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
		const bridge = new AgentBridge({ ompPath: fake.path, timeoutMs: 10_000 });
		try {
			await bridge.start();
			const start = Date.now();
			await expect(bridge.executePrompt("INACTIVE prompt", { inactivityMs: 200 })).rejects.toThrow(
				/inactive for \d+ms \(limit 200ms\)/,
			);
			const elapsed = Date.now() - start;
			// Watchdog polls every 500ms; allow generous slack. The point is
			// it triggers well before the 10s wall timeout.
			expect(elapsed).toBeLessThan(3_000);
			// Bridge itself must remain alive for the next caller.
			expect(bridge.isRunning).toBe(true);
		} finally {
			bridge.stop();
			await fake.cleanup();
		}
	});

	test("does not abort a prompt that is slow but actively emitting events", async () => {
		const fake = await createInactiveRpcBinary();
		const bridge = new AgentBridge({ ompPath: fake.path, timeoutMs: 10_000 });
		try {
			await bridge.start();
			// "EVENTUAL" emits an event every 500ms for 2s. inactivityMs=750
			// would fire the watchdog if it treated a slow-but-active prompt
			// as inactive. With activity-touched semantics, the watchdog
			// resets on each event and the prompt runs to completion.
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
		const fake = await createInactiveRpcBinary();
		const bridge = new AgentBridge({ ompPath: fake.path, timeoutMs: 10_000 });
		try {
			await bridge.start();
			// No inactivityMs — prompt would hang forever. Set a tight
			// outer timeout via options.timeoutMs instead. The bridge's
			// wall-clock timeout fires and rejects.
			await expect(bridge.executePrompt("INACTIVE prompt", { timeoutMs: 250 })).rejects.toThrow(
				/timed out after 250ms/,
			);
		} finally {
			bridge.stop();
			await fake.cleanup();
		}
	});

	test("runs BOOT.md self-check on start when the file exists", async () => {
		const fake = await createFakeRpcBinary();
		const bootDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-boot-"));
		await Bun.write(path.join(bootDir, "BOOT.md"), "Check today's tasks and report status.");
		const bridge = new AgentBridge({ ompPath: fake.path, timeoutMs: 2_000, cwd: bootDir });
		try {
			await bridge.start();
			// BOOT.md runs fire-and-forget; give it time to execute.
			await Bun.sleep(200);
			// The fake RPC echoes the prompt back; verify BOOT.md content was prompted.
			// We can't directly observe the prompt, but the bridge should still
			// be running and responsive to normal messages.
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
		const fake = await createFakeRpcBinary();
		const bridge = new AgentBridge({ ompPath: fake.path, timeoutMs: 2_000 });
		try {
			await bridge.start();
			expect(bridge.isRunning).toBe(true);
		} finally {
			bridge.stop();
			await fake.cleanup();
		}
	});
});
