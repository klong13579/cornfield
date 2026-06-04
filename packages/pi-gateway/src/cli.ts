/**
 * CLI entry point for the gateway.
 *
 * Usage:
 *   pi-gateway start                    Start the gateway in foreground
 *   pi-gateway status                   Show gateway status
 *   pi-gateway config                   Show resolved configuration
 *   pi-gateway cron create ...          Create a scheduled task
 *   pi-gateway cron list                List all scheduled tasks
 *   pi-gateway cron pause <name>        Pause a task
 *   pi-gateway cron resume <name>       Resume a task
 *   pi-gateway cron run <name>          Trigger a task immediately
 *   pi-gateway cron remove <name>       Delete a task
 *   pi-gateway cron status              Show scheduler status
 *   pi-gateway cron diagnose            Run scheduler diagnostics
 *   pi-gateway cron logs <name>         View task execution logs
 *   pi-gateway service install          Install as system service
 *   pi-gateway service uninstall        Remove system service
 *   pi-gateway service start            Start system service
 *   pi-gateway service stop             Stop system service
 *   pi-gateway service status           Show service status
 */

import { logger } from "@oh-my-pi/pi-utils";
import { getConfigPath, loadConfig } from "./config";
import { Gateway } from "./gateway";
import { executeScheduledCommand } from "./scheduler/executor";
import { SchedulerDbStorage } from "./scheduler/storage";
import {
	formatExecutionRow,
	formatTaskRow,
	getNextRun,
	getSchedulerDbPath,
	getSchedulerPidPath,
	isDaemonRunning,
	parseSchedule,
} from "./scheduler/types";
import { getServiceStatus, installService, startService, stopService, uninstallService } from "./service-installer";

// ═══════════════════════════════════════════════════════════════════════
// CLI Parsing
// ═══════════════════════════════════════════════════════════════════════

function parseArgs(): { command: string; subcommand?: string; args: string[]; config?: string } {
	const argv = process.argv.slice(2);
	const cmd = argv[0] ?? "start";
	const sub = argv[1];
	const extra = argv.slice(2);
	const configIdx = extra.indexOf("--config");
	const c = configIdx >= 0 ? extra[configIdx + 1] : undefined;
	return { command: cmd, subcommand: sub, args: extra, config: c };
}

// ═══════════════════════════════════════════════════════════════════════
// Gateway Commands
// ═══════════════════════════════════════════════════════════════════════

async function cmdStart(_configPath?: string): Promise<void> {
	const config = await loadConfig(_configPath);
	const gateway = new Gateway(config);

	const shutdown = async () => {
		logger.debug("Shutting down...");
		await gateway.stop();
		process.exit(0);
	};

	process.on("SIGTERM", shutdown);

	await gateway.start();

	// CLI 交互模式
	console.log("\n✅ Gateway 已启动！");
	console.log("📝 输入消息直接和 Agent 对话，输入 exit 退出");
	console.log("---".repeat(30));

	const readline = await import("node:readline");
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
		prompt: "> ",
	});

	rl.prompt();

	rl.on("line", async (line) => {
		const text = line.trim();
		if (!text) {
			rl.prompt();
			return;
		}
		if (text === "exit" || text === "quit") {
			rl.close();
			return;
		}

		console.log("\n⏳ 处理中...");
		try {
			const result = await gateway.sendDirectMessage(text);
			if (result) {
				console.log("\n🤖 Agent: " + result);
			} else {
				console.log("\n⚠️ 无响应");
			}
		} catch (e) {
			console.log("\n❌ 错误: " + e);
		}
		console.log("---".repeat(30));
		rl.prompt();
	});

	rl.on("close", async () => {
		console.log("\n\n👋 关闭 Gateway...");
		await gateway.stop();
		process.exit(0);
	});

