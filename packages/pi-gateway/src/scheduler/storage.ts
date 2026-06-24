/**
 * SQLite storage layer for the persistent cron scheduler.
 */
import { Database, type SQLQueryBindings, type Statement } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import {
	generateExecutionId,
	generateTaskId,
	getSchedulerDbPath,
	type ScheduledTask,
	type SchedulerStorage,
	type TaskExecution,
} from "./types";

// ---------------------------------------------------------------------------
// DB row shapes (snake_case)
// ---------------------------------------------------------------------------

type TaskRow = {
	id: string;
	name: string;
	description: string | null;
	cron: string;
	command: string;
	status: string;
	schedule_type: string | null;
	task_type: string | null;
	model: string | null;
	provider: string | null;
	enabled_toolsets: string | null;
	timeout_ms: number | null;
	retry_config: string | null;
	skills_config: string | null;
	pre_script: string | null;
	consecutive_failures: number;
	created_at: number;
	updated_at: number;
	last_run_at: number | null;
	next_run_at: number | null;
	run_count: number;
	fail_count: number;
	repeat_count: number | null;
	repeat_completed: number | null;
	deliver: string | null;
	deliver_user: string | null;
	last_delivery_error: string | null;
	account_id: string | null;
	agent_dir: string | null;
	delivery_channel: string | null;
	delivery_account_id: string | null;
	delivery_to_user_id: string | null;
	delivery_to_conversation_id: string | null;
	delivery_mode: string | null;
};

type ExecutionRow = {
	id: string;
	task_id: string;
	started_at: number;
	ended_at: number | null;
	exit_code: number | null;
	output: string | null;
	stderr: string | null;
	status: string;
	agent_session_path: string | null;
};

// ---------------------------------------------------------------------------
// Field allow-lists for dynamic updates
// ---------------------------------------------------------------------------

const TASK_UPDATE_FIELDS = new Set<string>([
	"name",
	"description",
	"cron",
	"command",
	"status",
	"scheduleType",
	"taskType",
	"model",
	"provider",
	"enabledToolsets",
	"timeoutMs",
	"retryConfig",
	"skills",
	"preScript",
	"consecutiveFailures",
	"createdAt",
	"updatedAt",
	"lastRunAt",
	"nextRunAt",
	"runCount",
	"failCount",
	"repeatCount",
	"repeatCompleted",
	"deliver",
	"deliverUser",
	"lastDeliveryError",
	"accountId",
	"agentDir",
	"deliveryChannel",
	"deliveryAccountId",
	"deliveryToUserId",
	"deliveryToConversationId",
	"deliveryMode",
]);

