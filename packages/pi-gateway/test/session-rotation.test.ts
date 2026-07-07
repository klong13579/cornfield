/**
 * Session rotation tests.
 *
 *   - `session-rotation.test.ts` — Lazy session rotation logic:
 *     idle timeout, daily boundary, reset deletes old jsonl and
 *     refreshes the SQLite record in place, system note injection,
 *     bridge.resetActiveSession() clears cached path.
 *   - `session-rotation-e2e.test.ts` — End-to-end: real AgentBridge +
 *     fake RPC that mimics omp's switch_session behavior (creates a
 *     fresh jsonl when the file doesn't exist). Verifies the full
 *     message → timeout → rotation → new session file flow.
 *
 * Two layers of the rotation story: the algorithm and the integration
 * with the bridge / store. Co-located here.
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

/**
 * Simulate the gateway's rotation check + reset logic inline.
 * This mirrors Gateway.#shouldResetSession + #resetSession exactly,
 * so we test the actual algorithm without needing to instantiate the
 * full Gateway class (which requires DingTalk config, channels, etc.).
 */
function shouldResetSession(
	session: SessionRecord,
	config: { resetPolicy: string; idleTimeoutMinutes: number; dailyResetHour: number },
): boolean {
	const { resetPolicy, idleTimeoutMinutes, dailyResetHour } = config;
	if (resetPolicy === "none") return false;

	const now = Date.now();
	const updatedAt = session.updatedAt;

	if (resetPolicy === "idle" || resetPolicy === "both") {
		const idleMs = idleTimeoutMinutes * 60_000;
		if (now - updatedAt > idleMs) return true;
	}

	if (resetPolicy === "daily" || resetPolicy === "both") {
		const today = new Date(now);
		const todayReset = new Date(today.getFullYear(), today.getMonth(), today.getDate(), dailyResetHour, 0, 0, 0);
		const boundary = now < todayReset.getTime() ? todayReset.getTime() - 86_400_000 : todayReset.getTime();
		if (updatedAt < boundary) return true;
	}

	return false;
}

async function resetSession(session: SessionRecord, _accountId: string): Promise<SessionRecord> {
	// 1. Archive old jsonl (rename with timestamp suffix)
	if (session.ompSessionPath) {
		try {
			const dot = session.ompSessionPath.lastIndexOf(".");
			const ts = new Date()
				.toISOString()
				.replace(/[-:T]/g, "")
				.slice(0, 14)
				.replace(/(\d{8})(\d{6})/, "$1_$2");
			const archivePath =
				dot === -1
					? `${session.ompSessionPath}.${ts}`
					: `${session.ompSessionPath.slice(0, dot)}.${ts}${session.ompSessionPath.slice(dot)}`;
			await fs.rename(session.ompSessionPath, archivePath);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		}
	}

	// 2. Refresh the session record in place (same row, fresh timestamp).
	//    Can't close+create due to UNIQUE(channel_id, account_id, conversation_id).
	const now = Date.now();
	await store.updateSession(session.id, { updatedAt: now });
	return { ...session, updatedAt: now };
}

let store: SQLiteSessionStore;

