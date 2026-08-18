/**
 * squad-programming bootstrap — 集结阶段机械化部分
 *
 * 作用
 * ────
 * 按任务包（.squad.json schema）把用户任务集结成一组并行子 omp：
 *   1. isolation="worktree"   → herdr worktree create（幂等，已存在则复用）+ 写 <worktree>/.squad.json
 *   2. isolation="shared-*"   → cwd 用 repo 根，brief 写到 /tmp/squad-<squadId>/<taskId>.squad.json
 *   3. 每个子任务 → herdr pane split + pane run，注入 PI_SUBAGENT_* env（注册父 edge）+ --model 档位模型
 *
 * 用法
 * ────
 *   # 只校验任务包 schema（不执行任何操作，Phase 0 的 completion 检查）
 *   bun run .omp/skills/squad-programming/scripts/bootstrap.ts --check <任务包路径>
 *
 *   # 集结（建 worktree / 写任务包 / 启动子 omp）
 *   bun run .omp/skills/squad-programming/scripts/bootstrap.ts \
 *     --bundle <任务包绝对路径> \
 *     --parent-target <父 session 名或前缀> \
 *     --parent-session-id <父 session id> \
 *     [--dry-run]
 *
 * 前置条件
 * ────────
 * - HERDR_ENV=1（Herdr 环境），herdr ≥ 0.7.5
 * - pi 在 PATH（或 PI_BIN / PI_INTERCOM_PI_BIN 指定）
 * - 脚本零依赖，不 import 任何 @oh-my-pi/* 包
 *
 * 输出：每子任务的 { taskId, isolation, worktree?, paneId, model, briefPath, command } JSON。
 * 任何 herdr/pi 命令失败 → 退出码 1（集结失败不静默继续，由父 agent 决策）。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type Gate = {
	kind: "derived" | "explicit" | "unknown";
	verifiers?: string[];
	acceptance?: string;
	mergePolicy: "auto" | "human-review";
};

type Subtask = {
	id: string;
	title: string;
	kind: "code" | "test" | "docs" | "review" | "research";
	isolation: "worktree" | "shared-read" | "shared-write";
	scope?: { files?: string[]; questions?: string[]; targets?: string[] };
	deps?: string[];
	acceptance: string;
	gate: Gate;
	modelTier?: "cheap" | "mid";
	model?: string;
	branch?: string;
	worktree?: string;
	budgetTokens?: number;
};

type Bundle = {
	squadId: string;
	taskType: string;
	baseBranch?: string;
	maxConcurrency?: number;
	modelTiers: { cheap: string; mid: string; banned?: string[] };
	parent: { target: string; sessionId?: string; cwd: string };
	subtasks: Subtask[];
	reportProtocol?: { status?: string; ask?: string };
};

const BANNED_GLOB_TIPS = ["claude-opus", "claude-sonnet"];

function fail(message: string): never {
	process.stderr.write(`${message}\n`);
	process.exit(1);
}

function isBanned(model: string, banned: string[] | undefined): boolean {
	if (!banned) return BANNED_GLOB_TIPS.some(glob => model.includes(glob));
	return banned.some(glob => model.includes(glob.replaceAll("*", "")));
}

function validateBundle(raw: unknown): Bundle {
	if (typeof raw !== "object" || raw === null) fail("任务包不是 JSON 对象");
	const b = raw as Bundle;
	if (!b.squadId || typeof b.squadId !== "string") fail("缺少 string: squadId");
	if (!b.modelTiers || typeof b.modelTiers !== "object") fail("缺少 modelTiers 表（cheap/mid）");
	if (!b.parent?.cwd || typeof b.parent.cwd !== "string") fail("缺少 parent.cwd（repo 根绝对路径）");
	if (!b.parent.target) fail("缺少 parent.target（父 session 名或 id）");
	if (!Array.isArray(b.subtasks) || b.subtasks.length === 0) fail("缺少 subtasks 数组（至少 1 个）");
	const ids = new Set<string>();
	for (const [i, s] of b.subtasks.entries()) {
		const tag = `subtasks[${i}]`;
		if (!s.id || typeof s.id !== "string") fail(`${tag} 缺少 string: id`);
		if (ids.has(s.id)) fail(`${tag} 重复 id: ${s.id}`);
		ids.add(s.id);
		if (!s.title) fail(`${tag}(${s.id}) 缺少 title`);
		if (!s.acceptance) fail(`${tag}(${s.id}) 缺少可验证的 acceptance`);
		if (!["code", "test", "docs", "review", "research"].includes(s.kind))
			fail(`${tag}(${s.id}) kind 非法: ${s.kind}`);
		if (!["worktree", "shared-read", "shared-write"].includes(s.isolation))
			fail(`${tag}(${s.id}) isolation 非法: ${s.isolation}`);
		if (!s.gate || !["derived", "explicit", "unknown"].includes(s.gate.kind))
			fail(`${tag}(${s.id}) gate.kind 非法或缺失`);
		if (s.gate.kind === "unknown" && s.gate.mergePolicy !== "human-review")
			fail(`${tag}(${s.id}) gate=unknown 必须 mergePolicy=human-review（report-only 护栏）`);
		if (s.isolation === "worktree" && !s.branch) fail(`${tag}(${s.id}) isolation=worktree 需要 branch`);
		if (s.isolation === "worktree" && !s.worktree)
			fail(`${tag}(${s.id}) isolation=worktree 需要 worktree 绝对路径`);
		if (s.modelTier && !["cheap", "mid"].includes(s.modelTier))
			fail(`${tag}(${s.id}) modelTier 非法: ${s.modelTier}`);
		const model = s.model ?? (s.modelTier ? b.modelTiers[s.modelTier] : b.modelTiers.cheap);
		if (!model) fail(`${tag}(${s.id}) 解析不出模型（model 或 modelTier→档位表）`);
		if (isBanned(model, b.modelTiers.banned)) fail(`${tag}(${s.id}) 模型在禁用清单: ${model}`);
	}
	return b;
}

function run(command: string[], options: { cwd?: string; quiet?: boolean } = {}): string {
	if (options.cwd) {
		const st = fs.statSync(options.cwd, { throwIfNoEntry: false });
		if (!st?.isDirectory()) fail(`cwd 不是目录: ${options.cwd}`);
	}
	const result = Bun.spawnSync(command, {
		cwd: options.cwd,
		env: { ...process.env } as NodeJS.ProcessEnv,
	});
	const out = String(result.stdout ?? "");
	const err = String(result.stderr ?? "");
	if (result.exitCode !== 0) {
		process.stderr.write(`命令失败 (${result.exitCode}): ${command.join(" ")}\n${err}${out}\n`);
		process.exit(1);
	}
	if (!options.quiet && out.trim()) process.stdout.write(out);
	return out;
}

function shellQuote(value: string): string {
	if (process.platform === "win32") return `"${value.replaceAll('"', '\\"')}"`;
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function envPrefix(bundle: Bundle, subtask: Subtask, index: number): string {
	const entries: Array<[string, string]> = [
		["PI_SUBAGENT_ORCHESTRATOR_TARGET", bundle.parent.target],
		["PI_SUBAGENT_ORCHESTRATOR_SESSION_ID", bundle.parent.sessionId ?? bundle.parent.target],
		["PI_SUBAGENT_RUN_ID", bundle.squadId],
		["PI_SUBAGENT_CHILD_AGENT", subtask.id],
		["PI_SUBAGENT_CHILD_INDEX", String(index)],
	];
	return `${entries.map(([k, v]) => `${k}=${shellQuote(v)}`).join(" ")} `;
}

function piBin(): string {
	return process.env.PI_INTERCOM_PI_BIN?.trim() || process.env.PI_BIN?.trim() || "pi";
}

function worktreeExists(worktreePath: string): boolean {
	const out = run(["herdr", "worktree", "list"], { quiet: true });
	return out.includes(worktreePath);
}

function createWorktree(subtask: Subtask, baseBranch: string | undefined): void {
	run(["herdr", "worktree", "create", "--branch", subtask.branch!, "--base", baseBranch ?? "main", "--path", subtask.worktree!, "--label", subtask.id, "--no-focus"], { quiet: true });
}

function launchPane(cwd: string, command: string): string {
	const json = run(["herdr", "pane", "split", "--current", "--cwd", cwd, "--no-focus"]);
	const paneId = extractPaneId(json);
	if (!paneId) fail(`pane split 未返回 pane id，输出: ${json}`);
	run(["herdr", "pane", "run", paneId, command], { quiet: true });
	return paneId;
}

function extractPaneId(json: string): string | undefined {
	try {
		const parsed = JSON.parse(json.trim());
		const result = (parsed as { result?: unknown }).result;
		if (result && typeof result === "object") {
			const rec = result as Record<string, unknown>;
			const pane = (rec.pane && typeof rec.pane === "object" ? rec.pane : rec) as Record<string, unknown>;
			for (const key of ["pane_id", "paneId", "id"]) if (typeof pane[key] === "string") return pane[key] as string;
		}
	} catch {
		/* 非 JSON 输出时下面按行回找 */
	}
	for (const line of json.trim().split(/\r?\n/).reverse()) {
		try {
			const parsed = JSON.parse(line) as { result?: { pane_id?: string; paneId?: string } };
			const id = parsed.result?.pane_id ?? parsed.result?.paneId;
			if (id) return id;
		} catch {
			/* skip */
		}
	}
	return undefined;
}

