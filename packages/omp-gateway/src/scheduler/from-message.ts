/**
 * Inbound cron task creation from channel messages.
 *
 * Closes the user-facing gap: a DingTalk (or other channel) message
 * can request a new scheduled task and have it persisted into the
 * owning account's `<agentDir>/cron/tasks/` directory — matching the
 * skeleton's directory layout — and also into the global scheduler
 * DB so the engine picks it up on its next tick.
 *
 * The message format is intentionally simple and slash-command-like
 * so a user can type it without an LLM in the loop:
 *
 *   /cron create <schedule> <command...>
 *   /cron create "0 8 * * *" echo good morning
 *
 * Extracted from `Gateway.#handleInboundMessage` so the create
 * logic can be unit-tested with a temp
 * agentDir, without spinning up a real Gateway or a real DingTalk
 * stream.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { SchedulerStorage } from "./types";

export interface CronIntent {
	schedule: string;
	command: string;
	type: "shell" | "agent";
}

const CRON_CREATE_PREFIX = "/cron create";

export function parseCronIntent(text: string): CronIntent | undefined {
	const trimmed = text.trim();
	if (!trimmed.startsWith(CRON_CREATE_PREFIX)) return undefined;
	const rest = trimmed.slice(CRON_CREATE_PREFIX.length).trimStart();

	// Format: /cron create <schedule> -- <command...>
	// The `--` is the standard end-of-options marker; it cleanly
	// separates the cron expression (which may itself contain
	// whitespace) from the command to run. Trying to split the
	// schedule on whitespace is ambiguous because cron expressions
	// are themselves 5/6/7 space-separated fields.
	const sepIdx = rest.indexOf(" -- ");
	if (sepIdx === -1) return undefined;
	const schedule = rest.slice(0, sepIdx).trim();
	const command = rest.slice(sepIdx + 4).trim();

	if (!schedule || !command) return undefined;

	return {
		schedule,
		command,
		type: "shell",
	};
}

export interface CreateFromMessageResult {
	name: string;
	schedule: string;
	command: string;
	type: "shell" | "agent";
	taskDir: string;
	filePath: string;
}

export interface CreateFromMessageError {
	reason: "not-cron-intent" | "no-agent-dir" | "missing-schedule" | "missing-command" | "write-failed" | "db-failed";
	detail?: string;
}

export type CreateFromMessageOutcome =
	| { ok: true; result: CreateFromMessageResult }
	| { ok: false; error: CreateFromMessageError };

/**
 * Create a cron task from an inbound channel message.
 *
 * Returns an outcome (not throw) so the caller can render a useful
 * error back to the user without try/catch noise. On success the
 * task is:
 *   1. Persisted to `<agentDir>/cron/tasks/<name>.json5` — matches
 *      the skeleton's directory layout and the existing
 *      SchedulerFileStore format.
 *   2. Inserted into the global scheduler DB so the engine picks
 *      it up on its next tick.
 *
 * The file is the human-readable / git-trackable view; the DB row
 * is the runtime source of truth. Today we write to both; a future
 * refactor could rely on the file store's existing syncToDb path
 * instead, but the current SchedulerFileStore is wired to the
 * global tasks dir, not per-agentDir, so the explicit dual-write
 * is the path of least resistance.
 */
export function createCronTaskFromMessage(
	text: string,
	agentDir: string | undefined,
	storage: SchedulerStorage,
	/** Channel platform for auto-fill delivery.channel (e.g. "dingtalk") */
	sourceChannel?: string,
	/** User ID for auto-fill delivery.toUserId */
	sourceUser?: string,
): CreateFromMessageOutcome {
	if (!agentDir) {
		return { ok: false, error: { reason: "no-agent-dir" } };
	}
	const intent = parseCronIntent(text);
	if (!intent) {
		return { ok: false, error: { reason: "not-cron-intent" } };
	}

	const name = `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
	const taskDir = path.join(agentDir, "cron", "tasks");
	const filePath = path.join(taskDir, `${name}.json5`);

	const fileContent = {
		name,
		cron: intent.schedule,
		command: intent.command,
		type: intent.type,
		timeoutMs: intent.type === "agent" ? 120_000 : 30_000,
	};

	try {
		fs.mkdirSync(taskDir, { recursive: true, mode: 0o700 });
		fs.writeFileSync(filePath, `${JSON.stringify(fileContent, null, 2)}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
	} catch (err) {
		return {
			ok: false,
			error: { reason: "write-failed", detail: String(err) },
		};
	}

	try {
		storage.addTask({
			name,
			cron: intent.schedule,
			command: intent.command,
			taskType: intent.type,
			timeoutMs: fileContent.timeoutMs,
			agentDir,
			delivery: sourceChannel ? { channel: sourceChannel, toUserId: sourceUser, mode: "announce" } : undefined,
			status: "active",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			runCount: 0,
			failCount: 0,
			consecutiveFailures: 0,
		});
	} catch (err) {
		// Roll back the file we just wrote so we don't leave an
		// orphan definition that the user would have to clean up.
		try {
			fs.unlinkSync(filePath);
		} catch {
			// best-effort
		}
		return {
			ok: false,
			error: { reason: "db-failed", detail: String(err) },
		};
	}

	return {
		ok: true,
		result: {
			name,
			schedule: intent.schedule,
			command: intent.command,
			type: intent.type,
			taskDir,
			filePath,
		},
	};
}
