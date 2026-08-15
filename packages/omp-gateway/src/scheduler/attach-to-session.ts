/**
 * attach_to_session — mirror cron delivery to the user's chat session.
 *
 * Background
 * ----------
 * Cron deliveries are fire-and-forget: the brief is pushed to the
 * user's IM, but the user's chat session has no record of it. If the
 * user later DMs the bot asking "yesterday's brief mentioned X" the
 * chat agent has no idea what the brief said.
 *
 * `attachToSession: true` opts the task in. After a successful
 * delivery, the gateway appends a labelled user-role message entry to
 * the chat session JSONL so the next reply lands in a session that
 * already contains the brief.
 *
 * This is the same pattern as Hermes Agent's `attach_to_session`
 * (see `hermes-agent.nousresearch.com/docs/developer-guide/cron-internals`):
 * mirror the delivery as a user-role turn with a `[Cron delivery: ...]`
 * label so the chat agent can recognise it as a system-injected
 * delivery, not a real user message.
 *
 * Implementation
 * --------------
 * The module is pure (no I/O beyond `fs` and `path`): the gateway
 * injects the `mirrorDeliveryToSession` function as a `CronDeps`
 * dependency (see `cron-service.ts: MirrorToSessionFn`). This file
 * holds the resolution and append logic so it can be unit-tested
 * against a real temp directory + JSONL.
 *
 * Scope
 * -----
 * - Channel: DingTalk only for now. The label, the IM-mapped session
 *   path convention, and the conversationId rules are all
 *   DingTalk-shaped; other channels would need their own
 *   session-path conventions before extending.
 * - Group vs DM: explicit `toConversationId` (group / saved DM) maps
 *   directly. Pure DM (`toUserId` only) falls back to the most
 *   recent non-cron session file under `<agentDir>/sessions/`.
 *   This is best-effort — the user must have previously chatted with
 *   the bot for the file to exist.
 * - Message alternation: if the chat session's last entry is `user`,
 *   we insert a tiny placeholder assistant turn before the user
 *   mirror, so the LLM provider's strict user/assistant alternation
 *   is not violated. (Most providers reject two consecutive `user`
 *   turns.)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { buildAgentSessionPath } from "@oh-my-pi/pi-coding-agent/skeleton";

/** Mirrors the `delivery` shape on `ScheduledTask`. */
export interface MirrorDelivery {
	channel: string;
	accountId?: string;
	toUserId?: string;
	toConversationId?: string;
}

/** Result of a single mirror attempt. */
export type MirrorResult = { ok: true } | { ok: false; error: string };

/** Local time string used in the mirror label. */
function localTimestamp(ms: number): string {
	return new Date(ms).toLocaleString();
}

/** Filename pattern for cron session files. Mirrors `session-paths.ts:CRON_FILE`. */
const CRON_FILE = /^cron_\d+\.jsonl$/;

/**
 * Resolve the chat session JSONL that a cron delivery should be
 * mirrored to. Returns the path, or `undefined` when no suitable
 * session exists.
 *
 * Priority:
 *   1. `toConversationId` set → `buildAgentSessionPath(agentDir, ...)`.
 *      The file MUST exist (no prior chat → no mirror).
 *   2. `toUserId` set, no `toConversationId` → scan
 *      `<agentDir>/sessions/` for the most recent non-cron file
 *      (DM best-effort).
 *   3. Neither → no mirror.
 */
export function resolveMirrorSessionPath(
	agentDir: string | undefined,
	delivery: Pick<MirrorDelivery, "toConversationId" | "toUserId">,
): string | undefined {
	if (!agentDir) return undefined;

	if (delivery.toConversationId) {
		const sessionPath = buildAgentSessionPath(agentDir, delivery.toConversationId);
		if (fs.existsSync(sessionPath)) return sessionPath;
		return undefined;
	}

	if (delivery.toUserId) {
		const sessionsDir = path.join(agentDir, "sessions");
		if (!fs.existsSync(sessionsDir)) return undefined;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
		} catch {
			return undefined;
		}
		let best: { full: string; mtimeMs: number } | undefined;
		for (const ent of entries) {
			if (!ent.isFile() || !ent.name.endsWith(".jsonl")) continue;
			// Skip cron session files — they belong to a previous cron
			// run, not the user's interactive chat.
			if (CRON_FILE.test(ent.name)) continue;
			const full = path.join(sessionsDir, ent.name);
			let stat: fs.Stats;
			try {
				stat = fs.statSync(full);
			} catch {
				continue;
			}
			if (!best || stat.mtimeMs > best.mtimeMs) {
				best = { full, mtimeMs: stat.mtimeMs };
			}
		}
		return best?.full;
	}

	return undefined;
}

