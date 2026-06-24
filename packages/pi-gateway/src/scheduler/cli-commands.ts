/**
 * Shared cron CLI command implementations.
 *
 * These functions provide the canonical implementation of cron subcommands
 * used by both `pi-gateway` and `omp gateway cron`. They live in the
 * scheduler package so both CLIs can call them without duplicating logic.
 *
 * Feature set (richer than the old pi-gateway CLI):
 * - create: --name, --type, --deliver, --timeout-ms, --skills, --retry, --pre-script
 * - run: writes JSONL execution log + links agent session traces
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { appendExecutionLog } from "./execution-log";
import { executeScheduledCommand, scanCronPrompt } from "./executor";
import type { SchedulerDbStorage } from "./storage";
import {
	formatExecutionRow,
	formatTaskRow,
	getGatewayPidPath,
	getNextRun,
	isDaemonRunning,
	parseSchedule,
} from "./types";

// ---------------------------------------------------------------------------
// Agent session path discovery
// ---------------------------------------------------------------------------

/**
 * Resolve a task's `accountId` to the `agentDir` declared in
 * `~/.omp/gateway.json` (under `channels.dingtalk.accounts[<id>]`).
 *
 * Returns the agentDir path on a hit, or `undefined` when:
 *   - the accountId has no matching entry in config, OR
 *   - the entry exists but has no `agentDir` field.
 *
 * Callers in `cronRun` use the returned path as the `Bun.spawn` cwd so
 * the spawned `omp` process finds the right `.omp/config.yml` for the
 * account that owns the task. Returning `undefined` triggers a fallback
 * to the gateway cwd with a warning, so a stale or removed binding does
 * not silently fail (the task still runs, just with the gateway's
 * default agent context).
 *
 * Extracted from `cronRun` so the resolution can be unit-tested with a
 * fixture config object without touching the real `~/.omp/gateway.json`
 * or mocking module imports.
 */
export function resolveAgentCwd(
	accountId: string,
	config: { channels?: { dingtalk?: { accounts?: Record<string, { agentDir?: string }> } } },
): string | undefined {
	const account = config.channels?.dingtalk?.accounts?.[accountId];
	return account?.agentDir;
}

/**
 * Find the OMP agent session JSONL created during a specific time window.
 *
 * OMP writes agent session files to
 *   `~/.omp/agent/sessions/<encoded-cwd>/<timestamp>_<id>.jsonl`
 * where the ISO timestamp prefix is the immutable creation time of the
 * session (e.g. `2026-06-15T09-18-46-865Z_019eca93-...jsonl`).
 *
 * Why filename-based, not mtime: OMP frequently touches mtime on existing
 * session files (compaction, --continue, etc.), so mtime-based filtering
 * produces false positives linking to the wrong (older) session.
 *
 * To stay decoupled from OMP's cwd-encoding scheme, we scan ALL session
 * subdirectories and pick the file whose filename timestamp is closest
 * to (and >= startedAt - tolerance) within the window.
 */