const EXECUTION_UPDATE_FIELDS = new Set<string>([
	"taskId",
	"startedAt",
	"endedAt",
	"exitCode",
	"output",
	"stderr",
	"status",
	"agentSessionPath",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toTask(row: TaskRow): ScheduledTask {
	// agentDir: prefer the new column, fall back to legacy account_id for
	// rows written before the agentDir migration.
	const agentDir = row.agent_dir ?? row.account_id ?? undefined;

	// delivery: prefer the new structured column group. For rows written
	// before the delivery migration, reconstruct from legacy deliver /
	// deliver_user so old tasks keep firing to their configured channel.
	let delivery: ScheduledTask["delivery"];
	if (row.delivery_channel) {
		delivery = {
			channel: row.delivery_channel,
			accountId: row.delivery_account_id ?? undefined,
			toUserId: row.delivery_to_user_id ?? undefined,
			toConversationId: row.delivery_to_conversation_id ?? undefined,
			mode: (row.delivery_mode as "announce" | "none") ?? "announce",
		};
	} else if (row.deliver) {
		delivery = {
			channel: row.deliver,
			toUserId: row.deliver_user ?? undefined,
			mode: "announce",
		};
	}

	return {
		id: row.id,
		name: row.name,
		description: row.description ?? undefined,
		cron: row.cron,
		command: row.command,
		status: row.status as ScheduledTask["status"],
		scheduleType: (row.schedule_type as ScheduledTask["scheduleType"]) ?? "cron",
		taskType: (row.task_type as ScheduledTask["taskType"]) ?? "shell",
		model: row.model ?? undefined,
		provider: row.provider ?? undefined,
		enabledToolsets: row.enabled_toolsets ? JSON.parse(row.enabled_toolsets) : undefined,
		timeoutMs: row.timeout_ms ?? 30_000,
		retry: row.retry_config ? JSON.parse(row.retry_config) : undefined,
		skills: row.skills_config ? JSON.parse(row.skills_config) : undefined,
		preScript: row.pre_script ?? undefined,
		consecutiveFailures: row.consecutive_failures,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		lastRunAt: row.last_run_at ?? undefined,
		nextRunAt: row.next_run_at ?? undefined,
		runCount: row.run_count,
		failCount: row.fail_count,
		repeatCount: row.repeat_count ?? undefined,
		repeatCompleted: row.repeat_completed ?? undefined,
		agentDir,
		delivery,
		// Legacy fields preserved for backward-compat reads.
		deliver: row.deliver ?? undefined,
		deliverUser: row.deliver_user ?? undefined,
		lastDeliveryError: row.last_delivery_error ?? undefined,
		accountId: row.account_id ?? undefined,
	};
}

function toExecution(row: ExecutionRow): TaskExecution {
	return {
		id: row.id,
		taskId: row.task_id,
		startedAt: row.started_at,
		endedAt: row.ended_at ?? undefined,
		exitCode: row.exit_code ?? undefined,
		output: row.output ?? undefined,
		stderr: row.stderr ?? undefined,
		status: row.status as TaskExecution["status"],
		agentSessionPath: row.agent_session_path ?? undefined,
	};
}

function camelToSnake(str: string): string {
	return str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
}

function buildDynamicUpdate(
	updates: Record<string, unknown>,
	allowedFields: Set<string>,
	alwaysSet?: Record<string, unknown>,
): { sql: string; values: SQLQueryBindings[] } | undefined {
	const entries = Object.entries(updates).filter(([key]) => key !== "id" && allowedFields.has(key));
	if (entries.length === 0 && (!alwaysSet || Object.keys(alwaysSet).length === 0)) {
		return undefined;
	}

	const setClauses: string[] = [];
	const values: SQLQueryBindings[] = [];

	for (const [key, value] of entries) {
		setClauses.push(`${camelToSnake(key)} = ?`);
		values.push((value === undefined ? null : value) as SQLQueryBindings);
	}

	if (alwaysSet) {
		for (const [key, value] of Object.entries(alwaysSet)) {
			setClauses.push(`${camelToSnake(key)} = ?`);
			values.push(value as SQLQueryBindings);
		}
	}

	return { sql: setClauses.join(", "), values };
}

// ---------------------------------------------------------------------------
// Storage implementation
// ---------------------------------------------------------------------------

export class SchedulerDbStorage implements SchedulerStorage {
	#db: Database;

	// Prepared statements
	#insertTaskStmt: Statement;
	#getTaskStmt: Statement;
	#getTaskByNameStmt: Statement;
	#listTasksStmt: Statement;
	#deleteTaskStmt: Statement;
	#insertExecutionStmt: Statement;
	#getExecutionsStmt: Statement;

	constructor(dbPath: string = getSchedulerDbPath()) {
		const dir = path.dirname(dbPath);
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

		this.#db = new Database(dbPath);
		this.#db.exec("PRAGMA journal_mode = WAL;");
		this.#db.exec("PRAGMA foreign_keys = ON;");
		this.#db.exec("PRAGMA busy_timeout = 5000;");

		this.#initSchema();

		this.#insertTaskStmt = this.#db.prepare(`
			INSERT INTO tasks (
				id, name, description, cron, command, status,
				schedule_type, task_type,
				model, provider, enabled_toolsets, timeout_ms,
				retry_config, skills_config, pre_script, consecutive_failures,
				created_at, updated_at, last_run_at, next_run_at,
				run_count, fail_count, repeat_count, repeat_completed,
				deliver, deliver_user, last_delivery_error, account_id,
				agent_dir, delivery_channel, delivery_account_id,
				delivery_to_user_id, delivery_to_conversation_id, delivery_mode
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);

		this.#getTaskStmt = this.#db.prepare("SELECT * FROM tasks WHERE id = ?");
		this.#getTaskByNameStmt = this.#db.prepare("SELECT * FROM tasks WHERE name = ?");
		this.#listTasksStmt = this.#db.prepare("SELECT * FROM tasks ORDER BY created_at DESC");
		this.#deleteTaskStmt = this.#db.prepare("DELETE FROM tasks WHERE id = ?");

		this.#insertExecutionStmt = this.#db.prepare(`
			INSERT INTO executions (
				id, task_id, started_at, ended_at,
				exit_code, output, stderr, status,
				agent_session_path
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);

		this.#getExecutionsStmt = this.#db.prepare(
			"SELECT * FROM executions WHERE task_id = ? ORDER BY started_at DESC LIMIT ?",
		);

		logger.debug("SchedulerDbStorage initialized", { path: dbPath });
	}

	#initSchema(): void {
		this.#db.exec(`
			CREATE TABLE IF NOT EXISTS tasks (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL UNIQUE,
				description TEXT,
				cron TEXT NOT NULL,
				command TEXT NOT NULL,
				status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'disabled')),
				schedule_type TEXT,
				task_type TEXT,
				timeout_ms INTEGER,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				last_run_at INTEGER,
				next_run_at INTEGER,
				run_count INTEGER NOT NULL DEFAULT 0,
				fail_count INTEGER NOT NULL DEFAULT 0
			)
		`);

		this.#db.exec(`
			CREATE TABLE IF NOT EXISTS executions (
				id TEXT PRIMARY KEY,
				task_id TEXT NOT NULL,
				started_at INTEGER NOT NULL,
				ended_at INTEGER,
				exit_code INTEGER,
				output TEXT,
				stderr TEXT,
				status TEXT NOT NULL CHECK(status IN ('running', 'success', 'failure')),
				agent_session_path TEXT,
				FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
			)
		`);

		// Migrate: add new columns if missing
		const execColumns = this.#db.prepare("PRAGMA table_info(executions)").all() as Array<{ name: string }>;
		if (!execColumns.some(c => c.name === "agent_session_path")) {
			this.#db.exec("ALTER TABLE executions ADD COLUMN agent_session_path TEXT;");
		}

		// Migrate: add new columns if missing
		const columns = this.#db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
		const hasScheduleType = columns.some(c => c.name === "schedule_type");
		const hasTaskType = columns.some(c => c.name === "task_type");
		const hasTimeoutMs = columns.some(c => c.name === "timeout_ms");
		const hasRetry = columns.some(c => c.name === "retry_config");
		const hasSkills = columns.some(c => c.name === "skills_config");
		const hasPreScript = columns.some(c => c.name === "pre_script");
		const hasConsecutiveFails = columns.some(c => c.name === "consecutive_failures");
		const hasDeliver = columns.some(c => c.name === "deliver");
		const hasDeliverUser = columns.some(c => c.name === "deliver_user");
		const hasAccountId = columns.some(c => c.name === "account_id");
		const hasModel = columns.some(c => c.name === "model");
		const hasProvider = columns.some(c => c.name === "provider");
		const hasEnabledToolsets = columns.some(c => c.name === "enabled_toolsets");
		if (!hasDeliverUser) this.#db.exec("ALTER TABLE tasks ADD COLUMN deliver_user TEXT;");
		if (!hasAccountId) this.#db.exec("ALTER TABLE tasks ADD COLUMN account_id TEXT;");
		if (!hasScheduleType) this.#db.exec("ALTER TABLE tasks ADD COLUMN schedule_type TEXT;");
		if (!hasTaskType) this.#db.exec("ALTER TABLE tasks ADD COLUMN task_type TEXT;");
		if (!hasModel) this.#db.exec("ALTER TABLE tasks ADD COLUMN model TEXT;");
		if (!hasProvider) this.#db.exec("ALTER TABLE tasks ADD COLUMN provider TEXT;");
		if (!hasEnabledToolsets) this.#db.exec("ALTER TABLE tasks ADD COLUMN enabled_toolsets TEXT;");
		if (!hasTimeoutMs) this.#db.exec("ALTER TABLE tasks ADD COLUMN timeout_ms INTEGER;");
		if (!hasRetry) this.#db.exec("ALTER TABLE tasks ADD COLUMN retry_config TEXT;");
		if (!hasSkills) this.#db.exec("ALTER TABLE tasks ADD COLUMN skills_config TEXT;");
		if (!hasPreScript) this.#db.exec("ALTER TABLE tasks ADD COLUMN pre_script TEXT;");
		if (!hasConsecutiveFails)
			this.#db.exec("ALTER TABLE tasks ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;");
		const hasRepeatCount = columns.some(c => c.name === "repeat_count");
		const hasRepeatCompleted = columns.some(c => c.name === "repeat_completed");
		if (!hasRepeatCount) this.#db.exec("ALTER TABLE tasks ADD COLUMN repeat_count INTEGER;");
		if (!hasRepeatCompleted) this.#db.exec("ALTER TABLE tasks ADD COLUMN repeat_completed INTEGER;");
		const hasLastDeliveryError = columns.some(c => c.name === "last_delivery_error");
		if (!hasLastDeliveryError) this.#db.exec("ALTER TABLE tasks ADD COLUMN last_delivery_error TEXT;");
		if (!hasDeliver) this.#db.exec("ALTER TABLE tasks ADD COLUMN deliver TEXT;");

		// agentDir + delivery migration (replaces accountId / deliver / deliver_user)
		const hasAgentDir = columns.some(c => c.name === "agent_dir");
		const hasDeliveryChannel = columns.some(c => c.name === "delivery_channel");
		const hasDeliveryAccountId = columns.some(c => c.name === "delivery_account_id");
		const hasDeliveryToUserId = columns.some(c => c.name === "delivery_to_user_id");
		const hasDeliveryToConversationId = columns.some(c => c.name === "delivery_to_conversation_id");
		const hasDeliveryMode = columns.some(c => c.name === "delivery_mode");
		if (!hasAgentDir) this.#db.exec("ALTER TABLE tasks ADD COLUMN agent_dir TEXT;");
		if (!hasDeliveryChannel) this.#db.exec("ALTER TABLE tasks ADD COLUMN delivery_channel TEXT;");
		if (!hasDeliveryAccountId) this.#db.exec("ALTER TABLE tasks ADD COLUMN delivery_account_id TEXT;");
		if (!hasDeliveryToUserId) this.#db.exec("ALTER TABLE tasks ADD COLUMN delivery_to_user_id TEXT;");
		if (!hasDeliveryToConversationId) this.#db.exec("ALTER TABLE tasks ADD COLUMN delivery_to_conversation_id TEXT;");
		if (!hasDeliveryMode) this.#db.exec("ALTER TABLE tasks ADD COLUMN delivery_mode TEXT;");
		this.#db.exec("CREATE INDEX IF NOT EXISTS idx_executions_task_id ON executions(task_id)");
		this.#db.exec("CREATE INDEX IF NOT EXISTS idx_executions_started_at ON executions(started_at DESC)");
	}

	addTask(task: Omit<ScheduledTask, "id">): ScheduledTask {
		const id = generateTaskId();
		const now = Date.now();
		this.#insertTaskStmt.run(
			id,
			task.name,
			task.description ?? null,
			task.cron,
			task.command,
			task.status,
			task.scheduleType ?? "cron",
			task.taskType ?? "shell",
			task.model ?? null,
			task.provider ?? null,
			task.enabledToolsets ? JSON.stringify(task.enabledToolsets) : null,
			task.timeoutMs ?? (task.taskType === "agent" ? 120_000 : 30_000),
			task.retry ? JSON.stringify(task.retry) : null,
			task.skills ? JSON.stringify(task.skills) : null,
			task.preScript ?? null,
			task.consecutiveFailures ?? 0,
			task.createdAt ?? now,
			task.updatedAt ?? now,
			task.lastRunAt ?? null,
			task.nextRunAt ?? null,
			task.runCount ?? 0,
			task.failCount ?? 0,
			task.repeatCount ?? null,
			task.repeatCompleted ?? null,
			task.deliver ?? null,
			task.deliverUser ?? null,
			task.lastDeliveryError ?? null,
			task.accountId ?? null,
			task.agentDir ?? null,
			task.delivery?.channel ?? null,
			task.delivery?.accountId ?? null,
			task.delivery?.toUserId ?? null,
			task.delivery?.toConversationId ?? null,
			task.delivery?.mode ?? null,
		);
		return this.getTask(id)!;
	}

	getTask(id: string): ScheduledTask | undefined {
		const row = this.#getTaskStmt.get(id) as TaskRow | undefined;
		return row ? toTask(row) : undefined;
	}

	getTaskByName(name: string): ScheduledTask | undefined {
		const row = this.#getTaskByNameStmt.get(name) as TaskRow | undefined;
		return row ? toTask(row) : undefined;
	}

	listTasks(): ScheduledTask[] {
		const rows = this.#listTasksStmt.all() as TaskRow[];
		return rows.map(toTask);
	}

	updateTask(id: string, updates: Partial<ScheduledTask>): void {
		// Flatten the `delivery` object into the 5 snake_case delivery_* columns.
		// buildDynamicUpdate only handles scalar fields, so a structured `delivery`
		// would otherwise be dropped (or stored as "[object Object]").
		const flattened: Record<string, unknown> = { ...updates };
		if (updates.delivery !== undefined) {
			const d = updates.delivery;
			flattened.deliveryChannel = d?.channel ?? null;
			flattened.deliveryAccountId = d?.accountId ?? null;
			flattened.deliveryToUserId = d?.toUserId ?? null;
			flattened.deliveryToConversationId = d?.toConversationId ?? null;
			flattened.deliveryMode = d?.mode ?? null;
			delete flattened.delivery;
		}

		const built = buildDynamicUpdate(flattened, TASK_UPDATE_FIELDS, { updatedAt: Date.now() });
		if (!built) return;

		const sql = `UPDATE tasks SET ${built.sql} WHERE id = ?`;
		const params: SQLQueryBindings[] = [...built.values, id];
		this.#db.prepare(sql).run(...params);
	}

	deleteTask(id: string): void {
		this.#deleteTaskStmt.run(id);
	}

	recordExecution(exec: Omit<TaskExecution, "id">): TaskExecution {
		const id = generateExecutionId();
		this.#insertExecutionStmt.run(
			id,
			exec.taskId,
			exec.startedAt,
			exec.endedAt ?? null,
			exec.exitCode ?? null,
			exec.output ?? null,
			exec.stderr ?? null,
			exec.status,
			exec.agentSessionPath ?? null,
		);
		return this.#getExecution(id)!;
	}

	updateExecution(id: string, updates: Partial<TaskExecution>): void {
		const built = buildDynamicUpdate(updates, EXECUTION_UPDATE_FIELDS);
		if (!built) return;

		const sql = `UPDATE executions SET ${built.sql} WHERE id = ?`;
		const params: SQLQueryBindings[] = [...built.values, id];
		this.#db.prepare(sql).run(...params);
	}

	getExecutions(taskId: string, limit?: number): TaskExecution[] {
		const safeLimit = Number.isFinite(limit) && limit! > 0 ? limit! : 1_000_000;
		const rows = this.#getExecutionsStmt.all(taskId, safeLimit) as ExecutionRow[];
		return rows.map(toExecution);
	}

	/**
	 * All executions currently in the `running` state, across every task,
	 * newest first. Used by `gateway doctor` to detect executions that were
	 * orphaned by a gateway crash (started but never transitioned to
	 * success/failure). Each row carries the owning task name for reporting.
	 */
	getRunningExecutions(): Array<TaskExecution & { taskName: string }> {
		const rows = this.#db
			.prepare(
				`SELECT e.*, t.name AS task_name FROM executions e
				 LEFT JOIN tasks t ON t.id = e.task_id
				 WHERE e.status = 'running' ORDER BY e.started_at DESC`,
			)
			.all() as Array<ExecutionRow & { task_name: string | null }>;
		return rows.map(r => ({ ...toExecution(r), taskName: r.task_name ?? "(deleted task)" }));
	}

	pruneExecutions(maxAgeDays?: number, maxCount?: number): number {
		let deleted = 0;

		if (maxAgeDays && maxAgeDays > 0) {
			const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
			const result = this.#db.run("DELETE FROM executions WHERE started_at < ?", [cutoff]);
			deleted += Number(result.changes);
		}

		if (maxCount && maxCount > 0) {
			const tasks = this.listTasks();
			for (const task of tasks) {
				const keepIds = (
					this.#db
						.prepare("SELECT id FROM executions WHERE task_id = ? ORDER BY started_at DESC LIMIT ?")
						.all(task.id, maxCount) as Array<{ id: string }>
				).map(r => r.id);
				if (keepIds.length > 0) {
					const placeholders = keepIds.map(() => "?").join(",");
					const result = this.#db.run(`DELETE FROM executions WHERE task_id = ? AND id NOT IN (${placeholders})`, [
						task.id,
						...keepIds,
					]);
					deleted += Number(result.changes);
				}
			}
		}

		if (deleted > 0) {
			this.#db.run("PRAGMA wal_checkpoint(TRUNCATE);");
		}
		return deleted;
	}

	close(): void {
		this.#db.close();
	}

	#getExecution(id: string): TaskExecution | undefined {
		const row = this.#db.prepare("SELECT * FROM executions WHERE id = ?").get(id) as ExecutionRow | undefined;
		return row ? toExecution(row) : undefined;
	}
}
