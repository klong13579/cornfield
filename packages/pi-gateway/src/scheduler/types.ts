/**
 * Core types for the persistent cron scheduler.
 *
 * Paths relocated to ~/.omp/gateway-data/scheduler/ for unified gateway.
 */

import * as os from "node:os";
import * as path from "node:path";
import { getRecentDeliveryFailureCount } from "./execution-log";

export type TaskStatus = "active" | "paused" | "disabled";

export type ScheduleType = "cron" | "interval" | "once";

export type TaskType = "shell" | "agent";

export interface RetryConfig {
	maxAttempts: number;
	backoffMs: number[];
	retryOn?: string[];
}

export interface SchedulerConfig {
	enabled: boolean;
	taskDir: string;
	maxConcurrentRuns: number;
}

export interface ScheduledTask {
	id: string;
	name: string;
	description?: string;
	cron: string;
	command: string;
	status: TaskStatus;
	scheduleType?: "cron" | "interval" | "once";
	taskType?: "shell" | "agent";
	/** Override LLM model for agent tasks */
	model?: string;
	/** Override LLM provider for agent tasks */
	provider?: string;
	/** Restrict agent tools to named toolsets (reduces token use) */
	enabledToolsets?: string[];
	/** Total number of runs before auto-disable. null = unlimited (default). */
	repeatCount?: number;
	/** Number of runs completed so far. Incremented each execution. */
	repeatCompleted?: number;
	timeoutMs?: number;
	retry?: RetryConfig;
	skills?: string[];
	preScript?: string;
	consecutiveFailures: number;
	createdAt: number;
	updatedAt: number;
	lastRunAt?: number;
	nextRunAt?: number;
	runCount: number;
	failCount: number;
	/** Agent execution directory (replaces accountId for execution routing) */
	agentDir?: string;
	/** Delivery configuration (replaces deliver + deliverUser) */
	delivery?: {
		channel: string;
		accountId?: string;
		toUserId?: string;
		toConversationId?: string;
		mode: "announce" | "none";
	};
	/** Last delivery error message (null/undefined when last delivery succeeded) */
	lastDeliveryError?: string;
	/** @deprecated Use agentDir instead */
	accountId?: string;
	/** @deprecated Use delivery.channel instead */
	deliver?: string;
	/** @deprecated Use delivery.toUserId instead */
	deliverUser?: string;
}

export interface TaskFileDefinition {
	name: string;
	description?: string;
	cron: string;
	command: string;
	type?: "shell" | "agent";
	model?: string;
	provider?: string;
	enabledToolsets?: string[];
	repeatCount?: number;
	timeoutMs?: number;
	retry?: RetryConfig;
	skills?: string[];
	preScript?: string;
	/** Agent execution directory (replaces accountId for execution routing) */
	agentDir?: string;
	/** Delivery configuration (replaces deliver + deliverUser) */
	delivery?: {
		channel: string;
		accountId?: string;
		toUserId?: string;
		toConversationId?: string;
		mode: "announce" | "none";
	};
	/** @deprecated Use agentDir instead */
	accountId?: string;
	/** @deprecated Use delivery.channel instead */
	deliver?: string;
	/** @deprecated Use delivery.toUserId instead */
	deliverUser?: string;
}

export interface TaskExecution {
	id: string;
	taskId: string;
	startedAt: number;
	endedAt?: number;
	exitCode?: number;
	output?: string;
	stderr?: string;
	status: "running" | "success" | "failure";
	/**
	 * For agent tasks: absolute path to the OMP agent session JSONL
	 * that contains the full LLM trace (thinking + tool_use + tool_result).
	 * Set by CLI cronRun after execution completes. Null for shell tasks
	 * or when session cannot be located.
	 */
	agentSessionPath?: string;
}

export interface SchedulerStorage {
	addTask(task: Omit<ScheduledTask, "id">): ScheduledTask;
	getTask(id: string): ScheduledTask | undefined;
	getTaskByName(name: string): ScheduledTask | undefined;
	listTasks(): ScheduledTask[];
	updateTask(id: string, updates: Partial<ScheduledTask>): void;
	deleteTask(id: string): void;
	recordExecution(exec: Omit<TaskExecution, "id">): TaskExecution;
	updateExecution(id: string, updates: Partial<TaskExecution>): void;
	getExecutions(taskId: string, limit?: number): TaskExecution[];
	pruneExecutions(maxAgeDays?: number, maxCount?: number): number;
}

