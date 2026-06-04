/**
 * Unified Gateway command — started via omp gateway or pi-gateway CLI.
 *
 * Manages IM channels, cron scheduler, agent bridge, and heartbeat.
 *
 * All actions are handled inline (no subprocess spawning) to work
 * correctly in both dev and compiled binary modes.
 */

import { Args, Command, Flags, renderCommandHelp } from "@oh-my-pi/pi-utils/cli";
import { initTheme } from "../modes/theme/theme";

const ACTIONS = ["start", "status", "config", "cron", "service", "help"];

export default class Gateway extends Command {
	static description = "Unified gateway: IM channels, cron scheduler, agent bridge";
	static strict = false;
	static args = {
		action: Args.string({
			description: "Gateway action",
			required: false,
			options: ACTIONS,
		}),
	};

	static flags = {
		foreground: Flags.boolean({ description: "Run in foreground (default)" }),
		config: Flags.string({ description: "Path to gateway config file" }),
	};

	static examples = [
		"# Start gateway\n  omp gateway start",
		"# Start with custom config\n  omp gateway start --config /path/to/gateway.json",
		"# Show status\n  omp gateway status",
		"# Schedule a task\n  omp gateway cron create '0 9 * * *' 'bun run daily-report.ts'",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Gateway);
		await initTheme();
		await this.#runGateway(args.action, flags);
	}

	async #runGateway(action: string | undefined, flags: Record<string, unknown>): Promise<void> {
		if (!action) {
			renderCommandHelp("omp", "gateway", Gateway);
			return;
		}

		const configPath = flags.config as string | undefined;

		switch (action) {
			case "start": {
				const { Gateway: GW } = await import("@oh-my-pi/pi-gateway/src/gateway");
				const { loadConfig } = await import("@oh-my-pi/pi-gateway/src/config");
				const config = await loadConfig(configPath);
				const gateway = new GW(config);

				const shutdown = async () => {
					await gateway.stop();
					process.exit(0);
				};
				process.on("SIGINT", shutdown);
				process.on("SIGTERM", shutdown);

				await gateway.start();
				await new Promise(() => {});
				break;
			}
			case "status": {
				const { Gateway: GW } = await import("@oh-my-pi/pi-gateway/src/gateway");
				const { loadConfig } = await import("@oh-my-pi/pi-gateway/src/config");
				const config = await loadConfig(configPath);
				const gateway = new GW(config);
				const status = await gateway.getStatus();
				console.log("Gateway Status:");
				console.log(`  Running: ${status.running}`);
				console.log(`  Channels: ${status.channels.length}`);
				for (const ch of status.channels) {
					console.log(`    - ${ch.name} (${ch.id}): ${ch.connected ? "connected" : "disconnected"}`);
				}
				console.log(`  Active Sessions: ${status.sessions}`);
				console.log(`  Scheduler: ${status.scheduler.running ? `running (${status.scheduler.taskCount} tasks)` : "stopped"}`);
				break;
			}
			case "config": {
				const { loadConfig, getConfigPath } = await import("@oh-my-pi/pi-gateway/src/config");
				const config = await loadConfig(configPath);
				console.log(`Config file: ${getConfigPath()}`);
				console.log(JSON.stringify(config, null, 2));
				break;
			}
			case "cron": {
				await this.#handleCron();
				break;
			}
			case "service": {
				await this.#handleService();
				break;
			}
			case "help":
				renderCommandHelp("omp", "gateway", Gateway);
				break;
			default:
				console.error(`Unknown action: ${action}`);
				process.exitCode = 1;
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// Cron — inline handler (no subprocess spawn)
	// ═══════════════════════════════════════════════════════════════════

	async #handleCron(): Promise<void> {
		const argv = process.argv.slice(process.argv.indexOf("cron") + 1);
		const action = argv[0] ?? "help";

		const {
			SchedulerDbStorage,
			getSchedulerDbPath,
			parseSchedule,
			getNextRun,
			formatTaskRow,
			formatExecutionRow,
			executeScheduledCommand,
			isDaemonRunning,
			getSchedulerPidPath,
		} = await import("@oh-my-pi/pi-gateway/src/scheduler");

		const storage = new SchedulerDbStorage(getSchedulerDbPath());

		try {
			switch (action) {
				case "create":
					await this.#cronCreate(argv.slice(1), storage, parseSchedule, getNextRun);
					break;
				case "list":
					await this.#cronList(storage, formatTaskRow, argv.includes("--json"));
					break;
				case "pause":
				case "disable":
					await this.#cronSetStatus(argv[1], "disabled", storage, getNextRun);
					break;
				case "resume":
				case "enable":
					await this.#cronSetStatus(argv[1], "active", storage, getNextRun);
					break;
				case "run":
					await this.#cronRun(argv[1], storage, executeScheduledCommand);
					break;
				case "remove":
					await this.#cronRemove(argv[1], storage);
					break;
				case "status":
					this.#cronStatus(isDaemonRunning, getSchedulerPidPath);
					break;
				case "diagnose":
					await this.#cronDiagnose(storage, argv.includes("--json"));
					break;
				case "logs":
					await this.#cronLogs(argv[1], storage, formatExecutionRow, argv.includes("--json"));
					break;
				default:
					console.log(`
Cron management commands:
  omp gateway cron create <schedule> <command...> [--name <name>] [--type shell|agent] [--deliver <channel>]
  omp gateway cron list [--json]
  omp gateway cron pause <name>
  omp gateway cron resume <name>
  omp gateway cron run <name>
  omp gateway cron remove <name>
  omp gateway cron status
  omp gateway cron diagnose [--json]
  omp gateway cron logs <name> [--json]
`);
			}
		} finally {
			storage.close();
		}
	}

	async #cronCreate(
		args: string[],
		storage: import("@oh-my-pi/pi-gateway/src/scheduler").SchedulerDbStorage,
		parseSchedule: typeof import("@oh-my-pi/pi-gateway/src/scheduler").parseSchedule,
		getNextRun: typeof import("@oh-my-pi/pi-gateway/src/scheduler").getNextRun,
	): Promise<void> {
		let name: string | undefined;
		let schedule: string | undefined;
		let deliver: string | undefined;
		let type: "shell" | "agent" = "shell";
		const commandParts: string[] = [];

		let i = 0;
		while (i < args.length) {
			if (args[i] === "--name" && args[i + 1]) { name = args[i + 1]!; i += 2; }
			else if (args[i] === "--type" && args[i + 1]) { type = args[i + 1] as "shell" | "agent"; i += 2; }
			else if (args[i] === "--deliver" && args[i + 1]) { deliver = args[i + 1]; i += 2; }
			else {
				if (!schedule) schedule = args[i];
				else commandParts.push(args[i]!);
				i++;
			}
		}

		const command = commandParts.join(" ");
		if (!schedule || !command) {
			console.error("Usage: omp gateway cron create <schedule> <command...> [--name <name>] [--type shell|agent] [--deliver <channel>]");
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

		if (storage.getTaskByName(name)) {
			console.error(`Task "${name}" already exists.`);
			process.exitCode = 1;
			return;
		}

		const nextRun = parsed.type === "cron" ? getNextRun(parsed.schedule) : parsed.nextRunAt ? new Date(parsed.nextRunAt) : undefined;
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
		console.log(`  Type: ${parsed.type} | Schedule: ${parsed.schedule} | Next: ${nextRun ? nextRun.toLocaleString() : "—"}`);
		if (deliver) console.log(`  Delivery: ${deliver}`);
	}

	async #cronList(
		storage: import("@oh-my-pi/pi-gateway/src/scheduler").SchedulerDbStorage,
		formatTaskRow: typeof import("@oh-my-pi/pi-gateway/src/scheduler").formatTaskRow,
		json: boolean,
	): Promise<void> {
		const tasks = storage.listTasks();
		if (json) { console.log(JSON.stringify(tasks, null, 2)); return; }
		if (tasks.length === 0) { console.log("No scheduled tasks."); return; }
		console.log("NAME                 TYPE    STATUS     CRON                 NEXT RUN             LAST RUN");
		console.log("─".repeat(96));
		for (const task of tasks) console.log(formatTaskRow(task));
	}

	async #cronSetStatus(
		name: string,
		status: "active" | "disabled",
		storage: import("@oh-my-pi/pi-gateway/src/scheduler").SchedulerDbStorage,
		getNextRun: typeof import("@oh-my-pi/pi-gateway/src/scheduler").getNextRun,
	): Promise<void> {
		if (!name) { console.error("Usage: omp gateway cron pause|resume <name>"); process.exitCode = 1; return; }
		const task = storage.getTaskByName(name);
		if (!task) { console.error(`Task "${name}" not found.`); process.exitCode = 1; return; }
		storage.updateTask(task.id, {
			status,
			nextRunAt: status === "active" ? getNextRun(task.cron)?.getTime() : undefined,
			updatedAt: Date.now(),
		});
		console.log(`Task "${name}" ${status === "active" ? "resumed" : "paused"}.`);
	}

	async #cronRun(
		name: string,
		storage: import("@oh-my-pi/pi-gateway/src/scheduler").SchedulerDbStorage,
		executeScheduledCommand: typeof import("@oh-my-pi/pi-gateway/src/scheduler").executeScheduledCommand,
	): Promise<void> {
		if (!name) { console.error("Usage: omp gateway cron run <name>"); process.exitCode = 1; return; }
		const task = storage.getTaskByName(name);
		if (!task) { console.error(`Task "${name}" not found.`); process.exitCode = 1; return; }
		const exec = storage.recordExecution({ taskId: task.id, startedAt: Date.now(), status: "running" });
		try {
			const { exitCode, output, stderr } = await executeScheduledCommand(task.command, {
				taskType: task.taskType,
				timeoutMs: task.timeoutMs,
				skills: task.skills,
				preScript: task.preScript,
			});
			storage.updateExecution(exec.id, { endedAt: Date.now(), exitCode, output, stderr, status: exitCode === 0 ? "success" : "failure" });
			storage.updateTask(task.id, { lastRunAt: Date.now(), runCount: task.runCount + 1, failCount: exitCode === 0 ? task.failCount : task.failCount + 1 });
			if (exitCode !== 0) { console.error(`Task "${name}" failed (exit ${exitCode}).`); process.exitCode = exitCode; }
			else console.log(`Task "${name}" completed.`);
		} catch (err) {
			storage.updateExecution(exec.id, { endedAt: Date.now(), exitCode: 1, stderr: String(err), status: "failure" });
			console.error(`Task "${name}" failed: ${err}`);
			process.exitCode = 1;
		}
	}

	async #cronRemove(name: string, storage: import("@oh-my-pi/pi-gateway/src/scheduler").SchedulerDbStorage): Promise<void> {
		if (!name) { console.error("Usage: omp gateway cron remove <name>"); process.exitCode = 1; return; }
		const task = storage.getTaskByName(name);
		if (!task) { console.error(`Task "${name}" not found.`); process.exitCode = 1; return; }
		storage.deleteTask(task.id);
		console.log(`Task "${name}" removed.`);
	}

	#cronStatus(
		isDaemonRunning: typeof import("@oh-my-pi/pi-gateway/src/scheduler").isDaemonRunning,
		getSchedulerPidPath: typeof import("@oh-my-pi/pi-gateway/src/scheduler").getSchedulerPidPath,
	): void {
		const pidPath = getSchedulerPidPath();
		const running = isDaemonRunning(pidPath);
		console.log(`Scheduler: ${running ? "running" : "stopped"}`);
	}

	async #cronDiagnose(storage: import("@oh-my-pi/pi-gateway/src/scheduler").SchedulerDbStorage, json: boolean): Promise<void> {
		const tasks = storage.listTasks();
		const total = tasks.length;
		const active = tasks.filter(t => t.status === "active").length;
		const paused = tasks.filter(t => t.status === "paused").length;
		const disabled = tasks.filter(t => t.status === "disabled").length;
		if (json) { console.log(JSON.stringify({ taskCounts: { total, active, paused, disabled } }, null, 2)); return; }
		console.log("## Scheduler Diagnosis");
		console.log(`Tasks: ${total} total (${active} active, ${paused} paused, ${disabled} disabled)`);
	}

	async #cronLogs(
		name: string,
		storage: import("@oh-my-pi/pi-gateway/src/scheduler").SchedulerDbStorage,
		formatExecutionRow: typeof import("@oh-my-pi/pi-gateway/src/scheduler").formatExecutionRow,
		json: boolean,
	): Promise<void> {
		if (!name) { console.error("Usage: omp gateway cron logs <name>"); process.exitCode = 1; return; }
		const task = storage.getTaskByName(name);
		if (!task) { console.error(`Task "${name}" not found.`); process.exitCode = 1; return; }
		const executions = storage.getExecutions(task.id, 20);
		if (json) { console.log(JSON.stringify(executions, null, 2)); return; }
		if (executions.length === 0) { console.log(`No executions for task "${name}".`); return; }
		console.log("ID                 STATUS   DURATION EXIT");
		console.log("─".repeat(50));
		for (const exec of executions) console.log(formatExecutionRow(exec));
	}

	// ═══════════════════════════════════════════════════════════════════
	// Service — inline handler
	// ═══════════════════════════════════════════════════════════════════

	async #handleService(): Promise<void> {
		const sub = process.argv[process.argv.indexOf("service") + 1];
		const {
			installService,
			uninstallService,
			startService,
			stopService,
			getServiceStatus,
		} = await import("@oh-my-pi/pi-gateway/src/service-installer");

		switch (sub) {
			case "install":
				await installService(import.meta.path);
				console.log("Service installed. Run 'omp gateway service start' to begin.");
				break;
			case "uninstall":
				await uninstallService();
				console.log("Service uninstalled.");
				break;
			case "start":
				await startService();
				console.log("Service started.");
				break;
			case "stop":
				await stopService();
				console.log("Service stopped.");
				break;
			case "status": {
				const status = await getServiceStatus();
				console.log("Service Status:");
				console.log(`  Platform: ${status.platform}`);
				console.log(`  Installed: ${status.installed}`);
				console.log(`  Running: ${status.running}`);
				if (status.pid) console.log(`  PID: ${status.pid}`);
				break;
			}
			default:
				console.log(`
Service management commands:
  omp gateway service install     Install as system service
  omp gateway service uninstall   Remove system service
  omp gateway service start       Start system service
  omp gateway service stop        Stop system service
  omp gateway service status      Show service status
`);
		}
	}
}