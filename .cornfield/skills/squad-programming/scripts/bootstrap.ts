/**
 * squad-programming bootstrap — 集结阶段机械化部分
 *
 * 作用
 * ────
 * 按任务包（.squad.json schema）把用户任务集结成一组并行子 omp（最终形态，全链真实验证）：
 *   1. 父 workspace 改名任务包名（label=squadId，父 pane 所在 workspace 即任务包 workspace）
 *   2. isolation="worktree" → herdr worktree create（按任务名建树节点：分支/目录 = id 小写，
 *      label = "T<n> · <title 前 18 字>"），返回节点 workspace + pane —— Spaces 面板在父下挂树
 *   3. 每个子任务在其树节点 pane 上起 worker：bash -c 'export PI_SUBAGENT_*; exec omp --model <档> <brief>'
 *      —— exec 直启（agent 登记必需）；env 注入走 shell export（tab create --env 破坏 pane prompt）
 *   4. isolation="shared-*" → 父 workspace 内 tab create + 同款 worker 启动
 *   5. 启动后准备检查：轮询 herdr agent list 确认每个 pane 的 omp 已登记（agent.start 实验不稳定，不用）
 *
 * 用法
 * ────
 *   # 只校验任务包 schema（不执行任何操作，Phase 0 的 completion 检查）
 *   bun run .cornfield/skills/squad-programming/scripts/bootstrap.ts --check <任务包路径>
 *
 *   # 集结（建 worktree / 写任务包 / 启动子 omp + 启动后准备检查）
 *   bun run .cornfield/skills/squad-programming/scripts/bootstrap.ts \
 *     --bundle <任务包绝对路径> \
 *     --parent-target <父 session 名或前缀> \
 *     --parent-session-id <父 session id> \
 *     [--dry-run] [--skip-verify] [--verify-timeout <ms>]
 *
 * 前置条件
 * ────────
 * - HERDR_ENV=1（Herdr 环境），herdr ≥ 0.7.5（tab create 支持 --workspace）
 * - omp 在 PATH（或 OMP_BIN 指定）。不读 PI_INTERCOM_PI_BIN —— 那是旧 pi CLI，认证栈与本仓库不互通
 * - 脚本零依赖，不 import 任何 @oh-my-pi/* 包
 *
 * 输出：{ squadId, launched: [{ taskId, isolation, worktree?, paneId, model, briefPath }], verify } JSON。
 * 任何 herdr/omp 命令失败 / 准备检查未通过 → 退出码 1（集结失败不静默继续，由父 agent 决策）。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { statePath, writeState, type SquadState, type SubtaskState } from "./squad-state.ts";

/** 当前任务包 schema 版本。与 bundle.squadVersion 比对，不匹配则拒绝。v2：reportProtocol.ask 强制 ask-with-to + deps 结构校验。 */
const CURRENT_SQUAD_VERSION = 2;

const VALID_TIERS = ["cheap", "mid", "high"] as const;

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
	modelTier?: "cheap" | "mid" | "high";
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
	squadVersion?: number;
	modelTiers: { cheap: string; mid: string; high?: string; banned?: string[] };
	parent: { target: string; sessionId?: string; name?: string; cwd?: string };
	subtasks: Subtask[];
	reportProtocol?: { status?: string; ask?: string };
};

const BANNED_GLOB_TIPS = ["claude-opus", "claude-sonnet"];

function fail(message: string): never {
	process.stderr.write(`${message}\n`);
	process.exit(1);
}

/** 档位等级：cheap=0 < mid=1 < high=2。数值越大越高级。 */
const TIER_ORDER: Record<string, number> = { cheap: 0, mid: 1, high: 2 };

function isBanned(model: string, banned: string[] | undefined): boolean {
	if (!banned) return BANNED_GLOB_TIPS.some(glob => model.includes(glob));
	return banned.some(glob => model.includes(glob.replaceAll("*", "")));
}

/**
 * 将模型字符串映射到档位标签（cheap/mid/high）。
 * 在 modelTiers 表里逐项匹配值；不在标准档位表时返回 undefined。
 */
function resolveTierLabel(model: string, tiers: Bundle["modelTiers"]): string | undefined {
	for (const [tier, tierModel] of Object.entries(tiers)) {
		if (tier === "banned") continue;
		if (typeof tierModel === "string" && model === tierModel) return tier;
	}
	return undefined;
}

/**
 * 校验父模型 >= 所有子模型的档位。
 * 父模型不在标准档位表时跳过（假设为高级模型）。
 * 子模型不在标准档位表时跳过（无法判断档位时不拦）。
 */
