/**
 * CLI entry point for the gateway.
 *
 * Usage:
 *   pi-gateway start                    Start the gateway in foreground
 *   pi-gateway stop                     Stop the gateway (via PID file)
 *   pi-gateway status                   Show gateway status & PID
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
 *   pi-gateway service install          Install as system service (launchd/systemd)
 *   pi-gateway service uninstall        Remove system service
 *   pi-gateway service start            Start system service
 *   pi-gateway service stop             Stop system service
 *   pi-gateway service status           Show service status
 *
 * First-time setup:
 *   1. Create ~/.omp/gateway.json with your DingTalk app credentials
 *      (example: omp gateway config prints the expected schema)
 *   2. omp gateway start
 *   3. Send a message to your DingTalk bot to verify
 *
 * Environment variables:
 *   PI_LOG_LEVEL        Log level for stderr (debug|info|warn|error)
 *                       File log (~/.omp/logs/omp.*.log) always full
 *   PI_GATEWAY_CONFIG   Alternative config path (default: ~/.omp/gateway.json)
 */

import { runAgentInit } from "@oh-my-pi/pi-coding-agent/cli/agent-cli";
import { logger } from "@oh-my-pi/pi-utils";
import { getConfigPath, getDataDir, getDingTalkConfig, loadConfig } from "./config";
import { Gateway } from "./gateway";
import {
	cronCreate,
	cronDiagnose,
	cronList,
	cronLogs,
	cronReconcile,
	cronRemove,
	cronRun,
	cronSetStatus,
	cronStatus,
	cronUpdate,
	getSchedulerDbPath,
	SchedulerDbStorage,
} from "./scheduler";
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
	const cliConfig = configIdx >= 0 ? extra[configIdx + 1] : undefined;
	const config = cliConfig ?? process.env.PI_GATEWAY_CONFIG;
	return { command: cmd, subcommand: sub, args: extra, config };
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
	process.on("SIGHUP", async () => {
		logger.debug("Reloading gateway config...");
		try {
			const nextConfig = await loadConfig(_configPath);
			await gateway.reload(nextConfig);
		} catch (err) {
			logger.error("Failed to reload gateway config", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	});

	// A single async failure inside any channel / SDK callback / cron
	// tick must not bring down the whole gateway. Without these
	// handlers, a rejected promise from a DingTalk SDK `error` event
	// or a thrown exception inside a streaming handler would silently
	// terminate the process and take every connected channel (hr,
	// opencode, …) with it. Log and keep running.
	process.on("unhandledRejection", (reason, promise) => {
		logger.error("unhandledRejection in gateway process", {
			reason: reason instanceof Error ? reason.stack || reason.message : String(reason),
		});
	});
	process.on("uncaughtException", err => {
		logger.error("uncaughtException in gateway process", {
			error: err.stack || err.message,
		});
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

	// Non-interactive daemon mode (stdin not a TTY)
	if (!process.stdin.isTTY) {
		console.log("\n✅ Gateway started in daemon mode");
		await new Promise(() => {}); // hang forever until SIGTERM
		return;
	}

	// CLI 交互模式
	const dtConfig = getDingTalkConfig(config);
	const accounts = dtConfig?.accounts ? Object.keys(dtConfig.accounts) : [];
	const isMultiAccount = accounts.length > 0;

	console.log("\n✅ Gateway 已启动！");
	if (isMultiAccount) {
		console.log(`📝 多账号模式，可用账号: ${accounts.join(", ")}`);
		console.log("📝 输入 @账号名 消息 和指定 Agent 对话 (如 @hr 你好)");
		console.log("📝 输入 /switch 账号名 切换默认账号");
	} else {
		console.log("📝 输入消息直接和 Agent 对话");
	}
	console.log("📝 输入 exit 退出");
	console.log("---".repeat(30));

	let defaultAccountId: string | undefined = isMultiAccount ? accounts[0] : undefined;

	const readline = await import("node:readline");
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
		prompt: isMultiAccount ? `[${defaultAccountId}] > ` : "> ",
	});

	rl.prompt();

	rl.on("line", async line => {
		const text = line.trim();
		if (!text) {
			rl.prompt();
			return;
		}
		if (text === "exit" || text === "quit") {
			rl.close();
			return;
		}

		// /switch command: change default account for CLI session
		if (isMultiAccount && text.startsWith("/switch")) {
			const target = text.slice(7).trim();
			if (!target || !accounts.includes(target)) {
				console.log(`\n可用账号: ${accounts.join(", ")}`);
			} else {
				defaultAccountId = target;
				console.log(`\n已切换到账号: ${target}`);
				rl.setPrompt(`[${target}] > `);
			}
			console.log("---".repeat(30));
			rl.prompt();
			return;
		}

		// Parse @accountId prefix from message
		let accountId: string | undefined;
		let message = text;
		if (isMultiAccount && text.startsWith("@")) {
			const spaceIdx = text.indexOf(" ");
			if (spaceIdx > 1) {
				const parsedId = text.slice(1, spaceIdx);
				if (accounts.includes(parsedId)) {
					accountId = parsedId;
					message = text.slice(spaceIdx + 1).trim();
				} else {
					console.log(`\n账号 "${parsedId}" 不存在。可用账号: ${accounts.join(", ")}`);
					console.log("---".repeat(30));
					rl.prompt();
					return;
				}
			}
		}

		// Use default account if no prefix specified in multi-account mode
		if (isMultiAccount && !accountId) {
			accountId = defaultAccountId;
		}

		if (!message) {
			rl.prompt();
			return;
		}

		console.log("\n⏳ 处理中...");
		try {
			const result = await gateway.sendDirectMessage(message, accountId);
			if (result) {
				console.log(`\n🤖 Agent: ${result}`);
			} else {
				console.log("\n⚠️ 无响应");
			}
		} catch (e) {
			console.log(`\n❌ 错误: ${e}`);
		}
		console.log("---".repeat(30));
		rl.prompt();
	});

	rl.on("close", async () => {
		console.log("\n\n👋 关闭 Gateway...");
		await gateway.stop();
		process.exit(0);
	});
}

async function cmdStop(): Promise<void> {
	const { stopGatewayDaemon } = await import("./gateway");
	const stopped = await stopGatewayDaemon();
	if (stopped) {
		console.log("Gateway stopped.");
	} else {
		console.log("Gateway is not running.");
	}
}

async function cmdStatus(_configPath?: string): Promise<void> {
	const { getGatewayStatus } = await import("./gateway");
	const config = await loadConfig(_configPath);
	const status = await getGatewayStatus(config);

	console.log("Gateway Status:");
	console.log(`  Running: ${status.running}`);
	if (status.running) {
		console.log(`  PID: ${status.pid}`);
		console.log(`  Started: ${status.startedAt}`);
	} else if (status.stalePidFile) {
		console.log(`  (stale PID file removed)`);
	}
	console.log(`  Data dir: ${getDataDir(config)}`);
	const channels = Object.keys(config.channels ?? {});
	if (channels.length > 0) {
		console.log(`  Configured channels: ${channels.join(", ")}`);
	}
	const dingtalk = getDingTalkConfig(config);
	if (dingtalk?.accounts && Object.keys(dingtalk.accounts).length > 0) {
		console.log("  Accounts:");
		const accounts = status.accounts ?? [];
		for (const acc of accounts) {
			const channelIcon = acc.channelConnected ? "✅" : "❌";
			const bridgeState = acc.bridgeState ?? (acc.bridgeRunning ? "running" : "stopped");
			console.log(`    ${acc.accountId.padEnd(12)} channel=${channelIcon}  bridge=${bridgeState.padEnd(10)}`);
			// Find matching bridge stat for deeper info
			const bs = status.bridges?.find(b => b.accountId === acc.accountId);
			if (bs?.pid) {
				const circuit = bs.circuitState === "closed" ? "" : ` circuit=${bs.circuitState}`;
				console.log(`      pid=${bs.pid}  crashes=${bs.crashCount}  pending=${bs.pendingPrompts}${circuit}`);
			}
		}
	}
	if (status.scheduler) {
		console.log(`  Scheduler: ${status.scheduler.running ? "✅" : "❌"}  tasks=${status.scheduler.taskCount}`);
	}
}

async function cmdDoctor(args: string[], configPath?: string): Promise<void> {
	const { runDoctor, renderText, renderJson, applyFixes, countBySeverity } = await import("./doctor");
	const json = args.includes("--json");
	const doFix = args.includes("--fix");

	const report = await runDoctor(configPath);

	if (json) {
		console.log(renderJson(report));
	} else {
		console.log(renderText(report));
	}

	if (doFix) {
		const applied = await applyFixes(report);
		if (!json) {
			console.log("");
			if (applied.length === 0) {
				console.log("No fixable findings.");
			} else {
				console.log("Applied fixes:");
				for (const a of applied) console.log(`  - ${a}`);
			}
		}
	}

	// Exit non-zero when any error-severity finding is present, so the command
	// is usable as a health gate in scripts / service health checks.
	const counts = countBySeverity(report);
	if (counts.error > 0) process.exitCode = 1;
}

async function cmdReload(_configPath?: string): Promise<void> {
	const { getGatewayStatus } = await import("./gateway");
	const config = await loadConfig(_configPath);
	const status = await getGatewayStatus(config);
	if (!status.running || !status.pid) {
		console.log("Gateway is not running.");
		return;
	}
	process.kill(status.pid, "SIGHUP");
	console.log(`Gateway reload signalled (PID ${status.pid}).`);
}

async function cmdTestLongtask(accountId: string | undefined, args: string[]): Promise<void> {
	if (!accountId) {
		console.error("Usage: omp gateway test-longtask <accountId> [--hold-ms N] [--user-id <id>] [--simulate-stop]");
		process.exitCode = 1;
		return;
	}

	let holdMs = 35_000;
	let userId = "601590212";
	let simulateStop = false;
	for (let i = 0; i < args.length; i++) {
		const tok = args[i];
		if (tok === "--hold-ms" && args[i + 1]) {
			holdMs = Number(args[i + 1]);
			i++;
		} else if (tok === "--user-id" && args[i + 1]) {
			userId = args[i + 1]!;
			i++;
		} else if (tok === "--simulate-stop") {
			simulateStop = true;
		}
	}
	if (!Number.isFinite(holdMs) || holdMs <= 0) {
		console.error(`--hold-ms must be a positive number; got ${holdMs}`);
		process.exitCode = 1;
		return;
	}

	const { runLongTaskTest } = await import("./test-longtask");
	const result = await runLongTaskTest({ accountId, holdMs, userId, simulateStopClick: simulateStop });
	if (!result.success) {
		console.error(`[test-longtask] FAILED: ${result.error ?? "unknown error"}`);
		process.exitCode = 1;
		return;
	}
	console.log(`[test-longtask] card delivered: ${result.cardInstanceId}`);
	console.log(`[test-longtask] watcher fired: ${result.watcherFired} (events=${result.watcherEvents})`);
	if (simulateStop) {
		console.log(`[test-longtask] stop action handled: ${result.stopActionHandled}`);
		console.log(`[test-longtask] bridge.abort() returned: ${result.aborted}`);
	}
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
				await cronCreate(args.slice(1), storage);
				break;
			case "list":
				await cronList(storage, args.includes("--json"));
				break;
			case "pause":
			case "disable":
				await cronSetStatus(args[1], "disabled", storage);
				break;
			case "resume":
			case "enable":
				await cronSetStatus(args[1], "active", storage);
				break;
			case "run":
				await cronRun(args[1], storage);
				break;
			case "remove":
				await cronRemove(args[1], storage);
				break;
			case "reconcile":
				await cronReconcile(args.slice(1), storage);
				break;
			case "update":
				await cronUpdate(args.slice(1), storage);
				break;
			case "status":
				cronStatus();
				break;
			case "diagnose":
				await cronDiagnose(storage, args.includes("--json"));
				break;
			case "logs":
				await cronLogs(args[1], storage, args.includes("--json"));
				break;
			default:
				console.log(`
Cron management commands:
  pi-gateway cron create <schedule> <command...> [--name <name>] [--type shell|agent] [--deliver <channel>] [--deliver-user <id>] [--model <model>] [--provider <provider>] [--toolsets <a,b,c>] [--repeat <N>] [--source-channel <ch>] [--source-user <uid>] [--timeout-ms <ms>] [--skills <s1,s2,...>] [--retry <maxAttempts>] [--pre-script <path>]
  pi-gateway cron list [--json]
  pi-gateway cron pause <name>
  pi-gateway cron resume <name>
  pi-gateway cron run <name>
  pi-gateway cron remove <name>
  pi-gateway cron update <name> [--account <id> | --clear-account] [--deliver <channel> | --clear-deliver] [--deliver-user <id> | --clear-deliver-user] [--timeout-ms <ms>]
  pi-gateway cron reconcile [--apply]   Backfill accountId on legacy unbound tasks (dry run by default)
  pi-gateway cron status
  pi-gateway cron diagnose [--json]
  pi-gateway cron logs <name> [--json]
`);
		}
	} finally {
		storage.close();
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
	console.log(`  Config: ${status.configPath}`);
	console.log(`  Log: ${status.logPath}`);
}

