/**
 * End-to-end session rotation simulation.
 *
 * Uses real AgentBridge + fake RPC to verify the full flow:
 * 1. Send message → jsonl file created with session content
 * 2. Simulate idle timeout → trigger rotation
 * 3. Send another message → jsonl file recreated with fresh content
 * 4. Verify old file was deleted, new file has different session ID
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildAgentSessionPath, ensureAgentDir } from "@oh-my-pi/pi-coding-agent/skeleton";
import { AgentBridge } from "../src/agent-bridge";
import { SQLiteSessionStore } from "../src/session-store";
import type { InboundMessage, SessionRecord } from "../src/types";

/**
 * Fake RPC that behaves like real omp:
 * - On switch_session: records the path, creates the file if it doesn't exist
 *   (mimicking session-manager.setSessionFile → #newSessionSync + #rewriteFile)
 * - On prompt: echoes back the session ID from the file
 *
 * This simulates the critical behavior: when switch_session targets a
 * non-existent file, omp creates a fresh session at that path.
 */
const FAKE_RPC_SCRIPT = `#!/usr/bin/env bun
process.stdout.write(JSON.stringify({ type: "ready" }) + "\\n");
let currentSession = "";
let sessionId = "";
let buffer = "";

function emit(value) {
  process.stdout.write(JSON.stringify(value) + "\\n");
}

function loadOrCreateSession(sessionPath) {
  currentSession = sessionPath;
  try {
    const content = require("fs").readFileSync(sessionPath, "utf-8");
    const firstLine = content.trim().split("\\n")[0];
    const header = JSON.parse(firstLine);
    sessionId = header.id || "unknown";
  } catch {
    // File doesn't exist — create a fresh session (mimics setSessionFile else branch)
    sessionId = "sess_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
    const header = JSON.stringify({
      type: "session",
      version: 1,
      id: sessionId,
      timestamp: new Date().toISOString(),
      cwd: process.cwd(),
    });
    require("fs").writeFileSync(sessionPath, header + "\\n", { flag: "wx" });
  }
}

async function handleFrame(frame) {
  if (frame.type === "switch_session") {
    loadOrCreateSession(frame.sessionPath);
    emit({ type: "response", id: frame.id, command: "switch_session", success: true, data: { cancelled: false } });
    return;
  }
  if (frame.type === "prompt") {
    emit({ type: "response", id: frame.id, command: "prompt", success: true });
    const sid = sessionId;
    const msg = frame.message;
    setTimeout(() => {
      emit({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "session=" + sid + " :: " + msg }],
        },
      });
      emit({ type: "agent_end" });
    }, 10);
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

function makeInbound(text: string, conversationId: string, accountId = "ops"): InboundMessage {
	return {
		channelId: "dingtalk",
		userId: "user1",
		conversationId,
		isGroup: false,
		content: { type: "text", text },
		timestamp: new Date(),
		accountId,
	};
}

describe("session rotation e2e", () => {
	let rootDir: string;
	let rpcPath: string;
	let store: SQLiteSessionStore;
	let bridge: AgentBridge;
	let agentDir: string;

	beforeEach(async () => {
		rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-gateway-rotation-e2e-"));
		rpcPath = path.join(rootDir, "fake-rpc");
		await Bun.write(rpcPath, FAKE_RPC_SCRIPT);
		await fs.chmod(rpcPath, 0o755);

		store = new SQLiteSessionStore(path.join(rootDir, "sessions.db"));
		agentDir = path.join(rootDir, "agent");
		await ensureAgentDir(agentDir);
		bridge = new AgentBridge({ ompPath: rpcPath, cwd: agentDir, timeoutMs: 5_000 });
		await bridge.start();
	});

	afterEach(async () => {
		bridge.stop();
		store.close();
		await fs.rm(rootDir, { recursive: true, force: true });
	});

	test("full flow: message → timeout → rotation → new session file", async () => {
		const conversationId = "test-conv-e2e";
		const sessionPath = buildAgentSessionPath(agentDir, conversationId);

		// ── Step 1: First message — create session, forward to bridge ──
		const now = Date.now();
		let session = await store.createSession({
			channelId: "dingtalk",
			accountId: "ops",
			userId: "user1",
			conversationId,
			createdAt: now,
			updatedAt: now,
			ompSessionPath: sessionPath,
			status: "active",
		});

		const msg1 = makeInbound("hello world", conversationId);
		const meta1 = await bridge.forwardWithMeta(msg1, session);

		// Verify: agent replied
		expect(meta1).not.toBeNull();
		expect(meta1!.text).toContain("hello world");

		// Verify: jsonl file was created
		const file1Exists = await fs.access(sessionPath).then(() => true).catch(() => false);
		expect(file1Exists).toBe(true);

		// Read the session ID from the file
		const file1Content = await fs.readFile(sessionPath, "utf-8");
		const file1Header = JSON.parse(file1Content.trim().split("\n")[0]);
		const sessionId1 = file1Header.id;
		expect(sessionId1).toBeTruthy();
		console.log("  [step 1] session file created, id:", sessionId1);

		// ── Step 2: Simulate idle timeout (5 hours pass) ──
		const fiveHoursAgo = now - 5 * 60 * 60_000;
		await store.updateSession(session.id, { updatedAt: fiveHoursAgo });

		// Check rotation should trigger
		const config = { resetPolicy: "both", idleTimeoutMinutes: 240, dailyResetHour: 2 };
		const shouldRotate = (Date.now() - fiveHoursAgo) > config.idleTimeoutMinutes * 60_000;
		expect(shouldRotate).toBe(true);

		// ── Step 3: Perform rotation (mirrors Gateway.#resetSession) ──
		// 3a. Archive old jsonl file (rename with timestamp suffix)
		const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14).replace(/(\d{8})(\d{6})/, "$1_$2");
		const archivePath = sessionPath.replace(/\.jsonl$/, `.${ts}.jsonl`);
		await fs.rename(sessionPath, archivePath);
		const fileArchived = await fs.access(sessionPath).then(() => false).catch(() => true);
		expect(fileArchived).toBe(true);
		const archiveExists = await fs.access(archivePath).then(() => true).catch(() => false);
		expect(archiveExists).toBe(true);
		console.log("  [step 3] old session file archived to:", path.basename(archivePath));

		// 3b. Refresh session record in place
		const resetTime = Date.now();
		await store.updateSession(session.id, { updatedAt: resetTime });
		session = { ...session, updatedAt: resetTime };

		// 3c. Reset bridge cache so next forward re-switches
		bridge.resetActiveSession();

		// 3d. Inject system note
		const msg2 = makeInbound("new conversation", conversationId);
		const note = "[System note: This is a fresh conversation with no prior context.]\n\n";
		msg2.content = { type: "text", text: note + msg2.content.text };

		// ── Step 4: Second message — bridge re-switches to same path ──
		const meta2 = await bridge.forwardWithMeta(msg2, session);

		// Verify: agent replied
		expect(meta2).not.toBeNull();

		// Verify: jsonl file was recreated (by fake RPC mimicking omp behavior)
		const file2Exists = await fs.access(sessionPath).then(() => true).catch(() => false);
		expect(file2Exists).toBe(true);

		// Read the new session ID
		const file2Content = await fs.readFile(sessionPath, "utf-8");
		const file2Header = JSON.parse(file2Content.trim().split("\n")[0]);
		const sessionId2 = file2Header.id;
		expect(sessionId2).toBeTruthy();
		console.log("  [step 4] new session file created, id:", sessionId2);

		// ── Step 5: Verify the two sessions are different ──
		expect(sessionId2).not.toBe(sessionId1);
		console.log("  [step 5] session IDs differ:", sessionId1, "→", sessionId2);

		// Verify: agent's reply references the new session ID
		expect(meta2!.text).toContain(sessionId2);
		expect(meta2!.text).not.toContain(sessionId1);

		// Verify: the system note was included in the prompt
		expect(meta2!.text).toContain("new conversation");

		// ── Step 6: Verify archived file still has old session data ──
		const archiveContent = await fs.readFile(archivePath, "utf-8");
		const archiveHeader = JSON.parse(archiveContent.trim().split("\n")[0]);
		expect(archiveHeader.id).toBe(sessionId1);
		console.log("  [step 6] archived file preserved, old id:", archiveHeader.id);

		// Both files coexist: archived (old) + active (new)
		const sessionDir = path.dirname(sessionPath);
		const allFiles = await fs.readdir(sessionDir);
		const jsonlFiles = allFiles.filter(f => f.endsWith(".jsonl"));
		expect(jsonlFiles.length).toBe(2);
		console.log("  [step 6] files in sessions dir:", jsonlFiles);
	});

	test("no rotation: consecutive messages keep same session", async () => {
		const conversationId = "test-conv-no-rotate";
		const sessionPath = buildAgentSessionPath(agentDir, conversationId);

		const now = Date.now();
		const session = await store.createSession({
			channelId: "dingtalk",
			accountId: "ops",
			userId: "user1",
			conversationId,
			createdAt: now,
			updatedAt: now,
			ompSessionPath: sessionPath,
			status: "active",
		});

		// First message
		const meta1 = await bridge.forwardWithMeta(makeInbound("first", conversationId), session);
		expect(meta1).not.toBeNull();

		const file1Content = await fs.readFile(sessionPath, "utf-8");
		const sessionId1 = JSON.parse(file1Content.trim().split("\n")[0]).id;

		// Second message immediately (no rotation)
		const meta2 = await bridge.forwardWithMeta(makeInbound("second", conversationId), session);
		expect(meta2).not.toBeNull();

		const file2Content = await fs.readFile(sessionPath, "utf-8");
		const sessionId2 = JSON.parse(file2Content.trim().split("\n")[0]).id;

		// Same session — no rotation happened
		expect(sessionId2).toBe(sessionId1);
		console.log("  [no-rotate] same session id:", sessionId1);
	});
});
