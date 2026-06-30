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
import { ZodError } from "zod";
import type { DingTalkConfig, DingtalkAccountConfig, GatewayConfig } from "./types";
import { getConfigPath, loadConfig, validateAndNormalizeConfig } from "./config";

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
	| "invalid-merged-config"
	| "error";

export async function runInteractiveSetup(opts: SetupOptions = {}): Promise<SetupResult> {
	const cfgPath = opts.configPath ?? getConfigPath();
	let existing: GatewayConfig;
	try {
		// loadConfig returns GatewayConfig; on missing/parse-error it falls back
		// to DEFAULT_CONFIG so the wizard always has a base shape to extend.
		existing = await loadConfig(opts.configPath);
	} catch (err) {
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

	// Show existing accounts. `existing.channels.dingtalk` is a typed
	// DingTalkConfig | undefined — no casts needed.
	const dtConfig: DingTalkConfig | undefined = existing.channels.dingtalk;
	const existingAccounts: Record<string, DingtalkAccountConfig> = dtConfig?.accounts ?? {};
	const hasTopLevel = !!dtConfig?.appKey;

	console.log(`\n已配置的账号:`);
	if (hasTopLevel) {
		console.log(`  [单账号] appKey: ${dtConfig?.appKey}`);
	}
	if (Object.keys(existingAccounts).length > 0) {
		for (const [id, acct] of Object.entries(existingAccounts)) {
			console.log(`  ${id}: appKey=${acct.appKey}, model=${(acct as { model?: string }).model ?? "(默认)"}`);
		}
	}
	if (!hasTopLevel && Object.keys(existingAccounts).length === 0) {
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
	if (hasTopLevel && dtConfig?.appKey) allExistingKeys.push(dtConfig.appKey);
	for (const acct of Object.values(existingAccounts)) {
		if (acct.appKey) allExistingKeys.push(acct.appKey);
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

	// Build the new dingtalk channel. Preserve existing policies and ACLs
	// (allowedUsers / allowedGroups) so the wizard is a no-op for those fields.
	const accounts: Record<string, DingtalkAccountConfig> = { ...existingAccounts };
	accounts[accountId] = {
		appKey,
		appSecret,
		robotCode,
		agentDir,
	};

	const mergedRaw = {
		...existing,
		channels: {
			...existing.channels,
			dingtalk: {
				enabled: true,
				dmPolicy: dtConfig?.dmPolicy ?? "open",
				groupPolicy: dtConfig?.groupPolicy ?? "allowlist",
				allowedUsers: dtConfig?.allowedUsers ?? [],
				allowedGroups: dtConfig?.allowedGroups ?? [],
				accounts,
			},
		},
	};

	// Validate the merged shape against gatewayConfigSchema. If the merged
	// object fails the schema (e.g. because existing config has fields that
	// were valid in an older schema version but aren't anymore), we refuse
	// to write a config that loadConfig() would silently replace with
	// DEFAULT_CONFIG on the next read — that path is a data-loss footgun.
	let normalized: GatewayConfig;
	try {
		normalized = validateAndNormalizeConfig(mergedRaw);
	} catch (err) {
		const issues =
			err instanceof ZodError
				? err.issues.map(i => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n")
				: (err as Error).message;
		console.error(`\n❌ 合并后的 config 不通过 schema 校验，拒绝写入 ${cfgPath}:`);
		console.error(issues);
		console.error("\n请手动编辑 gateway.json 修复上述问题后再试。");
		return {
			ok: false,
			reason: "invalid-merged-config",
			message: `Merged config failed schema validation; not written. ${issues}`,
		};
	}

	// Write the NORMALIZED form (defaults filled in, fields renamed) rather
	// than the raw merge — keeps the file consistent with what loadConfig
	// would have produced from it.
	await Bun.write(cfgPath, JSON.stringify(normalized, null, 2));

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
