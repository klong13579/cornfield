/**
 * Unit tests for `attach-to-session` (a+ `attachToSession` feature).
 *
 * Covers:
 * - `resolveMirrorSessionPath`: explicit conversationId, DM scan, no
 *   match, cron files skipped, missing dir.
 * - `appendMirrorEntry`: writes user-role entry with label, handles
 *   alternation (last user → insert placeholder assistant), tolerates
 *   malformed last line, fails on missing file.
 * - `mirrorDeliveryToSession` (orchestrator): end-to-end success,
 *   channel gate, agentDir gate, no-session gate.
 *
 * Tests use real temp files under the OS temp dir; the JSONL is
 * written by the SUT and read back for assertions.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	appendMirrorEntry,
	mirrorDeliveryToSession,
	resolveMirrorSessionPath,
} from "../src/scheduler/attach-to-session";

let tempDir = "";
let agentDir = "";

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "attach-to-session-test-"));
	agentDir = path.join(tempDir, "agent");
	fs.mkdirSync(path.join(agentDir, "sessions"), { recursive: true });
});

afterEach(() => {
	if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

/** Write a session JSONL with the given entries (one per line). */
function writeSession(fileName: string, lines: object[]): string {
	const filePath = path.join(agentDir, "sessions", fileName);
	const content = lines.length > 0 ? `${lines.map(l => JSON.stringify(l)).join("\n")}\n` : "";
	fs.writeFileSync(filePath, content, "utf-8");
	return filePath;
}