function validateParentModel(parentModel: string, bundle: Bundle): void {
	const parentTier = resolveTierLabel(parentModel, bundle.modelTiers);
	if (!parentTier) return; // 父模型不在标准档位表，假设 >= high
	const parentLevel = TIER_ORDER[parentTier] ?? 2;

	for (const s of bundle.subtasks) {
		const childModel = resolveModel(bundle, s);
		if (!childModel) continue;
		const childTier = resolveTierLabel(childModel, bundle.modelTiers);
		if (!childTier) continue; // 子模型不在标准档位表，跳过
		const childLevel = TIER_ORDER[childTier] ?? 2;
		if (childLevel > parentLevel) {
			fail(
				`${s.id} 模型档位（${childTier}）高于父模型档位（${parentTier}），` +
				`父模型必须 >= 子模型（当前父: ${parentModel} = ${parentTier}, 子: ${childModel} = ${childTier}）`,
			);
		}
	}
}

function validateBundle(raw: unknown): Bundle {
	if (typeof raw !== "object" || raw === null) fail("任务包不是 JSON 对象");
	const b = raw as Bundle;
	if (!b.squadId || typeof b.squadId !== "string") fail("缺少 string: squadId");
	// 版本校验
	if (b.squadVersion === undefined || b.squadVersion === null)
		fail(`缺少 squadVersion（当前版本 ${CURRENT_SQUAD_VERSION}）`);
	if (typeof b.squadVersion !== "number" || !Number.isInteger(b.squadVersion))
		fail(`squadVersion 必须是整数，收到: ${JSON.stringify(b.squadVersion)}`);
	if (b.squadVersion !== CURRENT_SQUAD_VERSION)
		fail(`squadVersion 不匹配：任务包 ${b.squadVersion}，脚本要求 ${CURRENT_SQUAD_VERSION}（请重新生成任务包）`);
	if (!b.modelTiers || typeof b.modelTiers !== "object") fail("缺少 modelTiers 表（cheap/mid）");
	if (!b.parent || typeof b.parent !== "object") fail("缺少 parent（target 必填，cwd 可选）");
	if (!b.parent.target) fail("缺少 parent.target（父 session 名或 id）");
	if (b.parent.cwd !== undefined && typeof b.parent.cwd !== "string") fail("parent.cwd 必须是字符串绝对路径");
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
		// worktree 字段可选：缺省时按 <父cwd>/.worktrees/<branch> 自动推导（见 resolveWorktree）
		if (s.modelTier && !(VALID_TIERS as readonly string[]).includes(s.modelTier))
			fail(`${tag}(${s.id}) modelTier 非法: ${s.modelTier}（可选: ${VALID_TIERS.join(" | ")}）`);
		const model = resolveModel(b, s);
		if (!model) fail(`${tag}(${s.id}) 解析不出模型（model 或 modelTier→档位表）`);
		if (isBanned(model, b.modelTiers.banned)) fail(`${tag}(${s.id}) 模型在禁用清单: ${model}`);
	}
	// deps 结构校验：引用存在、不自指、无环（环 = reconcile 永远等不到 GO，集结前拒掉）
	for (const [i, s] of b.subtasks.entries()) {
		for (const dep of s.deps ?? []) {
			if (dep === s.id) fail(`subtasks[${i}](${s.id}) deps 不允许自指: ${dep}`);
			if (!ids.has(dep)) fail(`subtasks[${i}](${s.id}) deps 引用了不存在的子任务: ${dep}`);
		}
	}
	const cycle = detectDepsCycle(b.subtasks);
	if (cycle) fail(`subtasks deps 存在循环依赖: ${cycle}——顺序依赖必须合并为同一执行序列（见 SKILL.md Step 0.2）`);
	// reportProtocol 校验：ask 必须 ask-with-to（不带 to 的 ask 按 cwd 路由，实测误投同目录其他会话）
	if (b.reportProtocol) {
		if (b.reportProtocol.status !== undefined && b.reportProtocol.status !== "send")
			fail(`reportProtocol.status 非法: ${b.reportProtocol.status}（状态汇报只支持 send）`);
		if (b.reportProtocol.ask !== undefined && b.reportProtocol.ask !== "ask-with-to")
			fail(`reportProtocol.ask 非法: ${b.reportProtocol.ask}（必须 ask-with-to——ask 不带 to 实测会误投同目录其他会话，见 SKILL.md Phase 2）`);
	}
	return b;
}

/** 检测 subtasks deps 环；有环返回环路径描述（A -> B -> A），无环返回 null。 */
function detectDepsCycle(subtasks: Subtask[]): string | null {
	const depsOf = new Map(subtasks.map(s => [s.id, s.deps ?? []]));
	const color = new Map<string, 0 | 1 | 2>(); // 0=未访 1=在栈 2=完成
	const stack: string[] = [];
	const visit = (id: string): string | null => {
		color.set(id, 1);
		stack.push(id);
		for (const dep of depsOf.get(id) ?? []) {
			const c = color.get(dep) ?? 0;
			if (c === 1) {
				const start = stack.indexOf(dep);
				return [...stack.slice(start), dep].join(" -> ");
			}
			if (c === 0) {
				const found = visit(dep);
				if (found) return found;
			}
		}
		color.set(id, 2);
		stack.pop();
		return null;
	};
	for (const s of subtasks) {
		if ((color.get(s.id) ?? 0) === 0) {
			const found = visit(s.id);
			if (found) return found;
		}
	}
	return null;
}