/**
 * Append a labelled user-role message entry to the chat session
 * JSONL. Returns `{ ok: true }` on success, or `{ ok: false, error }`
 * on I/O / parse failure.
 *
 * The label format is the same as Hermes's `attach_to_session`:
 *
 *     [Cron delivery: <taskName> at <local time>]\n\n<brief>
 *
 * so the chat agent on the next user reply can recognise the entry as
 * a system-injected delivery.
 *
 * Message alternation: OMP session files alternate user / assistant /
 * toolResult. If the last entry is `user`, the mirror would create
 * two consecutive user turns (a model API violation). In that case
 * we insert a small placeholder assistant turn before the user
 * mirror, mirroring the "user asks, assistant acknowledges system
 * message" pattern.
 */
export function appendMirrorEntry(
	sessionPath: string,
	taskName: string,
	brief: string,
	now: number = Date.now(),
): MirrorResult {
	let lastLine: string | undefined;
	try {
		const content = fs.readFileSync(sessionPath, "utf-8");
		const lines = content.split("\n").filter(l => l.trim());
		lastLine = lines[lines.length - 1];
	} catch (err) {
		return { ok: false, error: `read session failed: ${err instanceof Error ? err.message : String(err)}` };
	}

	const newId = `mirror_${now}_${Math.random().toString(36).slice(2, 8)}`;
	const label = `[Cron delivery: ${taskName} at ${localTimestamp(now)}]\n\n${brief}`;

	let lastEntry: { id?: string; message?: { role?: string } } | undefined;
	if (lastLine) {
		try {
			lastEntry = JSON.parse(lastLine);
		} catch {
			// Malformed last line — still safe to append, just can't
			// enforce alternation.
		}
	}

	const lastRole = lastEntry?.message?.role;
	const linesToWrite: string[] = [];

	if (lastRole === "user") {
		// Insert a placeholder assistant turn so the mirror user
		// message doesn't violate user/assistant alternation.
		linesToWrite.push(
			JSON.stringify({
				type: "message",
				id: `${newId}_ack`,
				parentId: lastEntry?.id ?? null,
				timestamp: new Date(now - 1).toISOString(),
				message: {
					role: "assistant",
					content: [{ type: "text", text: "(noted)" }],
				},
			}),
		);
	}

	linesToWrite.push(
		JSON.stringify({
			type: "message",
			id: newId,
			parentId: lastEntry?.id ?? null,
			timestamp: new Date(now).toISOString(),
			message: {
				role: "user",
				content: [{ type: "text", text: label }],
			},
		}),
	);

	try {
		fs.appendFileSync(sessionPath, `${linesToWrite.join("\n")}\n`, "utf-8");
		return { ok: true };
	} catch (err) {
		return { ok: false, error: `append failed: ${err instanceof Error ? err.message : String(err)}` };
	}
}

/**
 * End-to-end mirror orchestrator. Resolves the session path, then
 * appends the mirror entry. Returns a structured result.
 *
 * The gateway calls this via the `mirrorToSession` dep on `CronDeps`.
 * Errors are non-fatal: the caller should log and continue.
 */
export async function mirrorDeliveryToSession(params: {
	task: { name: string; agentDir?: string; accountId?: string };
	brief: string;
	delivery: MirrorDelivery;
}): Promise<{ ok: boolean; error?: string }> {
	if (params.delivery.channel !== "dingtalk") {
		return { ok: false, error: `mirror not supported for channel: ${params.delivery.channel}` };
	}

	const agentDir = params.task.agentDir ?? params.task.accountId;
	if (!agentDir) {
		return { ok: false, error: "task has no agentDir / accountId; cannot resolve chat session" };
	}

	const sessionPath = resolveMirrorSessionPath(agentDir, params.delivery);
	if (!sessionPath) {
		return { ok: false, error: "no chat session found (user has not started a conversation yet)" };
	}

	const result = appendMirrorEntry(sessionPath, params.task.name, params.brief);
	return result.ok ? { ok: true } : { ok: false, error: result.error };
}
