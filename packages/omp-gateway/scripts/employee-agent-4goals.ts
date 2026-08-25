/**
 * 员工个人 agent 4 目标引擎配置生成器（B3，D9）。
 *
 * 为指定员工 agent（gateway 账号）生成 4 个确定性目标的常驻运行配置：
 *   1. 钉钉 context 摄入（每日 cron，agent 型任务）
 *   2. 知识库定期刷新（每日 cron）
 *   3. 画像保鲜（每周 cron，带质量准入：证据/备份/diff）
 *   4. 业务进展秒答（对话能力，无需 cron；契约写入 mission.md）
 *
 * 同时把「4 目标契约」幂等追加到 agentDir/mission.md（prompt-includes.json
 * always-on 注入），agent 在日常对话中知晓自身 4 目标。
 *
 * 用法：
 *   bun run packages/omp-gateway/scripts/employee-agent-4goals.ts --account hr
 *   bun run packages/omp-gateway/scripts/employee-agent-4goals.ts --account hr --dry-run
 *   bun run packages/omp-gateway/scripts/employee-agent-4goals.ts --account hr --gateway-json ~/.omp/gateway.json
 *   bun run packages/omp-gateway/scripts/employee-agent-4goals.ts --account hr --mission-only
 *
 * 幂等：同名 cron 任务已存在则跳过；mission.md 含 4 目标锚标记则跳过。
 * 平台能力依赖：gateway scheduler agent 型任务（已存在，daily-kb-sync 等实测在跑）。
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { cronCreate, cronList } from "../src/scheduler/cli-commands";
import { JsonFileStorage } from "../src/scheduler/json-file-storage";

const MISSION_ANCHOR = "<!-- omp-4goals -->";

/** 4 目标 cron 任务模板（agent 型，command 为 agent 自然语言指令）。 */
const GOAL_TASKS: ReadonlyArray<{
	name: string;
	schedule: string;
	command: string;
	timeoutMs: number;
}> = [
	{
		name: "goal-1-context-intake",
		schedule: "0 8 * * *",
		command:
			"执行员工个人 agent 目标 1（钉钉 context 摄入）：用 dws 拉取本人昨天的钉钉会话/文档/工作动态，" +
			"提炼工作上下文（正在进行的事项、决策、待办、关键人物动态），写入 <agentDir>/context/YYYY-MM-DD.md，" +
			"并把增量信息并入长期 context 摘要（context/summary.md）。输出一行摘要推送给用户。",
		timeoutMs: 300000,
	},
	{
		name: "goal-2-kb-refresh",
		schedule: "0 12 * * *",
		command:
			"执行员工个人 agent 目标 2（知识库定期刷新）：扫描个人知识库目录的过期/空窗文件，" +
			"刷新知识库索引（projects/、knowledge/ 下文件），更新 KB 状态与外部链接有效性检查。" +
			"输出变更摘要推送给用户；无变更则静默。",
		timeoutMs: 300000,
	},
	{
		name: "goal-3-profile-freshness",
		schedule: "0 9 * * 1",
		command:
			"执行员工个人 agent 目标 3（画像保鲜）：回顾本周 session/对话记录，更新 mission.md 与 user.md。" +
			"质量准入：① 只改有证据支持的内容（引用本周具体事件）；② 更新前备份旧版到 .backup/；" +
			"③ 不确定的信息保留旧值不臆造；④ 变更后输出 diff 摘要推送给用户。禁止无依据改写。",
		timeoutMs: 300000,
	},
];

/** mission.md 4 目标契约（幂等追加）。 */
function goalContractMarkdown(): string {
	return [
		"",
		"## 4 个确定性目标（员工个人 agent）",
		MISSION_ANCHOR,
		"",
		"> 常驻运行（cron 驱动），非按需响应。日常对话中也应主动服务于这 4 个目标。",
		"",
		"1. **钉钉 context**：经 dws 获取本人 context（会话/文档/工作动态），维护 `context/` 摘要（每日 goal-1-context-intake）。",
		"2. **知识库定期刷新**：定期更新个人知识库与索引（每日 goal-2-kb-refresh）。",
		"3. **画像保鲜**：持续更新 mission.md 与 user.md，带质量准入（证据/备份/diff，每周 goal-3-profile-freshness）。",
		"4. **业务进展秒答**：任何业务进展问题快速回答（数据来自 context/ 摘要与知识库，不臆造）。",
		"",
	].join("\n");
}

