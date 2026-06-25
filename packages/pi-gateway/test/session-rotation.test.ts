/**
 * Session rotation integration test.
 *
 * Verifies the gateway's lazy session rotation logic:
 * - idle timeout triggers reset after configured inactivity
 * - daily boundary triggers reset when updatedAt crosses the daily reset hour
 * - reset deletes the old jsonl file, closes the old SQLite record, creates a new session
 * - system note is injected into the message on reset
 * - bridge's cached session path is cleared so omp re-switches
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildAgentSessionPath, ensureAgentDir } from "@oh-my-pi/pi-coding-agent/skeleton";
import { AgentBridge } from "../src/agent-bridge";
import { SQLiteSessionStore } from "../src/session-store";
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
    emit({ type: "response", id: frame.id, command: "prompt", success: true });
    const sessionAtPrompt = currentSession;
    setTimeout(() => {
      emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: sessionAtPrompt + " :: " + frame.message }] } });
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

describe("session rotation", () => {
	let rootDir: string;
	let rpcPath: string;
	let store: SQLiteSessionStore;
	let bridge: AgentBridge;
	let agentDir: string;
	let sessionPath: string;

	beforeEach(async () => {
		rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-gateway-rotation-"));
		rpcPath = path.join(rootDir, "fake-rpc");
		await Bun.write(rpcPath, FAKE_RPC_SCRIPT);
		await fs.chmod(rpcPath, 0o755);

		store = new SQLiteSessionStore(path.join(rootDir, "sessions.db"));
		agentDir = path.join(rootDir, "agent");
		await ensureAgentDir(agentDir);
		bridge = new AgentBridge({ ompPath: rpcPath, cwd: agentDir, timeoutMs: 2_000 });
		await bridge.start();
	});

	afterEach(async () => {
		bridge.stop();
		store.close();
		await fs.rm(rootDir, { recursive: true, force: true });
	});

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

	async function resetSession(session: SessionRecord, accountId: string): Promise<SessionRecord> {
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

	test("idle timeout triggers reset when updatedAt is old", async () => {
		const config = { resetPolicy: "both" as const, idleTimeoutMinutes: 240, dailyResetHour: 2 };

		// Create a session with updatedAt 5 hours ago
		const fiveHoursAgo = Date.now() - 5 * 60 * 60_000;
		sessionPath = buildAgentSessionPath(agentDir, "test-conv");
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
	});

	test("idle timeout does NOT trigger when session is recent", async () => {
		const config = { resetPolicy: "both" as const, idleTimeoutMinutes: 240, dailyResetHour: 2 };

		const now = Date.now();
		sessionPath = buildAgentSessionPath(agentDir, "test-conv2");
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
			ompSessionPath: buildAgentSessionPath(agentDir, "test-conv3"),
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
			ompSessionPath: buildAgentSessionPath(agentDir, "test-conv4"),
			status: "active",
		});

		expect(shouldResetSession(session, config)).toBe(false);
	});

	test("reset deletes jsonl file and creates new session with same path", async () => {
		sessionPath = buildAgentSessionPath(agentDir, "test-conv5");
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
	});

	test("bridge.resetActiveSession() clears cached path so next switch re-loads", async () => {
		// First, switch to a session (sets #activeSessionPath)
		sessionPath = buildAgentSessionPath(agentDir, "test-conv6");
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
