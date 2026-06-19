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
/**
 * Unified Gateway command — started via omp gateway or pi-gateway CLI.
 *
 * Manages IM channels, cron scheduler, agent bridge, and heartbeat.
 *
 * All actions are handled inline (no subprocess spawning) to work
 * correctly in both dev and compiled binary modes.
 */

import { Args, Command, Flags, renderCommandHelp } from "@oh-my-pi/pi-utils/cli";
import { logger } from "@oh-my-pi/pi-utils";
import { initTheme } from "../modes/theme/theme";

const ACTIONS = ["start", "stop", "status", "config", "cron", "service", "setup", "help"];

export default class Gateway extends Command {
	static description = "Unified gateway: IM channels, cron scheduler, agent bridge";
	static strict = false;
	static args = {
		action: Args.string({
			description: "Gateway action: start | stop | status | config | cron | service | help",
			required: false,
			options: ACTIONS,
		}),
	};

	static flags = {
		foreground: Flags.boolean({ description: "Run in foreground (default)" }),
		config: Flags.string({ description: "Path to gateway config file (default: ~/.omp/gateway.json)" }),
	};

	static examples = [
		"",
		"  ======== 生命周期 ========",
		"  omp gateway start                        Start gateway (foreground)",
		"  omp gateway start --config /path/gw.json  Start with custom config",
		"  omp gateway stop                         Stop gateway (via PID file)",
		"  omp gateway status                       Show running status & PID",
		"",
		"  ======== 系统服务 (launchd/systemd) ========",
		"  omp gateway service install              Install as system daemon",
		"  omp gateway service uninstall            Remove system daemon",
		"  omp gateway service start                Start daemon",
		"  omp gateway service stop                 Stop daemon (no auto-restart)",
		"  omp gateway service status               Show daemon status",
		"",
		"  ======== 配置 ========",
		"  omp gateway setup                        Interactive DingTalk credential setup",
		"  omp gateway config                       Print resolved config",
		"  omp gateway config --config /path/gw.json Print custom config",
		"",
		"  ======== 定时任务 ========",
		"  omp gateway cron create '0 9 * * *' 'cmd'  Create cron task",
		"  omp gateway cron list                     List all tasks",
		"  omp gateway cron pause <name>             Pause a task",
		"  omp gateway cron resume <name>            Resume a task",
		"  omp gateway cron run <name>               Run a task immediately",
		"  omp gateway cron remove <name>            Delete a task",
		"  omp gateway cron logs <name>              View execution logs",
		"",
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

				// Reload config on SIGHUP without restarting the process
				process.on("SIGHUP", async () => {
					logger.debug("Reloading gateway config...");
					try {
						const nextConfig = await loadConfig(configPath);
						await gateway.reload(nextConfig);
					} catch (err) {
						logger.error("Failed to reload gateway config", {
							error: err instanceof Error ? err.message : String(err),
						});
					}
				});

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

					if (status.channels && status.channels.length > 0) {
						console.log("  Channels:");
						for (const ch of status.channels) {
							console.log(`    ${ch.name} (${ch.id}): ${ch.connected ? "connected" : "disconnected"}`);
						}
					}
					if (status.accounts && status.accounts.length > 0) {
						console.log("  Accounts:");
						for (const acct of status.accounts) {
							console.log(`    ${acct.accountId}: bridge ${acct.bridgeRunning ? "running" : "stopped"}` +
								(acct.bridgeState ? ` [${acct.bridgeState}]` : ""));
						}
					}
					if (status.scheduler) {
						console.log(`  Scheduler: ${status.scheduler.running ? "running" : "stopped"} (${status.scheduler.taskCount} tasks)`);
					}
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
			case "setup": {
				// Delegate to pi-gateway CLI install
				const { $ } = await import("bun");
				const path = require("node:path");
				const pkg = require.resolve("@oh-my-pi/pi-gateway/package.json");
				const cliPath = path.join(path.dirname(pkg), "src", "cli.ts");
				await $`bun ${cliPath} install`.quiet().nothrow();
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

		const { SchedulerDbStorage, getSchedulerDbPath, cronCreate, cronList, cronSetStatus, cronRun, cronRemove, cronStatus, cronDiagnose, cronLogs } = await import("@oh-my-pi/pi-gateway/src/scheduler");

		const storage = new SchedulerDbStorage(getSchedulerDbPath());

		try {
			switch (action) {
				case "create":
					await cronCreate(argv.slice(1), storage);
					break;
				case "list":
					await cronList(storage, argv.includes("--json"));
					break;
				case "pause":
				case "disable":
					await cronSetStatus(argv[1], "disabled", storage);
					break;
				case "resume":
				case "enable":
					await cronSetStatus(argv[1], "active", storage);
					break;
				case "run":
					await cronRun(argv[1], storage);
					break;
				case "remove":
					await cronRemove(argv[1], storage);
					break;
				case "status":
					cronStatus();
					break;
				case "diagnose":
					await cronDiagnose(storage, argv.includes("--json"));
					break;
				case "logs":
					await cronLogs(argv[1], storage, argv.includes("--json"));
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
