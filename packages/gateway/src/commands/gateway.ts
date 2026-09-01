/**
 * Find the OMP agent session JSONL created during a specific time window.
 *
 * OMP writes agent session files to
 *   `~/.cornfield/agent/sessions/<encoded-cwd>/<timestamp>_<id>.jsonl`
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
 * Unified Gateway command — started via the cornfield-gateway CLI (root subcommands).
 *
 * Manages IM channels, cron scheduler, agent bridge, and heartbeat.
 *
 * All actions are handled inline (no subprocess spawning) to work
 * correctly in both dev and compiled binary modes.
 */

import * as path from "node:path";
import { logger } from "@cornfield/utils";
import { Args, Command, Flags, renderCommandHelp } from "@cornfield/utils/cli";
import { clearStatusFileSync } from "../gateway-daemon";
import type { DingTalkConfig, DingtalkAccountConfig } from "../types";

const ACTIONS = [
	"start",
	"stop",
	"status",
	"reload",
	"account",
	"doctor",
	"config",
	"cron",
	"robot-context",
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
				"Gateway action: start | stop | status | doctor | reload | account | config | cron | robot-context | service | test-longtask | help",
			required: false,
			options: ACTIONS,
		}),
	};

	static flags = {
		foreground: Flags.boolean({ description: "Run in foreground (used internally for daemon mode)" }),
		config: Flags.string({ description: "Path to gateway config file (default: ~/.cornfield/gateway.json)" }),
		nonInteractive: Flags.boolean({
			description: "Skip prompts; for setup action, prints manual-edit instructions and exits",
		}),
	};

	static examples = [
		"",
		"  ======== 生命周期 ========",
		"  cornfield-gateway start                        Start gateway (foreground)",
		"  cornfield-gateway start --config /path/gw.json  Start with custom config",
		"  cornfield-gateway stop                         Stop gateway (via PID file)",
		"  cornfield-gateway status                       Show running status & PID",
		"  cornfield-gateway reload                        Reload config without restart (SIGHUP)",
		"",
		"  ======== 动态账号启停（热生效） ========",
		"  cornfield-gateway account list                  List accounts + enabled state",
		"  cornfield-gateway account enable <id>           Enable DingTalk account (hot reload, no restart)",
		"  cornfield-gateway account disable <id>          Disable DingTalk account (hot reload, no restart)",
		"  cornfield-gateway doctor                       Run health checks (config, creds, channels, scheduler)",
		"  cornfield-gateway doctor --fix                 Apply safe fixes (clear stale state, fail orphaned execs)",
		"",
		"  ======== 系统服务 (launchd/systemd) ========",
		"  cornfield-gateway service install              Install as system daemon",
		"  cornfield-gateway service uninstall            Remove system daemon",
		"  cornfield-gateway service start                Start daemon",
		"  cornfield-gateway service stop                 Stop daemon (no auto-restart)",
		"  cornfield-gateway service status               Show daemon status",
		"  cornfield-gateway setup                        Interactive DingTalk credential setup",
		"  cornfield-gateway setup --non-interactive      Print manual-edit instructions and exit (for CI/scripting)",
		"  cornfield-gateway config                       Print resolved config",
		"  cornfield-gateway config --config /path/gw.json Print custom config",
		"",
		"  ======== 机器人上下文 ========",
		"  cornfield-gateway robot-context probe           探测机器人×群矩阵并刷新各 agent 的 robot-context.md",
		"  cornfield-gateway robot-context probe --dry-run 只探测不写入",
		"",
		"  ======== 定时任务 ========",
		"  cornfield-gateway cron create '0 9 * * *' 'cmd'  Create cron task",
		"  cornfield-gateway cron list                     List all tasks",
		"  cornfield-gateway cron pause <name>             Pause a task",
		"  cornfield-gateway cron resume <name>            Resume a task",
		"  cornfield-gateway cron run <name>               Run a task now (debug only — skips delivery)",
		"  cornfield-gateway cron test-run <name>          Trigger through the real scheduler; verifies delivery",
		"  cornfield-gateway cron remove <name>            Delete a task",
		"  cornfield-gateway cron update <name> ...        Update task fields in place",
		"  cornfield-gateway cron reconcile [--apply]      Backfill accountId on legacy unbound tasks",
		"  cornfield-gateway cron status                   Show scheduler status",
		"  cornfield-gateway cron diagnose [--json]        System health (task counts + per-task snapshot)",
		"  cornfield-gateway cron diagnose <name> [--json]  View JSONL execution diagnostics for a task",
		"  cornfield-gateway cron logs <name> [--json]     View execution logs",
		"",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Gateway);
		await this.#runGateway(args.action, flags);
	}

	async #runGateway(action: string | undefined, flags: Record<string, unknown>): Promise<void> {
		if (!action) {
			renderCommandHelp("cornfield-gateway", "", Gateway);
			return;
		}

		const configPath = flags.config as string | undefined;

		switch (action) {
			case "start": {
				// --foreground: run in foreground (blocking). Used by the daemon child
				// process and service mode (launchd/systemd). Default path daemonizes.
				if (flags.foreground) {
					process.title = "cornfield-gateway";
					const { Gateway: GW } = await import("../gateway");
					const { loadConfig } = await import("../config");
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

					// Same error-boundary as cornfield-gateway cli.ts — a single async
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
				const { getGatewayStatus, PID_FILE } = await import("../gateway-daemon");
				const { loadConfig, getDataDir } = await import("../config");

				// Already running?
				const existingStatus = await getGatewayStatus();
				if (existingStatus.running) {
					console.log(`Gateway already running (PID ${existingStatus.pid}).`);
					await this.#printStatus(existingStatus);
					return;
				}

				// Spawn detached child with --foreground.
				// In bun dev mode: process.argv[1] is the .ts entry point.
				// In compiled cornfield-gateway binary: process.argv[1] is the subcommand.
				const entry = process.argv[1];
				const isDevMode = entry && (entry.endsWith(".ts") || entry.endsWith(".js"));
				const childCmd = isDevMode
					? [process.execPath, entry, "start", "--foreground"]
					: [process.execPath, "start", "--foreground"];
				if (configPath) childCmd.push("--config", configPath);

				const child = Bun.spawn({
					cmd: childCmd,
					argv0: "cornfield-gateway",
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
					console.error("Gateway failed to start within 15s. Check logs: ~/.cornfield/logs/cornfield.*.log");
					process.exitCode = 1;
					return;
				}

				console.log("✅ Gateway started in daemon mode.");
				const status = await getGatewayStatus();
				await this.#printStatus(status);
				break;
			}
			case "stop": {
				const { stopGatewayDaemon } = await import("../gateway-daemon");
				const stopped = await stopGatewayDaemon();
				if (stopped) {
					console.log("Gateway stopped.");
				} else {
					console.log("Gateway is not running.");
				}
				break;
			}
			case "status": {
				const { getGatewayStatus } = await import("../gateway-daemon");
				const { loadConfig, getConfigPath } = await import("../config");
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
				await this.#reloadRunningGateway();
				break;
			}

			case "account": {
				await this.#handleAccount(process.argv, configPath);
				break;
			}
			case "doctor": {
				const argv = process.argv.slice(process.argv.indexOf("doctor") + 1);
				const { runDoctor, renderText, renderJson, applyFixes, countBySeverity } = await import("../doctor");
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
				const { loadConfig, getConfigPath } = await import("../config");
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
				const { runLongTaskTest } = await import("../test-longtask");
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
						"Usage: cornfield-gateway test-longtask <accountId> [--hold-ms N] [--user-id <id>] [--simulate-stop]",
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
			case "robot-context": {
				await this.#handleRobotContext();
				break;
			}
			case "setup": {
				// Direct in-process call into the setup wizard — no subprocess spawn.
				// The legacy `cornfield-gateway install` path used `bun <cliPath> install`;
				// now the wizard lives at `cornfield-gateway/src/setup.ts` and is invoked
				// like any other library function.
				const { runInteractiveSetup } = await import("../setup");
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
				renderCommandHelp("cornfield-gateway", "", Gateway);
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

	/**
	 * Reload the running gateway config without a process restart.
	 *
	 * SIGHUP-based reload crashes the bun process when sent from the same
	 * parent (Bun async signal handler bug), so we pick the path based on
	 * what's actually running:
	 *
	 *   1. Service installed → stopService / startService (launchd/systemd
	 *      KeepAlive handles the gap), polling for the new PID.
	 *   2. Service not installed, PID file alive → SIGHUP the running gateway
	 *      (its `--foreground` handler does an in-process config reload).
	 *      PID liveness AND identity (argv) are verified first.
	 *   3. Nothing running → clean error.
	 */
	async #reloadRunningGateway(): Promise<void> {
		const { isServiceInstalled, stopService, startService, getServiceStatus } = await import("../service-installer");
		const { getGatewayStatus, isGatewayProcess } = await import("../gateway-daemon");

		if (await isServiceInstalled()) {
			const oldStatus = await getServiceStatus();
			const oldPid = oldStatus.running ? oldStatus.pid : undefined;
			await stopService();
			const stopDeadline = Date.now() + 5_000;
			while (Date.now() < stopDeadline) {
				const s = await getServiceStatus();
				if (!s.running) break;
				await Bun.sleep(100);
			}
			await startService();
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
				console.log("Gateway restart requested; new PID not yet visible (check `cornfield-gateway status`).");
			}
			return;
		}

		const status = await getGatewayStatus();
		if (status.running && status.pid) {
			if (!(await isGatewayProcess(status.pid))) {
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
			"Gateway is not running and not installed as a system service. Use `cornfield-gateway start` first.",
		);
		process.exitCode = 1;
	}

	/**
	 * 动态账号启停（热生效）：`account list|enable <id>|disable <id>`。
	 *
	 * 写 gateway.json 的 accounts.<id>.enabled，然后走 reload 路径（SIGHUP/
	 * 服务重启）让运行中的 gateway 捕获变化 —— 启停账号不依赖手工编辑配置。
	 * appSecret/appKey 不可在此路径修改（凭证走 `$ENV_VAR` 或 setup 向导）。
	 */
	async #handleAccount(argv: string[], configPath?: string): Promise<void> {
		const { loadConfig, saveConfig, getConfigPath, validateAndNormalizeConfig } = await import("../config");
		const idx = argv.indexOf("account");
		const sub = idx >= 0 ? argv[idx + 1] : undefined;
		const id = idx >= 0 ? argv[idx + 2] : undefined;

		if (sub === "list") {
			const config = await loadConfig(configPath);
			const { getDingTalkConfig } = await import("../config");
			const dt = getDingTalkConfig(config);
			const accounts = dt?.accounts ?? {};
			if (Object.keys(accounts).length === 0) {
				console.log("No DingTalk accounts configured.");
				return;
			}
			console.log("DingTalk accounts:");
			for (const [accountId, account] of Object.entries(accounts)) {
				console.log(
					`  ${accountId}: ${(account.enabled ?? true) ? "enabled" : "disabled"}` +
						(account.robotName ? ` (${account.robotName})` : "") +
						(account.agentDir ? ` → ${account.agentDir}` : ""),
				);
			}
			return;
		}

		if (sub !== "enable" && sub !== "disable") {
			console.error("Usage: cornfield-gateway account <list|enable|disable> [accountId]");
			process.exitCode = 1;
			return;
		}
		if (!id) {
			console.error(`cornfield-gateway account ${sub} requires an account id`);
			process.exitCode = 1;
			return;
		}

		const config = await loadConfig(configPath);
		const raw = config.channels.dingtalk as DingTalkConfig | undefined;
		const account = raw?.accounts?.[id];
		if (!account) {
			console.error(
				`Unknown account: ${id} (accounts in gateway.json: ${Object.keys(raw?.accounts ?? {}).join(", ") || "none"})`,
			);
			process.exitCode = 1;
			return;
		}

		const enabled = sub === "enable";
		const next = {
			...config,
			channels: {
				...config.channels,
				dingtalk: {
					...(raw as DingTalkConfig),
					accounts: {
						...raw.accounts,
						[id]: { ...account, enabled } as DingtalkAccountConfig,
					},
				},
			},
		};

		try {
			validateAndNormalizeConfig(next);
		} catch (err) {
			console.error(`Refusing to write invalid config: ${err instanceof Error ? err.message : String(err)}`);
			process.exitCode = 1;
			return;
		}

		await saveConfig(next, configPath);
		console.log(`✅ Account ${id} → ${enabled ? "enabled" : "disabled"} (${getConfigPath()})`);

		// 热生效：修复 gateway.json 后让运行中的 gateway 重载（不重启进程）。
		const { getGatewayStatus } = await import("../gateway-daemon");
		const status = await getGatewayStatus();
		if (!status.running) {
			console.log("Gateway is not running — change will apply on next start.");
			return;
		}
		await this.#reloadRunningGateway();
	}

	// ═══════════════════════════════════════════════════════════════════
	// Robot context — active group-membership probe
	// ═══════════════════════════════════════════════════════════════════

	async #handleRobotContext(): Promise<void> {
		const argv = process.argv.slice(process.argv.indexOf("robot-context") + 1);
		const action = argv[0] ?? "help";
		if (action !== "probe") {
			console.log("Usage: cornfield-gateway robot-context probe [--dry-run]");
			console.log("  Probe robot×group membership via DingTalk API and update every");
			console.log("  account's <agentDir>/robot-context.md. Requires dws CLI and one");
			console.log("  gateway account with the qyapi_chat_manage permission.");
			if (action !== "help") process.exitCode = 1;
			return;
		}
		const dryRun = argv.includes("--dry-run");

		const { loadConfig, getDataDir, getDingTalkConfig } = await import("../config");
		const config = await loadConfig(undefined);
		const dt = getDingTalkConfig(config);
		if (!dt?.accounts || Object.keys(dt.accounts).length === 0) {
			console.error("No DingTalk accounts configured in gateway.json");
			process.exitCode = 1;
			return;
		}

		const accounts = new Map<string, { appKey: string; appSecret: string }>();
		const robotCodeToAccount = new Map<string, string>();
		for (const [id, acc] of Object.entries(dt.accounts)) {
			accounts.set(id, { appKey: acc.appKey, appSecret: acc.appSecret });
			if (acc.robotCode) robotCodeToAccount.set(acc.robotCode, id);
		}

		const { probeRobotGroups, ingestProbeResult } = await import("../robot-probe");
		console.error("Probing robot×group membership...");
		const result = await probeRobotGroups(accounts, robotCodeToAccount);
		console.log(`Scanned ${result.scanned} groups (failures: ${result.failures}) via ${result.tokenAccount} token`);
		for (const [robotCode, groups] of result.byRobot) {
			const acc = robotCodeToAccount.get(robotCode);
			console.log(`  ${acc ?? robotCode}: ${groups.length} groups`);
			for (const g of groups) console.log(`    - ${g.title}`);
		}
		if (dryRun) {
			console.log("--dry-run: skipping sessions/robot-context update");
			return;
		}

		const { SQLiteSessionStore } = await import("../session-store");
		const { RobotContextWriter } = await import("../robot-context");
		const dataDir = getDataDir(config);
		const store = new SQLiteSessionStore(`${dataDir}/sessions.db`);
		try {
			const agentDirs = new Map<string, string>();
			const { resolveAgentDir } = await import("@cornfield/coding-agent/skeleton");
			const robotMeta = new Map<string, { robotCode?: string; robotName?: string }>();
			for (const [id, acc] of Object.entries(dt.accounts)) {
				agentDirs.set(id, resolveAgentDir(id, acc.agentDir));
				robotMeta.set(id, { robotCode: acc.robotCode, robotName: acc.robotName });
			}
			const writer = new RobotContextWriter({ store, agentDirs, robotMeta });
			const written = await ingestProbeResult(store, writer, result, robotCodeToAccount);
			for (const [id, n] of written)
				console.log(`Updated ${id}: ${n} session(s) changed, robot-context.md refreshed`);
			if (written.size === 0) console.log("No changes — robot contexts already up to date");
		} finally {
			store.close();
		}
	}

	async #handleCron(): Promise<void> {
		const argv = process.argv.slice(process.argv.indexOf("cron") + 1);
		const action = argv[0] ?? "help";

		const {
			JsonFileStorage,
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
		} = await import("../scheduler");

		const storage = new JsonFileStorage();
		// Migrate from existing SQLite if present
		try {
			const { getSchedulerDbPath } = await import("../scheduler");
			const { existsSync } = await import("node:fs");
			const dbPath = getSchedulerDbPath();
			if (existsSync(dbPath)) {
				const { migrated } = storage.migrateFromDb(dbPath);
				if (migrated > 0) {
					console.error(`Migrated ${migrated} tasks from SQLite.`);
				}
			}
		} catch {
			// No SQLite to migrate
		}

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
  cornfield-gateway cron create <schedule> <command...> [--name <name>] [--type shell|agent] [--deliver <channel>] [--deliver-user <id>] [--model <model>] [--provider <provider>] [--toolsets <a,b,c>] [--repeat <N>] [--source-channel <ch>] [--source-user <uid>] [--timeout-ms <ms>] [--skills <s1,s2,...>] [--retry <maxAttempts>] [--pre-script <path>]
  cornfield-gateway cron list [--json]
  cornfield-gateway cron pause <name>
  cornfield-gateway cron resume <name>
  cornfield-gateway cron run <name>                              Trigger a task now (debug only — skips delivery)
  cornfield-gateway cron test-run <name> [--in 90s] [--timeout 150s] [--no-restore]    Trigger through the real scheduler (waits + restores); verifies delivery
  cornfield-gateway cron remove <name>
  cornfield-gateway cron update <name> [--account <id> | --clear-account] [--deliver <channel> | --clear-deliver] [--deliver-user <id> | --clear-deliver-user] [--timeout-ms <ms>]
  cornfield-gateway cron reconcile [--apply]                      Backfill accountId on legacy unbound tasks (dry run by default)
  cornfield-gateway cron status
  cornfield-gateway cron diagnose [--json]                        System health (task counts + per-task snapshot)
  cornfield-gateway cron diagnose <name> [--json]                 View JSONL execution diagnostics for a task
  cornfield-gateway cron logs <name> [--json]
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
			"../service-installer"
		);

		switch (sub) {
			case "install": {
				// No-arg: dev/prod is detected inside installService from process.argv[1].
				// (Previously this resolved `<cornfield-gateway>/src/cli.ts` and passed it through,
				// which only worked in dev mode and broke the compiled-binary install path.)
				await installService();
				console.log("Service installed. Run 'cornfield-gateway service start' to begin.");
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
  cornfield-gateway service install     Install as system service
  cornfield-gateway service uninstall   Remove system service
  cornfield-gateway service start       Start system service
  cornfield-gateway service stop        Stop system service
  cornfield-gateway service status      Show service status
`);
		}
	}
}