export interface EngineOptions {
	storage: SchedulerStorage;
	onTrigger: (task: ScheduledTask, executionId: string) => Promise<void>;
	config?: Partial<SchedulerConfig>;
}

export interface DaemonOptions {
	dbPath: string;
	ompBinary: string;
	foreground?: boolean;
	config?: Partial<SchedulerConfig>;
}

export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
	enabled: true,
	taskDir: "", // resolved at init time
	maxConcurrentRuns: 3,
};

export interface DaemonStatus {
	running: boolean;
	pid?: number;
	taskCount: number;
	startedAt?: number;
}

export type ScheduleAction = "add" | "diagnose" | "list" | "remove" | "run" | "enable" | "disable" | "logs";

export type DaemonAction = "start" | "stop" | "status" | "restart";

// ---------------------------------------------------------------------------
// Paths — unified under ~/.omp/gateway-data/
// ---------------------------------------------------------------------------

export function getGatewayDataDir(): string {
	return path.join(os.homedir(), ".omp", "gateway-data");
}

export function getSchedulerDir(): string {
	return path.join(getGatewayDataDir(), "scheduler");
}

export function getSchedulerDbPath(): string {
	return path.join(getSchedulerDir(), "scheduler.db");
}

export function getSchedulerPidPath(): string {
	return path.join(getSchedulerDir(), "scheduler.pid");
}

export function getGatewayPidPath(): string {
	return path.join(getGatewayDataDir(), "gateway.pid");
}

export function getSchedulerLogPath(): string {
	return path.join(getSchedulerDir(), "scheduler.log");
}

export function getSchedulerScriptsDir(): string {
	return path.join(getSchedulerDir(), "scripts");
}

export function generateTaskId(): string {
	return `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function generateExecutionId(): string {
	return `exec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export interface ParsedSchedule {
	type: ScheduleType;
	schedule: string;
	intervalMs?: number;
	nextRunAt?: number;
	error?: string;
}

function parseRelativeTime(input: string): number | undefined {
	const match = input.match(/^\+(\d+)(ms|s|m|h|d)$/);
	if (!match) return undefined;
	const value = Number.parseInt(match[1]!, 10);
	const unit = match[2]!;
	const multipliers: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
	return value * multipliers[unit]!;
}

function parseInterval(input: string): number | undefined {
	const match = input.match(/^(\d+)(ms|s|m|h|d)$/);
	if (!match) return undefined;
	const value = Number.parseInt(match[1]!, 10);
	const unit = match[2]!;
	const multipliers: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
	return value * multipliers[unit]!;
}

function parseIsoTimestamp(input: string): number | undefined {
	// Require at least a year-month-day structure (e.g., 2026-05-08 or 2026/05/08)
	if (!/\d{4}[-/]\d{2}[-/]\d{2}/.test(input)) return undefined;
	const d = new Date(input);
	if (Number.isNaN(d.getTime())) return undefined;
	return d.getTime();
}

export function parseSchedule(input: string): ParsedSchedule {
	const trimmed = input.trim();

	// Relative time: +5m, +1h, +2d
	const relativeMs = parseRelativeTime(trimmed);
	if (relativeMs !== undefined) {
		return { type: "once", schedule: trimmed, nextRunAt: Date.now() + relativeMs };
	}

	// Interval: 5m, 1h (not starting with +)
	const intervalMs = parseInterval(trimmed);
	if (intervalMs !== undefined) {
		return { type: "interval", schedule: trimmed, intervalMs };
	}

	// ISO timestamp: 2026-05-08T09:00:00
	const ts = parseIsoTimestamp(trimmed);
	if (ts !== undefined) {
		return { type: "once", schedule: trimmed, nextRunAt: ts };
	}

	// Fall back to cron validation
	const cronValidation = validateCron(trimmed);
	if (cronValidation.valid) {
		return { type: "cron", schedule: trimmed };
	}

	return { type: "cron", schedule: trimmed, error: cronValidation.error };
}

export function validateCron(cron: string): { valid: boolean; error?: string } {
	try {
		if (!cron || cron.trim().length === 0) {
			return { valid: false, error: "Cron expression is empty" };
		}
		const { Cron } = require("croner");
		new Cron(cron, { maxIterations: 0 });
		return { valid: true };
	} catch (err) {
		return { valid: false, error: err instanceof Error ? err.message : String(err) };
	}
}

export function getNextRun(cron: string): Date | null {
	try {
		const { Cron } = require("croner");
		const job = new Cron(cron, { maxIterations: 0 });
		return job.nextRun() as Date | null;
	} catch {
		return null;
	}
}

export function getNextRuns(cron: string, count: number): Date[] {
	try {
		const { Cron } = require("croner");
		const job = new Cron(cron, { maxIterations: 0 });
		return job.nextRuns(count) as Date[];
	} catch {
		return [];
	}
}

export function isDaemonRunning(pidPath: string): boolean {
	const fs = require("node:fs");
	try {
		const pid = Number.parseInt(fs.readFileSync(pidPath, "utf8").trim(), 10);
		if (Number.isNaN(pid)) return false;
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export function readDaemonPid(pidPath: string): number | undefined {
	const fs = require("node:fs");
	try {
		const pid = Number.parseInt(fs.readFileSync(pidPath, "utf8").trim(), 10);
		return Number.isNaN(pid) ? undefined : pid;
	} catch {
		return undefined;
	}
}

export function writeDaemonPid(pidPath: string, pid: number): void {
	const fs = require("node:fs");
	const path = require("node:path");
	const dir = path.dirname(pidPath);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	fs.writeFileSync(pidPath, String(pid), { mode: 0o600, flag: "w" });
}

export function clearDaemonPid(pidPath: string): void {
	const fs = require("node:fs");
	try {
		fs.unlinkSync(pidPath);
	} catch {
		// ignore
	}
}

export function stopDaemon(pid: number): boolean {
	try {
		process.kill(pid, "SIGTERM");
		return true;
	} catch {
		return false;
	}
}

export async function waitForDaemonStop(pidPath: string, timeoutMs = 5000): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (!isDaemonRunning(pidPath)) return true;
		await Bun.sleep(200);
	}
	return false;
}

export async function waitForDaemonStart(pidPath: string, timeoutMs = 5000): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (isDaemonRunning(pidPath)) return true;
		await Bun.sleep(200);
	}
	return false;
}

