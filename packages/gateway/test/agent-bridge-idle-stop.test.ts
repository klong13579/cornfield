/**
 * AgentBridge idle-stop contract.
 *
 * The child process costs ~250-290MB of footprint whether or not it is working
 * (measured 2026-09-19: five per-account children, 1.43GB resident around the
 * clock). `parkChild()` gives that memory back after a quiet window and the
 * next prompt respawns the child through the crash-recovery path.
 *
 * What this file pins down:
 *   1. Parking releases the child but is NOT a failure — no crash recorded, no
 *      circuit trip, and status reports `parked`, not `stopped`.
 *   2. A prompt in flight owns the child; parking cannot yank it mid-turn.
 *   3. Waking re-attaches the session: the respawned child receives a fresh
 *      `switch_session` for the conversation's file. This is the regression
 *      guard for the stale-`#activeSessionPath` hazard — if parking left the
 *      cached path in place, the next `#switchSession` would early-return and
 *      the conversation would silently continue in a different session file.
 *   4. The idle timer parks on its own, and 0 disables it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentBridge, type AgentBridgeOptions } from "../src/agent-bridge";
import type { InboundMessage, SessionRecord } from "../src/types";

/**
 * Fake wire-stdio child.
 *
 * Speaks just enough of the protocol for the bridge, and appends every command
 * type it receives to `$FAKE_CHILD_LOG` so tests can assert on what the child
 * was actually told (not on the bridge's internal bookkeeping).
 */