export function findAgentSessionPath(
	startedAt: number,
	endedAt: number,
	sessionsRoot: string = path.join(os.homedir(), ".omp", "agent", "sessions"),
): string | undefined {
	if (!fs.existsSync(sessionsRoot)) return undefined;

	// The order is mtime-first, filename-second:
	//   - mtime is the only timezone-agnostic truth. The new layout encodes
	//     HHMMSS in local time; legacy encodes UTC. Parsing either requires
	//     knowing the writer's TZ. We don't trust filenames for timestamps.
	//   - Filename regexes are kept as a SANITY filter: a random `notes.jsonl`
	//     dropped into the session dir must not be considered a session. They
	//     are NOT used to compute the timestamp, only to accept or reject.
	//   - Within [startedAt - 5s, endedAt + 5s], the file with the LATEST
	//     mtime wins. This handles the common case where the agent task
	//     creates a new session file (its mtime is in the window and is the
	//     latest) and also the case where a resumed session gets touched
	//     during the run (its bumped mtime is the latest).
	//
	// Layouts we recognise:
	//   <root>/<project>/by-date/<YYYY-MM-DD>/<HHMMSS>[-<slug>]__<8hex>.jsonl
	//   <root>/<project>/<YYYY-MM-DD>T<HH-MM-SS-mmm>Z_<uuidv7>.jsonl   (legacy)
	//
	// The walker descends into every non-hidden subdirectory at the root
	// because the cwd-encoded project subdir name is opaque to the gateway.
	const SESSION_FILE = /^(\d{6})(?:-[a-z0-9-]+)?__[0-9a-f]{8}\.jsonl$/;
	const LEGACY_SESSION_FILE = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_/;
	const toleranceMs = 5_000;

	let bestMatch: { path: string; score: number } | undefined;
	try {
		const walk = (dir: string): void => {
			let entries: fs.Dirent[];
			try {
				entries = fs.readdirSync(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const ent of entries) {
				const full = path.join(dir, ent.name);
				if (ent.isDirectory()) {
					if (ent.name.startsWith(".")) continue;
					walk(full);
					continue;
				}
				if (!ent.isFile() || !ent.name.endsWith(".jsonl")) continue;
				// Accept any file that matches the new or legacy naming
				// convention. Both encode a creation timestamp; legacy embeds
				// UTC in the filename, new layout embeds local time. mtime is
				// the only timezone-agnostic truth.
				if (!SESSION_FILE.test(ent.name) && !LEGACY_SESSION_FILE.test(ent.name)) continue;

				let mtimeMs: number;
				try {
					mtimeMs = fs.statSync(full).mtimeMs;
				} catch {
					continue;
				}
				if (mtimeMs < startedAt - toleranceMs) continue;
				if (mtimeMs > endedAt + toleranceMs) continue;

				// Prefer the most recent file in the window. The agent session
				// file is created during the cron run, so the latest mtime in
				// [startedAt, endedAt] is the match. Smaller score = better.
				const score = endedAt - mtimeMs;
				if (!bestMatch || score < bestMatch.score) {
					bestMatch = { path: full, score };
				}
			}
		};
		walk(sessionsRoot);
	} catch {
		return undefined;
	}
	return bestMatch?.path;
}

// ---------------------------------------------------------------------------
// Cron subcommands
// ---------------------------------------------------------------------------

export async function cronCreate(args: string[], storage: SchedulerDbStorage): Promise<void> {
	let name: string | undefined;
	let schedule: string | undefined;
	let deliver: string | undefined;
	let deliverUser: string | undefined;
	let accountId: string | undefined;
	let agentDir: string | undefined;
	let type: "shell" | "agent" = "shell";
	let model: string | undefined;
	let provider: string | undefined;
	let enabledToolsets: string[] | undefined;
	let timeoutMs: number | undefined;
	let skills: string[] | undefined;
	let retryMaxAttempts: number | undefined;
	let preScript: string | undefined;
	let sourceChannel: string | undefined;
	let sourceUser: string | undefined;
	let repeatCount: number | undefined;
	const commandParts: string[] = [];

	let i = 0;
	while (i < args.length) {
		if (args[i] === "--name" && args[i + 1]) {
			name = args[i + 1]!;
			i += 2;
		} else if (args[i] === "--type" && args[i + 1]) {
			type = args[i + 1] as "shell" | "agent";
			i += 2;
		} else if (args[i] === "--deliver" && args[i + 1]) {
			deliver = args[i + 1];
			i += 2;
		} else if (args[i] === "--deliver-user" && args[i + 1]) {
			deliverUser = args[i + 1]!;
			i += 2;
		} else if (args[i] === "--account" && args[i + 1]) {
			accountId = args[i + 1]!;
			i += 2;
		} else if (args[i] === "--agent-dir" && args[i + 1]) {
			agentDir = args[i + 1]!;
			i += 2;
		} else if (args[i] === "--model" && args[i + 1]) {
			i += 2;
		} else if (args[i] === "--provider" && args[i + 1]) {
			provider = args[i + 1]!;
			i += 2;
		} else if (args[i] === "--toolsets" && args[i + 1]) {
			enabledToolsets = args[i + 1]!.split(",")
				.map(s => s.trim())
				.filter(Boolean);
			if (enabledToolsets.length === 0) {
				console.error(`Invalid --toolsets: must be a non-empty comma-separated list (got "${args[i + 1]}")`);
				process.exitCode = 1;
				return;
			}
			i += 2;
		} else if (args[i] === "--repeat" && args[i + 1]) {
			const v = Number.parseInt(args[i + 1]!, 10);
			if (!Number.isFinite(v) || v < 1) {
				console.error(`Invalid --repeat: must be a positive integer (got "${args[i + 1]}")`);
				process.exitCode = 1;
				return;
			}
			repeatCount = v;
			i += 2;
		} else if (args[i] === "--source-channel" && args[i + 1]) {
			sourceChannel = args[i + 1]!;
			i += 2;
		} else if (args[i] === "--source-user" && args[i + 1]) {
			sourceUser = args[i + 1]!;
			i += 2;
		} else if (args[i] === "--timeout-ms" && args[i + 1]) {
			const v = Number.parseInt(args[i + 1]!, 10);
			if (!Number.isFinite(v) || v <= 0) {
				console.error(`Invalid --timeout-ms: must be a positive integer (got "${args[i + 1]}")`);
				process.exitCode = 1;
				return;
			}
			timeoutMs = v;
			i += 2;
		} else if (args[i] === "--skills" && args[i + 1]) {
			skills = args[i + 1]!.split(",")
				.map(s => s.trim())
				.filter(Boolean);
			if (skills.length === 0) {
				console.error(`Invalid --skills: must be a non-empty comma-separated list (got "${args[i + 1]}")`);
				process.exitCode = 1;
				return;
			}
			i += 2;
		} else if (args[i] === "--retry" && args[i + 1]) {
			const v = Number.parseInt(args[i + 1]!, 10);
			if (!Number.isFinite(v) || v < 1) {
				console.error(`Invalid --retry: must be a positive integer >= 1 (got "${args[i + 1]}")`);
				process.exitCode = 1;
				return;
			}
			retryMaxAttempts = v;
			i += 2;
		} else if (args[i] === "--pre-script" && args[i + 1]) {
			preScript = args[i + 1]!;
			i += 2;
		} else {
			if (!schedule) schedule = args[i];
			else commandParts.push(args[i]!);
			i++;
		}
	}

	const command = commandParts.join(" ");
	if (!schedule || !command) {
		console.error(
			"Usage: <schedule> <command...> [--name <name>] [--type shell|agent] [--deliver <channel>] [--deliver-user <id>] [--account <accountId>] [--agent-dir <path>] [--model <model>] [--provider <provider>] [--toolsets <a,b,c>] [--source-channel <ch>] [--source-user <uid>] [--timeout-ms <ms>] [--skills <s1,s2,...>] [--retry <maxAttempts>] [--pre-script <path>]",
		);
		process.exitCode = 1;
		return;
	}

	if (!name) name = `task_${Date.now()}`;

	const parsed = parseSchedule(schedule);
	if (parsed.error) {
		console.error(`Invalid schedule: ${parsed.error}`);
		process.exitCode = 1;
		return;
	}

	// agentDir resolves where the spawned omp process runs (its cwd). It
	// is set directly via --agent-dir, or resolved from --account via
	// gateway.json. For agent tasks an agentDir is required so omp finds
	// the right .omp/config.yml; shell tasks may run without one (the
	// gateway cwd is used).
	if (!agentDir && accountId) {
		try {
			const { loadConfig } = await import("../config");
			const cfg = await loadConfig();
			agentDir = resolveAgentCwd(accountId, cfg);
			if (!agentDir) {
				console.error(
					`--account "${accountId}" has no agentDir in gateway.json. ` +
						"Pass --agent-dir <path> directly, or fix the account binding.",
				);
				process.exitCode = 1;
				return;
			}
		} catch (err) {
			console.error(`Failed to load gateway.json to resolve --account: ${err}`);
			process.exitCode = 1;
			return;
		}
	}

	if (type === "agent" && !agentDir) {
		console.error(
			"Agent tasks require --agent-dir (or --account with an agentDir in gateway.json) " +
				"so omp runs in the correct project. Shell tasks may omit it.",
		);
		process.exitCode = 1;
		return;
	}

	// Injection scan for agent task prompts
	if (type === "agent") {
		const blocked = scanCronPrompt(command);
		if (blocked) {
			console.error(`[BLOCKED] Task prompt matches threat pattern '${blocked}'.`);
			process.exitCode = 1;
			return;
		}
	}

	if (storage.getTaskByName(name)) {
		console.error(`Task "${name}" already exists.`);
		process.exitCode = 1;
		return;
	}

	// Auto-fill deliver/deliverUser from source channel/user if not explicitly set
	if (!deliver && sourceChannel) {
		deliver = sourceChannel;
	}
	if (!deliverUser && sourceUser) {
		deliverUser = sourceUser;
	}

	const nextRun =
		parsed.type === "cron" ? getNextRun(parsed.schedule) : parsed.nextRunAt ? new Date(parsed.nextRunAt) : undefined;
	storage.addTask({
		name,
		cron: parsed.schedule,
		command,
		scheduleType: parsed.type,
		taskType: type,
		model,
		provider,
		enabledToolsets,
		timeoutMs: timeoutMs ?? (type === "agent" ? 120_000 : 30_000),
		retry:
			retryMaxAttempts !== undefined ? { maxAttempts: retryMaxAttempts, backoffMs: [1000, 5000, 30000] } : undefined,
		skills,
		preScript,
		deliver,
		deliverUser,
		accountId,
		agentDir,
		delivery: deliver ? { channel: deliver, toUserId: deliverUser, mode: "announce" } : undefined,
		repeatCount,
		repeatCompleted: 0,
		status: "active",
		createdAt: Date.now(),
		updatedAt: Date.now(),
		nextRunAt: nextRun ? nextRun.getTime() : parsed.nextRunAt,
		runCount: 0,
		failCount: 0,
		consecutiveFailures: 0,
	});

	console.log(`Task "${name}" created.`);
	console.log(
		`  Type: ${parsed.type} | Schedule: ${parsed.schedule} | Next: ${nextRun ? nextRun.toLocaleString() : "—"}`,
	);
	if (deliver) console.log(`  Delivery: ${deliver}${deliverUser ? ` (user: ${deliverUser})` : ""}`);
	if (model) console.log(`  Model: ${model}`);
	if (provider) console.log(`  Provider: ${provider}`);
	if (enabledToolsets) console.log(`  Toolsets: ${enabledToolsets.join(", ")}`);
	if (agentDir) console.log(`  AgentDir: ${agentDir}`);
	else if (accountId) console.log(`  Account: ${accountId}`);
	if (timeoutMs !== undefined) console.log(`  Timeout: ${timeoutMs}ms`);
	if (skills) console.log(`  Skills: ${skills.join(", ")}`);
	if (retryMaxAttempts !== undefined) console.log(`  Retry: max ${retryMaxAttempts} attempts (backoff 1s/5s/30s)`);
	if (preScript) console.log(`  Pre-script: ${preScript}`);
}

export async function cronList(storage: SchedulerDbStorage, json: boolean): Promise<void> {
	const tasks = storage.listTasks();
	if (json) {
		console.log(JSON.stringify(tasks, null, 2));
		return;
	}
	if (tasks.length === 0) {
		console.log("No scheduled tasks.");
		return;
	}
	// Column widths: 21+1+6+1+12+1+8+1+16+1+15+1+7+1+20+1+8+1+8+1+21 = 148 chars
	const HEADER =
		"NAME".padEnd(21) +
		" " +
		"TYPE".padEnd(6) +
		" " +
		"AGENT".padEnd(12) +
		" " +
		"STATUS".padEnd(8) +
		" " +
		"CRON".padEnd(16) +
		" " +
		"MODEL".padEnd(15) +
		" " +
		"REPEAT".padEnd(7) +
		" " +
		"CHANNEL".padEnd(20) +
		" " +
		"LAST".padEnd(8) +
		" " +
		"DELIV".padEnd(8) +
		" " +
		"NEXT RUN".padEnd(21);
	console.log(HEADER);
	console.log("─".repeat(HEADER.length));
	for (const task of tasks) console.log(formatTaskRow(task));
}

export async function cronUpdate(args: string[], storage: SchedulerDbStorage): Promise<void> {
	if (args.length === 0) {
		console.error(
			"Usage: cron update <name> [--account <id> | --clear-account] [--deliver <channel> | --clear-deliver] [--deliver-user <id> | --clear-deliver-user] [--timeout-ms <ms>]",
		);
		process.exitCode = 1;
		return;
	}
	const name = args[0]!;
	const task = storage.getTaskByName(name);
	if (!task) {
		console.error(`Task "${name}" not found.`);
		process.exitCode = 1;
		return;
	}

	type AccountState = { tag: "none" } | { tag: "set"; value: string } | { tag: "clear" };
	type OptionalStringState = { tag: "none" } | { tag: "set"; value: string } | { tag: "clear" };

	const updates: Partial<typeof task> = {};
	let accountState: AccountState = { tag: "none" };
	let deliverState: OptionalStringState = { tag: "none" };
	let deliverUserState: OptionalStringState = { tag: "none" };
	let timeoutMs: number | undefined;

	for (let i = 1; i < args.length; i++) {
		const a = args[i]!;
		const next = args[i + 1];
		if (a === "--account") {
			if (!next) {
				console.error("--account requires a value");
				process.exitCode = 1;
				return;
			}
			if (accountState.tag === "clear") {
				console.error("Cannot combine --account and --clear-account");
				process.exitCode = 1;
				return;
			}
			accountState = { tag: "set", value: next };
			i++;
		} else if (a === "--clear-account") {
			if (accountState.tag === "set") {
				console.error("Cannot combine --account and --clear-account");
				process.exitCode = 1;
				return;
			}
			accountState = { tag: "clear" };
		} else if (a === "--deliver") {
			if (!next) {
				console.error("--deliver requires a value");
				process.exitCode = 1;
				return;
			}
			if (deliverState.tag === "clear") {
				console.error("Cannot combine --deliver and --clear-deliver");
				process.exitCode = 1;
				return;
			}
			deliverState = { tag: "set", value: next };
			i++;
		} else if (a === "--clear-deliver") {
			if (deliverState.tag === "set") {
				console.error("Cannot combine --deliver and --clear-deliver");
				process.exitCode = 1;
				return;
			}
			deliverState = { tag: "clear" };
		} else if (a === "--deliver-user") {
			if (!next) {
				console.error("--deliver-user requires a value");
				process.exitCode = 1;
				return;
			}
			if (deliverUserState.tag === "clear") {
				console.error("Cannot combine --deliver-user and --clear-deliver-user");
				process.exitCode = 1;
				return;
			}
			deliverUserState = { tag: "set", value: next };
			i++;
		} else if (a === "--clear-deliver-user") {
			if (deliverUserState.tag === "set") {
				console.error("Cannot combine --deliver-user and --clear-deliver-user");
				process.exitCode = 1;
				return;
			}
			deliverUserState = { tag: "clear" };
		} else if (a === "--timeout-ms") {
			if (!next) {
				console.error("--timeout-ms requires a value");
				process.exitCode = 1;
				return;
			}
			const v = Number.parseInt(next, 10);
			if (!Number.isFinite(v) || v <= 0) {
				console.error(`Invalid --timeout-ms: must be a positive integer (got "${next}")`);
				process.exitCode = 1;
				return;
			}
			timeoutMs = v;
			i++;
		} else {
			console.error(`Unknown flag: ${a}`);
			process.exitCode = 1;
			return;
		}
	}

	// --account resolves to agentDir (the new execution-routing field).
	// We still write accountId for backward-compat reads, but agentDir is
	// what cronRun actually uses as the spawn cwd.
	if (accountState.tag === "set") {
		try {
			const { loadConfig } = await import("../config");
			const cfg = await loadConfig();
			const resolved = resolveAgentCwd(accountState.value, cfg);
			if (!resolved) {
				console.error(
					`--account "${accountState.value}" has no agentDir in gateway.json. ` +
						"Pass --agent-dir <path> directly, or fix the account binding.",
				);
				process.exitCode = 1;
				return;
			}
			updates.accountId = accountState.value;
			updates.agentDir = resolved;
		} catch (err) {
			console.error(`Failed to load gateway.json to resolve --account: ${err}`);
			process.exitCode = 1;
			return;
		}
	} else if (accountState.tag === "clear") {
		updates.accountId = undefined;
		updates.agentDir = undefined;
	}

	// --deliver / --deliver-user write the structured `delivery` object.
	// Recompute it from the effective channel/user after applying the
	// requested set/clear so the delivery_* columns stay in sync with the
	// legacy deliver/deliver_user columns.
	if (deliverState.tag !== "none" || deliverUserState.tag !== "none") {
		const effChannel =
			deliverState.tag === "set" ? deliverState.value
			: deliverState.tag === "clear" ? undefined
			: task.delivery?.channel ?? task.deliver;
		const effUser =
			deliverUserState.tag === "set" ? deliverUserState.value
			: deliverUserState.tag === "clear" ? undefined
			: task.delivery?.toUserId ?? task.deliverUser;
		if (deliverState.tag === "set") updates.deliver = deliverState.value;
		else if (deliverState.tag === "clear") updates.deliver = undefined;
		if (deliverUserState.tag === "set") updates.deliverUser = deliverUserState.value;
		else if (deliverUserState.tag === "clear") updates.deliverUser = undefined;
		updates.delivery = effChannel
			? { channel: effChannel, toUserId: effUser, mode: "announce" }
			: undefined;
	}
	if (timeoutMs !== undefined) updates.timeoutMs = timeoutMs;

	if (Object.keys(updates).length === 0) {
		console.error("No changes specified. Pass at least one of --account, --deliver, --deliver-user, --timeout-ms.");
		process.exitCode = 1;
		return;
	}

	// buildDynamicUpdate treats `undefined` as NULL, so --clear-* becomes
	// the corresponding column = NULL. account_id/deliver/deliver_user are
	// already in TASK_UPDATE_FIELDS.
	storage.updateTask(task.id, updates);
	const changes: string[] = [];
	if (accountState.tag === "set") changes.push(`account: ${accountState.value}`);
	else if (accountState.tag === "clear") changes.push("account: cleared");
	if (deliverState.tag === "set") changes.push(`deliver: ${deliverState.value}`);
	else if (deliverState.tag === "clear") changes.push("deliver: cleared");
	if (deliverUserState.tag === "set") changes.push(`deliver-user: ${deliverUserState.value}`);
	else if (deliverUserState.tag === "clear") changes.push("deliver-user: cleared");
	if (timeoutMs !== undefined) changes.push(`timeout-ms: ${timeoutMs}`);
	console.log(`Task "${name}" updated.`);
	for (const c of changes) console.log(`  ${c}`);
}

export async function cronSetStatus(
	name: string,
	status: "active" | "disabled",
	storage: SchedulerDbStorage,
): Promise<void> {
	if (!name) {
		console.error("Usage: pause|resume <name>");
		process.exitCode = 1;
		return;
	}
	const task = storage.getTaskByName(name);
	if (!task) {
		console.error(`Task "${name}" not found.`);
		process.exitCode = 1;
		return;
	}
	storage.updateTask(task.id, {
		status,
		nextRunAt: status === "active" ? getNextRun(task.cron)?.getTime() : undefined,
		updatedAt: Date.now(),
	});
	console.log(`Task "${name}" ${status === "active" ? "resumed" : "paused"}.`);
}

export async function cronRun(name: string, storage: SchedulerDbStorage): Promise<void> {
	if (!name) {
		console.error("Usage: cron run <name>");
		process.exitCode = 1;
		return;
	}
	const task = storage.getTaskByName(name);
	if (!task) {
		console.error(`Task "${name}" not found.`);
		process.exitCode = 1;
		return;
	}
	const startedAt = Date.now();
	const exec = storage.recordExecution({ taskId: task.id, startedAt, status: "running" });
	try {
		// Resolve the spawn cwd. Prefer the new `agentDir` field directly;
		// fall back to resolving a legacy `accountId` via gateway.json. When
		// neither yields a path, leave cwd unset so executeScheduledCommand
		// uses the gateway cwd (shell tasks often don't need an agentDir).
		let cwd: string | undefined = task.agentDir;
		if (!cwd && task.accountId) {
			try {
				const { loadConfig } = await import("../config");
				const cfg = await loadConfig();
				cwd = resolveAgentCwd(task.accountId, cfg);
				if (!cwd) {
					console.error(
						`[warn] Task "${task.name}" is bound to account "${task.accountId}" but it has no agentDir in gateway.json. Falling back to gateway cwd.`,
					);
				}
			} catch (err) {
				console.error(`[warn] Failed to load gateway.json to resolve accountId: ${err}`);
			}
		}
		const { exitCode, output, stderr } = await executeScheduledCommand(task.command, {
			taskType: task.taskType,
			timeoutMs: task.timeoutMs,
			skills: task.skills,
			preScript: task.preScript,
			cwd,
		});
		const endedAt = Date.now();
		const durationMs = endedAt - startedAt;
		const status = exitCode === 0 ? "success" : "failure";

		// Link agent session trace for agent tasks
		const agentSessionPath = task.taskType === "agent" ? findAgentSessionPath(startedAt, endedAt) : undefined;

		storage.updateExecution(exec.id, {
			endedAt,
			exitCode,
			output,
			stderr,
			status,
			...(agentSessionPath ? { agentSessionPath } : {}),
		});
		storage.updateTask(task.id, {
			lastRunAt: Date.now(),
			runCount: task.runCount + 1,
			failCount: exitCode === 0 ? task.failCount : task.failCount + 1,
		});

		// Write full stdout/stderr to JSONL log
		appendExecutionLog(task.name, {
			id: exec.id,
			ts: endedAt,
			exitCode,
			status,
			durationMs,
			output,
			stderr,
		});

	// Manual `omp cron run` skips channel delivery — the scheduled path
	// through CronService owns delivery. Here we just print the captured
	// output to stdout/stderr so the operator sees what ran.
	if (output) console.log(output);
	if (stderr) console.error(stderr);

		if (agentSessionPath) {
			console.log(`[trace] agent session: ${agentSessionPath}`);
		}

		if (exitCode !== 0) {
			console.error(`Task "${name}" failed (exit ${exitCode}).`);
			process.exitCode = exitCode;
		} else {
			console.log(`Task "${name}" completed.`);
		}
	} catch (err) {
		const endedAt = Date.now();
		const agentSessionPath = task.taskType === "agent" ? findAgentSessionPath(startedAt, endedAt) : undefined;
		storage.updateExecution(exec.id, {
			endedAt,
			exitCode: 1,
			stderr: String(err),
			status: "failure",
			...(agentSessionPath ? { agentSessionPath } : {}),
		});
		if (agentSessionPath) console.log(`[trace] agent session: ${agentSessionPath}`);
		console.error(`Task "${name}" failed: ${err}`);
		process.exitCode = 1;
	}
}

export async function cronRemove(name: string, storage: SchedulerDbStorage): Promise<void> {
	if (!name) {
		console.error("Usage: cron remove <name>");
		process.exitCode = 1;
		return;
	}
	const task = storage.getTaskByName(name);
	if (!task) {
		console.error(`Task "${name}" not found.`);
		process.exitCode = 1;
		return;
	}
	storage.deleteTask(task.id);
	console.log(`Task "${name}" removed.`);
}

export function cronStatus(): void {
	// The scheduler runs inside the gateway process; check gateway.pid.
	const pidPath = getGatewayPidPath();
	const running = isDaemonRunning(pidPath);
	console.log(`Scheduler: ${running ? "running" : "stopped"}`);
	if (running) {
		try {
			const pid = Number.parseInt(fs.readFileSync(pidPath, "utf8").trim(), 10);
			if (!Number.isNaN(pid)) console.log(`  PID: ${pid}`);
		} catch {
			// ignore
		}
	}
}

export async function cronDiagnose(storage: SchedulerDbStorage, json: boolean): Promise<void> {
	const tasks = storage.listTasks();
	const total = tasks.length;
	const active = tasks.filter(t => t.status === "active").length;
	const paused = tasks.filter(t => t.status === "paused").length;
	const disabled = tasks.filter(t => t.status === "disabled").length;
	if (json) {
		console.log(JSON.stringify({ taskCounts: { total, active, paused, disabled } }, null, 2));
		return;
	}
	console.log("## Scheduler Diagnosis");
	console.log(`Tasks: ${total} total (${active} active, ${paused} paused, ${disabled} disabled)`);
}

export async function cronLogs(name: string, storage: SchedulerDbStorage, json: boolean): Promise<void> {
	if (!name) {
		console.error("Usage: cron logs <name>");
		process.exitCode = 1;
		return;
	}
	const task = storage.getTaskByName(name);
	if (!task) {
		console.error(`Task "${name}" not found.`);
		process.exitCode = 1;
		return;
	}
	const executions = storage.getExecutions(task.id, 20);
	if (json) {
		console.log(JSON.stringify(executions, null, 2));
		return;
	}
	if (executions.length === 0) {
		console.log(`No executions for task "${name}".`);
		return;
	}
	console.log("ID                 STATUS   DURATION EXIT");
	console.log("─".repeat(50));
	for (const exec of executions) console.log(formatExecutionRow(exec));
}

// ---------------------------------------------------------------------------
// Reconcile legacy unbound tasks
// ---------------------------------------------------------------------------

/**
 * Suggest and (optionally) apply accountId bindings for tasks that
 * pre-date the AGENT column. Heuristic, in priority order:
 *
 *   1. Task name starts with `<accountId>:` (e.g. `hr:daily-report`).
 *   2. Task name starts with `<agentDir basename>:` (e.g. the task
 *      `omp-atomix:wiki-cron` matches the `opencode` account whose
 *      agentDir ends in `omp-atomix`).
 *
 * The match must be a colon-delimited prefix, not a substring, so an
 * accountId of `hr` does not falsely bind a task named `hr3-daily`.
 *
 * Extracted from `cronReconcile` so the suggestion logic can be unit
 * tested with a fixture account map, no gateway.json required.
 */
export function suggestAccountBinding(
	taskName: string,
	accounts: Record<string, { agentDir?: string }>,
): { accountId: string; reason: string } | undefined {
	for (const [accountId, account] of Object.entries(accounts)) {
		if (taskName.startsWith(`${accountId}:`)) {
			return { accountId, reason: `name starts with "${accountId}:"` };
		}
		if (account.agentDir) {
			const basename = account.agentDir.split("/").filter(Boolean).pop();
			if (basename && taskName.startsWith(`${basename}:`)) {
				return {
					accountId,
					reason: `name starts with agentDir basename "${basename}:"`,
				};
			}
		}
	}
	return undefined;
}

/**
 * One-shot CLI: `cron reconcile [--apply]`.
 *
 * Default behaviour is a dry run: lists legacy tasks (no `accountId`)
 * with a heuristic suggestion column, and the user runs it again with
 * `--apply` to write the bindings. This is the only safe default —
 * silently rewriting storage based on a name match would be a footgun.
 */
export async function cronReconcile(args: string[], storage: SchedulerDbStorage): Promise<void> {
	const apply = args.includes("--apply");
	const unknownFlag = args.find(a => a !== "--apply");
	if (unknownFlag) {
		console.error(`Unknown flag: ${unknownFlag}. Usage: cron reconcile [--apply]`);
		process.exitCode = 1;
		return;
	}

	let cfg: Parameters<typeof resolveAgentCwd>[1];
	try {
		const { loadConfig } = await import("../config");
		cfg = await loadConfig();
	} catch (err) {
		console.error(`Failed to load gateway.json: ${err}`);
		process.exitCode = 1;
		return;
	}
	const accounts = cfg.channels?.dingtalk?.accounts ?? {};
	const accountKeys = Object.keys(accounts);
	if (accountKeys.length === 0) {
		console.log("No accounts in gateway.json. Nothing to reconcile against.");
		return;
	}

	const unbound = storage.listTasks().filter(t => !t.accountId);
	if (unbound.length === 0) {
		console.log("All tasks have an accountId. Nothing to reconcile.");
		return;
	}

	const rows = unbound.map(task => {
		const taskAny = task as { name: string; taskType?: string };
		const suggestion = suggestAccountBinding(taskAny.name, accounts);
		return { task, suggestion };
	});

	// Print table. Column widths are derived from the largest cell in
	// each column so the table never wraps.
	const nameColW = Math.max(4, ...rows.map(r => r.task.name.length));
	const typeColW = Math.max(4, ...rows.map(r => (r.task.taskType ?? "shell").length));
	const suggColW = Math.max(9, ...rows.map(r => (r.suggestion?.accountId ?? "—").length));
	const _reasonColW = Math.max(6, ...rows.map(r => (r.suggestion?.reason ?? "no match").length));
	const header = `${"NAME".padEnd(nameColW)}  ${"TYPE".padEnd(typeColW)}  ${"SUGGEST".padEnd(suggColW)}  REASON`;
	console.log(header);
	console.log("─".repeat(header.length));
	for (const { task, suggestion } of rows) {
		console.log(
			task.name.padEnd(nameColW) +
				"  " +
				(task.taskType ?? "shell").padEnd(typeColW) +
				"  " +
				(suggestion?.accountId ?? "—").padEnd(suggColW) +
				"  " +
				(suggestion?.reason ?? "no match"),
		);
	}
	console.log("");
	const matched = rows.filter(r => r.suggestion).length;
	console.log(`${matched} of ${rows.length} unbound task${rows.length === 1 ? "" : "s"} have a suggestion.`);
	if (!apply) {
		console.log("Re-run with --apply to write the bindings.");
		return;
	}

	let applied = 0;
	for (const { task, suggestion } of rows) {
		if (!suggestion) continue;
		storage.updateTask(task.id, { accountId: suggestion.accountId });
		applied++;
	}
	console.log(`Applied ${applied} update${applied === 1 ? "" : "s"}.`);
}