export function formatTaskRow(task: ScheduledTask): string {
	const next = task.status === "active" && task.nextRunAt ? new Date(task.nextRunAt).toLocaleString() : "—";
	const typeLabel = task.taskType === "agent" ? "agent" : "shell";
	const channel = formatChannel(task.delivery?.channel ?? task.deliver);
	const agent = formatAgent(task.agentDir ?? task.accountId);
	const name = truncateName(task.name, 20);
	const model = task.model ?? "—";
	const execFailed = task.failCount > 0 && task.consecutiveFailures > 0;
	const deliverFailed = !!task.lastDeliveryError;
	const lastStatus = task.lastRunAt ? (execFailed ? "fail" : deliverFailed ? "deliv!" : "ok") : "—";
	const deliveryFailures = formatDeliveryFailureCount(task.id);
	const repeatDisplay = task.repeatCount
		? `${Math.min(task.repeatCompleted ?? 0, task.repeatCount)}/${task.repeatCount}`
		: "—";
	return `${name.padEnd(21)} ${typeLabel.padEnd(6)} ${agent.padEnd(12)} ${task.status.padEnd(8)} ${task.cron.padEnd(16)} ${truncateName(model, 14).padEnd(15)} ${repeatDisplay.padEnd(7)} ${channel.padEnd(20)} ${lastStatus.padEnd(8)} ${deliveryFailures.padEnd(8)} ${next.padEnd(21)}`;
}

/**
 * Render the recent delivery-failure count for a task as a short cell.
 *   0 → "✓"        (green check, no recent failures)
 *   1+ → "× N"     (red flag, with count)
 *   no deliver → "—" (task doesn't deliver anywhere, failures N/A)
 *
 * Reads from the global `delivery-failures.jsonl` log via the
 * `getRecentDeliveryFailureCount` helper, which caches the file by
 * mtime. Default window is 24h so a stale historical failure doesn't
 * keep warning forever.
 */
export function formatDeliveryFailureCount(taskId: string): string {
	const failureCount = getRecentDeliveryFailureCount(taskId);
	if (failureCount === 0) return "✓";
	return `\u00d7 ${failureCount}`;
}

/**
 * Truncate a string to fit a fixed column width. If the input is longer
 * than `max`, replace the trailing chars with an ellipsis so the result
 * is exactly `max` chars long. Keeps the column count stable across
 * rows regardless of name length.
 */
export function truncateName(name: string, max: number): string {
	if (name.length <= max) return name;
	return `${name.slice(0, max - 1)}\u2026`;
}