const DEFAULT_RUN_TIMEOUT_MS = 30_000;

// herdr CLI/socket 错误信封：{ "id": …, "error": { "code", "message", "kind" } }
// 失败时优先提炼这个，而不是无脑贴整段输出。
function describeHerdrError(raw: string): string {
	for (const line of raw.split(/\r?\n/).reverse().slice(0, 8)) {
		try {
			const parsed = JSON.parse(line) as { error?: { code?: unknown; message?: string; kind?: string } };
			if (parsed.error && parsed.error.message) {
				const code = typeof parsed.error.code === "string" ? parsed.error.code : undefined;
				return `${parsed.error.kind ?? "herdr"}: ${parsed.error.message}${code ? ` (code=${code})` : ""}`;
			}
		} catch {
			/* 非 JSON 行跳过 */
		}
	}
	return raw.trim().slice(0, 400) || "(无输出)";
}

// herdr CLI 每次调用 = socket 一请求一连接；命令可能因 socket 挂起而卡死。
// Bun 的 spawn(Async)/spawnSync timeoutMs 在本环境不生效（实测 1.3.14），
// 所以自己用 Promise.race 做超时 + kill。
async function run(command: string[], options: { cwd?: string; quiet?: boolean; timeoutMs?: number; fatal?: boolean } = {}): Promise<string> {
	if (options.cwd) {
		const st = fs.statSync(options.cwd, { throwIfNoEntry: false });
		if (!st?.isDirectory()) fail(`cwd 不是目录: ${options.cwd}`);
	}
	const timeoutMs = options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
	const proc = Bun.spawn(command, {
		cwd: options.cwd,
		env: { ...process.env } as NodeJS.ProcessEnv,
		stdout: "pipe",
		stderr: "pipe",
	});
	const timedOut = await Promise.race([
		proc.exited.then(() => false),
		Bun.sleep(timeoutMs).then(() => {
			proc.kill();
			return true;
		}),
	]);
	const out = await new Response(proc.stdout).text();
	const err = await new Response(proc.stderr).text();
	if (timedOut || proc.exitCode !== 0) {
		const headline = timedOut
			? `命令超时 (${Math.round(timeoutMs / 1000)}s): ${command.join(" ")}`
			: `命令失败 (${proc.exitCode}): ${command.join(" ")}`;
		const detail = describeHerdrError(err + out);
		if (options.fatal === false) {
			process.stderr.write(`${headline}\n${detail}\n`);
			throw new Error(detail);
		}
		process.stderr.write(`${headline}\n${detail}\n`);
		process.exit(1);
	}
	if (!options.quiet && out.trim()) process.stdout.write(out);
	return out;
}

// 版本门：tab create --workspace 需要 herdr >= 0.8.0（socket protocol 19）。
// 提前 fail 而不是集结到一半才发现接口不认。
async function assertHerdrVersion(): Promise<void> {
	const out = (await run(["herdr", "--version"], { quiet: true, timeoutMs: 10_000 })).trim();
	const m = /herdr\s+(\d+)\.(\d+)/.exec(out);
	const versionOk = m !== null && (Number(m[1]) >= 1 || Number(m[2]) >= 8);
	if (!versionOk) fail(`herdr 版本不支持（${out || "无法解析"}）—— tab create --workspace 需要 herdr >= 0.8.0`);
}

function shellQuote(value: string): string {
	if (process.platform === "win32") return `"${value.replaceAll('"', '\\"')}"`;
	return `'${value.replaceAll("'", "'\\''")}'`;
}

const VERIFY_POLL_MS = 2000;

// 启动失败信号：shell/Bun 在 omp 无法启动时的确定性报错（无法从启动 brief 里误触发）。
const BOOT_FAILURE_PATTERNS: Array<RegExp> = [
	/\bcommand not found\b/,
	/\bNo such file or directory\b/,
	/\bCannot find module\b/,
];

function hasBootFailureSignal(text: string): boolean {
	return BOOT_FAILURE_PATTERNS.some(pattern => pattern.test(text));
}

function tryPaneRead(paneId: string): string {
	// omp TUI 在 alternate screen 上，pane read 多为空 —— 快照仅供诊断，不用于判定。
	// （实测 recent-unwrapped 能解码出 TUI 帧里的消息/bash 输出，主要信号还是靠 outLog，见 isPaneAlive）
	try {
		const result = Bun.spawnSync(
			["herdr", "pane", "read", paneId, "--source", "recent-unwrapped", "--lines", "120"],
			{ env: { ...process.env } as NodeJS.ProcessEnv },
		);
		return String(result.stdout ?? "").trim();
	} catch {
		return "";
	}
}

