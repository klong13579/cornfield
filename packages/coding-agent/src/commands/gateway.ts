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

import * as path from "node:path";
import { clearStatusFileSync } from "@oh-my-pi/pi-gateway/src/gateway-daemon";
import { logger } from "@oh-my-pi/pi-utils";
import { Args, Command, Flags, renderCommandHelp } from "@oh-my-pi/pi-utils/cli";

const ACTIONS = [
	"start",
	"stop",
	"status",
	"reload",
	"doctor",
	"config",
	"cron",
	"service",
	"setup",
	"test-longtask",
	"help",
];

export default class Gateway extends Command {
	static description = "Unified gateway: IM channels, cron scheduler, agent bridge";
	static strict = false;
	static args = {
		action: Args.string({
			description:
				"Gateway action: start | stop | status | doctor | reload | config | cron | service | test-longtask | help",
			required: false,
			options: ACTIONS,
		}),
	};

	static flags = {
		foreground: Flags.boolean({ description: "Run in foreground (used internally for daemon mode)" }),
		config: Flags.string({ description: "Path to gateway config file (default: ~/.omp/gateway.json)" }),
		nonInteractive: Flags.boolean({
			description: "Skip prompts; for setup action, prints manual-edit instructions and exits",
		}),
	};

	static examples = [
		"",
		"  ======== 生命周期 ========",
		"  omp gateway start                        Start gateway (foreground)",
		"  omp gateway start --config /path/gw.json  Start with custom config",
		"  omp gateway stop                         Stop gateway (via PID file)",
		"  omp gateway status                       Show running status & PID",
		"  omp gateway reload                        Reload config without restart (SIGHUP)",
		"  omp gateway doctor                       Run health checks (config, creds, channels, scheduler)",
		"  omp gateway doctor --fix                 Apply safe fixes (clear stale state, fail orphaned execs)",
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
		"  omp gateway setup --non-interactive      Print manual-edit instructions and exit (for CI/scripting)",
		"  omp gateway config                       Print resolved config",
		"  omp gateway config --config /path/gw.json Print custom config",
		"",
		"  ======== 定时任务 ========",
		"  omp gateway cron create '0 9 * * *' 'cmd'  Create cron task",
		"  omp gateway cron list                     List all tasks",
		"  omp gateway cron pause <name>             Pause a task",
		"  omp gateway cron resume <name>            Resume a task",
		"  omp gateway cron run <name>               Run a task now (debug only — skips delivery)",
		"  omp gateway cron test-run <name>          Trigger through the real scheduler; verifies delivery",
		"  omp gateway cron remove <name>            Delete a task",
		"  omp gateway cron update <name> ...        Update task fields in place",
		"  omp gateway cron reconcile [--apply]      Backfill accountId on legacy unbound tasks",
		"  omp gateway cron status                   Show scheduler status",
		"  omp gateway cron diagnose [--json]        System health (task counts + per-task snapshot)",
		"  omp gateway cron diagnose <name> [--json]  View JSONL execution diagnostics for a task",
		"  omp gateway cron logs <name> [--json]     View execution logs",
		"",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Gateway);
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
				// --foreground: run in foreground (blocking). Used by the daemon child
				// process and service mode (launchd/systemd). Default path daemonizes.
				if (flags.foreground) {
					process.title = "pi-gateway";
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

					// Circuit breaker for uncaughtException. A single error is
					// recoverable, but a sustained storm (e.g. a 3k-retry loop on
					// a missing module) means the process is wedged — we exit
					// and let launchd/systemd respawn us cleanly.
					let uncaughtCount = 0;
					let lastUncaughtAt = 0;
					const UNCAUGHT_WINDOW_MS = 60_000;
					const UNCAUGHT_THRESHOLD = 10;

					// Same error-boundary as pi-gateway cli.ts — a single async
					// rejection must not crash the daemon.
					process.on("unhandledRejection", reason => {
						logger.error("unhandledRejection in gateway process", {
							reason: reason instanceof Error ? reason.stack || reason.message : String(reason),
						});
					});
					process.on("uncaughtException", err => {
						const now = Date.now();
						// Count consecutive uncaughtExceptions within a sliding
						// window. A single error is recoverable; a sustained
						// storm (e.g. a 3k-retry loop on a missing module) means
						// the process is wedged and only a restart can recover.
						// We force `process.exit(1)` so launchd/systemd respawn
						// the daemon cleanly instead of letting the bad state
						// persist.
						if (now - lastUncaughtAt > UNCAUGHT_WINDOW_MS) {
							uncaughtCount = 0;
						}
						uncaughtCount++;
						lastUncaughtAt = now;
						logger.error("uncaughtException in gateway process", {
							error: err.stack || err.message,
							consecutiveCount: uncaughtCount,
						});
						if (uncaughtCount >= UNCAUGHT_THRESHOLD) {
							logger.error("uncaughtException threshold reached — exiting for supervisor restart", {
								threshold: UNCAUGHT_THRESHOLD,
								windowMs: UNCAUGHT_WINDOW_MS,
							});
							// Best-effort sync cleanup so the next reader does
							// not see a snapshot of a dead process. This handler
							// cannot await — `process.exit(1)` interrupts any
							// pending microtask. Use the sync unlink.
							clearStatusFileSync();
							process.exit(1);
						}
					});

					await gateway.start();

					// Attempt to resume any interrupted conversation from a previous gateway run.
					// This reads the restart sentinel (if present) and sends a continuation message
					// to the agent so it can acknowledge the restart and continue where it left off.
					try {
						const resumed = await gateway.resumeFromSentinel();
						if (resumed) {
							logger.info("Restart recovery completed successfully");
						}
					} catch (err) {
						logger.warn("Restart recovery failed", {
							error: err instanceof Error ? err.message : String(err),
						});
					}

					await new Promise(() => {});
					break;
				}
				const { getGatewayStatus, PID_FILE } = await import("@oh-my-pi/pi-gateway/src/gateway-daemon");
				const { loadConfig, getDataDir } = await import("@oh-my-pi/pi-gateway/src/config");

