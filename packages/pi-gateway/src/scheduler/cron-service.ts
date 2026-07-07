/**
 * CronService — decoupled cron orchestration via dependency injection.
 *
 * The gateway constructs CronService with two injected interfaces:
 * - executeAgent: runs an agent prompt and returns the result
 * - deliver: sends the result to a channel
 *
 * CronService itself knows nothing about AgentBridge, ChannelRegistry,
 * DingTalk OAuth, or any platform-specific details.
 */

import { findAgentSessionPath } from "../session-paths";
import {
	type CronRunDiagnostics,
	formatToolCallSummary,
	normalizeCronRunDiagnostics,
	parseAgentSessionForToolCalls,
	parseAgentSessionForToolFailures,
} from "./diagnostics";
import { appendDeliveryFailureLog, appendExecutionLog } from "./execution-log";
import { executeScheduledCommand, SILENT_MARKER } from "./executor";
import { readTestRunMarker } from "./test-run-marker";
import type { ScheduledTask, SchedulerStorage, TaskExecution } from "./types";

/** Logger contract consumed by CronService. */
export interface CronLogger {
	debug: (msg: string, ctx?: unknown) => void;
	info: (msg: string, ctx?: unknown) => void;
	warn: (msg: string, ctx?: unknown) => void;
	error: (msg: string, ctx?: unknown) => void;
}

/** Execute an agent prompt and return the result. */
export type ExecuteAgentFn = (params: {
	agentDir: string;
	prompt: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	/** Toolsets to disable during execution (e.g. ['cronjob', 'messaging']) */
	disabledToolsets?: string[];
	/** Per-task model override */
	model?: string;
	/** Per-task provider override */
	provider?: string;
}) => Promise<{ output: string; error?: string }>;

/** Deliver a result to a channel (internally handles retry).
 *
 *  The `text` field is the legacy plain-text summary (used by the
 *  sampleText path); `card` is the structured deliverable for the
 *  AI-Card path. Both are always supplied so the gateway can pick
 *  either at dispatch time without re-fetching task state. The `card`
 *  is optional because shell-task fallback paths may not have the
 *  full agent metadata handy. */
export type DeliverFn = (params: {
	channel: string;
	accountId?: string;
	toUserId?: string;
	toConversationId?: string;
	text: string;
	card?: {
		taskName: string;
		taskId: string;
		slug: string;
		status: "success" | "failure" | "timed_out";
		exitCode: number | undefined;
		durationMs: number;
		output: string;
		error?: string;
	};
	/**
	 * Origin IM session for the LLM `cron.test-run` host tool path.
	 * Captured at the START of `onTrigger` (before the agent runs) so
	 * the notifier can push a follow-up prompt to the LLM even if
	 * the test-run marker has been consumed by orphan recovery
	 * during a long-running agent execution. See
	 * `CronLifecycle.notifyOriginSessionIfPending` (B 方案).
	 *
	 * `accountId` selects the per-account bridge that the notifier
	 * dispatches against. Required in multi-account gateways — the
	 * default `bridge` may not be the one that ran the test-run.
	 */
	origin?: { sessionPath: string; accountId: string };
}) => Promise<{ ok: boolean; error?: string }>;

/**
 * Notify the user that a cron run failed in a way that the normal
 * delivery path would not surface (agent errored out, task timed out,
 * summary delivery itself failed, etc.). The notification is a short,
 * high-signal error message — not the full output. Implementations
 * should retry internally like {@link DeliverFn}; from the caller's
 * perspective this is best-effort.
 *
 * This is the user-facing safety net for "why is my cron task silent":
 * even when the regular summary delivery is misconfigured or the
 * task output is empty, the user gets a card saying "task X failed,
 * check the gateway log". Without this, a delivery-channel mismatch
 * (e.g. workspace basename ≠ accountId) makes the cron run
 * indistinguishable from "nothing happened" in the user's IM client.
 */
export type NotifyCronFailureFn = (params: {
	channel: string;
	accountId?: string;
	toUserId?: string;
	toConversationId?: string;
	taskName: string;
	taskId: string;
	reason: string;
	kind: "executeAgent_failed" | "task_failed" | "task_timed_out" | "delivery_failed";
	durationMs: number;
}) => Promise<{ ok: boolean; error?: string }>;

