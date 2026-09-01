/**
 * Gateway wire endpoint core（P2-4）——传输无关的 gateway 领域命令处理。
 *
 * 接收 wire 命令（cron CRUD / get_cron_tasks / get_cron_logs / gateway_status），
 * 直接回答 gateway 自己的领域（调度器 storage + 进程内状态），不再让 serve 侧
 * 直读 jobs.json/status.json（serve 改为转发 POST /wire）。
 *
 * 与传输形态解耦：HTTP POST / WS / serve 转发都调 `handleGatewayWireCommand`。
 *
 * 形状契约：get_cron_tasks / get_cron_logs / gateway_status 的返回形状与旧 serve
 * 直读代理一致（pi-wire 的 TaskRowDto / CronLogEntryDto / GatewayStatusDto）——
 * web-app 消费方无需改动；cron_create / cron_update / cron_remove / cron_test_run
 * 是新增写面（无既有消费方，纯增量）。
 */
import { logger } from "@cornfield/utils";
import type { CronLogEntryDto, TaskRowDto } from "@cornfield/wire";
import { runTestRun } from "./scheduler/test-run";
import type { ScheduledTask, SchedulerStorage } from "./scheduler/types";

/** cron 日志 output/stderr 截断上限（与旧 serve 直读代理一致）。 */
const CRON_LOG_MAX_OUTPUT = 2048;

/**
 * 账号级动态可 patch 的白名单字段（set_gateway_account 写面）。
 *
 * 刻意不含 appSecret/appKey：凭证类写回需走 `$ENV_VAR` 引用或 setup 向导，
 * 不在动态热生效面暴露明文密钥。
 */
export interface GatewayAccountPatch {
	enabled?: boolean;
	robotName?: string;
	robotCode?: string;
	agentDir?: string;
	deniedTools?: string[];
	hideThinkingBlock?: boolean;
}

export interface GatewayWireDeps {
	storage: SchedulerStorage;
	/** scheduler reload 触发（test-run 用；gateway 启动时装配）。 */
	reloadScheduler?: () => Promise<void> | void;
	/** gateway 进程内状态（旧 status.json 的权威源；live gateway stale=false）。 */
	gatewayStatus: () => Promise<GatewayStatusPayload> | GatewayStatusPayload;
	/**
	 * 动态账号热生效（set_gateway_account）：写 gateway.json accounts.<id> 白名单
	 * 字段并触发进程内 reload（只重建受影响账号 bridge/channel）。未装配（如
	 * serve 直连路径）时命令返回明确错误。
	 */
	applyGatewayAccountPatch?: (accountId: string, patch: GatewayAccountPatch) => Promise<GatewayWireResult>;
	/** 进程内 reload（reload_gateway；fallback 重新 loadConfig + reload）。 */
	reloadGateway?: () => Promise<GatewayWireResult>;
}

/** 与旧 serve readGatewayStatus 输出同形的状态负载（web-app GatewayStatusDto）。 */
export interface GatewayStatusPayload {
	pid: number;
	statusWrittenAt: number;
	stale: boolean;
	accounts: Array<{
		accountId: string;
		bridgeRunning?: boolean;
		bridgeState?: string;
		channelConnected?: boolean;
		agentDir?: string;
	}>;
	scheduler: { running?: boolean; taskCount?: number } | null;
}

export type GatewayWireResult = { ok: true; result: unknown } | { ok: false; error: string };

/** ScheduledTask → web-app TaskRowDto（与旧 jobs.json 只读代理同形）。 */
function toTaskRowDto(task: ScheduledTask): TaskRowDto {
	return {
		id: task.id,
		name: task.name,
		description: task.description,
		status: task.status,
		scheduleType: task.scheduleType ?? "cron",
		cron: task.cron,
		command: task.command,
		nextRunAt: task.nextRunAt,
		lastRunAt: task.lastRunAt,
		enabled: task.status !== "disabled",
		accountId: task.accountId ?? task.agentDir,
		runCount: task.runCount,
		failCount: task.failCount,
		consecutiveFailures: task.consecutiveFailures,
	};
}