				// Already running?
				const existingStatus = await getGatewayStatus();
				if (existingStatus.running) {
					console.log(`Gateway already running (PID ${existingStatus.pid}).`);
					await this.#printStatus(existingStatus);
					return;
				}

				// Spawn detached child with --foreground.
				// In bun dev mode: process.argv[1] is the .ts entry point.
				// In compiled omp binary: process.argv[1] is absent, use "omp" from PATH.
				const entry = process.argv[1];
				const isDevMode = entry && (entry.endsWith(".ts") || entry.endsWith(".js"));
				const childCmd = isDevMode
					? [process.execPath, entry, "gateway", "start", "--foreground"]
					: [process.execPath, "gateway", "start", "--foreground"];
				if (configPath) childCmd.push("--config", configPath);

				const child = Bun.spawn({
					cmd: childCmd,
					argv0: "pi-gateway",
					stdin: "ignore",
					stdout: "ignore",
					stderr: "ignore",
					detached: true,
				});
				child.unref?.();

				// Wait for PID file to appear (up to 15s)
				const config = await loadConfig(configPath);
				const pidPath = path.join(getDataDir(config), PID_FILE);

				let ready = false;
				for (let i = 0; i < 150; i++) {
					await Bun.sleep(100);
					try {
						const pidText = await Bun.file(pidPath).text();
						const pid = parseInt(pidText.trim(), 10);
						if (pid > 0) {
							try {
								process.kill(pid, 0);
								ready = true;
								break;
							} catch {}
						}
					} catch {}
				}

				if (!ready) {
					console.error("Gateway failed to start within 15s. Check logs: ~/.omp/logs/omp.*.log");
					process.exitCode = 1;
					return;
				}

