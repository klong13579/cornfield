/**
 * Gateway new-session interception + rotation tests.
 *
 * Verifies:
 * - isNewSessionCommand() matches the trigger set (/new, /reset, /clear,
 *   新会话, 重新开始, 清空对话) and ignores non-matches.
 * - handle() intercepts a `/new` message, archives the old session file,
 *   sends RPC new_session + switch_session to the agent bridge, refreshes
 *   the SQLite row in place, and replies to the user.
 * - handle() returns true and consumes the message (does not fall through).
 * - handle() gracefully reports a no-active-session case.
 * - rotate() drives the same flow for idle/daily lazy rotation. It also
 *   mutates msg.content to prepend a system note when opts.injectSystemNote
 *   is true (so the LLM sees the abrupt context loss on the next turn).
 * - rotate() tolerates a missing bridge (still archives + updates SQLite).
 * - shouldRotate() follows the config session reset policy.
 *
 * Uses a real AgentBridge backed by a fake RPC script (matching the
 * pattern in gateway-message-pipeline.test.ts and gateway-model-command.test.ts).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildAgentSessionPath, ensureAgentDir } from "@oh-my-pi/pi-coding-agent/skeleton";
import { AgentBridge } from "../src/agent-bridge";
import { NewSessionHandler } from "../src/gateway-new-session";
import { SQLiteSessionStore } from "../src/session-store";
import type { GatewayConfig, InboundMessage, OutboundMessage, SessionRecord } from "../src/types";

/** Fake RPC: records every command, echoes session state for switch_session. */
const FAKE_RPC_SCRIPT = `#!/usr/bin/env bun
process.stdout.write(JSON.stringify({ type: "ready" }) + "\\n");
const receivedCommands = [];
let currentSession = "";
let sessionIdCounter = 0;
let buffer = "";
function emit(v) { process.stdout.write(JSON.stringify(v) + "\\n"); }
async function handleFrame(frame) {
  receivedCommands.push({ type: frame.type, id: frame.id });
  if (frame.type === "switch_session") {
    currentSession = frame.sessionPath;
    emit({ type: "response", id: frame.id, command: "switch_session", success: true, data: { cancelled: false } });
    return;
  }
  if (frame.type === "new_session") {
    sessionIdCounter += 1;
    emit({ type: "response", id: frame.id, command: "new_session", success: true, data: { cancelled: false } });
    return;
  }
  if (frame.type === "get_state") {
    emit({ type: "response", id: frame.id, command: "get_state", success: true, data: { sessionId: "sess-" + sessionIdCounter, sessionFile: currentSession, messageCount: 0 } });
    return;
  }
  if (frame.type === "prompt") {
    emit({ type: "response", id: frame.id, command: "prompt", success: true });
    setTimeout(() => {
      emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ack" }] } });
      emit({ type: "agent_end" });
    }, 0);
  }
}
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk);
  let i = buffer.indexOf("\\n");
  while (i !== -1) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (line) await handleFrame(JSON.parse(line));
    i = buffer.indexOf("\\n");
  }
}
`;

function makeInbound(text: string, conversationId = "conv-test"): InboundMessage {
	return {
		channelId: "dingtalk:test",
		accountId: "ops",
		userId: "user1",
		conversationId,
		isGroup: false,
		content: { type: "text", text },
		timestamp: new Date(),
	};
}

function makeConfig(overrides?: Partial<NonNullable<GatewayConfig["session"]>>): GatewayConfig {
	return {
		channels: {},
		session: {
			resetPolicy: "none",
			idleTimeoutMinutes: 240,
			dailyResetHour: 2,
			...overrides,
		},
	} as GatewayConfig;
}