function workerBrief(bundle: Bundle, subtask: Subtask, model: string, briefPath: string): string {
	const lines = [
		`你是 ${subtask.id}（${subtask.title}）的实现者，属于 squad ${bundle.squadId} 的 worker。`,
		`第一步：读 ${shellQuote(briefPath)} 的任务包（.squad.json），完整理解任务、scope、gate、汇报协议、模型档位。`,
		`规则：只改 scope 内文件；求助用 intercom ask（不带 to，自动路由父）；`,
		`状态用 intercom send 给 ${bundle.parent.target}，格式 "[${subtask.id}] <STATE>: 一句话"（STATE ∈ STARTED/BLOCKED/REVIEWING/COMPLETE/FAILED）；`,
		`模型不在 ${model} 档位先 switch_model；完成标准见任务包 acceptance。开始。`,
	];
	return lines.join(" ");
}

function resolveModel(bundle: Bundle, subtask: Subtask): string {
	return subtask.model ?? (subtask.modelTier ? bundle.modelTiers[subtask.modelTier] : bundle.modelTiers.cheap);
}

function writeJson(file: string, data: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

function main(): void {
	const argv = process.argv.slice(2);
	if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
		process.stdout.write(
			[
				"squad-programming bootstrap — 集结阶段机械化部分",
				"",
				"用法:",
				"  --check <bundle>           只校验任务包 schema（Phase 0 completion 检查）",
				"  --bundle <bundle>          任务包绝对路径（集结）",
				"  --parent-target <id>       父 session 名或前缀（PI_SUBAGENT_ORCHESTRATOR_TARGET）",
				"  --parent-session-id <id>   父 session id（PI_SUBAGENT_ORCHESTRATOR_SESSION_ID）",
				"  --dry-run                  只打印将执行的命令，不执行",
				"",
				"示例:",
				"  bun run .omp/skills/squad-programming/scripts/bootstrap.ts --check /tmp/bundle.json",
				"  bun run .omp/skills/squad-programming/scripts/bootstrap.ts --bundle /tmp/bundle.json --parent-target planner --parent-session-id abc123",
			].join("\n") + "\n",
		);
		return;
	}

	const checkOnly = argv.includes("--check");
	const dryRun = argv.includes("--dry-run");

	function flagValue(name: string): string | undefined {
		const i = argv.indexOf(name);
		return i >= 0 && i + 1 < argv.length ? argv[i + 1]! : undefined;
	}

	const checkBundlePath = flagValue("--check") ?? flagValue("--bundle");
	if (!checkBundlePath) fail("需要 --check <bundle> 或 --bundle <bundle>");

	const bundlePath = path.resolve(checkBundlePath);
	let raw: string;
	try {
		raw = fs.readFileSync(bundlePath, "utf8");
	} catch {
		fail(`任务包文件不可读: ${bundlePath}`);
	}
	const bundle = validateBundle(JSON.parse(raw));

	if (checkOnly) {
		process.stdout.write(`任务包校验通过: ${bundle.squadId}（${bundle.subtasks.length} 个子任务）\n`);
		return;
	}

	const parentTarget = flagValue("--parent-target");
	const parentSessionId = flagValue("--parent-session-id");
	if (!parentTarget) fail("集结需要 --parent-target <父 session 名或 id>");

	if (process.env.HERDR_ENV !== "1") {
		process.stderr.write("警告: HERDR_ENV != 1，herdr pane/worktree 命令可能不可用；继续执行\n");
	}

	const result: unknown[] = [];
	const tmpDir = path.join(os.tmpdir(), `squad-${bundle.squadId}`);
	if (!dryRun) fs.mkdirSync(tmpDir, { recursive: true });

	bundle.subtasks.forEach((subtask, index) => {
		const model = resolveModel(bundle, subtask);
		if (isBanned(model, bundle.modelTiers.banned))
			fail(`${subtask.id} 模型在禁用清单: ${model}（需用户拍板放行）`);

		let cwd: string;
		let briefPath: string;
		if (subtask.isolation === "worktree") {
			cwd = subtask.worktree!;
			briefPath = path.join(cwd, ".squad.json");
			if (!dryRun) {
				if (!worktreeExists(cwd)) createWorktree(subtask, bundle.baseBranch);
				writeJson(briefPath, bundle);
			}
		} else {
			cwd = bundle.parent.cwd;
			briefPath = path.join(tmpDir, `${subtask.id}.squad.json`);
			if (!dryRun) writeJson(briefPath, bundle);
		}

		const command = `${envPrefix(bundle, subtask, index)}${shellQuote(piBin())} --model ${shellQuote(model)} ${shellQuote(workerBrief(bundle, subtask, model, briefPath))}`;
		if (dryRun) {
			result.push({ taskId: subtask.id, isolation: subtask.isolation, cwd, worktree: subtask.worktree ?? null, briefPath, dryRunCommand: command });
			return;
		}
		const paneId = launchPane(cwd, command);
		result.push({ taskId: subtask.id, isolation: subtask.isolation, cwd, worktree: subtask.worktree ?? null, briefPath, paneId, model });
	});

	process.stdout.write(JSON.stringify({ squadId: bundle.squadId, launched: result }, null, 2) + "\n");
	const worktrees = result.filter(r => (r as { worktree?: string }).worktree).length;
	process.stderr.write(
		`集结完成: ${result.length} 个子任务（${worktrees} 个 worktree / ${result.length - worktrees} 个共享区）\n` +
			`父 agent 用 intercom({action:"children"}) 确认全部上线后进入 Phase 2。\n`,
	);
}

main();