async function cmdStatus(_configPath?: string): Promise<void> {
	const config = await loadConfig(_configPath);
	const gateway = new Gateway(config);
	const status = await gateway.getStatus();

	console.log("Gateway Status:");
	console.log(`  Running: ${status.running}`);
	console.log(`  Channels: ${status.channels.length}`);
	for (const ch of status.channels) {
		console.log(`    - ${ch.name} (${ch.id}): ${ch.connected ? "connected" : "disconnected"}`);
	}
	console.log(`  Active Sessions: ${status.sessions}`);
	console.log(
		`  Scheduler: ${status.scheduler.running ? `running (${status.scheduler.taskCount} tasks)` : "stopped"}`,
	);
}

async function cmdConfig(_configPath?: string): Promise<void> {
	const cfgPath = _configPath ?? getConfigPath();
	const config = await loadConfig(_configPath);
	console.log(`Config file: ${cfgPath}`);
	console.log(JSON.stringify(config, null, 2));
}

// ═══════════════════════════════════════════════════════════════════════
// Cron Commands
// ═══════════════════════════════════════════════════════════════════════

async function cmdCron(args: string[]): Promise<void> {
	const action = args[0];
	const storage = new SchedulerDbStorage(getSchedulerDbPath());

	try {
		switch (action) {
			case "create":
				await cmdCronCreate(args.slice(1), storage);
				break;
			case "list":
				await cmdCronList(storage, args.includes("--json"));
				break;
			case "pause":
			case "disable":
				await cmdCronSetStatus(args[1], "disabled", storage);
				break;
			case "resume":
			case "enable":
				await cmdCronSetStatus(args[1], "active", storage);
				break;
			case "run":
				await cmdCronRun(args[1], storage);
				break;
			case "remove":
				await cmdCronRemove(args[1], storage);
				break;
			case "status":
				await cmdCronStatus();
				break;
			case "diagnose":
				await cmdCronDiagnose(storage, args.includes("--json"));
				break;
			case "logs":
				await cmdCronLogs(args[1], storage, args.includes("--json"));
				break;
			default:
				console.log(`
Cron management commands:
  pi-gateway cron create <schedule> <command...> [--name <name>] [--type shell|agent] [--deliver <channel>]
  pi-gateway cron list [--json]
  pi-gateway cron pause <name>
  pi-gateway cron resume <name>
  pi-gateway cron run <name>
  pi-gateway cron remove <name>
  pi-gateway cron status
  pi-gateway cron diagnose [--json]
  pi-gateway cron logs <name> [--json]
`);
		}
	} finally {
		storage.close();
	}
}