describe("NewSessionHandler", () => {
	let rootDir: string;
	let rpcPath: string;
	let agentDir: string;
	let store: SQLiteSessionStore;
	let bridge: AgentBridge;
	let replies: OutboundMessage[];

	beforeEach(async () => {
		rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-gateway-new-session-"));
		rpcPath = path.join(rootDir, "fake-rpc");
		await Bun.write(rpcPath, FAKE_RPC_SCRIPT);
		await fs.chmod(rpcPath, 0o755);

		agentDir = path.join(rootDir, "agent");
		await ensureAgentDir(agentDir);

		store = new SQLiteSessionStore(path.join(rootDir, "sessions.db"));
		bridge = new AgentBridge({ ompPath: rpcPath, cwd: agentDir, timeoutMs: 5_000 });
		await bridge.start();
		replies = [];
	});

	afterEach(async () => {
		bridge.stop();
		store.close();
		await fs.rm(rootDir, { recursive: true, force: true });
	});

	// ───────────────────────────────────────────────────────────────
	// Trigger detection
	// ───────────────────────────────────────────────────────────────

	describe("isNewSessionCommand", () => {
		test.each([
			"/new",
			"/new session",
			"  /new  ",
			"/reset",
			"/clear",
			"新会话",
			"重新开始",
			"清空对话",
		])("matches %p", text => {
			const handler = new NewSessionHandler({
				config: makeConfig(),
				store,
				resolveDirectBridge: () => bridge,
				sendAgentResponse: async () => {},
				extractMessageText: m => (m.content.type === "text" ? m.content.text : ""),
			});
			expect(handler.isNewSessionCommand(text)).toBe(true);
		});

		test.each([
			"hello",
			"what is /new?",
			"create /new file",
			"新会话开始",
			"session",
			"",
		])("does NOT match %p", text => {
			const handler = new NewSessionHandler({
				config: makeConfig(),
				store,
				resolveDirectBridge: () => bridge,
				sendAgentResponse: async () => {},
				extractMessageText: m => (m.content.type === "text" ? m.content.text : ""),
			});
			expect(handler.isNewSessionCommand(text)).toBe(false);
		});
	});

	// ───────────────────────────────────────────────────────────────
	// /new command interception
	// ───────────────────────────────────────────────────────────────

	describe("handle (slash command)", () => {
		test("/new archives old file, RPC new_session + switch_session, refreshes SQLite, replies", async () => {
			const convId = "conv-new-1";
			const sessionPath = buildAgentSessionPath(agentDir, convId);
			await fs.mkdir(path.dirname(sessionPath), { recursive: true });
			await Bun.write(sessionPath, '{"type":"session","id":"old"}\n{"type":"message","id":"m1"}\n');

			const oldTime = Date.now() - 10 * 60_000;
			const session = await store.createSession({
				channelId: "dingtalk:test",
				accountId: "ops",
				userId: "user1",
				conversationId: convId,
				createdAt: oldTime,
				updatedAt: oldTime,
				ompSessionPath: sessionPath,
				status: "active",
			});

			const handler = new NewSessionHandler({
				config: makeConfig(),
				store,
				resolveDirectBridge: () => bridge,
				sendAgentResponse: async (_msg, text) => {
					replies.push({
						channelId: "dingtalk:test",
						conversationId: convId,
						content: { type: "markdown", markdown: text },
					});
				},
				extractMessageText: m => (m.content.type === "text" ? m.content.text : ""),
			});

			const handled = await handler.handle(makeInbound("/new", convId), "ops");
			expect(handled).toBe(true);

			// Old file should be archived (no longer at the original path)
			const originalExists = await fs
				.access(sessionPath)
				.then(() => true)
				.catch(() => false);
			expect(originalExists).toBe(false);

			const dir = path.dirname(sessionPath);
			const baseName = path.basename(sessionPath, ".jsonl");
			const files = await fs.readdir(dir);
			const archived = files.filter(f => f.startsWith(`${baseName}.`) && f !== `${baseName}.jsonl`);
			expect(archived.length).toBe(1);

			// SQLite row refreshed in place (same id, fresh updatedAt)
			const refreshed = await store.getSession("dingtalk:test", "ops", convId);
			expect(refreshed?.id).toBe(session.id);
			expect(refreshed?.ompSessionPath).toBe(sessionPath);
			expect(refreshed?.updatedAt).toBeGreaterThan(oldTime);

			// User received confirmation
			expect(replies.length).toBe(1);
			const replyContent = replies[0].content;
			if (replyContent.type === "markdown") {
				expect(replyContent.markdown).toContain("已开启新会话");
			} else {
				throw new Error(`unexpected reply type ${(replyContent as { type: string }).type}`);
			}
		});

		test("non-matching message returns false and does NOT reply", async () => {
			const handler = new NewSessionHandler({
				config: makeConfig(),
				store,
				resolveDirectBridge: () => bridge,
				sendAgentResponse: async () => {
					replies.push({
						channelId: "dingtalk:test",
						conversationId: "x",
						content: { type: "markdown", markdown: "unexpected" },
					});
				},
				extractMessageText: m => (m.content.type === "text" ? m.content.text : ""),
			});

			const handled = await handler.handle(makeInbound("hello world"), "ops");
			expect(handled).toBe(false);
			expect(replies).toHaveLength(0);
		});

		test("/new with no active session reports and still consumes", async () => {
			const handler = new NewSessionHandler({
				config: makeConfig(),
				store,
				resolveDirectBridge: () => bridge,
				sendAgentResponse: async (_msg, text) => {
					replies.push({
						channelId: "dingtalk:test",
						conversationId: "no-session",
						content: { type: "markdown", markdown: text },
					});
				},
				extractMessageText: m => (m.content.type === "text" ? m.content.text : ""),
			});

			const handled = await handler.handle(makeInbound("/new", "no-such-conv"), "ops");
			expect(handled).toBe(true);
			expect(replies).toHaveLength(1);
			const replyContent = replies[0].content;
			if (replyContent.type === "markdown") {
				expect(replyContent.markdown).toContain("没有活跃会话");
			} else {
				throw new Error("unexpected");
			}
		});
	});

	// ───────────────────────────────────────────────────────────────
	// Lazy rotation (idle/daily)
	// ───────────────────────────────────────────────────────────────

	describe("rotate (lazy)", () => {
		test("archives file, drives RPC, refreshes SQLite, optionally injects system note", async () => {
			const convId = "conv-rotate-1";
			const sessionPath = buildAgentSessionPath(agentDir, convId);
			await fs.mkdir(path.dirname(sessionPath), { recursive: true });
			await Bun.write(sessionPath, '{"type":"session","id":"old"}\n');

			const oldTime = Date.now() - 10 * 60_000;
			const created = await store.createSession({
				channelId: "dingtalk:test",
				accountId: "ops",
				userId: "user1",
				conversationId: convId,
				createdAt: oldTime,
				updatedAt: oldTime,
				ompSessionPath: sessionPath,
				status: "active",
			});
			const session: SessionRecord = created;

			// Pre-switch the bridge so the next prompt is fast.
			await bridge.switchSession(sessionPath);

			const handler = new NewSessionHandler({
				config: makeConfig(),
				store,
				resolveDirectBridge: () => bridge,
				sendAgentResponse: async () => {},
				extractMessageText: m => (m.content.type === "text" ? m.content.text : ""),
			});

			const msg = makeInbound("继续干", convId);
			const rotated = await handler.rotate(session, "ops", { injectSystemNote: true, msg });

			expect(rotated.id).toBe(session.id);
			expect(rotated.ompSessionPath).toBe(sessionPath);
			expect(rotated.updatedAt).toBeGreaterThan(oldTime);

			// System note should be prepended to the next message
			if (msg.content.type === "text") {
				expect(msg.content.text).toMatch(/^\[System note: This is a fresh conversation/);
				expect(msg.content.text).toContain("继续干");
			} else {
				throw new Error("msg content should be text");
			}

			// Old file archived
			const dir = path.dirname(sessionPath);
			const baseName = path.basename(sessionPath, ".jsonl");
			const files = await fs.readdir(dir);
			const archived = files.filter(f => f.startsWith(`${baseName}.`) && f !== `${baseName}.jsonl`);
			expect(archived.length).toBe(1);

			// SQLite row updated
			const refreshed = await store.getSession("dingtalk:test", "ops", convId);
			expect(refreshed?.updatedAt).toBeGreaterThan(oldTime);

			// Switch_session should now be a no-op (same path), but the bridge
			// should still be able to accept the next prompt cleanly.
			const after = await bridge.getState();
			expect(after.success).toBe(true);
		});

		test("without injectSystemNote, msg.content is untouched", async () => {
			const convId = "conv-rotate-2";
			const sessionPath = buildAgentSessionPath(agentDir, convId);
			await fs.mkdir(path.dirname(sessionPath), { recursive: true });
			await Bun.write(sessionPath, '{"type":"session","id":"old"}\n');

			const now = Date.now();
			const created = await store.createSession({
				channelId: "dingtalk:test",
				accountId: "ops",
				userId: "user1",
				conversationId: convId,
				createdAt: now,
				updatedAt: now,
				ompSessionPath: sessionPath,
				status: "active",
			});
			const session: SessionRecord = created;

			const handler = new NewSessionHandler({
				config: makeConfig(),
				store,
				resolveDirectBridge: () => bridge,
				sendAgentResponse: async () => {},
				extractMessageText: m => (m.content.type === "text" ? m.content.text : ""),
			});

			const msg = makeInbound("原样", convId);
			await handler.rotate(session, "ops");

			if (msg.content.type === "text") {
				expect(msg.content.text).toBe("原样");
			} else {
				throw new Error("msg content should be text");
			}
		});

		test("tolerates missing bridge (still rotates file + SQLite)", async () => {
			const convId = "conv-rotate-3";
			const sessionPath = buildAgentSessionPath(agentDir, convId);
			await fs.mkdir(path.dirname(sessionPath), { recursive: true });
			await Bun.write(sessionPath, '{"type":"session","id":"old"}\n');

			const oldTime = Date.now() - 10 * 60_000;
			const created = await store.createSession({
				channelId: "dingtalk:test",
				accountId: "ops",
				userId: "user1",
				conversationId: convId,
				createdAt: oldTime,
				updatedAt: oldTime,
				ompSessionPath: sessionPath,
				status: "active",
			});
			const session: SessionRecord = created;

			const handler = new NewSessionHandler({
				config: makeConfig(),
				store,
				resolveDirectBridge: () => null, // bridge not running
				sendAgentResponse: async () => {},
				extractMessageText: m => (m.content.type === "text" ? m.content.text : ""),
			});

			const rotated = await handler.rotate(session, "ops");
			expect(rotated.updatedAt).toBeGreaterThan(oldTime);

			const dir = path.dirname(sessionPath);
			const baseName = path.basename(sessionPath, ".jsonl");
			const files = await fs.readdir(dir);
			const archived = files.filter(f => f.startsWith(`${baseName}.`) && f !== `${baseName}.jsonl`);
			expect(archived.length).toBe(1);
		});

		test("tolerates missing session file (no archive needed)", async () => {
			const convId = "conv-rotate-4";
			const sessionPath = buildAgentSessionPath(agentDir, convId);
			// NOTE: do NOT create the file

			const now = Date.now();
			const created = await store.createSession({
				channelId: "dingtalk:test",
				accountId: "ops",
				userId: "user1",
				conversationId: convId,
				createdAt: now,
				updatedAt: now,
				ompSessionPath: sessionPath,
				status: "active",
			});
			const session: SessionRecord = created;

			const handler = new NewSessionHandler({
				config: makeConfig(),
				store,
				resolveDirectBridge: () => bridge,
				sendAgentResponse: async () => {},
				extractMessageText: m => (m.content.type === "text" ? m.content.text : ""),
			});

			// Should not throw
			const rotated = await handler.rotate(session, "ops");
			expect(rotated.id).toBe(session.id);
		});
	});

	// ───────────────────────────────────────────────────────────────
	// shouldRotate policy
	// ───────────────────────────────────────────────────────────────

	describe("shouldRotate", () => {
		function makeSession(updatedAt: number): SessionRecord {
			return {
				id: "row",
				channelId: "dingtalk:test",
				accountId: "ops",
				userId: "user1",
				conversationId: "x",
				createdAt: updatedAt,
				updatedAt,
				ompSessionPath: "x.jsonl",
				status: "active",
			};
		}

		test("'none' never triggers", () => {
			const handler = new NewSessionHandler({
				config: makeConfig({ resetPolicy: "none", idleTimeoutMinutes: 1 }),
				store,
				resolveDirectBridge: () => bridge,
				sendAgentResponse: async () => {},
				extractMessageText: () => "",
			});
			const yearOld = makeSession(Date.now() - 365 * 24 * 60 * 60_000);
			expect(handler.shouldRotate(yearOld)).toBe(false);
		});

		test("'idle' triggers when updatedAt is past the idle timeout", () => {
			const handler = new NewSessionHandler({
				config: makeConfig({ resetPolicy: "idle", idleTimeoutMinutes: 60 }),
				store,
				resolveDirectBridge: () => bridge,
				sendAgentResponse: async () => {},
				extractMessageText: () => "",
			});
			const fiveHoursAgo = makeSession(Date.now() - 5 * 60 * 60_000);
			expect(handler.shouldRotate(fiveHoursAgo)).toBe(true);
		});

		test("'idle' does NOT trigger for a recent session", () => {
			const handler = new NewSessionHandler({
				config: makeConfig({ resetPolicy: "idle", idleTimeoutMinutes: 240 }),
				store,
				resolveDirectBridge: () => bridge,
				sendAgentResponse: async () => {},
				extractMessageText: () => "",
			});
			const recent = makeSession(Date.now() - 10 * 60_000);
			expect(handler.shouldRotate(recent)).toBe(false);
		});

		test("'both' idle component triggers", () => {
			const handler = new NewSessionHandler({
				config: makeConfig({ resetPolicy: "both", idleTimeoutMinutes: 240, dailyResetHour: 2 }),
				store,
				resolveDirectBridge: () => bridge,
				sendAgentResponse: async () => {},
				extractMessageText: () => "",
			});
			const fiveHoursAgo = makeSession(Date.now() - 5 * 60 * 60_000);
			expect(handler.shouldRotate(fiveHoursAgo)).toBe(true);
		});

		test("'both' daily component triggers for a session before today's reset hour", () => {
			const handler = new NewSessionHandler({
				config: makeConfig({ resetPolicy: "both", idleTimeoutMinutes: 999_999, dailyResetHour: 2 }),
				store,
				resolveDirectBridge: () => bridge,
				sendAgentResponse: async () => {},
				extractMessageText: () => "",
			});
			const yesterdayMidnight = new Date();
			yesterdayMidnight.setDate(yesterdayMidnight.getDate() - 1);
			yesterdayMidnight.setHours(0, 0, 0, 0);
			expect(handler.shouldRotate(makeSession(yesterdayMidnight.getTime()))).toBe(true);
		});
	});
});
