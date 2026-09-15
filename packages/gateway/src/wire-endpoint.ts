/**
 * Gateway wire endpoint core（P2-4；T10C 补调度写面与 Agent 绑定）——传输无关的 gateway 领域命令处理。
 *
 * 接收 wire 命令（cron CRUD / get_cron_tasks / get_cron_logs / gateway_status），
 * 直接回答 gateway 自己的领域（调度器 storage + 进程内状态），不再让 serve 侧
 * 直读 jobs.json/status.json（serve 改为转发 POST /wire）。
 *
 * 与传输形态解耦：HTTP POST / WS / serve 转发都调 `handleGatewayWireCommand`。
 *
 * 形状契约：返回形状是 pi-wire 的 TaskRowDto / CronLogEntryDto / GatewayStatusDto；
 * cron_create / cron_update / cron_remove / cron_test_run 是写面（见 `../pi-wire/src/results/cron.ts`）。
 *
 * ## T10C：写面落盘的是**解析后的** Agent 身份
 *
 * `agentId` 在创建/改绑时由 {@link resolveScheduleAgentForWrite} 解析并持久化（同时落 agentDir），
 * 到点执行按存下来的身份走，不读 UI 当前选中（`docs/client/agent-hub.md` §1.7/§1.10）。
 * 解析不到 → `ok:false`，不写一条跑不起来的 Schedule。
 */

import type { AgentDirectoryEntry } from "@cornfield/coding-agent/agent-domain/agent-directory";
import { logger } from "@cornfield/utils";
import type {
	CronLogEntryDto,
	CronRemoveResultDto,
	CronTaskWriteResultDto,
	CronTestRunResultDto,
	TaskDeliveryDto,
	TaskRetryDto,
	TaskRowDto,
} from "@cornfield/wire";
import {
	resolveScheduleAgentBinding,
	resolveScheduleAgentForWrite,
	type ScheduleAgentBinding,
	type ScheduleAgentWrite,
} from "./scheduler/agent-binding";
import { runTestRun } from "./scheduler/test-run";
import type { ScheduledTask, SchedulerStorage, TaskExecution } from "./scheduler/types";

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
	/** Registered Agent this account speaks for (registry key). */
	agentId?: string;
	agentDir?: string;
	deniedTools?: string[];
	hideThinkingBlock?: boolean;
}

export interface GatewayWireDeps {
	storage: SchedulerStorage;
	/** scheduler reload 触发（写面改完调度定义/绑定后重排；gateway 启动时装配）。 */
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
	/**
	 * 测试注入：Agent 注册目录（registry + workspace 声明的读模型）。
	 *
	 * 注入的是**世界**而不是**规则**：绑定三态（registered / unregistered / unbound）的判断只有
	 * `resolveScheduleAgentBinding` 一份，测试换掉注册表内容，不换解析语义 —— 否则单测与生产
	 * 可能对「unbound 是什么」有不同理解，而写面据此误报一个运行面并不认的状态。
	 */
	loadAgentDirectory?: () => Promise<AgentDirectoryEntry[]>;
}

/** 群信息（gateway sessions.db 中 isGroup=true 的记录）。 */
export interface GatewayGroupInfo {
	channelId: string;
	title: string;
	conversationId: string;
	lastActive: number;
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
		groups?: GatewayGroupInfo[];
	}>;
	scheduler: { running?: boolean; taskCount?: number } | null;
}

export type GatewayWireResult = { ok: true; result: unknown } | { ok: false; error: string };

/**
 * ScheduledTask → web-app TaskRowDto。
 *
 * `accountId` 按**原样**透出（`task.accountId`）：旧实现写成 `task.accountId ?? task.agentDir`
 * 把 agentDir 冒充成 accountId，读的人没法区分「这是个通道账号」还是「这是个目录」。
 * 绑定事实全部由 `agentId` / `agentDir` / `agentResolution` / `agentEnabled` / `agentError` 表达。
 */