/** Reverse-resolve a task's `agentDir` to the registered channel
 *  `accountId`. Returns undefined if the agentDir is not mapped to a
 *  live bridge (e.g. cron test-run during a bridge restart). */
export type ResolveAccountIdFn = (agentDir: string) => string | undefined;

/**
 * Mirror the cron delivery brief to the user's chat session JSONL so the
 * user can reply with full context (a+ "continuable jobs" pattern, modeled
 * on Hermes's `attach_to_session`). Optional; tasks with
 * `attachToSession: true` trigger this only on successful delivery.
 *
 * The function is best-effort: a mirror failure must NOT fail the cron
 * run. Implementations should resolve the chat session path themselves
 * (from the delivery params + task.agentDir) and append a user-role
 * message entry with a labelled prefix so the chat agent recognises it
 * as a system-injected delivery, not a real user message.
 */
export type MirrorToSessionFn = (params: {
	task: ScheduledTask;
	brief: string;
	delivery: {
		channel: string;
		accountId?: string;
		toUserId?: string;
		toConversationId?: string;
	};
}) => Promise<{ ok: boolean; error?: string }>;

/** Dependencies injected by the gateway. */
export interface CronDeps {
	executeAgent: ExecuteAgentFn;
	deliver: DeliverFn;
	log: CronLogger;
	/** Optional. See {@link ResolveAccountIdFn}. */
	resolveAccountId?: ResolveAccountIdFn;
	/** Optional. See {@link NotifyCronFailureFn}. */
	notifyFailure?: NotifyCronFailureFn;
	/** Optional. See {@link MirrorToSessionFn}. Called after a
	 *  successful delivery when `task.attachToSession` is true. */
	mirrorToSession?: MirrorToSessionFn;
}

/** Result of a cron trigger execution. */
export interface CronTriggerResult {
	execution: TaskExecution;
	delivered: boolean;
	deliveryError?: string;
}

/**
 * Per-task context block injected between the [CRON-CONTEXT] header and
 * the four rules. All fields are optional; missing fields are omitted.
 *
 * Tier 1 (`metaLine`) is always present in storage-backed calls.
 * Tier 2 (`lastOutput`) is conditional on the task's `injectLastOutput`
 * config and the last run's status.
 * Tier 3 (`lastToolCalls`) is conditional on the last run failing AND
 * a non-zero `injectToolCalls` AND the prior OMP session JSONL being
 * locatable.
 */
export interface PrefixContext {
	/** Pre-formatted "Last run: ..." line. */
	metaLine?: string;
	/** Last run output text, already truncated to fit Tier 2 budget. */
	lastOutput?: string;
	/** Last N tool calls, already formatted as one-liners. */
	lastToolCalls?: string;
}

/**
 * Fixed postamble of the cron context prefix. Held in a module constant so
 * the wording stays byte-equal across calls and tests can match against
 * it. The four rules are the load-bearing soft recursion guard — if you
 * edit them, audit the regression test in
 * `packages/pi-gateway/test/scheduler-cron-context-prefix.test.ts`.
 */
const CRON_FOUR_RULES =
	"Four rules for this run:\n" +
	"1. Do NOT call the `cron` host tool (create / list / update / delete scheduled tasks). The `cronjob` toolset is disabled for this run — calling it would either fail or recursively schedule more tasks.\n" +
	"2. Do NOT call proactive messaging tools (e.g. `dws chat message send`, `chat_post`, anything in the `messaging` toolset). The `messaging` toolset is disabled. These would create duplicate notifications on top of the gateway's own delivery.\n" +
	'3. Your reply text IS the delivery. The gateway renders the body of your final reply as a DingTalk AI card to the original conversation (markdown headings, lists, code blocks, and inline code are all supported — use them). So just write your answer in the reply body and stop — do not call any `send` tool, do not try to push it anywhere. Format with `##` headings, `-` bullets, fenced code blocks, and `` `inline code` `` so the card stays scannable. This applies even if the task wording says "发给用户" / "send to user" / "notify" / "告诉用户".\n' +
	'4. If there is genuinely nothing new to report (no changes, no errors, no notable findings), respond with exactly "[SILENT]" and nothing else. The gateway detects this marker and suppresses delivery — no card is sent to the user. Never combine [SILENT] with other content; either report your findings normally, or output [SILENT] alone.\n';