async function agentListPaneIds(): Promise<Set<string>> {
	try {
		const json = JSON.parse((await run(["herdr", "agent", "list"], { quiet: true })).trim()) as {
			result?: { agents?: Array<{ pane_id?: string }> };
		};
		return new Set((json.result?.agents ?? []).flatMap(a => (a.pane_id ? [a.pane_id] : [])));
	} catch {
		return new Set();
	}
}

// 启动后准备检查（脚本层）：exec omp 启动后 herdr 会登记 agent（前台进程=omp），轮询 agent list 确认。
async function verifyLaunched(items: Array<{ taskId: string; paneId: string }>, timeoutMs: number): Promise<"ok" | "failed"> {
	process.stderr.write(`准备检查: 确认 ${items.length} 个 agent 登记（agent list 探测，超时 ${Math.round(timeoutMs / 1000)}s）...\n`);
	const deadline = Date.now() + timeoutMs;
	let pending = [...items];
	const problems: Array<{ taskId: string; paneId: string; reason: string; snapshot: string }> = [];

	while (pending.length > 0 && Date.now() < deadline) {
		const livePaneIds = await agentListPaneIds();
		pending = pending.filter(item => {
			if (livePaneIds.has(item.paneId)) {
				process.stderr.write(`  ✓ ${item.taskId} (${item.paneId}): agent 已登记\n`);
				return false;
			}
			const snapshot = tryPaneRead(item.paneId);
			if (hasBootFailureSignal(snapshot)) {
				problems.push({ ...item, reason: "pane 输出出现启动失败信号", snapshot });
				return false;
			}
			return true;
		});
		if (pending.length > 0 && problems.length === 0) await Bun.sleep(VERIFY_POLL_MS);
	}

	if (pending.length > 0 && problems.length === 0) {
		for (const item of pending) {
			problems.push({ ...item, reason: "超时未登记 agent list", snapshot: tryPaneRead(item.paneId) });
		}
	} else if (pending.length > 0) {
		process.stderr.write(`另有 ${pending.length} 个 pane 未检出（本轮已有失败，不再等待）\n`);
	}

	if (problems.length > 0) {
		process.stderr.write(`准备检查失败: ${problems.length}/${items.length} 个子任务未通过：\n`);
		for (const problem of problems) {
			process.stderr.write(`  ✗ ${problem.taskId} (${problem.paneId}) — ${problem.reason}\n`);
			process.stderr.write(`    pane 输出快照（omp TUI 在 alternate screen，空属正常，仅供排查）:\n`);
			process.stderr.write(`    ${(problem.snapshot.slice(0, 500) || "(空)").split("\n").map(line => `      ${line}`).join("\n")}\n`);
		}
		process.stderr.write(
			"恢复建议: 按快照排查（omp 是否在 PATH、模型是否有 key/配额、brief 是否可解析）。若确认只是 agent list 同步慢，\n" +
				"父 agent 可用 --skip-verify 重跑集结绕过，再用 intercom 复核，全部 STARTED 后进 Phase 2。\n",
		);
		return "failed";
	}

	process.stderr.write(`准备检查通过: ${items.length} 个子任务的 agent 全部登记\n`);
	return "ok";
}

function resolveWorktree(subtask: Subtask, parentCwd: string): string {
	// worktree 落点默认在父 omp 的 cwd 下：<父cwd>/.worktrees/<branch>
	// （branch 中 / 替换为 -，feat/t1 → feat-t1）；任务包显式 worktree 字段可覆盖（特殊场景）。
	if (subtask.worktree) return subtask.worktree;
	return path.join(parentCwd, ".worktrees", (subtask.branch ?? "").replaceAll("/", "-"));
}

