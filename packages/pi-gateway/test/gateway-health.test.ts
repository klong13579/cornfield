/**
 * End-to-end test: circuit breaker triggers → gateway health check
 * detects it → bridge is automatically restarted → circuit resets.
 *
 * Uses a fake RPC binary that returns failure for any prompt containing
 * "fail". Sends 10 failures to trip the circuit breaker (threshold = 10),
 * then invokes checkBridgeHealth() with a short threshold (via env var)
 * to verify the bridge is stopped and restarted.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Gateway } from "../src/gateway";
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
    setTimeout(() => {
      emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: sessionAtPrompt + " :: " + frame.message }] } });
      emit({ type: "agent_end" });
    }, 0);
    return;
  }
  if (frame.type === "abort") {
    emit({ type: "response", id: frame.id, command: "abort", success: true });
  }
  if (frame.type === "set_disabled_toolsets") {
    emit({ type: "response", id: frame.id, command: "set_disabled_toolsets", success: true });
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

async function createFakeRpcBinary(): Promise<{ path: string; cleanup: () => Promise<void> }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-gateway-health-rpc-"));
	const scriptPath = path.join(dir, "fake-rpc");
	await Bun.write(scriptPath, FAKE_RPC_SCRIPT);
	await fs.chmod(scriptPath, 0o755);
	return {
		path: scriptPath,
		cleanup: async () => {
			await fs.rm(dir, { recursive: true, force: true });
		},
	};
}

function makeMessage(text: string): InboundMessage {
	return {
		channelId: "test",
		accountId: "test",
		userId: "user",
		conversationId: "conv-health",
		isGroup: false,
		content: { type: "text", text },
		timestamp: new Date(),
	};
}

function makeSession(sessionPath: string): SessionRecord {
	return {
		id: "conv-health",
		channelId: "test",
		accountId: "test",
		userId: "user",
		conversationId: "conv-health",
		createdAt: Date.now(),
		updatedAt: Date.now(),
		ompSessionPath: sessionPath,
		status: "active",
	};
}

describe("Gateway circuit breaker health check", () => {
	let tmpDir: string;
	let fake: { path: string; cleanup: () => Promise<void> };
	let originalOpenMs: string | undefined;
	let originalCooldownMs: string | undefined;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-gateway-health-"));
		fake = await createFakeRpcBinary();
		originalOpenMs = process.env.GATEWAY_CIRCUIT_OPEN_MS;
		originalCooldownMs = process.env.GATEWAY_CIRCUIT_COOLDOWN_MS;
	});

	afterEach(async () => {
		if (originalOpenMs === undefined) delete process.env.GATEWAY_CIRCUIT_OPEN_MS;
		else process.env.GATEWAY_CIRCUIT_OPEN_MS = originalOpenMs;
		if (originalCooldownMs === undefined) delete process.env.GATEWAY_CIRCUIT_COOLDOWN_MS;
		else process.env.GATEWAY_CIRCUIT_COOLDOWN_MS = originalCooldownMs;
		await fake.cleanup();
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	test("circuit opens after 10 failures, then health check restarts bridge", async () => {
		const gateway = new Gateway({
			channels: {},
			dataDir: tmpDir,
			agent: { ompPath: fake.path, timeoutMs: 2_000 },
		});

		try {
			await gateway.start();
			const bridge = gateway.getDefaultBridge();
			expect(bridge.isRunning).toBe(true);

			const sessionPath = path.join(tmpDir, "session.jsonl");

			// Send 10 failing prompts to trip the circuit breaker.
			// Each forward() is serialized via #runExclusive.
			for (let i = 0; i < 10; i++) {
				await bridge.forward(makeMessage("fail"), makeSession(sessionPath));
			}

			// Circuit should now be open.
			const snapshot = bridge.getSnapshot();
			expect(snapshot.circuitState).toBe("open");
			expect(snapshot.circuitOpenedAt).toBeDefined();

			// Set a short threshold so checkBridgeHealth triggers immediately.
			process.env.GATEWAY_CIRCUIT_OPEN_MS = "50";
			process.env.GATEWAY_CIRCUIT_COOLDOWN_MS = "1000";

			// Wait beyond the threshold.
			await Bun.sleep(60);

			// Health check should detect the open circuit and restart the bridge.
			await gateway.checkBridgeHealth();

			// After restart, circuit should be reset to closed.
			const afterSnapshot = bridge.getSnapshot();
			expect(afterSnapshot.circuitState).toBe("closed");
			expect(bridge.isRunning).toBe(true);
		} finally {
			await gateway.stop();
		}
	});

	test("health check skips bridge within cooldown period", async () => {
		const gateway = new Gateway({
			channels: {},
			dataDir: tmpDir,
			agent: { ompPath: fake.path, timeoutMs: 2_000 },
		});

		try {
			await gateway.start();
			const bridge = gateway.getDefaultBridge();

			const sessionPath = path.join(tmpDir, "session.jsonl");

			// Trip the circuit breaker.
			for (let i = 0; i < 10; i++) {
				await bridge.forward(makeMessage("fail"), makeSession(sessionPath));
			}
			expect(bridge.getSnapshot().circuitState).toBe("open");

			// Short threshold, long cooldown.
			process.env.GATEWAY_CIRCUIT_OPEN_MS = "50";
			process.env.GATEWAY_CIRCUIT_COOLDOWN_MS = "999999";

			await Bun.sleep(60);

			// First health check: restarts the bridge.
			await gateway.checkBridgeHealth();
			expect(bridge.getSnapshot().circuitState).toBe("closed");

			// Trip the circuit breaker again.
			for (let i = 0; i < 10; i++) {
				await bridge.forward(makeMessage("fail"), makeSession(sessionPath));
			}
			expect(bridge.getSnapshot().circuitState).toBe("open");

			await Bun.sleep(60);

			// Second health check: should NOT restart (within cooldown).
			await gateway.checkBridgeHealth();
			expect(bridge.getSnapshot().circuitState).toBe("open");
		} finally {
			await gateway.stop();
		}
	});
});
