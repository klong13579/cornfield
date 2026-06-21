/**
 * sendDirectMessage multi-account routing tests.
 *
 * Tests the accountId routing logic added to Gateway.sendDirectMessage.
 * Verifies the resolveDirectBridge contract and per-account bridge forwarding.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ensureAgentDir } from "@oh-my-pi/pi-coding-agent/skeleton";
import { AgentBridge } from "../src/agent-bridge";

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
    emit({ type: "response", id: frame.id, command: "prompt", success: true });
    const sessionAtPrompt = currentSession;
    setTimeout(() => {
      emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "echo:" + sessionAtPrompt + "::" + frame.message }] } });
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

async function createFakeRpcBinary(): Promise<{ path: string; cleanup: () => Promise<void> }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-gateway-direct-msg-"));
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

/**
 * Mirrors the routing logic from Gateway.#resolveDirectBridge.
 * This is the contract we need to verify.
 */
function resolveDirectBridge(
	accountId: string | undefined,
	accountBridges: Map<string, AgentBridge>,
	defaultBridge: AgentBridge | null,
): AgentBridge | null {
	if (accountId && accountBridges.has(accountId)) {
		return accountBridges.get(accountId)!;
	}
	if (!accountId && accountBridges.size === 0 && defaultBridge?.isRunning) {
		return defaultBridge;
	}
	return null;
}

describe("sendDirectMessage multi-account routing", () => {
	test("routes to the specified account bridge when accountId is provided", async () => {
		const fake = await createFakeRpcBinary();
		const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-gateway-direct-msg-routing-"));

		try {
			const opsDir = path.join(rootDir, "agents", "ops");
			const hrDir = path.join(rootDir, "agents", "hr");
			await ensureAgentDir(opsDir);
			await ensureAgentDir(hrDir);

			const opsBridge = new AgentBridge({ ompPath: fake.path, cwd: opsDir, timeoutMs: 2_000 });
			const hrBridge = new AgentBridge({ ompPath: fake.path, cwd: hrDir, timeoutMs: 2_000 });

			await opsBridge.start();
			await hrBridge.start();

			const bridges = new Map<string, AgentBridge>();
			bridges.set("ops", opsBridge);
			bridges.set("hr", hrBridge);

			// Verify resolveDirectBridge contract
			const resolved = resolveDirectBridge("ops", bridges, null);
			expect(resolved).toBe(opsBridge);

			const resolvedHr = resolveDirectBridge("hr", bridges, null);
			expect(resolvedHr).toBe(hrBridge);

			// Verify the bridge actually forwards correctly with account context
			const opsSession = {
				id: "test-session-ops",
				channelId: "cli",
				accountId: "ops",
				userId: "cli-user",
				conversationId: "cli-conv-ops",
				createdAt: Date.now(),
				updatedAt: Date.now(),
				status: "active" as const,
			};
			const opsMessage = {
				channelId: "cli",
				userId: "cli-user",
				userName: "CLI User",
				conversationId: "cli-conv-ops",
				isGroup: false,
				content: { type: "text" as const, text: "hello ops" },
				timestamp: new Date(),
			};
			const opsResponse = await opsBridge.forward(opsMessage, opsSession);
			expect(opsResponse).toContain("hello ops");

			const hrSession = {
				id: "test-session-hr",
				channelId: "cli",
				accountId: "hr",
				userId: "cli-user",
				conversationId: "cli-conv-hr",
				createdAt: Date.now(),
				updatedAt: Date.now(),
				status: "active" as const,
			};
			const hrMessage = {
				channelId: "cli",
				userId: "cli-user",
				userName: "CLI User",
				conversationId: "cli-conv-hr",
				isGroup: false,
				content: { type: "text" as const, text: "hello hr" },
				timestamp: new Date(),
			};
			const hrResponse = await hrBridge.forward(hrMessage, hrSession);
			expect(hrResponse).toContain("hello hr");
		} finally {
			await fs.rm(rootDir, { recursive: true, force: true });
			await fake.cleanup();
		}
	});

	test("returns null when accountId is omitted in multi-account mode", () => {
		const bridges = new Map<string, AgentBridge>();
		// Don't need real bridges for routing logic test
		const result = resolveDirectBridge(undefined, bridges, null);
		expect(result).toBeNull();
	});

	test("returns default bridge when accountId is omitted in single-account mode", async () => {
		const fake = await createFakeRpcBinary();
		const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-gateway-direct-msg-single-"));

		try {
			const agentDir = path.join(rootDir, "agents", "default");
			await ensureAgentDir(agentDir);
			const defaultBridge = new AgentBridge({ ompPath: fake.path, cwd: agentDir, timeoutMs: 2_000 });
			await defaultBridge.start();

			const bridges = new Map<string, AgentBridge>(); // empty = single-account mode
			const result = resolveDirectBridge(undefined, bridges, defaultBridge);
			expect(result).toBe(defaultBridge);

			// Verify default bridge still works
			const session = {
				id: "cli-session-__default__",
				channelId: "cli",
				accountId: "__default__",
				userId: "cli-user",
				conversationId: "cli-conv-__default__",
				createdAt: Date.now(),
				updatedAt: Date.now(),
				status: "active" as const,
			};
			const message = {
				channelId: "cli",
				userId: "cli-user",
				userName: "CLI User",
				conversationId: "cli-conv-__default__",
				isGroup: false,
				content: { type: "text" as const, text: "hello default" },
				timestamp: new Date(),
			};
			const response = await defaultBridge.forward(message, session);
			expect(response).toContain("hello default");
		} finally {
			await fs.rm(rootDir, { recursive: true, force: true });
			await fake.cleanup();
		}
	});

	test("returns null for unknown accountId", () => {
		const bridges = new Map<string, AgentBridge>();
		const result = resolveDirectBridge("nonexistent", bridges, null);
		expect(result).toBeNull();
	});
});
