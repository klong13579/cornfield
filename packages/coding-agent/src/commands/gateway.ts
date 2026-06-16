/**
 * Find the OMP agent session JSONL created during a specific time window.
 *
 * OMP writes agent session files to
 *   `~/.omp/agent/sessions/<encoded-cwd>/<timestamp>_<id>.jsonl`
 * where the ISO timestamp prefix is the immutable creation time of the
 * session (e.g. `2026-06-15T09-18-46-865Z_019eca93-...jsonl`).
 *
 * Why filename-based, not mtime: OMP frequently touches mtime on existing
 * session files (compaction, `--continue`, etc.), so mtime-based filtering
 * produces false positives linking to the wrong (older) session.
 *
 * To stay decoupled from OMP's cwd-encoding scheme, we scan ALL session
 * subdirectories and pick the file whose filename timestamp is closest
 * to (and >= startedAt - tolerance) within the window.
 */
function findAgentSessionPath(startedAt: number, endedAt: number): string | undefined {
	const os = require("node:os") as typeof import("node:os");
	const path = require("node:path") as typeof import("node:path");
	const fs = require("node:fs") as typeof import("node:fs");

	const sessionsRoot = path.join(os.homedir(), ".omp", "agent", "sessions");
	if (!fs.existsSync(sessionsRoot)) return undefined;

	// 2026-06-15T09-18-46-865Z (ISO basic format, dashes between time fields)
	const FILENAME_TS = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_/;
	const toleranceMs = 5_000; // 容忍启动/创建间 5s 偏差

	let bestMatch: { path: string; score: number } | undefined;
	try {
		for (const dirEnt of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
			if (!dirEnt.isDirectory()) continue;
			const dir = path.join(sessionsRoot, dirEnt.name);
			for (const entry of fs.readdirSync(dir)) {
				if (!entry.endsWith(".jsonl")) continue;
				const m = FILENAME_TS.exec(entry);
				if (!m) continue;
				// 重组成标准 ISO 让 Date.parse 吃
				const iso = `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`;
				const createdAt = Date.parse(iso);
				if (!Number.isFinite(createdAt)) continue;
				if (createdAt < startedAt - toleranceMs) continue;
				if (createdAt > endedAt + toleranceMs) continue;
				const score = Math.abs(createdAt - startedAt);
				if (!bestMatch || score < bestMatch.score) {
					bestMatch = { path: path.join(dir, entry), score };
				}
			}
		}
	} catch {
		return undefined;
	}
	return bestMatch?.path;
}

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

