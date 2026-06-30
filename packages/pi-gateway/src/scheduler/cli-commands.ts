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
import { findAgentSessionPath } from "../session-paths";
import { appendExecutionLog } from "./execution-log";
import { executeScheduledCommand, scanCronPrompt } from "./executor";
import type { SchedulerDbStorage } from "./storage";
import { runTestRun, type TestRunHardError, type TestRunResult } from "./test-run";
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

// ---------------------------------------------------------------------------
// Cron subcommands
// ---------------------------------------------------------------------------
// (findAgentSessionPath has moved to ../session-paths.ts. It now requires an
// agentDir argument and scopes its search to that agent's `sessions/` tree.
// The old cross-tree walk over `~/.omp/agent/sessions/` is gone.)

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
			deliverState.tag === "set"
				? deliverState.value
				: deliverState.tag === "clear"
					? undefined
					: (task.delivery?.channel ?? task.deliver);
		const effUser =
			deliverUserState.tag === "set"
				? deliverUserState.value
				: deliverUserState.tag === "clear"
					? undefined
					: (task.delivery?.toUserId ?? task.deliverUser);
		if (deliverState.tag === "set") updates.deliver = deliverState.value;
		else if (deliverState.tag === "clear") updates.deliver = undefined;
		if (deliverUserState.tag === "set") updates.deliverUser = deliverUserState.value;
		else if (deliverUserState.tag === "clear") updates.deliverUser = undefined;
		updates.delivery = effChannel ? { channel: effChannel, toUserId: effUser, mode: "announce" } : undefined;
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
	// Resolve the agentDir once so both success and error paths can use it
	// for session linking. Prefer the new `agentDir` field directly; fall
	// back to resolving a legacy `accountId` via gateway.json. This is also
	// the spawn cwd for agent tasks; for shell tasks the agentDir may be
	// undefined (we still record an execution).
	let agentDir: string | undefined = task.agentDir;
	if (!agentDir && task.accountId) {
		try {
			const { loadConfig } = await import("../config");
			const cfg = await loadConfig();
			agentDir = resolveAgentCwd(task.accountId, cfg);
			if (!agentDir) {
				console.error(
					`[warn] Task "${task.name}" is bound to account "${task.accountId}" but it has no agentDir in gateway.json. Falling back to gateway cwd.`,
				);
			}
		} catch (err) {
			console.error(`[warn] Failed to load gateway.json to resolve accountId: ${err}`);
		}
	}
	try {
		const { exitCode, output, stderr } = await executeScheduledCommand(task.command, {
			taskType: task.taskType,
			timeoutMs: task.timeoutMs,
			skills: task.skills,
			preScript: task.preScript,
			cwd: agentDir, // shell tasks without agentDir fall through to gateway cwd
		});
		const endedAt = Date.now();
		const durationMs = endedAt - startedAt;
		const status = exitCode === 0 ? "success" : "failure";

		// Link agent session trace for agent tasks. Per-agent scope: only
		// search the agent's own `sessions/` tree.
		const agentSessionPath =
			task.taskType === "agent" && agentDir ? findAgentSessionPath(agentDir, startedAt, endedAt) : undefined;

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
		const agentSessionPath =
			task.taskType === "agent" && agentDir ? findAgentSessionPath(agentDir, startedAt, endedAt) : undefined;
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

// ---------------------------------------------------------------------------
// test-run: temporarily set schedule, wait for scheduled-path trigger, restore
// ---------------------------------------------------------------------------

/**
 * Options for `cron test-run`.
 *
 * The CLI version parses these from argv; the LLM `cron` host tool
 * action `test-run` accepts the same shape (camelCase). The shared
 * core lives in `test-run.ts` (`runTestRun`).
 */
export interface CronTestRunOptions {
	/** Trigger delay from now. Default 90_000ms. Anything < 60s may race the
	 *  gateway's reload tick (default 60s) and end up with a past-dated
	 *  next_run_at that the engine auto-disables. */
	inMs?: number;
	/** How long to wait for the agent run to reach a terminal state
	 *  after the trigger fires. Default 30_000ms. Total wall-time is
	 *  `inMs + timeoutMs` (default 120s). */
	timeoutMs?: number;
	/** If true, leave the schedule as `+<delay>` after the run. Default
	 *  false: always restore. */
	noRestore?: boolean;
	/** Override the gateway tick assumption. Tests may pass a smaller
	 *  value; production should leave it alone. */
	_gatewayTickMs?: number;
}

/**
 * CLI front-end for `omp gateway cron test-run <name>`. The core
 * schedule-rewrite + poll + restore logic lives in `test-run.ts`
 * (`runTestRun`); this function owns argv parsing, SIGINT/SIGTERM
 * restore, console output, and process.exitCode translation.
 *
 * The shared core is non-negotiable: the LLM `cron` host tool's
 * `test-run` action calls the same `runTestRun`. A drift between
 * CLI and LLM behavior would mean the operator verifies one thing
 * and the agent verifies another — exactly the kind of split that
 * hides bugs.
 *
 * Exit codes (matched to host-tool `isError: true` semantics):
 *   0  trigger fired, task exited 0, delivery succeeded (or no delivery)
 *   1  timeout, task not found, task exited non-zero, or delivery failed
 *  130 / 143  SIGINT / SIGTERM during wait (schedule restored in handler)
 */
export async function cronTestRun(args: string[], storage: SchedulerDbStorage): Promise<void> {
	const name = args[0];
	if (!name) {
		console.error("Usage: cron test-run <name> [--in 90s] [--timeout 150s] [--no-restore]");
		process.exitCode = 1;
		return;
	}

	// Parse flags. We accept the three documented flags plus an internal
	// `_gatewayTickMs` knob for tests that drive a faster tick.
	let inMs: number | undefined;
	let timeoutMs: number | undefined;
	let noRestore = false;
	let gatewayTickMs = 60_000;
	for (let i = 1; i < args.length; i++) {
		const a = args[i];
		if (a === "--no-restore") {
			noRestore = true;
		} else if (a === "--in" && args[i + 1]) {
			inMs = parseDuration(args[i + 1]!);
			i++;
		} else if (a === "--timeout" && args[i + 1]) {
			timeoutMs = parseDuration(args[i + 1]!);
			i++;
		} else if (a === "_gatewayTickMs" && args[i + 1]) {
			gatewayTickMs = parseDuration(args[i + 1]!);
			i++;
		} else {
			console.error(`Unknown flag for cron test-run: ${a}`);
			process.exitCode = 1;
			return;
		}
	}

	// AbortController wires the CLI's signal handling into the
	// AbortSignal that `runTestRun` honors. The handler restores
	// nothing directly — the shared core's `finally` block does the
	// restore; the CLI handler just aborts the polling loop and lets
	// the core return. The shared core then exits with
	// `kind: "aborted"`.
	const ac = new AbortController();
	const onSig = () => ac.abort();
	process.once("SIGINT", () => {
		onSig();
		process.exit(130);
	});
	process.once("SIGTERM", () => {
		onSig();
		process.exit(143);
	});

	// Fast-fail if the gateway daemon is not running. The shared core
	// would eventually time out (no scheduler tick to pick up the
	// schedule change), but the operator gets a clearer error this
	// way. This check is CLI-only; the LLM host tool assumes the
	// gateway is running (otherwise the dispatcher wouldn't exist).
	const pidPath = getGatewayPidPath();
	if (!isDaemonRunning(pidPath)) {
		console.error(
			`Gateway is not running. Start it with "omp gateway start" first — test-run waits for the in-process scheduler to pick up the schedule change.`,
		);
		process.exitCode = 1;
		return;
	}

	console.log(`[test-run] Task "${name}" — preparing test-run (snapshot, rewrite to one-shot, wait, restore).`);

	const result: TestRunResult | TestRunHardError = await runTestRun({
		name,
		inMs,
		timeoutMs,
		noRestore,
		tickIntervalMs: gatewayTickMs,
		signal: ac.signal,
		storage,
	});

	if (result.kind === "task_not_found") {
		console.error(`Task "${name}" not found.`);
		process.exitCode = 1;
		return;
	}

	// Print result in CLI format. We translate the structured
	// result to the same console layout the operator was getting
	// before the refactor.
	if (result.kind === "trigger_timeout") {
		if (result.sawRunningExec) {
			console.error(
				`[test-run] Trigger fired (exec ${result.runningExecId}) but agent did NOT reach a terminal state within the wait window.`,
			);
			console.error(`[test-run] Check the gateway log (~/.omp/logs/omp.*.log) for the latest activity on this run.`);
		} else {
			console.error(`[test-run] Timed out waiting for trigger.`);
		}
		console.error(`[test-run] Schedule ${noRestore ? "NOT " : ""}restored to original.`);
		process.exitCode = 1;
		return;
	}

	if (result.kind === "aborted") {
		console.log(`[test-run] Aborted after ${Math.round(result.waitedMs / 1000)}s; schedule ${result.scheduleRestored ? "" : "NOT "}restored.`);
		// The signal handler will exit(130/143); we don't set exitCode
		// here to avoid clobbering the signal-driven exit code.
		return;
	}

	if (result.kind === "task_failed") {
		console.log(`  exec id:   ${result.execId}`);
		console.log(`  status:    ${result.status}`);
		console.log(`  exit:      ${result.exitCode}`);
		if (result.stderr) console.log(`  stderr:    ${result.stderr.slice(0, 500)}`);
		console.log(
			`[test-run] Schedule ${result.scheduleRestored ? "restored to original." : "NOT restored (--no-restore). Task is now cron='+<delay>s' once."}`,
		);
		process.exitCode = 1;
		return;
	}

	if (result.kind === "delivery_failed") {
		console.log(`  exec id:   ${result.execId}`);
		console.log(`  status:    ${result.status}`);
		console.log(`  exit:      ${result.exitCode}`);
		console.log(`  deliver:   FAILED — ${result.deliveryError}`);
		console.log(
			`[test-run] Schedule ${result.scheduleRestored ? "restored to original." : "NOT restored (--no-restore). Task is now cron='+<delay>s' once."}`,
		);
		process.exitCode = 1;
		return;
	}

	// Success
	console.log(`[test-run] Triggered after ~${result.triggerLatencyMs}ms (poll wait)`);
	console.log(`  exec id:   ${result.execId}`);
	console.log(`  status:    ${result.status}`);
	console.log(`  exit:      ${result.exitCode}`);
	console.log(`  duration:  ${result.durationMs ?? "?"}ms`);
	if (result.stderr) console.log(`  stderr:    ${result.stderr.slice(0, 500)}`);
	if (result.delivery.configured) {
		console.log(`  deliver:   ${result.delivery.ok ? "ok" : `FAILED — ${result.delivery.error}`}`);
	} else {
		console.log(`  deliver:   n/a (task has no delivery config)`);
	}
	if (result.output) {
		console.log(`  --- output (truncated to 2K) ---`);
		console.log(result.output.slice(0, 2000));
	}
	console.log(
		`[test-run] Schedule ${result.scheduleRestored ? "restored to original." : "NOT restored (--no-restore). Task is now cron='+<delay>s' once."}`,
	);
}

/**
 * Parse a duration string like `1m`, `90s`, `2h`, `500ms` into milliseconds.
 * Accepts: `<n>ms` | `<n>s` | `<n>m` | `<n>h`. Bare `<n>` is treated as
 * seconds to match the existing cron `+<n>` one-shot syntax.
 */
function parseDuration(input: string): number {
	const trimmed = input.trim();
	const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(trimmed);
	if (!m) {
		throw new Error(`Invalid duration: ${input} (use 500ms / 30s / 2m / 1h)`);
	}
	const n = Number.parseFloat(m[1]!);
	const unit = m[2] ?? "s";
	switch (unit) {
		case "ms":
			return Math.round(n);
		case "s":
			return Math.round(n * 1000);
		case "m":
			return Math.round(n * 60_000);
		case "h":
			return Math.round(n * 3_600_000);
		default:
			throw new Error(`Invalid duration unit: ${unit}`);
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