async function ensureTaskWorktree(subtask: Subtask, baseBranch: string | undefined, workspaceId: string, worktreePath: string): Promise<{ nodeWorkspaceId: string; paneId: string }> {
	// 任务名 worktree = herdr 树的子节点：herdr worktree create 会为任务建 linked worktree
	// 并开一个展示 workspace（label=任务名，Spaces 面板挂在父 workspace 树下的子节点），
	// worker 直接起在这个节点 workspace 的 pane 里（用户要求：先建任务 worktree，再挂 worker）。
	// 幂等：已有则复用其 open workspace 的 pane。
	try {
		const list = JSON.parse((await run(["herdr", "worktree", "list", "--workspace", workspaceId], { quiet: true })).trim()) as {
			result?: { worktrees?: Array<{ path?: string; open_workspace_id?: string }> };
		};
		const existing = list.result?.worktrees?.find(w => w.path === worktreePath);
		if (existing?.open_workspace_id) {
			const ws = JSON.parse((await run(["herdr", "workspace", "list"], { quiet: true })).trim()) as {
				result?: { workspaces?: Array<{ workspace_id?: string; active_tab_id?: string }> };
			};
			const target = ws.result?.workspaces?.find(w => w.workspace_id === existing.open_workspace_id);
			if (target?.workspace_id) {
				const panes = JSON.parse((await run(["herdr", "pane", "list", "--workspace", target.workspace_id], { quiet: true })).trim()) as {
					result?: { panes?: Array<{ pane_id?: string }> };
				};
				const paneId = panes.result?.panes?.[0]?.pane_id;
				if (paneId) {
					process.stderr.write(`复用任务 worktree 节点: ${target.workspace_id}（${subtask.id}）\n`);
					return { nodeWorkspaceId: target.workspace_id, paneId };
				}
			}
		}
	} catch {
		/* 列表解析失败走新建 */
	}
	const json = await run(
		[
			"herdr", "worktree", "create", "--workspace", workspaceId,
			"--branch", subtask.branch!, "--base", baseBranch ?? "main",
			"--path", worktreePath, "--label", tabLabel(subtask), "--no-focus",
		],
		{ quiet: true },
	);
	const result = JSON.parse(json.trim()).result as { workspace?: { workspace_id?: string }; root_pane?: { pane_id?: string } };
	const nodeWorkspaceId = result.workspace?.workspace_id;
	const paneId = result.root_pane?.pane_id;
	if (!nodeWorkspaceId || !paneId) fail(`herdr worktree create 未返回 workspace/pane，输出: ${json}`);
	// 新 worktree 无 node_modules：tsgo 的 types ["bun","assets"] 会解析失败（"从未安装依赖"）。
	// 创建后立即 bun install（幂等：已存在/复用分支跳过，hoisted 缓存下秒级到分钟级）。
	if (!fs.existsSync(path.join(worktreePath, "node_modules"))) {
		process.stderr.write(`安装依赖（${subtask.id}，首次约 1-3 分钟）...\n`);
		await run(["bun", "install"], { cwd: worktreePath, quiet: true, timeoutMs: 300_000, fatal: true });
		process.stderr.write(`依赖安装完成: ${worktreePath}/node_modules\n`);
	}
	process.stderr.write(`任务 worktree 节点: ${nodeWorkspaceId}（${subtask.id}，树节点在 ${workspaceId} 下）\n`);
	return { nodeWorkspaceId, paneId };
}

async function currentWorkspaceId(): Promise<string> {
	// 父 workspace = 当前对话进程所在 workspace（HERDR_WORKSPACE_ID 由 herdr 注入；缺失查 focused）。
	const env = process.env.HERDR_WORKSPACE_ID?.trim();
	if (env) return env;
	const json = await run(["herdr", "workspace", "list"], { quiet: true });
	try {
		const parsed = JSON.parse(json) as { result?: { workspaces?: Array<{ workspace_id?: string; focused?: boolean }> } };
		const focused = parsed.result?.workspaces?.find(w => w.focused);
		if (focused?.workspace_id) return focused.workspace_id;
	} catch {
		/* fallthrough */
	}
	fail(`无法确定父进程所在 workspace（HERDR_WORKSPACE_ID 为空，workspace list 无 focused）`);
}

async function ensureParentWorkspaceLabel(workspaceId: string, squadId: string): Promise<void> {
	// 父 workspace label 改为任务包名：用户看到的这个 workspace 就是当前 squad（不改 workspace_id）。
	// 多次集结同名 label 时 rename 会报错或幂等 —— fatal:false 忽略。
	await run(["herdr", "workspace", "rename", workspaceId, squadId], { quiet: true, fatal: false });
}

// tab label 语义化："T1 · <title 前 14 字符>"（herdr UI 平铺 tab，一眼对应子任务）。
function tabLabel(subtask: Subtask): string {
	// 语义化显示名："T1 · <title 前 18 字符>"（树节点/tab 都用它 —— 用户要求不能裸显示 T1）
	const short = subtask.title.replace(/\s+/g, " ").trim().slice(0, 18);
	return `${subtask.id} · ${short || "task"}`;
}

// 子 omp 进程环境注入：PI_SUBAGENT_* 注册 intercom 父 edge（ask 自动路由 + 父 children 可见）。
// 注入位置 = 启动 shell 文件的 export 前缀（tab create --env 实测破坏 pane prompt，不用）。
function envExports(bundle: Bundle, subtask: Subtask, index: number): string {
	const entries: Array<[string, string]> = [
		["PI_SUBAGENT_ORCHESTRATOR_TARGET", bundle.parent.target],
		["PI_SUBAGENT_ORCHESTRATOR_SESSION_ID", bundle.parent.sessionId ?? bundle.parent.target],
		["PI_SUBAGENT_RUN_ID", bundle.squadId],
		["PI_SUBAGENT_CHILD_AGENT", subtask.id],
		["PI_SUBAGENT_CHILD_INDEX", String(index)],
	];
	return entries.map(([k, v]) => `export ${k}=${shellQuote(v)};`).join(" ");
}

