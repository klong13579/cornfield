/**
 * Gateway wire endpoint core（P2-4）——传输无关的 gateway 领域命令处理。
 *
 * 接收 wire 命令（cron CRUD / gateway_status），直接回答 gateway 自己的领域
 * （调度器 storage + 进程内状态），不再让 serve 侧直读 jobs.json/status.json。
 *
 * 与传输形态解耦：HTTP POST / WS / serve 转发都调 `handleGatewayWireCommand`。
 * 形态拍板后只加传输层（见 plan P2-4 三选项）。
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { SchedulerStorage, ScheduledTask } from "./scheduler/types";
import { runTestRun } from "./scheduler/test-run";


export interface GatewayWireDeps {
	storage: SchedulerStorage;
	/** scheduler reload 触发（test-run 用；gateway 启动时装配）。 */
	reloadScheduler?: () => Promise<void> | void;
	/** gateway 进程内状态（status.json 的权威源）。 */
	gatewayStatus: () => {
		pid: number;
		statusWrittenAt: number;
		accounts: Array<{ accountId: string; agentDir: string; running: boolean }>;
		scheduler: { running: boolean; taskCount: number };
	};
}

export type GatewayWireResult = { ok: true; result: unknown } | { ok: false; error: string };

/** wire 命令 → gateway 领域。返回统一结果形状（传输层包帧）。 */
export async function handleGatewayWireCommand(
	command: { type: string; [key: string]: unknown },
	deps: GatewayWireDeps,
): Promise<GatewayWireResult> {
	const { storage, gatewayStatus } = deps;

	switch (command.type) {
		case "get_cron_tasks": {
			const tasks = storage.listTasks();
			return {
				ok: true,
				result: {
					tasks: tasks.map(task => ({
						id: task.id,
						name: task.name,
						cron: task.cron,
						status: task.status,
						taskType: task.taskType ?? "shell",
						scheduleType: task.scheduleType ?? "cron",
						description: task.description,
						command: task.command,
						model: task.model,
						provider: task.provider,
						enabledToolsets: task.enabledToolsets,
						timeoutMs: task.timeoutMs,
						repeatCount: task.repeatCount,
						repeatCompleted: task.repeatCompleted,
						skills: task.skills,
						preScript: task.preScript,
						createdAt: task.createdAt,
					})),
				},
			};
		}

		case "get_cron_logs": {
			const taskId = typeof command.taskId === "string" ? command.taskId : undefined;
			const days = typeof command.days === "number" ? Math.min(30, Math.max(1, command.days)) : 3;
			const limit = typeof command.limit === "number" ? Math.min(200, Math.max(1, command.limit)) : 50;
			const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
			const targetTask = taskId ? storage.getTask(taskId) : undefined;
			const executions = storage.getRecentExecutions({ limit, sinceMs: cutoff }).filter(exec =>
				(targetTask ? exec.taskId === targetTask.id : true),
			);
			return {
				ok: true,
				result: {
					logs: executions.map(exec => ({
						taskId: exec.taskId,
						taskName: "taskName" in exec ? exec.taskName : targetTask?.name,
						startedAt: exec.startedAt,
						finishedAt: exec.endedAt,
						status: exec.status,
						output: exec.output,
						error: exec.stderr,
						exitCode: exec.exitCode,
						agentSessionPath: exec.agentSessionPath,
					})),
				},
			};
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
				enabledToolsets: Array.isArray(command.enabledToolsets)
					? (command.enabledToolsets as string[])
					: undefined,
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
			return { ok: true, result: gatewayStatus() };
		}

		default:
			return { ok: false, error: `gateway wire: unknown command ${command.type}` };
	}
}