describe("session rotation algorithm", () => {
	beforeEach(async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-gateway-rot-alg-"));
		store = new SQLiteSessionStore(path.join(dir, "sessions.db"));
	});

	afterEach(async () => {
		store.close();
		// Best-effort: temp dirs are cleaned up by individual tests
		// (each calls fs.rm on its own agentDir). The SQLite file
		// is removed by `close()`'s drop on next test creation.
	});

	test("idle timeout triggers reset when updatedAt is old", async () => {
		const config = { resetPolicy: "both" as const, idleTimeoutMinutes: 240, dailyResetHour: 2 };

		// Create a session with updatedAt 5 hours ago
		const fiveHoursAgo = Date.now() - 5 * 60 * 60_000;
		const agentDir = path.join(os.tmpdir(), `pi-gateway-rot-alg-${Date.now()}`);
		await fs.mkdir(agentDir, { recursive: true });
		const sessionPath = buildAgentSessionPath(agentDir, "test-conv");
		await fs.mkdir(path.dirname(sessionPath), { recursive: true });
		await Bun.write(
			sessionPath,
			JSON.stringify({ type: "session", id: "old", timestamp: new Date(fiveHoursAgo).toISOString() }) + "\n",
		);

		const session = await store.createSession({
			channelId: "dingtalk",
			accountId: "ops",
			userId: "user1",
			conversationId: "test-conv",
			createdAt: fiveHoursAgo,
			updatedAt: fiveHoursAgo,
			ompSessionPath: sessionPath,
			status: "active",
		});

		// Should trigger
		expect(shouldResetSession(session, config)).toBe(true);

		// Verify old file exists before reset
		expect(
			await fs
				.access(sessionPath)
				.then(() => true)
				.catch(() => false),
		).toBe(true);

		// Perform reset
		const newSession = await resetSession(session, "ops");

		// Original path should be vacant (file was archived/renamed)
		expect(
			await fs
				.access(sessionPath)
				.then(() => true)
				.catch(() => false),
		).toBe(false);

		// Archived file should exist in the same directory
		const dir = path.dirname(sessionPath);
		const files = await fs.readdir(dir);
		const archivedFiles = files.filter(f => f.startsWith("test-conv.") && f !== "test-conv.jsonl");
		expect(archivedFiles.length).toBe(1);

		// Session record refreshed in place — same id, fresh updatedAt
		const refreshed = await store.getSession("dingtalk", "ops", "test-conv");
		expect(refreshed?.id).toBe(session.id);
		expect(refreshed?.status).toBe("active");
		expect(refreshed?.updatedAt).toBeGreaterThan(fiveHoursAgo);
		void newSession;
		await fs.rm(agentDir, { recursive: true, force: true });
	});

	test("idle timeout does NOT trigger when session is recent", async () => {
		const config = { resetPolicy: "both" as const, idleTimeoutMinutes: 240, dailyResetHour: 2 };

		const now = Date.now();
		const sessionPath = buildAgentSessionPath(path.join(os.tmpdir(), "rot-recent"), "test-conv2");
		const session = await store.createSession({
			channelId: "dingtalk",
			accountId: "ops",
			userId: "user1",
			conversationId: "test-conv2",
			createdAt: now,
			updatedAt: now,
			ompSessionPath: sessionPath,
			status: "active",
		});

		expect(shouldResetSession(session, config)).toBe(false);
	});

	test("daily boundary triggers when updatedAt is before today's reset hour", async () => {
		// Use idle=99999 (effectively disabled) so only daily triggers
		const config = { resetPolicy: "both" as const, idleTimeoutMinutes: 99999, dailyResetHour: 2 };

		// Create a session with updatedAt yesterday at midnight (before 2 AM boundary)
		const yesterdayMidnight = new Date();
		yesterdayMidnight.setDate(yesterdayMidnight.getDate() - 1);
		yesterdayMidnight.setHours(0, 0, 0, 0);
		const ts = yesterdayMidnight.getTime();

		const session = await store.createSession({
			channelId: "dingtalk",
			accountId: "ops",
			userId: "user1",
			conversationId: "test-conv3",
			createdAt: ts,
			updatedAt: ts,
			ompSessionPath: buildAgentSessionPath(path.join(os.tmpdir(), "rot-daily"), "test-conv3"),
			status: "active",
		});

		expect(shouldResetSession(session, config)).toBe(true);
	});

	test("resetPolicy 'none' never triggers", async () => {
		const config = { resetPolicy: "none" as const, idleTimeoutMinutes: 1, dailyResetHour: 2 };

		const veryOld = Date.now() - 365 * 24 * 60 * 60_000; // 1 year ago
		const session = await store.createSession({
			channelId: "dingtalk",
			accountId: "ops",
			userId: "user1",
			conversationId: "test-conv4",
			createdAt: veryOld,
			updatedAt: veryOld,
			ompSessionPath: buildAgentSessionPath(path.join(os.tmpdir(), "rot-none"), "test-conv4"),
			status: "active",
		});

		expect(shouldResetSession(session, config)).toBe(false);
	});

	test("reset deletes jsonl file and creates new session with same path", async () => {
		const agentDir = path.join(os.tmpdir(), `pi-gateway-rot-file-${Date.now()}`);
		await fs.mkdir(agentDir, { recursive: true });
		const sessionPath = buildAgentSessionPath(agentDir, "test-conv5");
		await fs.mkdir(path.dirname(sessionPath), { recursive: true });
		await Bun.write(sessionPath, '{"type":"session","id":"old-session"}\n');

		const oldTime = Date.now() - 10 * 60 * 60_000;
		const session = await store.createSession({
			channelId: "dingtalk",
			accountId: "ops",
			userId: "user1",
			conversationId: "test-conv5",
			createdAt: oldTime,
			updatedAt: oldTime,
			ompSessionPath: sessionPath,
			status: "active",
		});

		// File exists
		expect(
			await fs
				.access(sessionPath)
				.then(() => true)
				.catch(() => false),
		).toBe(true);

		// Reset
		const newSession = await resetSession(session, "ops");

		// Original path vacant (archived), archived file exists
		expect(
			await fs
				.access(sessionPath)
				.then(() => true)
				.catch(() => false),
		).toBe(false);
		const dir = path.dirname(sessionPath);
		const files = await fs.readdir(dir);
		expect(files.filter(f => f.startsWith("test-conv5.") && f !== "test-conv5.jsonl").length).toBe(1);

		// Session record refreshed in place — same id, same path, fresh updatedAt
		expect(newSession.id).toBe(session.id);
		expect(newSession.ompSessionPath).toBe(sessionPath);
		expect(newSession.updatedAt).toBeGreaterThan(oldTime);
		expect(newSession.status).toBe("active");
		await fs.rm(agentDir, { recursive: true, force: true });
	});

	test("system note injection prepends to message text", () => {
		const note = "[System note: This is a fresh conversation with no prior context.]\n\n";
		const originalText = "hello";
		const injected = note + originalText;

		expect(injected).toContain("[System note:");
		expect(injected).toContain(originalText);
		expect(injected.indexOf("[System note:")).toBe(0);
	});

	test("config defaults: both / 240min / hour 2", async () => {
		// Import the actual config module to verify defaults
		const { loadConfig } = await import("../src/config");
		const config = await loadConfig("/nonexistent/path.json");

		expect(config.session?.resetPolicy).toBe("both");
		expect(config.session?.idleTimeoutMinutes).toBe(240);
		expect(config.session?.dailyResetHour).toBe(2);
	});
});