async function cmdCronCreate(args: string[], storage: SchedulerDbStorage): Promise<void> {
	let name: string | undefined;
	let schedule: string | undefined;
	let deliver: string | undefined;
	let type: "shell" | "agent" = "shell";
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
		} else {
			if (!schedule) {
				schedule = args[i];
			} else {
				commandParts.push(args[i]!);
			}
			i++;
		}
	}

	const command = commandParts.join(" ");
	if (!schedule || !command) {
		console.error(
			"Usage: pi-gateway cron create <schedule> <command...> [--name <name>] [--type shell|agent] [--deliver <channel>]",
		);
		console.error("  Schedule: cron expr, interval (5m, 1h), or one-shot (+30m, ISO timestamp)");
		process.exitCode = 1;
		return;
	}

	if (!name) {
		name = `task_${Date.now()}`;
	}

	const parsed = parseSchedule(schedule);
	if (parsed.error) {
		console.error(`Invalid schedule: ${parsed.error}`);
		process.exitCode = 1;
		return;
	}

	const existing = storage.getTaskByName(name);
	if (existing) {
		console.error(`Task "${name}" already exists.`);
		process.exitCode = 1;
		return;
	}

	const nextRun =
		parsed.type === "cron" ? getNextRun(parsed.schedule) : parsed.nextRunAt ? new Date(parsed.nextRunAt) : undefined;
	storage.addTask({
		name,
		cron: parsed.schedule,
		command,
		scheduleType: parsed.type,
		taskType: type,
		timeoutMs: type === "agent" ? 120_000 : 30_000,
		deliver,
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
	if (deliver) console.log(`  Delivery: ${deliver}`);
}

async function cmdCronList(storage: SchedulerDbStorage, json = false): Promise<void> {
	const tasks = storage.listTasks();
	if (json) {
		console.log(JSON.stringify(tasks, null, 2));
		return;
	}
	if (tasks.length === 0) {
		console.log("No scheduled tasks.");
		return;
	}
	console.log("NAME                 TYPE    STATUS     CRON                 NEXT RUN             LAST RUN");
	console.log("─".repeat(96));
	for (const task of tasks) {
		console.log(formatTaskRow(task));
	}
}

async function cmdCronSetStatus(
	name: string,
	status: "active" | "disabled",
	storage: SchedulerDbStorage,
): Promise<void> {
	if (!name) {
		console.error("Usage: pi-gateway cron pause|resume <name>");
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

async function cmdCronRun(name: string, storage: SchedulerDbStorage): Promise<void> {
	if (!name) {
		console.error("Usage: pi-gateway cron run <name>");
		process.exitCode = 1;
		return;
	}
	const task = storage.getTaskByName(name);
	if (!task) {
		console.error(`Task "${name}" not found.`);
		process.exitCode = 1;
		return;
	}
	const exec = storage.recordExecution({ taskId: task.id, startedAt: Date.now(), status: "running" });
	try {
		const { exitCode, output, stderr } = await executeScheduledCommand(task.command, {
			taskType: task.taskType,
			timeoutMs: task.timeoutMs,
			skills: task.skills,
			preScript: task.preScript,
		});
		storage.updateExecution(exec.id, {
			endedAt: Date.now(),
			exitCode,
			output,
			stderr,
			status: exitCode === 0 ? "success" : "failure",
		});
		storage.updateTask(task.id, {
			lastRunAt: Date.now(),
			runCount: task.runCount + 1,
			failCount: exitCode === 0 ? task.failCount : task.failCount + 1,
		});
		if (exitCode !== 0) {
			console.error(`Task "${name}" failed (exit ${exitCode}).`);
			process.exitCode = exitCode;
		} else {
			console.log(`Task "${name}" completed.`);
		}
	} catch (err) {
		storage.updateExecution(exec.id, { endedAt: Date.now(), exitCode: 1, stderr: String(err), status: "failure" });
		console.error(`Task "${name}" failed: ${err}`);
		process.exitCode = 1;
	}
}

async function cmdCronRemove(name: string, storage: SchedulerDbStorage): Promise<void> {
	if (!name) {
		console.error("Usage: pi-gateway cron remove <name>");
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

async function cmdCronStatus(): Promise<void> {
	const pidPath = getSchedulerPidPath();
	const running = isDaemonRunning(pidPath);
	console.log(`Scheduler: ${running ? "running" : "stopped"}`);
	if (running) {
		const fs = await import("node:fs");
		try {
			const pid = Number.parseInt(fs.readFileSync(pidPath, "utf8").trim(), 10);
			console.log(`  PID: ${pid}`);
		} catch {
			/* ignore */
		}
	}
}

async function cmdCronDiagnose(storage: SchedulerDbStorage, json = false): Promise<void> {
	const tasks = storage.listTasks();
	const total = tasks.length;
	const active = tasks.filter(t => t.status === "active").length;
	const paused = tasks.filter(t => t.status === "paused").length;
	const disabled = tasks.filter(t => t.status === "disabled").length;
	const pidPath = getSchedulerPidPath();
	const daemonRunning = isDaemonRunning(pidPath);

	if (json) {
		console.log(JSON.stringify({ daemonRunning, taskCounts: { total, active, paused, disabled } }, null, 2));
		return;
	}
	console.log(`## Scheduler Diagnosis`);
	console.log(`Daemon: ${daemonRunning ? "running" : "stopped"}`);
	console.log(`Tasks: ${total} total (${active} active, ${paused} paused, ${disabled} disabled)`);
}

async function cmdCronLogs(name: string, storage: SchedulerDbStorage, json = false): Promise<void> {
	if (!name) {
		console.error("Usage: pi-gateway cron logs <name>");
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
	for (const exec of executions) {
		console.log(formatExecutionRow(exec));
	}
}

// ═══════════════════════════════════════════════════════════════════════
// Service Commands
// ═══════════════════════════════════════════════════════════════════════

async function cmdServiceInstall(): Promise<void> {
	const cliPath = import.meta.path;
	await installService(cliPath);
	console.log("Service installed. Run 'pi-gateway service start' to begin.");
}

async function cmdServiceUninstall(): Promise<void> {
	await uninstallService();
	console.log("Service uninstalled.");
}

async function cmdServiceStart(): Promise<void> {
	await startService();
	console.log("Service started.");
}

async function cmdServiceStop(): Promise<void> {
	await stopService();
	console.log("Service stopped.");
}

async function cmdServiceStatus(): Promise<void> {
	const status = await getServiceStatus();
	console.log("Service Status:");
	console.log(`  Platform: ${status.platform}`);
	console.log(`  Installed: ${status.installed}`);
	console.log(`  Running: ${status.running}`);
	if (status.pid) console.log(`  PID: ${status.pid}`);
}

async function cmdService(subcommand?: string): Promise<void> {
	switch (subcommand) {
		case "install":
			await cmdServiceInstall();
			break;
		case "uninstall":
			await cmdServiceUninstall();
			break;
		case "start":
			await cmdServiceStart();
			break;
		case "stop":
			await cmdServiceStop();
			break;
		case "status":
			await cmdServiceStatus();
			break;
		default:
			console.log(`
Service management commands:
  pi-gateway service install     Install as system service
  pi-gateway service uninstall   Remove system service
  pi-gateway service start       Start system service
  pi-gateway service stop        Stop system service
  pi-gateway service status      Show service status
`);
	}
}

// ═══════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════

const parsedArgs = parseArgs();
const command = parsedArgs.command;
const subcommand = parsedArgs.subcommand;
const args = parsedArgs.args;
const gatewayConfigPath = parsedArgs.config;
switch (command) {
	case "start":
		await cmdStart(gatewayConfigPath);
		break;
	case "status":
		await cmdStatus(gatewayConfigPath);
		break;
	case "config":
		await cmdConfig(gatewayConfigPath);
		break;
	case "cron":
		await cmdCron([subcommand ?? "help", ...args]);
		break;
	case "service":
		await cmdService(subcommand);
		break;
	case "help":
	case "--help":
	case "-h":
		console.log(`
pi-gateway — Unified Gateway for Oh My Pi

Usage:
  pi-gateway start [--config <path>]              Start gateway in foreground
  pi-gateway status [--config <path>]             Show gateway status
  pi-gateway config [--config <path>]             Show resolved configuration
  pi-gateway cron create <schedule> <cmd...>       Create a scheduled task
  pi-gateway cron list [--json]                    List all tasks
  pi-gateway cron pause <name>                     Pause a task
  pi-gateway cron resume <name>                    Resume a task
  pi-gateway cron run <name>                       Trigger a task now
  pi-gateway cron remove <name>                    Delete a task
  pi-gateway cron status                           Show scheduler status
  pi-gateway cron diagnose [--json]                Run diagnostics
  pi-gateway cron logs <name> [--json]             View execution logs
  pi-gateway service install                       Install as system service
  pi-gateway service uninstall                     Remove system service
  pi-gateway service start                         Start system service
  pi-gateway service stop                          Stop system service
  pi-gateway service status                        Show service status
  pi-gateway help                                  Show this help

Config file: ~/.pi/gateway.json
`);
		break;
	default:
		console.error(`Unknown command: ${command}`);
		console.log("Run 'pi-gateway help' for usage");
		process.exit(1);
}