/**
 * Render the deliver target as a single human-readable cell.
 *
 *   deliver="dingtalk:hr"               → "dingtalk:hr"
 *   deliver="dingtalk:user:601590212"   → "dingtalk:user:601590212"
 *   deliver undefined or empty          → "—"
 *
 * Note: `deliverUser` (the destination user for proactive send) is NOT
 * rendered in the table column. It's an orthogonal field that's only
 * used at delivery time, and folding it in would push the next column
 * around. Use `--json` to see the full record.
 */
export function formatChannel(deliver: string | undefined): string {
	if (!deliver) return "—";
	return deliver;
}

/**
 * Render the owning agent directory as a single human-readable cell.
 *
 *   agentDir="~/.omp/agents/hr"  → "hr"
 *   agentDir undefined            → "—"
 *
 * Shows the last path segment of the agent directory. Long paths are
 * truncated with an ellipsis using the shared `truncateName` helper
 * to keep the column width stable.
 */
export function formatAgent(agentDir: string | undefined, max = 12): string {
	if (!agentDir) return "—";
	const label = agentDir.split("/").pop() ?? agentDir;
	return truncateName(label, max);
}

export function formatExecutionRow(exec: TaskExecution): string {
	const duration = exec.endedAt && exec.startedAt ? `${((exec.endedAt - exec.startedAt) / 1000).toFixed(1)}s` : "—";
	return `${exec.id.slice(0, 16).padEnd(18)} ${exec.status.padEnd(8)} ${duration.padEnd(8)} ${exec.exitCode ?? "—"}`;
}

export function formatNextRuns(task: ScheduledTask, count = 3): string {
	if (task.status !== "active") return "(disabled)";
	if (task.scheduleType === "interval") return `every ${task.cron}`;
	if (task.scheduleType === "once") return task.nextRunAt ? new Date(task.nextRunAt).toLocaleString() : "(past)";
	const runs = getNextRuns(task.cron, count);
	if (runs.length === 0) return "(invalid cron)";
	return runs.map(d => d.toLocaleString()).join(", ");
}

// ---------------------------------------------------------------------------
// Delivery validation
// ---------------------------------------------------------------------------

/**
 * Normalized delivery descriptor produced by {@link validateCronDelivery}.
 * Shape-compatible with {@link ScheduledTask}'s `delivery` field so the
 * validated value can be persisted without further translation.
 */
export type CronDeliveryOutput = ScheduledTask["delivery"];

export type CronDeliveryValidation =
	| { ok: true; value: CronDeliveryOutput }
	| { ok: false; error: string };

/**
 * Normalize and validate a user-supplied or auto-inferred delivery
 * descriptor for a scheduled task.
 *
 * Rules:
 *   - `channel` is required and must be a non-empty string.
 *   - Exactly one of `toUserId` (DM) or `toConversationId` (group)
 *     must be a non-empty string. Setting both, or neither, is an
 *     error — the gateway cannot disambiguate a single target.
 *   - `accountId` is optional.
 *   - `mode` defaults to `"announce"` when omitted; `"announce"` and
 *     `"none"` are the only accepted values.
 *
 * The host tool's `args.delivery` and the auto-inference `Record<string,
 * unknown>` both flow through here, so the parameter is intentionally
 * permissive and field types are checked individually.
 */
export function validateCronDelivery(
	input: Partial<Record<"channel" | "accountId" | "toUserId" | "toConversationId" | "mode", unknown>>,
): CronDeliveryValidation {
	const channel = typeof input.channel === "string" ? input.channel.trim() : "";
	if (channel === "") {
		return { ok: false, error: "delivery.channel is required and must be a non-empty string" };
	}

	const toUserId = typeof input.toUserId === "string" && input.toUserId.trim() !== "" ? input.toUserId : undefined;
	const toConversationId =
		typeof input.toConversationId === "string" && input.toConversationId.trim() !== ""
			? input.toConversationId
			: undefined;

	if ((toUserId === undefined) === (toConversationId === undefined)) {
		return {
			ok: false,
			error: "delivery must specify exactly one of toUserId (DM) or toConversationId (group)",
		};
	}

	const accountId = typeof input.accountId === "string" && input.accountId.trim() !== "" ? input.accountId : undefined;
	const mode = input.mode === "none" ? "none" : "announce";

	const value: CronDeliveryOutput = {
		channel,
		...(accountId !== undefined ? { accountId } : {}),
		...(toUserId !== undefined ? { toUserId } : { toConversationId: toConversationId as string }),
		mode,
	};
	return { ok: true, value };
}