async function launchWorker(paneId: string, model: string, brief: string, name: string, envLine: string): Promise<void> {
	// 在任务 pane 里启动 omp worker：bash -c 'export PI_SUBAGENT_*; exec omp …' ——
	// exec 让前台进程就是 omp（herdr agent 识别认前台进程，实测 required）。
	const tmpDir = path.join(os.tmpdir(), "squad-launch");
	if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
	const shellFile = path.join(tmpDir, `${name}.sh`);
	fs.writeFileSync(shellFile, `#!/bin/bash\n${envLine} exec ${shellQuote("omp")} --model ${shellQuote(model)} ${shellQuote(brief)}\n`);
	await run(["herdr", "pane", "run", paneId, `bash ${shellQuote(shellFile)}`], { quiet: true });
}

function extractPaneId(json: string): string | undefined {
	try {
		const parsed = JSON.parse(json.trim());
		const result = (parsed as { result?: unknown }).result;
		if (result && typeof result === "object") {
			const rec = result as Record<string, unknown>;
			// pane split 返回 { pane }；tab create 返回 { root_pane }；兜底直接扫 rec
			const candidates: unknown[] = [];
			if (rec.pane && typeof rec.pane === "object") candidates.push(rec.pane);
			if (rec.root_pane && typeof rec.root_pane === "object") candidates.push(rec.root_pane);
			candidates.push(rec);
			for (const cand of candidates) {
				const pane = cand as Record<string, unknown>;
				for (const key of ["pane_id", "paneId", "id"]) if (typeof pane[key] === "string") return pane[key] as string;
			}
		}
	} catch {
		/* 非 JSON 输出时下面按行回找 */
	}
	for (const line of json.trim().split(/\r?\n/).reverse()) {
		try {
			const parsed = JSON.parse(line) as { result?: { pane_id?: string; paneId?: string; root_pane?: { pane_id?: string; paneId?: string } } };
			const id = parsed.result?.pane_id ?? parsed.result?.paneId ?? parsed.result?.root_pane?.pane_id ?? parsed.result?.root_pane?.paneId;
			if (id) return id;
		} catch {
			/* skip */
		}
	}
	return undefined;
}

export function workerBrief(bundle: Bundle, subtask: Subtask, model: string, briefPath: string): string {
	// 展示名优先 parent.name（可读），路由 = parent.target。
	// 注意：intercom 路由优先 cwd 匹配，parent edge 只是次选——ask 必须显式 to=父（实测误投 aion-ui）。
	const lines = [
		`你是 ${subtask.id}（${subtask.title}）的实现者，属于 squad ${bundle.squadId} 的 worker。`,
		`第一步（准备检查）：读 ${shellQuote(briefPath)} 的任务包（.squad.json），完整理解任务、scope、gate、汇报协议、模型档位；`,
		`用 list_models 确认 ${model} 在可用列表；不在列表则 switch_model 切换到该档位可用模型（按实际生效模型为准）；`,
		`然后向父报 STARTED 一次（intercom send 给 ${bundle.parent.target}，格式 "[${subtask.id}] STARTED: <实际生效模型>，任务包已读"；若报 Session not found/失败，不要重试刷屏、不要中断任务——这是启动窗口期 broker 路由未就绪的已知现象，父会用 ask 来确认你；收到父 ask（问 STARTED/当前状态）必须回复 "[${subtask.id}] ACK: <当前状态与实际生效模型>"）。`,
		`【硬约束·GO 闸门】收到父的开工确认（消息含「GO」或「开工」，可能经 parent ask 的 reply 或 send 到达）之前，不得开始实现代码；准备检查阶段只做：读任务包 + 核对模型 + 报 STARTED + 等待。GO 可重复到达（父恢复/补发），重复 GO 无副作用——已在干活就继续，不要重启任务。`,
		`【取消】收到含「CANCEL」的消息（"[${subtask.id}] CANCEL: <原因>"）→ 立即停止实现与提交，回复 "[${subtask.id}] CANCELLED: <一句话>"，不再改动任何文件。`,
		`规则：只改 scope 内文件；求助必须用 intercom ask 且必须带 to=${bundle.parent.target}（不带 to 的 ask 会被 intercom 按 cwd 路由到同目录其他会话，不会到达父 —— 实测误投到 aion-ui）；`,
		`状态用 intercom send 给 ${bundle.parent.target}，格式 "[${subtask.id}] <STATE>: 一句话"（STATE ∈ STARTED/BLOCKED/REVIEWING/COMPLETE/FAILED，STARTED 只在准备检查通过后发一次；终态与 BLOCKED 求助消息在启动窗口期后 send 可靠送达）；`,
		`完成标准见任务包 acceptance。收尾铁律：验收通过后必须把改动提交到当前分支（git add <改动文件> && git commit -m "[${subtask.id}] <一句话>"；排除 .squad.json 和 node_modules，commit 前先 git status 确认只含你的改动）——未提交的交付无法交接/merge，父只接收已提交的分支；`
	];
	return lines.join(" ");
}