/**
 * Build the cron context prefix injected before the task prompt.
 *
 * When called with no second argument the output is a header + the four
 * rules — byte-equivalent to the original single-arg signature. This is
 * the safe no-I/O path used by tests and the legacy test-run path.
 *
 * With a {@link PrefixContext}, the function splices in the per-task
 * history block between the header and the four rules. Callers (the
 * I/O-doing `buildCronContextPrefixFromStorage`) are responsible for
 * fetching, formatting, and truncating the context contents.
 */
export function buildCronContextPrefix(task: ScheduledTask, context: PrefixContext = {}): string {
	const agentLabel = task.agentDir ? (task.agentDir.split("/").pop() ?? task.agentDir) : (task.accountId ?? "default");
	const header =
		`[CRON-CONTEXT] Task: ${task.name}  Agent: ${agentLabel}\n` +
		`Schedule: ${task.cron}  Type: ${task.taskType ?? "agent"}\n` +
		(context.metaLine ? `${context.metaLine}\n` : "");

	const history =
		(context.lastOutput ? `\nLast run summary:\n${context.lastOutput}\n` : "") +
		(context.lastToolCalls ? `\nLast run tool calls:\n${context.lastToolCalls}\n` : "");

	return `${header}${history}\n---\n\n${CRON_FOUR_RULES}`;
}

// ---------------------------------------------------------------------------
// Storage-backed prefix builder (I/O doing version used by onTrigger)
// ---------------------------------------------------------------------------

/** Per-field token budget for Tier 2 last-output text. */
const TIER2_OUTPUT_MAX_CHARS = 6000;

/** Truncate an output string to {@link maxChars} chars with a visible marker. */
function truncateOutputForContext(output: string, maxChars = TIER2_OUTPUT_MAX_CHARS): string {
	if (output.length <= maxChars) return output;
	return `${output.slice(0, maxChars)}\n[...truncated, original was ${output.length} chars]`;
}