/** Read all non-empty lines from a session JSONL. */
function readSession(filePath: string): unknown[] {
	const content = fs.readFileSync(filePath, "utf-8");
	return content
		.split("\n")
		.filter(l => l.trim())
		.map(l => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// resolveMirrorSessionPath
// ---------------------------------------------------------------------------

describe("resolveMirrorSessionPath", () => {
	it("returns undefined when agentDir is undefined", () => {
		expect(resolveMirrorSessionPath(undefined, { toUserId: "u1" })).toBeUndefined();
	});

	it("uses toConversationId when set and the session file exists", () => {
		const convId = "cid_group_abc";
		const sessionPath = writeSession(`${convId}.jsonl`, [
			{
				type: "message",
				id: "m1",
				parentId: null,
				message: { role: "user", content: [{ type: "text", text: "hi" }] },
			},
		]);
		const result = resolveMirrorSessionPath(agentDir, { toConversationId: convId });
		expect(result).toBe(sessionPath);
	});

	it("returns undefined when toConversationId is set but file does not exist", () => {
		const result = resolveMirrorSessionPath(agentDir, { toConversationId: "cid_never_chatted" });
		expect(result).toBeUndefined();
	});

	it("scans sessions dir for most recent non-cron file when toUserId is set", () => {
		// 3 sessions, mtimes increasing
		const old1 = writeSession("old_dm.jsonl", [{ type: "message", id: "m1", message: { role: "user" } }]);
		const old2 = writeSession("recent_dm.jsonl", [{ type: "message", id: "m2", message: { role: "user" } }]);
		const old3 = writeSession("another_dm.jsonl", [{ type: "message", id: "m3", message: { role: "user" } }]);
		// Bump mtimes so old2 is the most recent
		const now = Date.now();
		fs.utimesSync(old1, now / 1000 - 100, now / 1000 - 100);
		fs.utimesSync(old2, now / 1000, now / 1000); // newest
		fs.utimesSync(old3, now / 1000 - 50, now / 1000 - 50);

		const result = resolveMirrorSessionPath(agentDir, { toUserId: "u1" });
		expect(result).toBe(old2);
	});

	it("skips cron_<ts>.jsonl files in the DM scan", () => {
		const dm = writeSession("dm_session.jsonl", [{ type: "message", id: "m1", message: { role: "user" } }]);
		const cron = writeSession("cron_1234567890.jsonl", [
			{ type: "message", id: "m2", message: { role: "assistant" } },
		]);
		// Make cron the most recent
		const now = Date.now();
		fs.utimesSync(dm, now / 1000 - 100, now / 1000 - 100);
		fs.utimesSync(cron, now / 1000, now / 1000);

		const result = resolveMirrorSessionPath(agentDir, { toUserId: "u1" });
		expect(result).toBe(dm);
	});

	it("returns undefined when DM scan finds no eligible session", () => {
		// Only a cron file exists
		writeSession("cron_9999999.jsonl", [{ type: "message", id: "m1", message: { role: "assistant" } }]);
		const result = resolveMirrorSessionPath(agentDir, { toUserId: "u1" });
		expect(result).toBeUndefined();
	});

	it("returns undefined when neither toUserId nor toConversationId is set", () => {
		expect(resolveMirrorSessionPath(agentDir, {})).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// appendMirrorEntry
// ---------------------------------------------------------------------------

describe("appendMirrorEntry", () => {
	it("writes a user-role entry with the [Cron delivery: ...] label", () => {
		const sessionPath = writeSession("dm.jsonl", [
			{
				type: "message",
				id: "m1",
				parentId: null,
				message: { role: "user", content: [{ type: "text", text: "old" }] },
			},
			{
				type: "message",
				id: "m2",
				parentId: "m1",
				message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
			},
		]);

		const result = appendMirrorEntry(sessionPath, "daily-brief", "Today's brief: 5 PRs", 1700000000000);
		expect(result.ok).toBe(true);

		const entries = readSession(sessionPath);
		expect(entries).toHaveLength(3);
		const mirror = entries[2] as {
			type: string;
			message: { role: string; content: Array<{ type: string; text: string }> };
		};
		expect(mirror.type).toBe("message");
		expect(mirror.message.role).toBe("user");
		expect(mirror.message.content[0]?.type).toBe("text");
		const text = mirror.message.content[0]?.text ?? "";
		expect(text).toContain("[Cron delivery: daily-brief");
		expect(text).toContain("Today's brief: 5 PRs");
	});

	it("uses parentId from the last entry", () => {
		const sessionPath = writeSession("dm.jsonl", [
			{ type: "message", id: "m1", parentId: null, message: { role: "user", content: [] } },
			{ type: "message", id: "m2", parentId: "m1", message: { role: "assistant", content: [] } },
		]);
		appendMirrorEntry(sessionPath, "task", "brief", 1700000000000);
		const entries = readSession(sessionPath);
		const mirror = entries[2] as { parentId: string };
		expect(mirror.parentId).toBe("m2");
	});

	it("inserts a placeholder assistant turn when last entry is user (alternation guard)", () => {
		const sessionPath = writeSession("dm.jsonl", [
			{ type: "message", id: "m1", parentId: null, message: { role: "user", content: [] } },
		]);

		appendMirrorEntry(sessionPath, "task", "brief", 1700000000000);
		const entries = readSession(sessionPath);
		expect(entries).toHaveLength(3);
		const placeholder = entries[1] as { message: { role: string; content: Array<{ text: string }> } };
		const mirror = entries[2] as { message: { role: string } };
		expect(placeholder.message.role).toBe("assistant");
		expect(placeholder.message.content[0]?.text).toBe("(noted)");
		expect(mirror.message.role).toBe("user");
	});

	it("appends directly when last entry is assistant (no placeholder needed)", () => {
		const sessionPath = writeSession("dm.jsonl", [
			{ type: "message", id: "m1", parentId: null, message: { role: "user", content: [] } },
			{ type: "message", id: "m2", parentId: "m1", message: { role: "assistant", content: [] } },
		]);
		appendMirrorEntry(sessionPath, "task", "brief", 1700000000000);
		const entries = readSession(sessionPath);
		expect(entries).toHaveLength(3); // original 2 + 1 mirror, no placeholder
	});

	it("appends directly when last entry is toolResult (no placeholder needed)", () => {
		const sessionPath = writeSession("dm.jsonl", [
			{ type: "message", id: "m1", parentId: null, message: { role: "toolResult", content: [] } },
		]);
		appendMirrorEntry(sessionPath, "task", "brief", 1700000000000);
		const entries = readSession(sessionPath);
		expect(entries).toHaveLength(2);
	});

	it("tolerates a malformed last line (still appends)", () => {
		const sessionPath = path.join(agentDir, "sessions", "dm.jsonl");
		fs.writeFileSync(sessionPath, "this is not json\n", "utf-8");
		const result = appendMirrorEntry(sessionPath, "task", "brief", 1700000000000);
		expect(result.ok).toBe(true);
		const content = fs.readFileSync(sessionPath, "utf-8");
		expect(content).toContain("[Cron delivery: task");
	});

	it("returns ok:false when the file does not exist", () => {
		const missing = path.join(agentDir, "sessions", "ghost.jsonl");
		const result = appendMirrorEntry(missing, "task", "brief", 1700000000000);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("read session failed");
	});

	it("appends to an empty file (no last entry)", () => {
		const sessionPath = path.join(agentDir, "sessions", "empty.jsonl");
		fs.writeFileSync(sessionPath, "", "utf-8");
		const result = appendMirrorEntry(sessionPath, "task", "brief", 1700000000000);
		expect(result.ok).toBe(true);
		const entries = readSession(sessionPath);
		expect(entries).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// mirrorDeliveryToSession (orchestrator)
// ---------------------------------------------------------------------------

describe("mirrorDeliveryToSession", () => {
	it("mirrors successfully on DingTalk with toConversationId", async () => {
		const convId = "cid_dm_001";
		const sessionPath = writeSession(`${convId}.jsonl`, [
			{ type: "message", id: "m1", parentId: null, message: { role: "user", content: [] } },
			{ type: "message", id: "m2", parentId: "m1", message: { role: "assistant", content: [] } },
		]);

		const result = await mirrorDeliveryToSession({
			task: { name: "daily-brief", agentDir },
			brief: "5 PRs today",
			delivery: { channel: "dingtalk", toConversationId: convId },
		});

		expect(result.ok).toBe(true);
		const entries = readSession(sessionPath);
		const mirror = entries[2] as { message: { content: Array<{ text: string }> } };
		expect(mirror.message.content[0]?.text).toContain("5 PRs today");
	});

	it("mirrors successfully on DingTalk DM (toUserId only, scan finds most recent)", async () => {
		const dm = writeSession("dm_session.jsonl", [
			{ type: "message", id: "m1", parentId: null, message: { role: "user", content: [] } },
			{ type: "message", id: "m2", parentId: "m1", message: { role: "assistant", content: [] } },
		]);
		const now = Date.now();
		fs.utimesSync(dm, now / 1000, now / 1000);

		const result = await mirrorDeliveryToSession({
			task: { name: "daily-brief", agentDir },
			brief: "DM brief",
			delivery: { channel: "dingtalk", toUserId: "u1" },
		});

		expect(result.ok).toBe(true);
		const entries = readSession(dm);
		const mirror = entries[2] as { message: { content: Array<{ text: string }> } };
		expect(mirror.message.content[0]?.text).toContain("DM brief");
	});

	it("rejects on non-dingtalk channel", async () => {
		const result = await mirrorDeliveryToSession({
			task: { name: "t", agentDir },
			brief: "b",
			delivery: { channel: "telegram", toUserId: "u1" },
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("not supported for channel: telegram");
	});

	it("rejects when task has no agentDir / accountId", async () => {
		const result = await mirrorDeliveryToSession({
			task: { name: "t" }, // no agentDir, no accountId
			brief: "b",
			delivery: { channel: "dingtalk", toUserId: "u1" },
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("no agentDir / accountId");
	});

	it("rejects when no chat session exists (user has not chatted with bot)", async () => {
		// No sessions dir content for the user
		const result = await mirrorDeliveryToSession({
			task: { name: "t", agentDir },
			brief: "b",
			delivery: { channel: "dingtalk", toUserId: "u_never_chatted" },
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("no chat session found");
	});

	it("falls back to deprecated task.accountId when agentDir is undefined", async () => {
		// The deprecated `accountId` field is normally a workspace basename
		// (e.g. `omp-atomix`) that the gateway resolves to an absolute
		// path via config. For this unit test we use an absolute path
		// directly so the file resolution has a real on-disk target.
		const accountId = path.join(tempDir, "deprecated_workspace");
		const accountDir = accountId;
		fs.mkdirSync(path.join(accountDir, "sessions"), { recursive: true });
		const sessionPath = path.join(accountDir, "sessions", "dm.jsonl");
		fs.writeFileSync(
			sessionPath,
			`${JSON.stringify({ type: "message", id: "m1", parentId: null, message: { role: "user", content: [] } })}\n`,
			"utf-8",
		);

		const result = await mirrorDeliveryToSession({
			task: { name: "t", accountId }, // no agentDir
			brief: "via accountId",
			delivery: { channel: "dingtalk", toUserId: "u1" },
		});
		expect(result.ok).toBe(true);
		const entries = readSession(sessionPath);
		// 1 original (user) + 1 placeholder (assistant, alternation guard) + 1 mirror (user)
		expect(entries).toHaveLength(3);
		const last = entries[2] as { message: { role: string; content: Array<{ text: string }> } };
		expect(last.message.role).toBe("user");
		expect(last.message.content[0]?.text).toContain("via accountId");
	});
});