function resolveModel(bundle: Bundle, subtask: Subtask): string | undefined {
	// 优先 subtask.model 显式指定，其次按 modelTier 查档位表，兜底 cheap
	if (subtask.model) return subtask.model;
	if (subtask.modelTier) {
		const m = (bundle.modelTiers as Record<string, string | undefined>)[subtask.modelTier];
		if (m) return m;
		return undefined; // 档位在表里但没配置模型（如 glM5 未填）
	}
	return bundle.modelTiers.cheap;
}

function writeJson(file: string, data: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

async function main(): Promise<void> {
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
				"  --parent-model <model>     父当前模型（如 narwal-plan/deepseek-v4-pro）；集结时必填，校验父 >= 子",
				"  --dry-run                  只打印将执行的命令，不执行",
				"  --skip-verify              跳过启动后 pane 准备检查（仅父 agent 确需绕过时用）",
				"  --verify-timeout <ms>      pane 准备检查超时（默认 60000）",
				"",
				"示例:",
				"  bun run .cornfield/skills/squad-programming/scripts/bootstrap.ts --check /tmp/bundle.json",
				"  bun run .cornfield/skills/squad-programming/scripts/bootstrap.ts --bundle /tmp/bundle.json --parent-target planner --parent-session-id abc123",
			].join("\n") + "\n",
		);
		return;
	}

	const checkOnly = argv.includes("--check");
	const dryRun = argv.includes("--dry-run");
	const skipVerify = argv.includes("--skip-verify");
	const verifyTimeoutMs = (() => {
		const raw = Number(flagValue("--verify-timeout"));
		return Number.isFinite(raw) && raw >= 1000 ? raw : 60000;
	})();

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

	const parentModel = flagValue("--parent-model");
	if (parentModel) {
		validateParentModel(parentModel, bundle);
	} else if (!checkOnly) {
		// 集结（非 --check）时 --parent-model 必填，确保父模型 >= 子模型
		fail("集结需要 --parent-model <父当前模型>（如 narwal-plan/deepseek-v4-pro），用于校验父模型 >= 子模型");
	}

	if (checkOnly) {
		process.stdout.write(`任务包校验通过: ${bundle.squadId}（${bundle.subtasks.length} 个子任务）\n`);
		return;
	}

	const parentTarget = flagValue("--parent-target");
	const parentSessionId = flagValue("--parent-session-id");
	if (!parentTarget) fail("集结需要 --parent-target <父 session 名或 id>");

	// 版本门：tab create --workspace 需要 herdr >= 0.8.0（集结/dry-run 都查，check 只验包不查）
	await assertHerdrVersion();

	if (process.env.HERDR_ENV !== "1") {
		process.stderr.write("警告: HERDR_ENV != 1，herdr pane/worktree 命令可能不可用；继续执行\n");
	}

	const result: unknown[] = [];
	const launchedPanes: Array<{ taskId: string; paneId: string }> = [];
	const tmpDir = path.join(os.tmpdir(), `squad-${bundle.squadId}`);
	if (!dryRun) fs.mkdirSync(tmpDir, { recursive: true });

	// worktree 落点仓库：parent.cwd（缺省 = bootstrap 运行目录，即父 omp 会话的 cwd）
	const parentCwd = path.resolve(bundle.parent.cwd ?? process.cwd());

	// 父 workspace = 当前对话所在 workspace：改名任务包名，三个子 pane 直接挂载在它下面。
	// 不新建 squad workspace（父+子同 workspace，一个窗口全看到）。
	const workspaceId = dryRun ? "(dry-run)" : await currentWorkspaceId();
	if (!dryRun) {
		await ensureParentWorkspaceLabel(workspaceId, bundle.squadId);
		process.stderr.write(`父 workspace ${workspaceId} 已命名：${bundle.squadId}\n`);
	}

	for (const [index, subtask] of bundle.subtasks.entries()) {
		const model = resolveModel(bundle, subtask);
		if (isBanned(model, bundle.modelTiers.banned))
			fail(`${subtask.id} 模型在禁用清单: ${model}（需用户拍板放行）`);

		let cwd: string;
		let briefPath: string;
		let paneId: string | null = null;
		if (subtask.isolation === "worktree") {
			cwd = resolveWorktree(subtask, parentCwd);
			briefPath = path.join(cwd, ".squad.json");
			if (!dryRun) {
				// 先按任务名建 worktree（herdr 树子节点），worker 后续起在节点 pane
				const node = await ensureTaskWorktree(subtask, bundle.baseBranch, workspaceId, cwd);
				paneId = node.paneId;
				// 回填实际 worktree 路径再写入任务包：子 omp 读 .squad.json 时 worktree 字段是解析后的实值
				writeJson(briefPath, {
					...bundle,
					parent: { ...bundle.parent, cwd: parentCwd },
					subtasks: bundle.subtasks.map(s => (s.isolation === "worktree" && !s.worktree ? { ...s, worktree: cwd } : s)),
				});
			}
		} else {
			cwd = parentCwd;
			briefPath = path.join(tmpDir, `${subtask.id}.squad.json`);
			if (!dryRun) writeJson(briefPath, { ...bundle, parent: { ...bundle.parent, cwd: parentCwd } });
		}

		const brief = workerBrief(bundle, subtask, model, briefPath);
		if (dryRun) {
			const dryRunCommand = `herdr worktree create --workspace <父ws> --branch ${subtask.branch ?? ""} --path ${cwd} --label ${subtask.id} && herdr pane run <节点pane> "bash <shell>（export PI_SUBAGENT_*; exec omp --model ${model} <brief>）"`;
			result.push({ taskId: subtask.id, isolation: subtask.isolation, cwd, worktree: subtask.isolation === "worktree" ? cwd : null, briefPath, dryRunCommand });
			continue;
		}

		// 先任务 worktree 节点（worktree 场景），再在其 pane 上起 worker（shared 场景 tab create 补 pane）
		if (!paneId) {
			const tabJson = await run(
				["herdr", "tab", "create", "--cwd", cwd, "--label", tabLabel(subtask), "--no-focus", "--workspace", workspaceId],
				{ quiet: true },
			);
			const created = extractPaneId(tabJson);
			if (!created) fail(`tab create 未返回 root pane id，输出: ${tabJson}`);
			paneId = created;
		}
		await launchWorker(paneId, model, brief, subtask.id.toLowerCase(), envExports(bundle, subtask, index));
		launchedPanes.push({ taskId: subtask.id, paneId });
		result.push({ taskId: subtask.id, isolation: subtask.isolation, cwd, worktree: subtask.isolation === "worktree" ? cwd : null, briefPath, paneId, model });
	}

	let verify: "ok" | "failed" | "skipped" = "skipped";
	if (!dryRun && !skipVerify && launchedPanes.length > 0) {
		verify = await verifyLaunched(launchedPanes, verifyTimeoutMs);
	} else if (!dryRun && skipVerify) {
		process.stderr.write("准备检查已跳过（--skip-verify），由父 agent 用 intercom 复核。\n");
	}

	// 父中断恢复：集结结果落盘 ~/.cornfield/squads/<squadId>/state.json，父每收一条状态消息更新它
	// （见 SKILL.md 父盯盘与中断恢复）。verify 失败也写（记录已启动的子任务）。
	if (!dryRun) {
		const subtaskById = new Map(bundle.subtasks.map(s => [s.id, s]));
		const subtaskStates: SubtaskState[] = result.map(r => {
			const rr = r as { taskId: string; isolation: SubtaskState["isolation"]; worktree: string | null; paneId?: string; model?: string; briefPath: string };
			return {
				id: rr.taskId,
				isolation: rr.isolation,
				worktree: rr.worktree ?? undefined,
				branch: subtaskById.get(rr.taskId)?.branch,
				paneId: rr.paneId,
				model: rr.model,
				briefPath: rr.briefPath,
				deps: subtaskById.get(rr.taskId)?.deps ?? [],
				status: "assembled",
				updatedAt: Date.now(),
			};
		});
		const state: SquadState = {
			squadId: bundle.squadId,
			squadVersion: CURRENT_SQUAD_VERSION,
			version: 0,
			taskType: bundle.taskType,
			baseBranch: bundle.baseBranch,
			maxConcurrency: bundle.maxConcurrency,
			parent: { target: bundle.parent.target, sessionId: bundle.parent.sessionId, cwd: parentCwd },
			workspaceId,
			createdAt: Date.now(),
			subtasks: subtaskStates,
		};
		const stateFile = statePath(bundle.squadId);
		writeState(stateFile, state);
		process.stderr.write(`squad state 已写入 ${stateFile}（父中断后读它恢复）\n`);
	}

	process.stdout.write(JSON.stringify({ squadId: bundle.squadId, workspaceId, launched: result, verify }, null, 2) + "\n");
	if (verify === "failed") process.exit(1);

	process.stderr.write(
		`集结完成: ${result.length} 个子任务（${worktrees} 个 worktree / ${result.length - worktrees} 个共享区）。worker 全部停在 GO 闸门。\n` +
		`下一步（父 agent）：① intercom ask 逐个确认 STARTED（确认后 squad-state update <id> started）；\n` +
		`② 跑 squad-state.ts <stateFile> reconcile 计算 GO 发放（deps + 并发槽位），按 needGo 发 GO 并 update <id> running（见 SKILL.md Phase 1.5/GO 发放）。\n`,
	);
}

if (import.meta.main) {
	main().catch(err => {
		process.stderr.write(`bootstrap 异常终止: ${err instanceof Error ? err.stack : String(err)}\n`);
		process.exit(1);
	});
}