/** Format a millisecond delta as a short human string ("5m ago", "2d ago"). */
function formatAgo(ts: number, now: number): string {
	const diff = now - ts;
	if (diff < 0) return "just now";
	const s = Math.floor(diff / 1000);
	if (s < 60) return `${s}s ago`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ago`;
	const d = Math.floor(h / 24);
	return `${d}d ago`;
}

/** Build the Tier 1 metadata line summarizing the most recent run. */
function formatLastRunMeta(task: ScheduledTask, lastExec: TaskExecution, now: number): string {
	const ts = lastExec.endedAt ?? lastExec.startedAt;
	const when = new Date(ts).toLocaleString();
	const ago = formatAgo(ts, now);
	const status = lastExec.status === "success" ? "ok" : lastExec.status;
	const exit = lastExec.exitCode !== undefined ? `  Exit: ${lastExec.exitCode}` : "";
	const consec = task.consecutiveFailures > 0 ? `  Consecutive failures: ${task.consecutiveFailures}` : "";
	const delivery = task.lastDeliveryError ? `  Last delivery error: ${task.lastDeliveryError}` : "";
	return `Last run: ${when} (${ago})  Status: ${status}${exit}${consec}${delivery}`;
}

/**
 * Storage-backed entry point used by `onTrigger` to construct the cron
 * context prefix with full per-task history.
 *
 * Returns the legacy four-rules-only prefix when `storage` is undefined,
 * which preserves the behavior of older `CronDeps` consumers that don't
 * inject a storage backend. The function is synchronous because every
 * dependency it uses (`storage.getExecutions`, `fs.readFileSync`) is
 * already sync — the cron hot path tolerates the few ms this costs.
 */
export function buildCronContextPrefixFromStorage(
	task: ScheduledTask,
	storage: SchedulerStorage | undefined,
	opts?: { nowMs?: () => number },
): string {
	if (!storage) {
		return buildCronContextPrefix(task);
	}

	const now = opts?.nowMs?.() ?? Date.now();
	// Engine creates the exec row BEFORE calling onTrigger
	// (engine.ts#runTask: recordExecution at start, then await onTrigger).
	// So at onTrigger time, getExecutions(taskId, 1)[0] is the in-flight
	// run (status="running", endedAt=undefined) — NOT the previous run.
	// Filter by `endedAt != null` to skip the in-flight row and pick up
	// the most recent TERMINAL run. Without this, Tier 1 always shows
	// "Status: running" and Tier 2 always reads the current run's empty
	// output — which would make a+ useless for real cron triggers.
	const recent = storage.getExecutions(task.id, 10);
	const lastExec = recent.find(e => e.endedAt != null);

	if (!lastExec) {
		return buildCronContextPrefix(task, { metaLine: "No previous runs." });
	}

	// Tier 1 — always
	const metaLine = formatLastRunMeta(task, lastExec, now);

	// Tier 2 — conditional on config + last run status
	const injectLastOutput = task.injectLastOutput ?? "on_failure";
	const injectFailure = task.injectFailureContext !== false;
	const isFailure = lastExec.status === "failure";
	let lastOutput: string | undefined;
	if (
		injectFailure &&
		lastExec.output &&
		(injectLastOutput === "always" || (isFailure && injectLastOutput !== "never"))
	) {
		lastOutput = truncateOutputForContext(lastExec.output);
	}

	// Tier 3 — conditional on failure + non-zero limit + present session file
	const injectToolCallsN = task.injectToolCalls ?? 10;
	let lastToolCalls: string | undefined;
	if (injectFailure && isFailure && injectToolCallsN > 0 && lastExec.agentSessionPath) {
		const all = parseAgentSessionForToolCalls(lastExec.agentSessionPath);
		if (all && all.length > 0) {
			// Error-priority selection. On failure runs we want the agent
			// to see every errored call (up to the quota) because those
			// are the most diagnostic signal; any remaining budget goes
			// to the most recent successful calls for context. Older
			// non-error calls are dropped first.
			//
			// Examples (limit=10):
			//   5 errors + 5 successes   → 5 errors + 5 successes (quota full)
			//   20 errors + 5 successes  → 10 most recent errors
			//   3 errors + 50 successes  → 3 errors + 7 most recent successes
			//   0 errors + 10 successes  → 10 most recent successes
			const errors = all.filter(c => c.isError);
			const successes = all.filter(c => !c.isError);
			const errorSlots = Math.min(errors.length, injectToolCallsN);
			const successSlots = Math.max(0, injectToolCallsN - errorSlots);
			// Guard against `slice(-0) === slice(0)` returning the full array
			// when a slot count is zero.
			const errorSlice = errorSlots > 0 ? errors.slice(-errorSlots) : [];
			const successSlice = successSlots > 0 ? successes.slice(-successSlots) : [];
			const selected = [...errorSlice, ...successSlice];
			const dropped = all.length - selected.length;
			const droppedErrors = errors.length - errorSlots;
			const header =
				dropped > 0
					? `Last run tool calls (${selected.length} of ${all.length} shown — ${dropped} earlier calls dropped, ${droppedErrors} of them errors):`
					: `Last run tool calls (${selected.length} calls):`;
			lastToolCalls = `${header}\n${selected.map(formatToolCallSummary).join("\n")}`;
		}
	}

	return buildCronContextPrefix(task, { metaLine, lastOutput, lastToolCalls });
}

/**
 * Build the delivery summary string from task execution results.
 *
 * Output is truncated to 2000 characters to avoid oversized messages.
 */
export function buildDeliverySummary(
	task: ScheduledTask,
	output: string,
	exitCode: number | undefined,
	durationMs: number,
): string {
	const prefix = exitCode === 0 ? "✅" : "⏰";
	const truncatedOutput = output.slice(0, 2000);
	return `${prefix} ${task.name} (exit ${exitCode ?? "?"}, ${(durationMs / 1000).toFixed(1)}s)\n\n${truncatedOutput}`;
}

/**
 * Resolve the effective agentDir for a task, with fallback to deprecated accountId.
 *
 * During the migration period, tasks may still have `accountId` but not
 * `agentDir`. This function returns `agentDir` if present, otherwise
 * returns `accountId` (which the caller can resolve to a path via config).
 */
export function resolveAgentDir(task: ScheduledTask): string | undefined {
	return task.agentDir ?? task.accountId;
}

/**
 * Resolve the effective delivery configuration for a task.
 *
 * `resolveAccountId` is an optional gateway-side hook that maps a task's
 * `agentDir` back to the registered channel `accountId` (e.g. resolving
 * `/Users/.../OMP-workspace-test/omp-atomix` → `algorithm`). This is the
 * source of truth — the registry's multi-account channel key is
 * `<channel>:<accountId>`, and the workspace basename (e.g. `omp-atomix`)
 * is NOT the accountId. The deprecated `task.accountId` field may hold
 * a stale workspace name from before the migration; callers should
 * prefer the agentDir-based lookup.
 */
export function resolveDelivery(
	task: ScheduledTask,
	resolveAccountId?: (agentDir: string) => string | undefined,
):
	| {
			channel: string;
			accountId?: string;
			toUserId?: string;
			toConversationId?: string;
			mode: "announce" | "none";
	  }
	| undefined {
	if (task.delivery) {
		// Priority: explicit delivery.accountId → reverse-resolved accountId
		// from agentDir → deprecated task.accountId (last-resort fallback
		// for tasks written before the agentDir migration).
		const accountId =
			task.delivery.accountId ?? (task.agentDir ? resolveAccountId?.(task.agentDir) : undefined) ?? task.accountId;
		return {
			...task.delivery,
			accountId,
		};
	}
	return undefined;
}

/** Additional dependencies for CronService beyond the injected interfaces. */
export interface CronServiceDeps extends CronDeps {
	storage: SchedulerStorage;
	ompBinary: string;
}

/**
 * CronService — orchestrates cron task execution via dependency injection.
 *
 * The gateway constructs CronService with two injected interfaces:
 * - executeAgent: runs an agent prompt and returns the result
 * - deliver: sends the result to a channel
 *
 * CronService itself knows nothing about AgentBridge, ChannelRegistry,
 * DingTalk OAuth, or any platform-specific details. It coordinates:
 * 1. Building the cron context prefix (soft recursion guard)
 * 2. Calling executeAgent (warm bridge or cold subprocess)
 * 3. Recording execution results in storage + JSONL logs
 * 4. Delivering results via the injected deliver function
 * 5. Updating delivery error state
 */
export class CronService {
	#deps: CronServiceDeps;

	constructor(deps: CronServiceDeps) {
		this.#deps = deps;
	}

	async onTrigger(task: ScheduledTask, executionId: string): Promise<void> {
		const { storage, executeAgent, deliver, log, ompBinary, resolveAccountId, notifyFailure } = this.#deps;
		const startedAt = Date.now();
		const isAgent = task.taskType === "agent";

		const agentDir = resolveAgentDir(task);
		const cronContextPrefix = buildCronContextPrefixFromStorage(task, storage);

		// B 方案: capture the test-run marker at the START of onTrigger
		// so we have the origin session path even if orphan recovery
		// consumes the marker during the long agent run. Reading
		// happens BEFORE the agent runs, so the race window is closed
		// for this onTrigger. We pass the captured origin to the
		// deliver call below; the notifier uses it directly instead
		// of re-reading the marker (which may be gone by then).
		// Without this, a long-running agent that takes longer than
		// the marker's expiresAt causes the orphan recovery to
		// consume the marker, and the LLM never gets the result
		// follow-up.
		//
		// We also capture `accountId` (resolved from agentDir via
		// `resolveAccountId`) so the notifier can pick the right
		// per-account bridge in multi-account gateways. The default
		// `bridge` may not be the one that ran the test-run.
		let capturedOrigin: { sessionPath: string; accountId: string } | undefined;
		if (task.cron && /^\+\d+s$/.test(task.cron)) {
			const marker = readTestRunMarker(storage.getMarkerBaseDir?.());
			if (marker?.origin) {
				const originAccountId = resolveAccountId ? resolveAccountId(agentDir) : undefined;
				capturedOrigin = { sessionPath: marker.origin.sessionPath, accountId: originAccountId ?? "" };
			}
		}

		let exitCode = 0;
		let output = "";
		let stderr = "";
		let timedOut = false;
		let executeAgentFailed: { reason: string } | null = null;

		// Structured diagnostics accumulator (push at collection points,
		// normalized & flushed to JSONL before the throw/finish).
		const diagnosticsEntries: CronRunDiagnostics["entries"] = [];
		const addDiag = (
			source: CronRunDiagnostics["entries"][number]["source"],
			severity: CronRunDiagnostics["entries"][number]["severity"],
			message: string,
			opts?: { exitCode?: number | null },
		) => {
			diagnosticsEntries.push({
				ts: Date.now(),
				source,
				severity,
				message,
				...(opts?.exitCode !== undefined ? { exitCode: opts.exitCode } : {}),
			});
		};

		// Preflight diagnostics
		if (!task.command?.trim()) {
			addDiag("cron-preflight", "warn", "Task has no command configured");
		}
		if (isAgent && !agentDir) {
			addDiag("cron-preflight", "warn", "Agent task has no agentDir - will use shell fallback");
		}

		// Try injected executeAgent (warm bridge path)
		if (isAgent && agentDir) {
			addDiag("cron-setup", "info", `Warm bridge execution (agentDir: ${agentDir.split("/").pop()})`, {
				exitCode: null,
			});
			log.debug("Executing cron task via injected executeAgent", {
				taskName: task.name,
				agentDir,
				modelOverride: task.model ?? null,
			});

			const result = await executeAgent({
				agentDir,
				prompt: cronContextPrefix + task.command,
				timeoutMs: task.timeoutMs,
				disabledToolsets: ["cronjob", "messaging"],
				model: task.model,
				provider: task.provider,
			});

			if (result.error && !result.output) {
				stderr = result.error;
				executeAgentFailed = { reason: stderr };
				addDiag("agent-run", "error", `Agent RPC failed: ${stderr}`);
				exitCode = 1;
				log.warn("executeAgent failed, falling back to omp --print", {
					taskName: task.name,
					error: stderr,
				});
			} else {
				output = result.output;
			}
		}

		// Fallback: cold subprocess execution
		if (!output) {
			const setupMsg = isAgent
				? "Falling back to cold subprocess after warm bridge failure"
				: "Running task via subprocess (no agent bridge)";
			addDiag("cron-setup", "info", setupMsg);
			try {
				const execResult = await executeScheduledCommand(task.command, {
					taskType: task.taskType,
					timeoutMs: task.timeoutMs,
					ompBinary,
					skills: task.skills,
					preScript: task.preScript,
					cwd: agentDir,
					promptPrefix: isAgent ? cronContextPrefix : undefined,
				});
				exitCode = execResult.exitCode;
				output = execResult.output;
				stderr = execResult.stderr;
				timedOut = execResult.timedOut;
				if (timedOut) {
					addDiag("exec", "error", `Subprocess timed out after ${task.timeoutMs ?? 30_000}ms`, { exitCode });
				}
			} catch (fallbackErr) {
				// The fallback can throw (e.g. posix_spawn ENOENT when
				// the omp binary is missing, or Bun.spawn unable to
				// resolve the shell on a stripped-down test environment).
				// Without this catch, the exception bubbles out of
				// onTrigger and we skip the failure-card delivery below
				// — the user sees nothing. Treat the fallback throw as
				// a hard task failure and continue.
				stderr = stderr || (fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr));
				exitCode = exitCode || 1;
				addDiag("exec", "error", `Fallback threw: ${stderr}`, { exitCode });
				log.error("Cron fallback execution threw", {
					taskId: task.id,
					taskName: task.name,
					error: stderr,
				});
			}
		}

		const endedAt = Date.now();
		const durationMs = endedAt - startedAt;

		// Link agent session trace for agent tasks. We use the per-agent
		// finder from session-paths (single source of truth) rather than
		// the legacy cross-tree walk. Pass `agentDir` directly when we
		// have it; fall back to a (deprecated) accountId-based lookup
		// when the task is unbound to an agentDir.
		const agentSessionPath =
			task.taskType === "agent" && agentDir ? findAgentSessionPath(agentDir, startedAt, endedAt) : undefined;

		// Parse agent session for tool failures (if session file exists).
		const toolDiagnostics = parseAgentSessionForToolFailures(agentSessionPath);
		if (toolDiagnostics) {
			for (const entry of toolDiagnostics.entries) {
				diagnosticsEntries.push(entry);
			}
		}

		// DEBUG-ONLY forceFail hook: override the warm bridge / fallback
		// result to a failure while keeping the real agent session path.
		// The session path is critical — without it, the next run's
		// Tier 3 (tool-call recap) silently skips. Only fires when the
		// task has it set in jobs.json; the field is documented as
		// debug-only so production task definitions never carry it.
		// Diagnostics entry explains the override in the JSONL log.
		if (task.forceFail && exitCode === 0) {
			exitCode = 1;
			output = output
				? `${output}\n\n[forceFail] debug-only override: warm bridge succeeded, recording as failure for Tier 3 e2e testing`
				: "[forceFail] debug-only override: warm bridge produced no output, recording as failure for Tier 3 e2e testing";
			addDiag("cron-debug", "warn", "forceFail=true — overriding exit code to 1", { exitCode: 1 });
			log.warn("Cron task forceFail override", { taskId: task.id, taskName: task.name });
		}

		// Record the execution result
		storage.updateExecution(executionId, {
			status: exitCode === 0 ? "success" : "failure",
			exitCode,
			output: timedOut ? `[TIMED OUT after ${task.timeoutMs ?? 30_000}ms]\n${output}` : output,
			stderr: timedOut ? `[TIMED OUT]\n${stderr}` : stderr,
			endedAt,
			...(agentSessionPath ? { agentSessionPath } : {}),
		});

		// If the agent (or pre-script) signaled silence, skip delivery entirely.
		// The LLM outputs [SILENT] when there's genuinely nothing to report;
		// the pre-script path uses the same marker. Either way, no card is sent.
		// Only suppress on success (exit 0) — a non-zero exit with [SILENT] is
		// likely a malformed response and the user should see it.
		const isSilent = exitCode === 0 && output.trim() === SILENT_MARKER;
		if (isSilent) {
			addDiag("delivery", "info", "Output is [SILENT] — suppressing delivery");
		}

		// Deliver result if configured (skip when silent)
		const deliveryConfig = resolveDelivery(task, resolveAccountId);
		if (deliveryConfig && deliveryConfig.mode === "announce" && !isSilent) {
			const prefix = exitCode === 0 ? "✅" : timedOut ? "⏰" : "❌";
			const summary = `${prefix} Task "${task.name}" completed (exit ${exitCode}, ${durationMs}ms)\n\n${output.slice(0, 2000)}`;

			// Structured deliverable for the AI-Card path. The text
			// path uses `text` (truncated); the card path uses `card`
			// (full output, structured metadata). Both are passed so
			// the gateway can dispatch by mode without re-fetching
			// task state.
			const cardStatus: "success" | "failure" | "timed_out" = timedOut
				? "timed_out"
				: exitCode === 0
					? "success"
					: "failure";

			const deliverResult = await deliver({
				channel: deliveryConfig.channel,
				accountId: deliveryConfig.accountId,
				toUserId: deliveryConfig.toUserId,
				toConversationId: deliveryConfig.toConversationId,
				text: summary,
				card: {
					taskName: task.name,
					taskId: task.id,
					slug: task.name,
					status: cardStatus,
					exitCode,
					durationMs,
					output: timedOut
						? `[TIMED OUT after ${task.timeoutMs ?? 30_000}ms]\n${output}`
						: output,
					error: stderr || undefined,
				},
				// B 方案: forward the captured origin so the notifier
				// can push a follow-up prompt to the LLM even if the
				// test-run marker was consumed by orphan recovery
				// during the long agent run. `undefined` for non-test-run
				// or pre-B tasks — the notifier silently no-ops.
				origin: capturedOrigin,
			});

			if (!deliverResult.ok) {
				storage.updateTask(task.id, { lastDeliveryError: deliverResult.error });
				appendDeliveryFailureLog({
					ts: Date.now(),
					taskId: task.id,
					taskName: task.name,
					channel: deliveryConfig.channel,
					userId: deliveryConfig.toUserId,
					reason: deliverResult.error ?? "unknown",
					attempts: 0,
					exitCode,
				});
				addDiag("delivery", "error", `Delivery failed: ${deliverResult.error ?? "unknown"}`);
				log.error("Cron result delivery failed", {
					taskId: task.id,
					taskName: task.name,
					channel: deliveryConfig.channel,
					error: deliverResult.error,
				});
				// Best-effort user-facing notification. Independent of the
				// summary delivery above so a misconfigured channel
				// (Unknown channel) doesn't also suppress the
				// failure card. notifyFailure implementations retry
				// internally; here we just log the result.
				if (notifyFailure) {
					try {
						const notifyResult = await notifyFailure({
							channel: deliveryConfig.channel,
							accountId: deliveryConfig.accountId,
							toUserId: deliveryConfig.toUserId,
							toConversationId: deliveryConfig.toConversationId,
							taskName: task.name,
							taskId: task.id,
							reason: deliverResult.error ?? "unknown",
							kind: "delivery_failed",
							durationMs,
						});
						if (!notifyResult.ok) {
							log.error("Cron failure notification also failed", {
								taskId: task.id,
								taskName: task.name,
								error: notifyResult.error,
							});
						}
					} catch (notifyErr) {
						log.error("Cron failure notification threw", {
							taskId: task.id,
							taskName: task.name,
							error: notifyErr instanceof Error ? notifyErr.message : String(notifyErr),
						});
					}
				}
			} else {
				// Clear delivery error on success
				storage.updateTask(task.id, { lastDeliveryError: undefined });

				// attach_to_session: mirror the brief to the user's chat
				// session so a follow-up DM/IM reply lands in a session
				// that already contains the brief. Best-effort: failure
				// here is logged but does NOT fail the cron run.
				if (task.attachToSession && this.#deps.mirrorToSession) {
					try {
						const mirrorResult = await this.#deps.mirrorToSession({
							task,
							brief: summary,
							delivery: {
								channel: deliveryConfig.channel,
								accountId: deliveryConfig.accountId,
								toUserId: deliveryConfig.toUserId,
								toConversationId: deliveryConfig.toConversationId,
							},
						});
						if (!mirrorResult.ok) {
							log.warn("attach_to_session mirror failed", {
								taskId: task.id,
								taskName: task.name,
								error: mirrorResult.error,
							});
						} else {
							log.debug("attach_to_session mirror ok", { taskId: task.id, taskName: task.name });
						}
					} catch (mirrorErr) {
						log.error("attach_to_session mirror threw", {
							taskId: task.id,
							taskName: task.name,
							error: mirrorErr instanceof Error ? mirrorErr.message : String(mirrorErr),
						});
					}
				}
			}
		}

		// Write full stdout/stderr to JSONL log with structured diagnostics.
		// This runs for both success and failure paths BEFORE the throw
		// so failures also produce a diagnostics trace in JSONL.

		const logDiagnostics = normalizeCronRunDiagnostics({ entries: diagnosticsEntries });
		appendExecutionLog(task.name, {
			id: executionId,
			ts: endedAt,
			exitCode,
			status: exitCode === 0 ? "success" : "failure",
			durationMs,
			output,
			stderr,
			...(logDiagnostics ? { diagnostics: logDiagnostics } : {}),
			// Persist the agent session path in the JSONL log so a
			// gateway restart between this run and the next scheduled
			// trigger does not lose it — Tier 3 of the cron context
			// prefix needs the path to read the failed tool calls.
			...(agentSessionPath ? { agentSessionPath } : {}),
		});

		// Throw on failure so the engine's retry loop and statistics work.
		if (exitCode !== 0 || timedOut) {
			const msg = timedOut
				? `Task "${task.name}" timed out after ${task.timeoutMs ?? 30_000}ms`
				: `Task "${task.name}" failed (exit ${exitCode})`;
			log.warn(msg, { taskId: task.id, exitCode, timedOut });

			// User-facing notification: the regular summary above may or
			// may not have reached the user (if delivery itself
			// failed, the summary was lost). For pure agent failures
			// (executeAgent errored) and hard timeouts, send a short
			// failure card independently of the delivery path. The
			// notification is best-effort and does not affect the
			// throw — the engine's retry + stats still run.
			if (notifyFailure && deliveryConfig?.mode === "announce") {
				const reason =
					executeAgentFailed?.reason ??
					(timedOut ? `任务超时 (${task.timeoutMs ?? 30_000}ms)` : `exit code ${exitCode}`);
				const kind: "executeAgent_failed" | "task_failed" | "task_timed_out" = timedOut
					? "task_timed_out"
					: executeAgentFailed
						? "executeAgent_failed"
						: "task_failed";
				try {
					await notifyFailure({
						channel: deliveryConfig.channel,
						accountId: deliveryConfig.accountId,
						toUserId: deliveryConfig.toUserId,
						toConversationId: deliveryConfig.toConversationId,
						taskName: task.name,
						taskId: task.id,
						reason,
						kind,
						durationMs,
					});
				} catch (notifyErr) {
					log.error("Cron failure notification threw", {
						taskId: task.id,
						taskName: task.name,
						error: notifyErr instanceof Error ? notifyErr.message : String(notifyErr),
					});
				}
			}

			throw new Error(msg);
		}

		log.debug("Cron task succeeded", { taskId: task.id, taskName: task.name });
	}
}