function truncateLog(s: string | undefined): { text?: string; truncated?: boolean } {
	if (s === undefined) return {};
	const truncated = s.length > CRON_LOG_MAX_OUTPUT;
	return { text: s.slice(0, CRON_LOG_MAX_OUTPUT), truncated };
}

/** wire 命令 → gateway 领域。返回统一结果形状（传输层包帧）。 */
export async function handleGatewayWireCommand(
	command: { type: string; [key: string]: unknown },
	deps: GatewayWireDeps,
): Promise<GatewayWireResult> {
	const { storage } = deps;

	switch (command.type) {
		case "get_cron_tasks": {
			return { ok: true, result: { tasks: storage.listTasks().map(toTaskRowDto) } };
		}

		case "get_cron_logs": {
			const taskName = typeof command.taskId === "string" ? command.taskId : undefined;
			const days = typeof command.days === "number" ? Math.min(30, Math.max(1, command.days)) : 3;
			const limit = typeof command.limit === "number" ? Math.min(200, Math.max(1, command.limit)) : 50;
			const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
			// taskId 参数语义 = 任务名（web-app 传 task.name；与旧 logs/by-task/<name> 目录一致）。
			// 未知任务（已删/不存在）→ 空列表，与旧代理行为一致。
			const targetTask = taskName ? storage.getTaskByName(taskName) : undefined;
			if (taskName && !targetTask) {
				return { ok: true, result: { logs: [] } };
			}
			const executions = storage
				.getRecentExecutions({ limit, sinceMs: cutoff })
				.filter(exec => (targetTask ? exec.taskId === targetTask.id : true));
			const logs: CronLogEntryDto[] = executions.map(exec => {
				const out = truncateLog(exec.output);
				const err = truncateLog(exec.stderr);
				return {
					taskId: exec.taskId,
					id: exec.id,
					ts: exec.startedAt,
					status: exec.status,
					exitCode: exec.exitCode ?? null,
					durationMs: exec.endedAt != null ? exec.endedAt - exec.startedAt : null,
					output: out.text,
					outputTruncated: out.truncated,
					stderr: err.text,
				};
			});
			return { ok: true, result: { logs } };
		}

		case "cron_create": {
			const name = typeof command.name === "string" ? command.name.trim() : "";
			const cron = typeof command.cron === "string" ? command.cron.trim() : "";
			const rawCommand = typeof command.command === "string" ? command.command : "";
			if (!name || !cron || !rawCommand) {
				return { ok: false, error: "cron_create requires name, cron, command" };
			}
			if (storage.getTaskByName(name)) {
				return { ok: false, error: `task already exists: ${name}` };
			}
			const task = storage.addTask({
				name,
				cron,
				command: rawCommand,
				status: command.status === "paused" ? "paused" : "active",
				taskType: command.taskType === "agent" ? "agent" : "shell",
				scheduleType: (typeof command.scheduleType === "string" ? command.scheduleType : "cron") as
					| "cron"
					| "interval"
					| "once",
				description: typeof command.description === "string" ? command.description : undefined,
				model: typeof command.model === "string" ? command.model : undefined,
				provider: typeof command.provider === "string" ? command.provider : undefined,
				enabledToolsets: Array.isArray(command.enabledToolsets) ? (command.enabledToolsets as string[]) : undefined,
				timeoutMs: typeof command.timeoutMs === "number" ? command.timeoutMs : undefined,
				repeatCount: typeof command.repeatCount === "number" ? command.repeatCount : undefined,
				skills: Array.isArray(command.skills) ? (command.skills as string[]) : undefined,
				preScript: typeof command.preScript === "string" ? command.preScript : undefined,
				consecutiveFailures: 0,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				runCount: 0,
				failCount: 0,
			});
			return { ok: true, result: { task } };
		}

		case "cron_update": {
			const id = typeof command.id === "string" ? command.id : "";
			if (!id || !storage.getTask(id)) {
				return { ok: false, error: `unknown task: ${id}` };
			}
			const updates: Partial<ScheduledTask> = {};
			if (typeof command.cron === "string") updates.cron = command.cron;
			if (typeof command.command === "string") updates.command = command.command;
			if (typeof command.status === "string") updates.status = command.status as ScheduledTask["status"];
			if (typeof command.description === "string") updates.description = command.description;
			if (typeof command.model === "string") updates.model = command.model;
			if (typeof command.provider === "string") updates.provider = command.provider;
			if (typeof command.timeoutMs === "number") updates.timeoutMs = command.timeoutMs;
			if (typeof command.repeatCount === "number") updates.repeatCount = command.repeatCount;
			if (Array.isArray(command.enabledToolsets)) updates.enabledToolsets = command.enabledToolsets as string[];
			if (Array.isArray(command.skills)) updates.skills = command.skills as string[];
			if (typeof command.preScript === "string") updates.preScript = command.preScript;
			storage.updateTask(id, updates);
			return { ok: true, result: { task: storage.getTask(id) } };
		}

		case "cron_remove": {
			const id = typeof command.id === "string" ? command.id : "";
			const task = id ? storage.getTask(id) : undefined;
			if (!task) {
				return { ok: false, error: `unknown task: ${id}` };
			}
			storage.deleteTask(id);
			return { ok: true, result: { removed: task.name } };
		}

		case "cron_test_run": {
			const name = typeof command.name === "string" ? command.name : "";
			if (!storage.getTaskByName(name)) {
				return { ok: false, error: `unknown task: ${name}` };
			}
			try {
				const started = await runTestRun({
					name,
					inMs: typeof command.inMs === "number" ? command.inMs : undefined,
					storage,
					markerBaseDir: storage.getMarkerBaseDir(),
					origin: { sessionPath: "wire" },
					reloadScheduler: () => {
						void deps.reloadScheduler?.();
					},
				});
				return { ok: true, result: started };
			} catch (err) {
				logger.error("wire:cron-test-run failed", { name, error: String(err) });
				return { ok: false, error: err instanceof Error ? err.message : String(err) };
			}
		}

		case "gateway_status": {
			return { ok: true, result: await deps.gatewayStatus() };
		}

		// 动态账号热生效（G10）：写 gateway.json accounts.<id> 白名单字段 → 进程内
		// reload（只重建受影响账号 bridge/channel），不重启 gateway。凭证类字段
		// （appSecret/appKey）不在白名单——前端不落明文密钥，维护走 `$ENV_VAR` 引用或 setup 向导。
		case "set_gateway_account": {
			const accountId = typeof command.accountId === "string" ? command.accountId : "";
			const rawPatch = command.patch;
			if (!accountId) {
				return { ok: false, error: "set_gateway_account requires accountId" };
			}
			if (!rawPatch || typeof rawPatch !== "object" || Array.isArray(rawPatch)) {
				return { ok: false, error: "set_gateway_account requires patch object" };
			}
			// 白名单过滤：只接受账号级动态字段，拒绝未知键（防配置注入）。
			// 先做字段校验（调用方错误）再检查 deps —— 空 patch 在任何端点上都是坏请求。
			const PATCH_FIELDS = new Set([
				"enabled",
				"robotName",
				"robotCode",
				"agentDir",
				"deniedTools",
				"hideThinkingBlock",
			]);
			const patch: GatewayAccountPatch = {};
			for (const [key, value] of Object.entries(rawPatch)) {
				if (PATCH_FIELDS.has(key)) {
					(patch as Record<string, unknown>)[key] = value;
				}
			}
			if (Object.keys(patch).length === 0) {
				return { ok: false, error: "set_gateway_account: no whitelisted fields in patch" };
			}
			if (!deps.applyGatewayAccountPatch) {
				return { ok: false, error: "gateway account patch not available on this endpoint" };
			}
			return deps.applyGatewayAccountPatch(accountId, patch);
		}

		case "reload_gateway": {
			if (!deps.reloadGateway) {
				return { ok: false, error: "gateway reload not available on this endpoint" };
			}
			return deps.reloadGateway();
		}

		default:
			return { ok: false, error: `gateway wire: unknown command ${command.type}` };
	}
}
