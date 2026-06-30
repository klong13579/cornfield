/**
 * Interactive DingTalk setup wizard.
 *
 * Replaces `pi-gateway install` / `omp gateway setup` legacy behavior. Walks
 * the user through accountId, AppKey, AppSecret, RobotCode, agentDir and
 * (optional) mission file, then writes a complete gateway config to disk.
 *
 * Invariants:
 *   - TTY prompt is the only input path. `nonInteractive: true` (or
 *     `!process.stdin.isTTY`) prints a "edit the file manually" hint and
 *     returns `{ ok: false, reason: "non-interactive" }`.
 *   - agentDir creation delegates to `runAgentInit` so the skeleton
 *     layout stays in lockstep with `omp agent init`.
 *   - AppKey dedup is enforced before prompting for AppSecret so we
 *     don't gather credentials we'd then refuse to use.
 */

import { runAgentInit } from "@oh-my-pi/pi-coding-agent/cli/agent-cli";
import type { DingtalkAccountConfig } from "./types";
import { getConfigPath, loadConfig } from "./config";

export interface SetupOptions {
	configPath?: string;
	nonInteractive?: boolean;
}

export type SetupResult =
	| { ok: true; accountId: string; agentDir: string; configPath: string; createdAccount: boolean }
	| { ok: false; reason: SetupSkipReason; message: string };

export type SetupSkipReason =
	| "non-interactive"
	| "missing-account-id"
	| "missing-app-key"
	| "missing-app-secret"
	| "duplicate-app-key"
	| "error";

export async function runInteractiveSetup(opts: SetupOptions = {}): Promise<SetupResult> {
	const cfgPath = opts.configPath ?? getConfigPath();
	let existing: Record<string, unknown>;
	try {
		// loadConfig returns GatewayConfig; we re-shape it as a plain object
		// so we can spread existing fields and overlay the new dingtalk config
		// without TypeScript narrowing the rest of the shape.
		existing = (await loadConfig(opts.configPath)) as unknown as Record<string, unknown>;
	} catch (err) {
		// loadConfig throws on parse error — surface as a structured skip.
		return {
			ok: false,
			reason: "error",
			message: `Failed to load existing config at ${cfgPath}: ${(err as Error).message}`,
		};
	}

	console.log(`
========================================`);
	console.log(`  钉钉机器人安装向导`);
	console.log(`========================================`);
	console.log(`
配置文件: ${cfgPath}`);

	if (opts.nonInteractive || !process.stdin.isTTY) {
		console.log("非交互模式，跳过。请手动编辑配置文件。");
		return {
			ok: false,
			reason: "non-interactive",
			message: "Run without --non-interactive on a TTY, or edit gateway.json directly.",
		};
	}

	const readline = await import("node:readline");
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	const ask = (question: string): Promise<string> => new Promise(resolve => rl.question(question, resolve));

	// Show existing accounts
	const dtConfig = (existing.channels as Record<string, unknown> | undefined)?.dingtalk as
		| Record<string, unknown>
		| undefined;
	const existingAccounts = dtConfig?.accounts as Record<string, { appKey?: string; model?: string }> | undefined;
	const hasTopLevel = !!(dtConfig as { appKey?: string } | undefined)?.appKey;

	console.log(`\n已配置的账号:`);
	if (hasTopLevel) {
		console.log(`  [单账号] appKey: ${(dtConfig as { appKey: string }).appKey}`);
	}
	if (existingAccounts && Object.keys(existingAccounts).length > 0) {
		for (const [id, acct] of Object.entries(existingAccounts)) {
			console.log(`  ${id}: appKey=${acct.appKey}, model=${acct.model ?? "(默认)"}`);
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
		return { ok: false, reason: "missing-account-id", message: "Account id is required." };
	}

	const appKey = (await ask(`AppKey: `)).trim();
	if (!appKey) {
		console.log("\n⚠️ AppKey不能为空，跳过。");
		rl.close();
		return { ok: false, reason: "missing-app-key", message: "AppKey is required." };
	}

	// Dedup: check if same appKey is already configured
	const allExistingKeys: string[] = [];
	if (hasTopLevel) allExistingKeys.push((dtConfig as { appKey: string }).appKey);
	if (existingAccounts) {
		for (const acct of Object.values(existingAccounts)) {
			if (acct.appKey) allExistingKeys.push(acct.appKey);
		}
	}
	if (allExistingKeys.includes(appKey)) {
		console.log(`\n⚠️ AppKey "${appKey}" 已经配置过了，跳过。`);
		rl.close();
		return {
			ok: false,
			reason: "duplicate-app-key",
			message: `AppKey "${appKey}" already configured.`,
		};
	}

	const appSecret = (await ask(`AppSecret: `)).trim();
	if (!appSecret) {
		console.log("\n⚠️ AppSecret不能为空，跳过。");
		rl.close();
		return { ok: false, reason: "missing-app-secret", message: "AppSecret is required." };
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
		return {
			ok: false,
			reason: "error",
			message: `Failed to create agent dir: ${(err as Error).message}`,
		};
	}

	// Build config. The existing map may have been read through `unknown`
	// (we only narrowed it to a partial shape for dedup), so widen via
	// spread + cast for the type-safe assignment below.
	const existingAccountMap = (existingAccounts ?? {}) as Record<string, DingtalkAccountConfig>;
	const accounts: Record<string, DingtalkAccountConfig> = { ...existingAccountMap };
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
			...((existing.channels as Record<string, unknown> | undefined) ?? {}),
			dingtalk: {
				enabled: true,
				dmPolicy: (dtConfig as { dmPolicy?: string } | undefined)?.dmPolicy ?? "open",
				groupPolicy: (dtConfig as { groupPolicy?: string } | undefined)?.groupPolicy ?? "allowlist",
				allowedUsers: (dtConfig as { allowedUsers?: unknown[] } | undefined)?.allowedUsers ?? [],
				allowedGroups: (dtConfig as { allowedGroups?: unknown[] } | undefined)?.allowedGroups ?? [],
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

	return { ok: true, accountId, agentDir, configPath: cfgPath, createdAccount: true };
}