// ═══════════════════════════════════════════════════════════════════════
// Install Commands (QR Device Auth for DingTalk)
// ═══════════════════════════════════════════════════════════════════════

async function cmdInstall(args: string[]): Promise<void> {
	const configIdx = args.indexOf("--config");
	const configPath = configIdx >= 0 ? args[configIdx + 1] : undefined;

	const { loadConfig, getConfigPath } = await import("./config");
	const cfgPath = configPath ?? getConfigPath();
	const existing = await loadConfig(cfgPath);

	console.log(`
========================================`);
	console.log(`  钉钉机器人安装向导`);
	console.log(`========================================`);
	console.log(`
配置文件: ${cfgPath}`);

	// Non-interactive mode
	if (!process.stdin.isTTY) {
		console.log("非交互模式，跳过。请手动编辑配置文件。");
		return;
	}

	const readline = await import("node:readline");
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	const ask = (question: string): Promise<string> => new Promise(resolve => rl.question(question, resolve));

	// Show existing accounts
	const dtConfig = existing.channels?.dingtalk ?? {};
	const existingAccounts = (dtConfig as any).accounts as Record<string, any> | undefined;
	const hasTopLevel = !!(dtConfig as any).appKey;

	console.log(`\n已配置的账号:`);
	if (hasTopLevel) {
		console.log(`  [单账号] appKey: ${(dtConfig as any).appKey}`);
	}
	if (existingAccounts && Object.keys(existingAccounts).length > 0) {
		for (const [id, acct] of Object.entries(existingAccounts)) {
			console.log(`  ${id}: appKey=${(acct as any).appKey}, model=${(acct as any).model ?? "(默认)"}`);
		}
	}
	if (!hasTopLevel && (!existingAccounts || Object.keys(existingAccounts).length === 0)) {
		console.log(`  (无)`);
	}

	console.log(`\n--- 添加/修改机器人 ---`);

	const accountId = (await ask(`账号ID (唯一标识, 如 ops/hr) []: `)).trim();
	if (!accountId) {
		console.log("\n⚠️ 账号ID不能为空，跳过。");
		rl.close();
		return;
	}

	const appKey = (await ask(`AppKey: `)).trim();
	if (!appKey) {
		console.log("\n⚠️ AppKey不能为空，跳过。");
		rl.close();
		return;
	}

	// Dedup: check if same appKey is already configured
	const allExistingKeys: string[] = [];
	if (hasTopLevel) allExistingKeys.push((dtConfig as any).appKey);
	if (existingAccounts) {
		for (const acct of Object.values(existingAccounts)) {
			allExistingKeys.push((acct as any).appKey);
		}
	}
	if (allExistingKeys.includes(appKey)) {
		console.log(`\n⚠️ AppKey "${appKey}" 已经配置过了，跳过。`);
		rl.close();
		return;
	}

	const appSecret = (await ask(`AppSecret: `)).trim();
	if (!appSecret) {
		console.log("\n⚠️ AppSecret不能为空，跳过。");
		rl.close();
		return;
	}

	const robotCode = (await ask(`RobotCode (可选, 默认同 AppKey) [${appKey}]: `)).trim() || appKey;
	// Model is configured in agentDir/.omp/config.yml (modelRoles.default)
	const agentDirInput = (await ask(`Agent 工作目录 (可选, 默认 ~/.omp/agents/${accountId}/) []: `)).trim();
	// Mission file: optional. If provided, content is seeded into <agentDir>/mission.md
	// before the skeleton runs, so the user's identity wins over the default template.
	const missionInput = (await ask(`Mission 文件 (可选, 直接回车用默认) []: `)).trim();

	rl.close();

	// Delegate agentDir creation to the public `omp agent init` handler so install
	// and the CLI share one source of truth for the skeleton layout.
	let agentDir: string;
	try {
		const initResult = await runAgentInit({
			name: accountId,
			dir: agentDirInput || undefined,
			mission: missionInput || undefined,
			json: true,
		});
		agentDir = initResult.agentDir;
		if (initResult.created) {
			console.log(`\n📁 已创建 Agent 工作目录: ${agentDir} (${initResult.filesWritten} 个文件)`);
		} else {
			console.log(`\n📁 Agent 工作目录已存在: ${agentDir}`);
		}
	} catch (err) {
		console.error(`\n❌ 创建 Agent 工作目录失败: ${(err as Error).message}`);
		process.exitCode = 1;
		return;
	}

	// Build config
	const accounts = { ...(existingAccounts ?? {}) };
	accounts[accountId] = {
		appKey,
		appSecret,
		robotCode,
		agentDir,
	};

	// Config uses accounts map (not top-level appKey/appSecret)
	const config = {
		...existing,
		channels: {
			...existing.channels,
			dingtalk: {
				enabled: true,
				dmPolicy: (dtConfig as any).dmPolicy ?? "open",
				groupPolicy: (dtConfig as any).groupPolicy ?? "allowlist",
				allowedUsers: (dtConfig as any).allowedUsers ?? [],
				allowedGroups: (dtConfig as any).allowedGroups ?? [],
				accounts,
			},
		},
	};

	await Bun.write(cfgPath, JSON.stringify(config, null, 2));

	console.log(`\n✅ 配置已写入 ${cfgPath}`);
	console.log(`   账号: ${accountId}`);
	console.log(`   AppKey: ${appKey}`);
	console.log(`   AgentDir: ${agentDir}`);
	console.log(`\n下一步：`);
	console.log(`  omp agent show ${accountId}        查看身份/工具/技能`);
	console.log(`  omp agent validate --dir ${agentDir}   校验目录结构`);
	console.log(`  omp gateway start              启动网关`);
	console.log(`  omp gateway stop               停止网关`);
	console.log(`  omp gateway service install    安装为系统服务(开机自启)`);
	console.log(`\n配置模型: 编辑 ${agentDir}/.omp/config.yml 下的 modelRoles.default`);
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

void (async () => {
	const parsedArgs = parseArgs();
	const command = parsedArgs.command;
	const subcommand = parsedArgs.subcommand;
	const args = parsedArgs.args;
	const gatewayConfigPath = parsedArgs.config;
	switch (command) {
		case "start":
			await cmdStart(gatewayConfigPath);
			break;
		case "stop":
			await cmdStop();
			break;
		case "status":
			await cmdStatus(gatewayConfigPath);
			break;
		case "doctor":
			await cmdDoctor([subcommand ?? "", ...args], gatewayConfigPath);
			break;
		case "reload":
			await cmdReload(gatewayConfigPath);
			break;
		case "config":
			await cmdConfig(gatewayConfigPath);
			break;
		case "cron":
			await cmdCron([subcommand ?? "help", ...args]);
			break;
		case "install":
		case "setup":
			await cmdInstall([subcommand ?? "", ...args]);
			break;
		case "service":
			await cmdService(subcommand);
			break;
		case "test-longtask":
			await cmdTestLongtask(subcommand, args);
			break;
		case "help":
		case "--help":
		case "-h":
			console.log(`
pi-gateway — Unified Gateway for Oh My Pi

Usage:
  pi-gateway start [--config <path>]              Start gateway in foreground
  pi-gateway stop                                  Stop gateway (via PID file)
  pi-gateway status [--config <path>]             Show gateway status & PID
  pi-gateway config [--config <path>]             Show resolved configuration
  pi-gateway reload [--config <path>]             Reload running gateway config
  pi-gateway doctor [--fix] [--json] [--config <path>]   Run health checks (and apply safe fixes with --fix)

  pi-gateway setup [--config <path>]              Interactive DingTalk credential setup
  pi-gateway install [--config <path>]            Alias for setup

  pi-gateway cron create <schedule> <cmd...>       Create a scheduled task
  pi-gateway cron list [--json]                    List all tasks
  pi-gateway cron pause <name>                     Pause a task
  pi-gateway cron resume <name>                   Resume a task
  pi-gateway cron run <name>                       Trigger a task now
  pi-gateway cron remove <name>                    Delete a task
  pi-gateway cron update <name> [--account <id> | --clear-account] [--deliver <ch> | --clear-deliver] [--deliver-user <id> | --clear-deliver-user] [--timeout-ms <ms>]   Update task fields in place
  pi-gateway cron reconcile [--apply]                  Backfill accountId on legacy unbound tasks (dry run by default)
  pi-gateway cron status                           Show scheduler status
  pi-gateway cron diagnose [--json]                Run diagnostics
  pi-gateway cron logs <name> [--json]             View execution logs

  pi-gateway service install                       Install as system service
  pi-gateway service uninstall                     Remove system service
  pi-gateway service start                         Start system service
  pi-gateway service stop                          Stop system service
  pi-gateway service status                        View service status

  pi-gateway test-longtask <accountId> [--hold-ms N] [--user-id <id>] [--simulate-stop]
                                            End-to-end long-task watcher test: bypasses the LLM
                                            with a fake RPC binary, delivers a real card with a
                                            stop block to the given DingTalk user, and (with
                                            --simulate-stop) fires a synthetic TOPIC_CARD stop
                                            click to verify the full click → abort chain.

  pi-gateway help                                  Show this help

Config file: ~/.omp/gateway.json
Environment:
  PI_LOG_LEVEL           Log level (debug|info|warn|error), default: info
  PI_GATEWAY_CONFIG      Alternative config path
`);
			break;
		default:
			console.error(`Unknown command: ${command}`);
			console.log("Run 'pi-gateway help' for usage");
			process.exit(1);
	}
})();