function toTaskRowDto(task: ScheduledTask, binding: ScheduleAgentBinding): TaskRowDto {
	const row: TaskRowDto = {
		id: task.id,
		name: task.name,
		status: task.status,
		scheduleType: task.scheduleType ?? "cron",
		cron: task.cron,
		command: task.command,
		enabled: task.status !== "disabled",
		runCount: task.runCount,
		failCount: task.failCount,
		consecutiveFailures: task.consecutiveFailures,
		agentResolution: binding.resolution,
		createdAt: task.createdAt,
		updatedAt: task.updatedAt,
	};
	if (task.description !== undefined) row.description = task.description;
	if (task.nextRunAt !== undefined) row.nextRunAt = task.nextRunAt;
	if (task.lastRunAt !== undefined) row.lastRunAt = task.lastRunAt;
	if (task.accountId !== undefined) row.accountId = task.accountId;
	if (binding.agentId !== undefined) row.agentId = binding.agentId;
	if (binding.agentDir !== undefined) row.agentDir = binding.agentDir;
	if (binding.displayName !== undefined) row.agentDisplayName = binding.displayName;
	if (binding.enabled !== undefined) row.agentEnabled = binding.enabled;
	if (binding.projectIds !== undefined) row.projectIds = binding.projectIds;
	if (binding.error !== undefined) row.agentError = binding.error;
	if (task.taskType !== undefined) row.taskType = task.taskType;
	if (task.timeoutMs !== undefined) row.timeoutMs = task.timeoutMs;
	if (task.retry !== undefined) row.retry = task.retry;
	if (task.repeatCount !== undefined) row.repeatCount = task.repeatCount;
	if (task.repeatCompleted !== undefined) row.repeatCompleted = task.repeatCompleted;
	if (task.delivery !== undefined) row.delivery = task.delivery;
	if (task.lastDeliveryError !== undefined) row.lastDeliveryError = task.lastDeliveryError;
	return row;
}

/** 行 + 绑定解析（读面统一出口：写面与 get_cron_tasks 用同一条路径生成行）。 */
async function toTaskRowDtoResolved(
	task: ScheduledTask,
	loadEntries: GatewayWireDeps["loadAgentDirectory"],
): Promise<TaskRowDto> {
	const binding = await resolveScheduleAgentBinding(task, loadEntries);
	return toTaskRowDto(task, binding);
}

function truncateLog(s: string | undefined): { text?: string; truncated?: boolean } {
	if (s === undefined) return {};
	const truncated = s.length > CRON_LOG_MAX_OUTPUT;
	return { text: s.slice(0, CRON_LOG_MAX_OUTPUT), truncated };
}

/** 执行记录 → wire 日志行（含 agentSessionPath：Session scope 的权威链接）。 */
function toLogEntryDto(exec: TaskExecution): CronLogEntryDto {
	const out = truncateLog(exec.output);
	const err = truncateLog(exec.stderr);
	const entry: CronLogEntryDto = {
		taskId: exec.taskId,
		id: exec.id,
		ts: exec.startedAt,
		status: exec.status,
		exitCode: exec.exitCode ?? null,
		durationMs: exec.endedAt != null ? exec.endedAt - exec.startedAt : null,
	};
	if (out.text !== undefined) entry.output = out.text;
	if (out.truncated !== undefined) entry.outputTruncated = out.truncated;
	if (err.text !== undefined) entry.stderr = err.text;
	if (exec.agentSessionPath !== undefined) entry.agentSessionPath = exec.agentSessionPath;
	return entry;
}

// ── wire 载荷消毒 ────────────────────────────────────────────────────────────
// wire 命令来自进程外（serve 转发 / 浏览器直连），每个字段都是 untrusted。逐字段收窄，而不是把
// `{[key: string]: unknown}` 硬 cast 成命令类型：cast 会让「字段存在但类型错」静默通过，
// 于是一个 `timeoutMs: "5m"` 会被当成合法输入写进调度定义。

function str(v: unknown): string | undefined {
	return typeof v === "string" ? v : undefined;
}