async function loadGatewayJson(gatewayJson: string): Promise<Record<string, unknown>> {
	try {
		return await Bun.file(gatewayJson).json();
	} catch (err) {
		const e = err as NodeJS.ErrnoException;
		if (e.code === "ENOENT") throw new Error(`gateway.json 不存在: ${gatewayJson}`);
		throw err;
	}
}

/** 从 gateway.json 解析账号的 agentDir（dingtalk.accounts.<id>.agentDir）。 */
async function resolveAgentDir(gatewayJsonPath: string, accountId: string): Promise<string> {
	const gw = (await loadGatewayJson(gatewayJsonPath)) as {
		channels?: { dingtalk?: { accounts?: Record<string, { agentDir?: string }> } };
	};
	const agentDir = gw.channels?.dingtalk?.accounts?.[accountId]?.agentDir;
	if (!agentDir) {
		throw new Error(
			`gateway.json 中未找到账号 "${accountId}" 的 agentDir（channels.dingtalk.accounts.${accountId}.agentDir）。`,
		);
	}
	return path.resolve(os.homedir(), agentDir.replace(/^~/, ""));
}

async function upsertMissionContract(agentDir: string, dryRun: boolean): Promise<boolean> {
	const missionPath = path.join(agentDir, "mission.md");
	let content = "";
	try {
		content = await Bun.file(missionPath).text();
	} catch (err) {
		const e = err as NodeJS.ErrnoException;
		if (e.code !== "ENOENT") throw err;
	}
	if (content.includes(MISSION_ANCHOR)) {
		console.log(`mission.md 已含 4 目标契约（${missionPath}），跳过`);
		return false;
	}
	if (dryRun) {
		console.log(`[dry-run] 将向 ${missionPath} 追加 4 目标契约`);
		return true;
	}
	const updated = `${content.trimEnd()}\n${goalContractMarkdown()}`;
	await fs.mkdir(path.dirname(missionPath), { recursive: true });
	await fs.writeFile(missionPath, updated, "utf8");
	console.log(`mission.md 4 目标契约已追加（${missionPath}）`);
	return true;
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	let accountId: string | undefined;
	let gatewayJson = path.join(os.homedir(), ".omp/gateway.json");
	let dryRun = false;
	let missionOnly = false;

	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		if (a === "--account" && argv[i + 1]) {
			accountId = argv[++i]!;
		} else if (a === "--gateway-json" && argv[i + 1]) {
			gatewayJson = argv[++i]!;
		} else if (a === "--dry-run") {
			dryRun = true;
		} else if (a === "--mission-only") {
			missionOnly = true;
		} else {
			console.error(`未知参数: ${a}`);
			process.exit(1);
		}
	}
	if (!accountId) {
		console.error("用法: employee-agent-4goals.ts --account <id> [--dry-run] [--mission-only] [--gateway-json <path>]");
		process.exit(1);
	}

	const agentDir = await resolveAgentDir(gatewayJson, accountId);
	console.log(`账号: ${accountId}\nagentDir: ${agentDir}`);

	const storage = new JsonFileStorage();
	await upsertMissionContract(agentDir, dryRun);
	if (missionOnly) return;

	const existing = storage.listTasks();
	const existingNames = new Set(existing.map(t => t.name));

	for (const goal of GOAL_TASKS) {
		if (existingNames.has(goal.name)) {
			console.log(`cron 任务已存在，跳过: ${goal.name}`);
			continue;
		}
		const args = [
			goal.schedule,
			goal.command,
			"--name",
			goal.name,
			"--type",
			"agent",
			"--account",
			accountId,
			"--agent-dir",
			agentDir,
			"--deliver",
			"dingtalk",
			"--deliver-user",
			"601590212",
			"--timeout-ms",
			String(goal.timeoutMs),
		];
		if (dryRun) {
			console.log(`[dry-run] 将创建 cron 任务: ${goal.name} (${goal.schedule})`);
		} else {
			await cronCreate(args, storage);
			console.log(`cron 任务已创建: ${goal.name} (${goal.schedule})`);
		}
	}
}

await main();