const FAKE_CHILD_SCRIPT = `#!/usr/bin/env bun
const logPath = process.env.FAKE_CHILD_LOG;
function note(line) {
  if (logPath) {
    try {
      require("node:fs").appendFileSync(logPath, line + "\\n");
    } catch {}
  }
}
let buffer = "";
function emit(value) {
  process.stdout.write(JSON.stringify(value) + "\\n");
}
function pushEvent(event) {
  emit({ type: "push", event: { type: "progress", sessionId: "s1", event } });
}
async function handleFrame(frame) {
  if (frame.type === "hello") {
    note("hello");
    emit({ type: "hello_ack", connectionId: "idle-stop", protocolVersion: 1 });
    return;
  }
  if (frame.type !== "request") return;
  const cmd = frame.command;
  note(cmd.type);
  switch (cmd.type) {
    case "switch_session":
      emit({ type: "response", id: frame.id, ok: true, result: { cancelled: false } });
      return;
    case "prompt":
      emit({ type: "response", id: frame.id, ok: true });
      // Configurable so tests can observe the bridge while a prompt is in
      // flight (the busy guard) without racing the completion.
      const delayMs = Number(process.env.FAKE_CHILD_PROMPT_DELAY_MS ?? 20);
      setTimeout(() => {
        pushEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } });
        pushEvent({ type: "agent_end" });
      }, delayMs);
      return;
    default:
      // set_model / set_host_tools / set_disabled_toolsets / abort / compact
      emit({ type: "response", id: frame.id, ok: true, result: {} });
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

type Harness = {
	bridge: AgentBridge;
	childLog: string;
	dir: string;
	cleanup: () => Promise<void>;
};

let savedChildLog: string | undefined;
let active: Harness | undefined;

async function startHarness(options: Partial<AgentBridgeOptions> = {}): Promise<Harness> {
	active = undefined;
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cornfield-idle-stop-"));
	const scriptPath = path.join(dir, "fake-wire-child");
	await Bun.write(scriptPath, FAKE_CHILD_SCRIPT);
	await fs.chmod(scriptPath, 0o755);

	const childLog = path.join(dir, "child.log");
	process.env.FAKE_CHILD_LOG = childLog;
	// Hold prompts long enough that a test can observe the bridge while one is
	// in flight; without this, the fake child finishes before the first poll.
	const savedPromptDelay = process.env.FAKE_CHILD_PROMPT_DELAY_MS;
	process.env.FAKE_CHILD_PROMPT_DELAY_MS = "400";

	const bridge = new AgentBridge({
		cornfieldPath: scriptPath,
		cwd: dir,
		accountId: "test-account",
		...options,
	});
	await bridge.start();

	const harness: Harness = {
		bridge,
		childLog,
		dir,
		cleanup: async () => {
			bridge.stop();
			delete process.env.FAKE_CHILD_LOG;
			if (savedPromptDelay === undefined) delete process.env.FAKE_CHILD_PROMPT_DELAY_MS;
			else process.env.FAKE_CHILD_PROMPT_DELAY_MS = savedPromptDelay;
			await fs.rm(dir, { recursive: true, force: true });
		},
	};
	active = harness;
	return harness;
}

async function childLogSpawns(harness: Harness): Promise<number> {
	const text = await Bun.file(harness.childLog)
		.text()
		.catch(() => "");
	return (text.match(/^hello$/gm) ?? []).length;
}

/** Poll until `predicate` holds, or fail the test after `timeoutMs`. */
async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (predicate()) return;
		await Bun.sleep(20);
	}
	throw new Error(`condition not met within ${timeoutMs}ms`);
}

function session(dir: string): SessionRecord {
	return {
		id: "sess-1",
		channelId: "dingtalk",
		accountId: "test-account",
		userId: "user-1",
		conversationId: "conv-1",
		createdAt: Date.now(),
		updatedAt: Date.now(),
		cornfieldSessionPath: path.join(dir, "conv-1.jsonl"),
		status: "active",
	};
}

function message(text: string): InboundMessage {
	return {
		channelId: "dingtalk",
		userId: "user-1",
		userName: "User",
		conversationId: "conv-1",
		isGroup: false,
		content: { type: "text", text },
		timestamp: new Date(),
	};
}

beforeEach(() => {
	savedChildLog = process.env.FAKE_CHILD_LOG;
});

afterEach(async () => {
	await active?.cleanup();
	active = undefined;
	if (savedChildLog === undefined) delete process.env.FAKE_CHILD_LOG;
	else process.env.FAKE_CHILD_LOG = savedChildLog;
});

describe("AgentBridge idle stop", () => {
	test("parkChild stops the child and reports parked — not a crash", async () => {
		const harness = await startHarness();
		const { bridge } = harness;
		expect(bridge.isRunning).toBe(true);
		const crashCountBefore = bridge.getSnapshot().crashCount;

		bridge.parkChild();

		expect(bridge.isRunning).toBe(false);
		expect(bridge.isParked).toBe(true);
		const snapshot = bridge.getSnapshot();
		// `parked` — an idle bridge that will wake on demand, not a dead one.
		expect(snapshot.state).toBe("parked");
		// A deliberate stop must not look like a crash: no crash accounting, no
		// circuit damage. Otherwise an idle-stop would eat into the crash window
		// and eventually suppress the bridge.
		expect(snapshot.crashCount).toBe(crashCountBefore);
		expect(snapshot.crashSuppressed).toBe(false);
		expect(snapshot.circuitFailures).toBe(0);
		expect(snapshot.circuitState).toBe("closed");
	});

	test("parkChild is a no-op while a prompt is in flight", async () => {
		const harness = await startHarness();
		const { bridge } = harness;
		const sess = session(harness.dir);

		const inflight = bridge.forward(message("hello"), sess);
		await waitFor(() => bridge.isBusy);

		bridge.parkChild();
		// The prompt owns the child: it must survive the park attempt.
		expect(bridge.isRunning).toBe(true);
		expect(bridge.isParked).toBe(false);

		await inflight;
		expect(bridge.isParked).toBe(false);
	});

	test("waking after a park respawns the child and re-attaches the session", async () => {
		const harness = await startHarness();
		const { bridge, childLog } = harness;
		const sess = session(harness.dir);

		await bridge.forward(message("first"), sess);
		const spawnsBeforePark = await childLogSpawns(harness);
		expect(spawnsBeforePark).toBe(1);

		bridge.parkChild();
		expect(bridge.isRunning).toBe(false);

		// Next inbound message: SessionManager calls ensureRunning() before
		// forwarding, which is the production wake path.
		await bridge.ensureRunning();
		expect(bridge.isRunning).toBe(true);
		expect(bridge.isParked).toBe(false);

		const text = await bridge.forward(message("second"), sess);
		expect(text).toBe("ok");

		expect(await childLogSpawns(harness)).toBe(2);
		const log = await Bun.file(childLog).text();
		const switchSessions = log.match(/^switch_session$/gm) ?? [];
		// One per child: the pre-park child, and the respawned one. If parking
		// left `#activeSessionPath` cached, the second switch_session would be
		// skipped and the conversation would land in a different session file.
		expect(switchSessions.length).toBe(2);
	});

	test("the idle timer parks by itself after the configured window", async () => {
		const harness = await startHarness({ childIdleStopMs: 60 });
		const { bridge } = harness;

		await waitFor(() => bridge.getSnapshot().state === "parked");
		expect(bridge.isRunning).toBe(false);
		// Still not a crash: the bridge must stay usable after a timer-driven park.
		expect(bridge.getSnapshot().crashCount).toBe(0);
		expect(bridge.getSnapshot().crashSuppressed).toBe(false);
	});

	test("the idle timer does not park mid-prompt", async () => {
		const harness = await startHarness({ childIdleStopMs: 60 });
		const { bridge } = harness;
		const sess = session(harness.dir);

		const inflight = bridge.forward(message("slow"), sess);
		await waitFor(() => bridge.isBusy);
		// Well past the window: work in flight is what keeps the child alive, so
		// the timer must re-arm instead of pulling the child out from under it.
		await Bun.sleep(150);
		expect(bridge.isRunning).toBe(true);

		await inflight;
		await waitFor(() => bridge.getSnapshot().state === "parked");
	});

	test("childIdleStopMs: 0 disables the timer", async () => {
		const harness = await startHarness({ childIdleStopMs: 0 });
		const { bridge } = harness;

		await Bun.sleep(200);
		expect(bridge.isRunning).toBe(true);
		expect(bridge.getSnapshot().state).toBe("idle");
	});
});