function num(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function strArray(v: unknown): string[] | undefined {
	return Array.isArray(v) && v.every(x => typeof x === "string") ? (v as string[]) : undefined;
}

function statusOf(v: unknown): ScheduledTask["status"] | undefined {
	return v === "active" || v === "paused" || v === "disabled" ? v : undefined;
}

function scheduleTypeOf(v: unknown): "cron" | "interval" | "once" | undefined {
	return v === "cron" || v === "interval" || v === "once" ? v : undefined;
}

function retryOf(v: unknown): TaskRetryDto | undefined {
	if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
	const raw = v as Record<string, unknown>;
	const maxAttempts = num(raw.maxAttempts);
	const backoffMs = Array.isArray(raw.backoffMs)
		? (raw.backoffMs as unknown[]).filter((n): n is number => typeof n === "number" && Number.isFinite(n))
		: undefined;
	if (maxAttempts === undefined || backoffMs === undefined) return undefined;
	const retryOn = strArray(raw.retryOn);
	return retryOn ? { maxAttempts, backoffMs, retryOn } : { maxAttempts, backoffMs };
}

function deliveryOf(v: unknown): TaskDeliveryDto | undefined {
	if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
	const raw = v as Record<string, unknown>;
	const channel = str(raw.channel);
	const mode = raw.mode === "announce" || raw.mode === "none" ? raw.mode : undefined;
	if (!channel || !mode) return undefined;
	const delivery: TaskDeliveryDto = { channel, mode };
	const accountId = str(raw.accountId);
	const toUserId = str(raw.toUserId);
	const toConversationId = str(raw.toConversationId);
	if (accountId) delivery.accountId = accountId;
	if (toUserId) delivery.toUserId = toUserId;
	if (toConversationId) delivery.toConversationId = toConversationId;
	return delivery;
}

/** wire 命令 → gateway 领域。返回统一结果形状（传输层包帧）。 */
export async function handleGatewayWireCommand(
	command: { type: string; [key: string]: unknown },
	deps: GatewayWireDeps,
): Promise<GatewayWireResult> {
	const { storage } = deps;
	const loadEntries = deps.loadAgentDirectory;
	/** 读/写两条路径共用同一条绑定规则，只有注册表来源可换。 */
	const resolveBinding = (ref: { agentId?: string; agentDir?: string; accountId?: string }) =>
		resolveScheduleAgentBinding(ref, loadEntries);

	switch (command.type) {
		case "get_cron_tasks": {
			const tasks = await Promise.all(storage.listTasks().map(task => toTaskRowDtoResolved(task, loadEntries)));
			return { ok: true, result: { tasks } };
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
			return { ok: true, result: { logs: executions.map(toLogEntryDto) } };
		}

		case "cron_create": {
			const name = str(command.name)?.trim() ?? "";
			const cron = str(command.cron)?.trim() ?? "";
			const rawCommand = str(command.command) ?? "";
			if (!name || !cron || !rawCommand) {
				return { ok: false, error: "cron_create requires name, cron, command" };
			}
			if (storage.getTaskByName(name)) {
				return { ok: false, error: `task already exists: ${name}` };
			}
			const createId = str(command.agentId);
			const createDir = str(command.agentDir);
			// create 总是显式的：给了字段就解析（两个都给必须一致），什么都没给 = 明确不绑。
			// 「不绑」是合法状态（行上报 unbound、运行面拒绝执行），而不是错误 —— 但也不允许
			// 把一个含糊的空 bind 交给解析器去猜。
			const createWrite: ScheduleAgentWrite =
				createId !== undefined || createDir !== undefined
					? { kind: "bind", agentId: createId, agentDir: createDir }
					: { kind: "unbind" };
			const resolved = await resolveScheduleAgentForWrite(createWrite, loadEntries);
			if (!resolved.ok) return { ok: false, error: resolved.error };
			const binding = resolved.binding;

			const task = storage.addTask({
				name,
				cron,
				command: rawCommand,
				status: command.status === "paused" ? "paused" : "active",
				taskType: command.taskType === "agent" ? "agent" : "shell",
				scheduleType: scheduleTypeOf(command.scheduleType) ?? "cron",
				// Resolved identity, persisted: a firing schedule must not depend on the
				// reader's selected Agent, nor on the registry being readable at fire time.
				agentId: binding.agentId,
				agentDir: binding.agentDir,
				description: str(command.description),
				model: str(command.model),
				provider: str(command.provider),
				enabledToolsets: strArray(command.enabledToolsets),
				timeoutMs: num(command.timeoutMs),
				repeatCount: num(command.repeatCount),
				retry: retryOf(command.retry),
				skills: strArray(command.skills),
				preScript: str(command.preScript),
				delivery: deliveryOf(command.delivery),
				consecutiveFailures: 0,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				runCount: 0,
				failCount: 0,
			});
			await notifyScheduleChanged(deps);
			const result: CronTaskWriteResultDto = { task: await toTaskRowDtoResolved(task, loadEntries) };
			return { ok: true, result };
		}

		case "cron_update": {
			const taskId = str(command.taskId) ?? "";
			const existing = taskId ? storage.getTask(taskId) : undefined;
			if (!existing) {
				return { ok: false, error: `unknown task: ${taskId}` };
			}
			const updates: Partial<ScheduledTask> = {};
			const name = str(command.name)?.trim();
			if (name) updates.name = name;
			if (str(command.cron) !== undefined) updates.cron = str(command.cron);
			if (str(command.command) !== undefined) updates.command = str(command.command);
			const status = statusOf(command.status);
			if (status) updates.status = status;
			if (str(command.description) !== undefined) updates.description = str(command.description);
			if (command.taskType === "shell" || command.taskType === "agent") updates.taskType = command.taskType;
			if (str(command.model) !== undefined) updates.model = str(command.model);
			if (str(command.provider) !== undefined) updates.provider = str(command.provider);
			if (num(command.timeoutMs) !== undefined) updates.timeoutMs = num(command.timeoutMs);
			if (num(command.repeatCount) !== undefined) updates.repeatCount = num(command.repeatCount);
			if (strArray(command.enabledToolsets) !== undefined)
				updates.enabledToolsets = strArray(command.enabledToolsets);
			if (strArray(command.skills) !== undefined) updates.skills = strArray(command.skills);
			if (str(command.preScript) !== undefined) updates.preScript = str(command.preScript);
			const retry = retryOf(command.retry);
			if (retry) updates.retry = retry;
			const delivery = deliveryOf(command.delivery);
			if (delivery) updates.delivery = delivery;

			// 改绑就是一次声明式的写入：传了什么就是什么。**不**与旧行合并 ——
			// 「只给了 agentDir」意味着整个绑定改成那个目录（identity 随之重算或被清掉），
			// 否则旧 agentId 会粘在一个新 home 上。三个意图显式分开：不给=不动，unbind=清空，给了=绑定。
			const rebindId = str(command.agentId);
			const rebindDir = str(command.agentDir);
			const unbind = command.unbind === true;
			const write: ScheduleAgentWrite = unbind
				? { kind: "unbind" }
				: rebindId !== undefined || rebindDir !== undefined
					? { kind: "bind", agentId: rebindId, agentDir: rebindDir }
					: { kind: "keep" };
			if (unbind && (rebindId !== undefined || rebindDir !== undefined)) {
				return { ok: false, error: "unbind 与 agentId/agentDir 互斥：要么清空绑定，要么绑到某个 Agent。" };
			}
			if (write.kind !== "keep") {
				const resolved = await resolveScheduleAgentForWrite(write, loadEntries);
				if (!resolved.ok) return { ok: false, error: resolved.error };
				// undefined 即“清掉”：两个存储实现都会把它写成 null/删键（JSON 掉 undefined、SQLite 写 NULL）。
				updates.agentId = resolved.binding.agentId;
				updates.agentDir = resolved.binding.agentDir;
				// 废弃字段 `accountId` 是**执行 home 的回退来源**（resolveScheduleAgentBinding 会在
				// agentDir/agentId 都空时拿它当目录）。绑定被重写时不清它，旧 home 就会在下次
				// unbind 之后“活回来”：unbind 看似清空了，行实际仍指向旧账号。所以现代改绑与清空
				// 一并把废弃字段清掉——legacy 行只有在没被改写过时才靠它执行。
				updates.accountId = undefined;
			}

			storage.updateTask(taskId, updates);
			await notifyScheduleChanged(deps);
			const updated = storage.getTask(taskId)!;
			const result: CronTaskWriteResultDto = { task: await toTaskRowDtoResolved(updated, loadEntries) };
			return { ok: true, result };
		}

		case "cron_remove": {
			const taskId = str(command.taskId) ?? "";
			const task = taskId ? storage.getTask(taskId) : undefined;
			if (!task) {
				return { ok: false, error: `unknown task: ${taskId}` };
			}
			storage.deleteTask(taskId);
			await notifyScheduleChanged(deps);
			const result: CronRemoveResultDto = { removed: task.name };
			return { ok: true, result };
		}

		case "cron_test_run": {
			const name = str(command.name) ?? "";
			const target = name ? storage.getTaskByName(name) : undefined;
			if (!target) {
				return { ok: false, error: `unknown task: ${name}` };
			}
			// A test-run is still a run: it must not be armed for a task that cannot execute
			// (no resolvable binding) — otherwise the operator waits for a timeout instead of
			// reading the real reason.
			const binding = await resolveBinding(target);
			if (binding.resolution !== "registered" || binding.error !== undefined) {
				return { ok: false, error: binding.error ?? "调度没有可用的 Agent 绑定，test-run 不会触发。" };
			}
			try {
				const started = await runTestRun({
					name,
					inMs: num(command.inMs),
					storage,
					markerBaseDir: storage.getMarkerBaseDir(),
					origin: { sessionPath: "wire" },
					reloadScheduler: () => {
						void deps.reloadScheduler?.();
					},
				});
				if (started.kind !== "started") {
					return { ok: false, error: `test-run rejected: ${started.kind}` };
				}
				const result: CronTestRunResultDto = {
					kind: "started",
					name: started.name,
					inMs: started.inMs,
					expiresAt: started.expiresAt,
					startedAt: started.startedAt,
				};
				return { ok: true, result };
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
				"agentId",
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

/** 写面绑定解析：使用注入的解析器（测试）时，把「解析不到」也判成失败——
 * 注入不该改变写面的验收条件，只改变它的输入来源。
 */ /** 调度定义变了：让 engine 重排（未装配 reload 时只是没有热重排，不是失败）。 */
async function notifyScheduleChanged(deps: GatewayWireDeps): Promise<void> {
	if (!deps.reloadScheduler) return;
	try {
		await deps.reloadScheduler();
	} catch (err) {
		logger.warn("wire:cron write applied but scheduler reload failed", { error: String(err) });
	}
}

/** 读面用：任务名（未知任务返回 undefined，调用方自己决定语义）。 */