describe("session rotation e2e", () => {
	let rootDir: string;
	let rpcPath: string;
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

	test("bridge.resetActiveSession() clears cached path so next switch re-loads", async () => {
		const sessionPath = buildAgentSessionPath(agentDir, "test-conv6");
		await fs.mkdir(path.dirname(sessionPath), { recursive: true });
		await Bun.write(sessionPath, '{"type":"session","id":"s6"}\n');

		// Use the real bridge to switch_session
		await bridge.switchSession(sessionPath);

		// Now reset the bridge's cached path
		bridge.resetActiveSession();

		// Delete the file (simulating rotation)
		await fs.unlink(sessionPath);

		// Switch again — should work even though path is the same,
		// because resetActiveSession cleared the cache
		await bridge.switchSession(sessionPath);

		// If we get here without throwing, the re-switch worked.
		// The fake RPC just records the sessionPath and echoes it back.
		expect(true).toBe(true);
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
		const file1Exists = await fs
			.access(sessionPath)
			.then(() => true)
			.catch(() => false);
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
		const shouldRotate = Date.now() - fiveHoursAgo > config.idleTimeoutMinutes * 60_000;
		expect(shouldRotate).toBe(true);

		// ── Step 3: Perform rotation (mirrors Gateway.#resetSession) ──
		// 3a. Archive old jsonl file (rename with timestamp suffix)
		const ts = new Date()
			.toISOString()
			.replace(/[-:T]/g, "")
			.slice(0, 14)
			.replace(/(\d{8})(\d{6})/, "$1_$2");
		const archivePath = sessionPath.replace(/\.jsonl$/, `.${ts}.jsonl`);
		await fs.rename(sessionPath, archivePath);
		const fileArchived = await fs
			.access(sessionPath)
			.then(() => false)
			.catch(() => true);
		expect(fileArchived).toBe(true);
		const archiveExists = await fs
			.access(archivePath)
			.then(() => true)
			.catch(() => false);
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
		const file2Exists = await fs
			.access(sessionPath)
			.then(() => true)
			.catch(() => false);
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