const ACTIONS = ["start", "stop", "status", "config", "cron", "service", "help"];

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
		"# Stop gateway\n  omp gateway stop",
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
			case "stop": {
				const { stopGatewayDaemon } = await import("@oh-my-pi/pi-gateway/src/gateway");
				const stopped = await stopGatewayDaemon();
				if (stopped) {
					console.log("Gateway stopped.");
				} else {
					console.log("Gateway is not running.");
				}
				break;
			}
			case "status": {
				const { getGatewayStatus } = await import("@oh-my-pi/pi-gateway/src/gateway");
				const { loadConfig, getConfigPath } = await import("@oh-my-pi/pi-gateway/src/config");
				const config = await loadConfig(configPath);
				const status = await getGatewayStatus();

				console.log("Gateway Status:");
				console.log(`  Running: ${status.running}`);
				if (status.running) {
					console.log(`  PID: ${status.pid}`);
					console.log(`  Started: ${status.startedAt}`);
				} else if (status.stalePidFile) {
					console.log(`  (stale PID file removed)`);
				}
				console.log(`  Config: ${getConfigPath()}`);
				const channels = Object.keys(config.channels ?? {});
				if (channels.length > 0) {
					console.log(`  Configured channels: ${channels.join(", ")}`);
				}
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
  omp gateway cron create <schedule> <command...> [--name <name>] [--type shell|agent] [--deliver <channel>] [--timeout-ms <ms>] [--skills <s1,s2,...>] [--retry <maxAttempts>] [--pre-script <path>]
  omp gateway cron list [--json]
  omp gateway cron pause <name>
  omp gateway cron resume <name>
  omp gateway cron run <name>
  omp gateway cron remove <name>
  omp gateway cron status
  omp gateway cron diagnose [--json]
  omp gateway cron logs <name> [--json]
`);
					break;
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
		let timeoutMs: number | undefined;
		let skills: string[] | undefined;
		let retryMaxAttempts: number | undefined;
		let preScript: string | undefined;
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
				"Usage: omp gateway cron create <schedule> <command...> [--name <name>] [--type shell|agent] [--deliver <channel>] [--timeout-ms <ms>] [--skills <s1,s2,...>] [--retry <maxAttempts>] [--pre-script <path>]",
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

		if (storage.getTaskByName(name)) {
			console.error(`Task "${name}" already exists.`);
			process.exitCode = 1;
			return;
		}

		const nextRun =
			parsed.type === "cron"
				? getNextRun(parsed.schedule)
				: parsed.nextRunAt
					? new Date(parsed.nextRunAt)
					: undefined;
		storage.addTask({
			name,
			cron: parsed.schedule,
			command,
			scheduleType: parsed.type,
			taskType: type,
			timeoutMs: timeoutMs ?? (type === "agent" ? 120_000 : 30_000),
			retry:
				retryMaxAttempts !== undefined
					? { maxAttempts: retryMaxAttempts, backoffMs: [1000, 5000, 30000] }
					: undefined,
			skills,
			preScript,
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
		if (timeoutMs !== undefined) console.log(`  Timeout: ${timeoutMs}ms`);
		if (skills) console.log(`  Skills: ${skills.join(", ")}`);
		if (retryMaxAttempts !== undefined) console.log(`  Retry: max ${retryMaxAttempts} attempts (backoff 1s/5s/30s)`);
		if (preScript) console.log(`  Pre-script: ${preScript}`);
	}

	async #cronList(
		storage: import("@oh-my-pi/pi-gateway/src/scheduler").SchedulerDbStorage,
		formatTaskRow: typeof import("@oh-my-pi/pi-gateway/src/scheduler").formatTaskRow,
		json: boolean,
	): Promise<void> {
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
		for (const task of tasks) console.log(formatTaskRow(task));
	}

	async #cronSetStatus(
		name: string,
		status: "active" | "disabled",
		storage: import("@oh-my-pi/pi-gateway/src/scheduler").SchedulerDbStorage,
		getNextRun: typeof import("@oh-my-pi/pi-gateway/src/scheduler").getNextRun,
	): Promise<void> {
		if (!name) {
			console.error("Usage: omp gateway cron pause|resume <name>");
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

	async #cronRun(
		name: string,
		storage: import("@oh-my-pi/pi-gateway/src/scheduler").SchedulerDbStorage,
		executeScheduledCommand: typeof import("@oh-my-pi/pi-gateway/src/scheduler").executeScheduledCommand,
	): Promise<void> {
		if (!name) {
			console.error("Usage: omp gateway cron run <name>");
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
			const { exitCode, output, stderr } = await executeScheduledCommand(task.command, {
				taskType: task.taskType,
				timeoutMs: task.timeoutMs,
				skills: task.skills,
				preScript: task.preScript,
			});
			const endedAt = Date.now();
			const durationMs = endedAt - startedAt;
			const status = exitCode === 0 ? "success" : "failure";

			// G7: agent task → 找本次 run 创建的 OMP session JSONL
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

			// G1: 写 logs/<name>.jsonl 完整 stdout/stderr（不只 SQLite 末段）
			try {
				const { appendExecutionLog } = await import("@oh-my-pi/pi-gateway/src/scheduler/execution-log");
				appendExecutionLog(task.name, {
					id: exec.id,
					ts: endedAt,
					exitCode,
					status,
					durationMs,
					output,
					stderr,
				});
			} catch (logErr) {
				console.error(`[warn] failed to append execution log: ${logErr}`);
			}

			if (agentSessionPath) {
				console.log(`[trace] agent session: ${agentSessionPath}`);
			}

			if (exitCode !== 0) {
				console.error(`Task "${name}" failed (exit ${exitCode}).`);
				process.exitCode = exitCode;
			} else console.log(`Task "${name}" completed.`);
		} catch (err) {
			// G7: failure 路径也试着找 session（agent 任务 timeout 也会写到 session）
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

	async #cronRemove(
		name: string,
		storage: import("@oh-my-pi/pi-gateway/src/scheduler").SchedulerDbStorage,
	): Promise<void> {
		if (!name) {
			console.error("Usage: omp gateway cron remove <name>");
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

	#cronStatus(
		isDaemonRunning: typeof import("@oh-my-pi/pi-gateway/src/scheduler").isDaemonRunning,
		getSchedulerPidPath: typeof import("@oh-my-pi/pi-gateway/src/scheduler").getSchedulerPidPath,
	): void {
		const pidPath = getSchedulerPidPath();
		const running = isDaemonRunning(pidPath);
		console.log(`Scheduler: ${running ? "running" : "stopped"}`);
	}

	async #cronDiagnose(
		storage: import("@oh-my-pi/pi-gateway/src/scheduler").SchedulerDbStorage,
		json: boolean,
	): Promise<void> {
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

	async #cronLogs(
		name: string,
		storage: import("@oh-my-pi/pi-gateway/src/scheduler").SchedulerDbStorage,
		formatExecutionRow: typeof import("@oh-my-pi/pi-gateway/src/scheduler").formatExecutionRow,
		json: boolean,
	): Promise<void> {
		if (!name) {
			console.error("Usage: omp gateway cron logs <name>");
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

	// ═══════════════════════════════════════════════════════════════════
	// Service — inline handler
	// ═══════════════════════════════════════════════════════════════════

	async #handleService(): Promise<void> {
		const sub = process.argv[process.argv.indexOf("service") + 1];
		const { installService, uninstallService, startService, stopService, getServiceStatus } = await import(
			"@oh-my-pi/pi-gateway/src/service-installer"
		);

		switch (sub) {
			case "install": {
				// Resolve pi-gateway CLI path from the package location
				const path = require("node:path");
				const piGatewayPkg = require.resolve("@oh-my-pi/pi-gateway/package.json");
				const cliPath = path.join(path.dirname(piGatewayPkg), "src", "cli.ts");
				await installService(cliPath);
				console.log("Service installed. Run 'omp gateway service start' to begin.");
				break;
			}
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