				console.log("✅ Gateway started in daemon mode.");
				const status = await getGatewayStatus();
				await this.#printStatus(status);
				break;
			}
			case "stop": {
				const { stopGatewayDaemon } = await import("@oh-my-pi/pi-gateway/src/gateway-daemon");
				const stopped = await stopGatewayDaemon();
				if (stopped) {
					console.log("Gateway stopped.");
				} else {
					console.log("Gateway is not running.");
				}
				break;
			}
			case "status": {
				const { getGatewayStatus } = await import("@oh-my-pi/pi-gateway/src/gateway-daemon");
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
							console.log(
								`    ${acct.accountId}: bridge ${acct.bridgeRunning ? "running" : "stopped"}` +
									(acct.bridgeState ? ` [${acct.bridgeState}]` : ""),
							);
						}
					}
					if (status.scheduler) {
						console.log(
							`  Scheduler: ${status.scheduler.running ? "running" : "stopped"} (${status.scheduler.taskCount} tasks)`,
						);
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
			case "reload": {
				// SIGHUP-based reload crashes the bun process when sent from
				// the same parent (Bun async signal handler bug). We pick a path
				// based on what's actually running:
				//
				//   1. Service installed → stopService / startService (launchd/systemd
				//      KeepAlive handles the gap). We poll the new PID rather than
				//      blind-sleeping because launchd's KeepAlive backoff can be
				//      several seconds.
				//   2. Service not installed, PID file alive → SIGHUP the running
				//      gateway. The gateway's SIGHUP handler (set up in the
				//      `--foreground` path) does an in-process config reload and
				//      avoids a process restart. We verify the PID is still
				//      alive AND is actually our gateway (not a PID-recycled
				//      unrelated process) by inspecting the command line.
				//   3. Nothing running → clean error.
				const { isServiceInstalled, stopService, startService, getServiceStatus } = await import(
					"@oh-my-pi/pi-gateway/src/service-installer"
				);
				const { getGatewayStatus } = await import("@oh-my-pi/pi-gateway/src/gateway-daemon");

				if (await isServiceInstalled()) {
					const oldStatus = await getServiceStatus();
					const oldPid = oldStatus.running ? oldStatus.pid : undefined;
					await stopService();
					// Wait until the service is actually stopped. launchd's bootout
					// returns immediately even though the unload is asynchronous;
					// a subsequent bootstrap too soon after can hit
					// "Bootstrap failed: 5: Input/output error".
					const stopDeadline = Date.now() + 5_000;
					while (Date.now() < stopDeadline) {
						const s = await getServiceStatus();
						if (!s.running) break;
						await Bun.sleep(100);
					}
					await startService();
					// Wait for the new PID to appear (up to 10s). launchd's
					// KeepAlive backoff can be ~5s on macOS.
					const deadline = Date.now() + 10_000;
					let newPid: number | undefined;
					while (Date.now() < deadline) {
						const next = await getServiceStatus();
						if (next.running && next.pid && next.pid !== oldPid) {
							newPid = next.pid;
							break;
						}
						await Bun.sleep(250);
					}
					if (newPid) {
						console.log(`Gateway restarted via system service (new PID ${newPid}).`);
					} else {
						console.log("Gateway restart requested; new PID not yet visible (check `omp gateway status`).");
					}
					return;
				}

				const status = await getGatewayStatus();
				if (status.running && status.pid) {
					// Verify the PID is actually our gateway — not a recycled PID
					// owned by some unrelated process. We check both liveness
					// (process.kill 0) and command-line identity (ps -p ... args).
					let isOurProcess = false;
					try {
						process.kill(status.pid, 0);
						const ps = Bun.spawnSync(["ps", "-p", String(status.pid), "-o", "args="]);
						const args = ps.stdout.toString();
						if (args.includes("gateway") && args.includes("--foreground")) {
							isOurProcess = true;
						}
					} catch {
						// process is gone or ps failed
					}
					if (!isOurProcess) {
						console.error(
							`PID ${status.pid} from gateway.pid is no longer our gateway process ` +
								`(stale PID file or PID was recycled). Refusing to send SIGHUP.`,
						);
						process.exitCode = 1;
						return;
					}
					try {
						process.kill(status.pid, "SIGHUP");
						console.log(`Sent SIGHUP to gateway (PID ${status.pid}) — in-process reload.`);
					} catch (err) {
						console.error(
							`Failed to send SIGHUP to gateway (PID ${status.pid}): ${err instanceof Error ? err.message : String(err)}`,
						);
						process.exitCode = 1;
					}
					return;
				}

				console.error(
					"Gateway is not running and not installed as a system service. Use `omp gateway start` first.",
				);
				process.exitCode = 1;
				break;
			}
			case "doctor": {
				const argv = process.argv.slice(process.argv.indexOf("doctor") + 1);
				const { runDoctor, renderText, renderJson, applyFixes, countBySeverity } = await import(
					"@oh-my-pi/pi-gateway/src/doctor"
				);
				const json = argv.includes("--json");
				const doFix = argv.includes("--fix");
				const report = await runDoctor(configPath);
				console.log(json ? renderJson(report) : renderText(report));
				if (doFix) {
					const applied = await applyFixes(report);
					if (!json) {
						console.log("");
						if (applied.length === 0) console.log("No fixable findings.");
						else {
							console.log("Applied fixes:");
							for (const a of applied) console.log(`  - ${a}`);
						}
					}
				}
				if (countBySeverity(report).error > 0) process.exitCode = 1;
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
			case "test-longtask": {
				const argv = process.argv.slice(process.argv.indexOf("test-longtask") + 1);
				const accountId = argv[0];
				const rest = argv.slice(1);
				const { runLongTaskTest } = await import("@oh-my-pi/pi-gateway/src/test-longtask");
				let holdMs = 35_000;
				let userId = "601590212";
				let simulateStop = false;
				for (let i = 0; i < rest.length; i++) {
					const tok = rest[i];
					if (tok === "--hold-ms" && rest[i + 1]) {
						holdMs = Number(rest[i + 1]);
						i++;
					} else if (tok === "--user-id" && rest[i + 1]) {
						userId = rest[i + 1]!;
						i++;
					} else if (tok === "--simulate-stop") {
						simulateStop = true;
					}
				}
				if (!accountId) {
					console.error(
						"Usage: omp gateway test-longtask <accountId> [--hold-ms N] [--user-id <id>] [--simulate-stop]",
					);
					process.exitCode = 1;
					break;
				}
				if (!Number.isFinite(holdMs) || holdMs <= 0) {
					console.error(`--hold-ms must be a positive number; got ${holdMs}`);
					process.exitCode = 1;
					break;
				}
				const result = await runLongTaskTest({ accountId, holdMs, userId, simulateStopClick: simulateStop });
				if (!result.success) {
					console.error(`[test-longtask] FAILED: ${result.error ?? "unknown error"}`);
					process.exitCode = 1;
					break;
				}
				console.log(`[test-longtask] card delivered: ${result.cardInstanceId}`);
				console.log(`[test-longtask] watcher fired: ${result.watcherFired} (events=${result.watcherEvents})`);
				if (simulateStop) {
					console.log(`[test-longtask] stop action handled: ${result.stopActionHandled}`);
					console.log(`[test-longtask] bridge.abort() returned: ${result.aborted}`);
				}
				break;
			}
			case "setup": {
				// Direct in-process call into the setup wizard — no subprocess spawn.
				// The legacy `pi-gateway install` path used `bun <cliPath> install`;
				// now the wizard lives at `pi-gateway/src/setup.ts` and is invoked
				// like any other library function.
				const { runInteractiveSetup } = await import("@oh-my-pi/pi-gateway/src/setup");
				const result = await runInteractiveSetup({
					configPath,
					nonInteractive: Boolean(flags.nonInteractive),
				});
				if (!result.ok) {
					// Non-interactive / missing input / dedup. Already echoed to the user
					// by the wizard; exit non-zero for scripting.
					process.exitCode = 1;
				}
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

	// Print gateway status (channels, accounts, scheduler) from a GatewayDaemonStatus.
	async #printStatus(status: {
		running: boolean;
		pid?: number;
		startedAt?: string;
		channels?: Array<{ id: string; name: string; connected: boolean }>;
		accounts?: Array<{ accountId: string; bridgeRunning: boolean; bridgeState?: string }>;
		scheduler?: { running: boolean; taskCount: number };
	}): Promise<void> {
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
					console.log(
						`    ${acct.accountId}: bridge ${acct.bridgeRunning ? "running" : "stopped"}` +
							(acct.bridgeState ? ` [${acct.bridgeState}]` : ""),
					);
				}
			}
			if (status.scheduler) {
				console.log(
					`  Scheduler: ${status.scheduler.running ? "running" : "stopped"} (${status.scheduler.taskCount} tasks)`,
				);
			}
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
			cronCreate,
			cronList,
			cronSetStatus,
			cronRun,
			cronTestRun,
			cronUpdate,
			cronReconcile,
			cronRemove,
			cronStatus,
			cronDiagnose,
			cronLogs,
		} = await import("@oh-my-pi/pi-gateway/src/scheduler");

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
				case "test-run":
					await cronTestRun(argv.slice(1), storage);
					break;
				case "remove":
					await cronRemove(argv[1], storage);
					break;
				case "update":
					await cronUpdate(argv.slice(1), storage);
					break;
				case "reconcile":
					await cronReconcile(argv.slice(1), storage);
					break;
				case "status":
					cronStatus();
					break;
				case "diagnose":
					await cronDiagnose(storage, argv.includes("--json"), argv[1]);
					break;
				case "logs":
					await cronLogs(argv[1], storage, argv.includes("--json"));
					break;
				default:
					console.log(`
Cron management commands:
  omp gateway cron create <schedule> <command...> [--name <name>] [--type shell|agent] [--deliver <channel>] [--deliver-user <id>] [--model <model>] [--provider <provider>] [--toolsets <a,b,c>] [--repeat <N>] [--source-channel <ch>] [--source-user <uid>] [--timeout-ms <ms>] [--skills <s1,s2,...>] [--retry <maxAttempts>] [--pre-script <path>]
  omp gateway cron list [--json]
  omp gateway cron pause <name>
  omp gateway cron resume <name>
  omp gateway cron run <name>                              Trigger a task now (debug only — skips delivery)
  omp gateway cron test-run <name> [--in 90s] [--timeout 150s] [--no-restore]    Trigger through the real scheduler (waits + restores); verifies delivery
  omp gateway cron remove <name>
  omp gateway cron update <name> [--account <id> | --clear-account] [--deliver <channel> | --clear-deliver] [--deliver-user <id> | --clear-deliver-user] [--timeout-ms <ms>]
  omp gateway cron reconcile [--apply]                      Backfill accountId on legacy unbound tasks (dry run by default)
  omp gateway cron status
  omp gateway cron diagnose [--json]                        System health (task counts + per-task snapshot)
  omp gateway cron diagnose <name> [--json]                 View JSONL execution diagnostics for a task
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
				// No-arg: dev/prod is detected inside installService from process.argv[1].
				// (Previously this resolved `<pi-gateway>/src/cli.ts` and passed it through,
				// which only worked in dev mode and broke the compiled-binary install path.)
				await installService();
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
