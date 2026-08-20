/**
 * squad-programming bootstrap — 集结阶段机械化部分
 *
 * 作用
 * ────
 * 按任务包（.squad.json schema）把用户任务集结成一组并行子 omp：
 *   1. isolation="worktree"   → herdr worktree create（幂等，已存在则复用）——必须传 --workspace <squadWorkspaceId>，
 *      worktree 建在 squad workspace 的 source repo（= workspace create --cwd 指定的仓库）；不传会建到父 workspace 的仓库（实测）
 *   2. isolation="shared-*"   → cwd 用 repo 根，brief 写到 /tmp/squad-<squadId>/<taskId>.squad.json
 *   3. 每个子任务 → herdr tab create（tab 固定落在 squad 专属 workspace，集结时创建并命名）
 *      + pane run，注入 PI_SUBAGENT_* env（注册父 edge）+ --model 档位模型
 *   4. 启动后准备检查：轮询 herdr agent list，确认每个 pane 的 omp TUI 已上线；
 *      超时/启动失败信号 → 打印 pane 快照并以退出码 1 失败（不静默继续）
 *
 * 用法
 * ────
 *   # 只校验任务包 schema（不执行任何操作，Phase 0 的 completion 检查）
 *   bun run .omp/skills/squad-programming/scripts/bootstrap.ts --check <任务包路径>
 *
 *   # 集结（建 worktree / 写任务包 / 启动子 omp + 启动后准备检查）
 *   bun run .omp/skills/squad-programming/scripts/bootstrap.ts \
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
		if (s.modelTier && !["cheap", "mid"].includes(s.modelTier))
			fail(`${tag}(${s.id}) modelTier 非法: ${s.modelTier}`);
		const model = s.model ?? (s.modelTier ? b.modelTiers[s.modelTier] : b.modelTiers.cheap);
		if (!model) fail(`${tag}(${s.id}) 解析不出模型（model 或 modelTier→档位表）`);
		if (isBanned(model, b.modelTiers.banned)) fail(`${tag}(${s.id}) 模型在禁用清单: ${model}`);
	}
	return b;
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
async function run(command: string[], options: { cwd?: string; quiet?: boolean; timeoutMs?: number } = {}): Promise<string> {
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
		process.stderr.write(`${headline}\n${describeHerdrError(err + out)}\n`);
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

// 子 omp 活体信号：优先问 outLog（script -q 落盘的 pane 原始终端流，omp 启动即刷屏）；
// 拿得到非空且不撞失败模式的 pane read 也认。不再用 herdr agent list：
// script 包装启动的 pane 终端标题是 bash，herdr 不会识别为 omp agent（实测 agent list 永远缺位）。
function isPaneAlive(paneId: string, outLog: string): boolean {
	const snapshot = tryPaneRead(paneId);
	if (hasBootFailureSignal(snapshot)) return false;
	if (snapshot.trim()) return true;
	try {
		return fs.statSync(outLog).size > 64; // script 自身头部噪音以上 = 子进程有真实输出
	} catch {
		return false;
	}
}

// 启动后准备检查（脚本层）：轮询确认每个 pane 内的 omp 已启动。
// 判定规则：
//   - pane 输出非空或 outLog 有真实内容 = omp 已启动 → 通过；
//   - pane 输出出现启动失败信号 → 立即失败并给快照；
//   - 超时仍无信号 → 失败并给每个 pane 的输出快照（供父 agent 排查）。
// 模型可访问性 + 任务包已读由 worker 侧 STARTED ack 确认（见 SKILL.md Phase 1.5），本函数只负责 pane 级活体。
function verifyLaunched(items: Array<{ taskId: string; paneId: string; outLog: string }>, timeoutMs: number): "ok" | "failed" {
	process.stderr.write(`准备检查: 确认 ${items.length} 个 pane 内 omp 已正常启动（pane 输出探测，超时 ${Math.round(timeoutMs / 1000)}s）...\n`);
	const deadline = Date.now() + timeoutMs;
	let pending = [...items];
	const problems: Array<{ taskId: string; paneId: string; reason: string; snapshot: string }> = [];

	while (pending.length > 0 && Date.now() < deadline) {
		const remain: Array<{ taskId: string; paneId: string; outLog: string }> = [];
		for (const item of pending) {
			const snapshot = tryPaneRead(item.paneId);
			if (hasBootFailureSignal(snapshot)) {
				// 明确启动失败：记录问题并从轮询中剔除，其余 pane 继续等到 deadline
				problems.push({ ...item, reason: "pane 输出出现启动失败信号", snapshot });
			} else if (isPaneAlive(item.paneId, item.outLog)) {
				process.stderr.write(`  ✓ ${item.taskId} (${item.paneId}): omp 已启动\n`);
			} else {
				remain.push(item);
			}
		}
		pending = remain;
		if (pending.length > 0 && problems.length === 0) Bun.sleepSync(VERIFY_POLL_MS);
	}

	// 有失败信号时不再等剩余 pane（只发一次提示）；否则等到 deadline 的按超时处理
	if (pending.length > 0 && problems.length === 0) {
		for (const item of pending) {
			problems.push({ ...item, reason: "超时未检测到 omp 上线", snapshot: tryPaneRead(item.paneId) });
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
			"恢复建议: 按快照排查（omp 是否在 PATH、模型是否合法、brief 是否可解析）。若确认只是启动慢/探测窗口短，\n" +
				"父 agent 可用 --skip-verify 重跑集结绕过，再用 intercom({action:\"children\"}) 复核，全部 STARTED 后进 Phase 2。\n",
		);
		return "failed";
	}

	process.stderr.write(`准备检查通过: ${items.length} 个子任务的 omp 全部启动\n`);
	return "ok";
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

function resolveWorktree(subtask: Subtask, parentCwd: string): string {
	// worktree 落点默认在父 omp 的 cwd 下：<父cwd>/.worktrees/<branch>
	// （branch 中 / 替换为 -，feat/t1 → feat-t1）；任务包显式 worktree 字段可覆盖（特殊场景）。
	if (subtask.worktree) return subtask.worktree;
	return path.join(parentCwd, ".worktrees", (subtask.branch ?? "").replaceAll("/", "-"));
}

function piBin(): string {
	// worker CLI 固定用 omp（本仓库的 CLI）。PI_INTERCOM_PI_BIN 是旧 intercom 的兼容变量，
	// 指向 pi（pi-mono 的 CLI，认证栈与本仓库不互通），读取它会用错进程 —— 不再读。
	// OMP_BIN 仅作为自定义 omp 路径的覆盖。
	return process.env.OMP_BIN?.trim() || "omp";
}

async function worktreeExists(worktreePath: string, parentCwd: string): Promise<boolean> {
	// git 原生 worktree 注册表（仓库上下文 = parentCwd 所在仓库）：herdr worktree list 需要 workspace
	// 关联且可能读错仓库，不用。
	const out = await run(["git", "worktree", "list", "--porcelain"], { cwd: parentCwd, quiet: true });
	return out.includes(worktreePath);
}

async function createWorktree(subtask: Subtask, baseBranch: string | undefined, parentCwd: string, worktreePath: string): Promise<void> {
	// git 原生 worktree add：仓库上下文由 -C parentCwd 明确。不用 herdr worktree create ——
	// 它会自动为每个 worktree 开一个展示 workspace（open_workspace_id，含一个空 tab、无 omp，纯冗余），
	// 且仓库上下文绕 workspace 关联容易建错位置（实测）。
	await run(
		["git", "worktree", "add", "--force", worktreePath, "-b", subtask.branch!, baseBranch ?? "main"],
		{ cwd: parentCwd, quiet: true },
	);
}

async function createSquadWorkspace(bundle: Bundle, parentCwd: string): Promise<string> {
	// 每个 squad 一个专属 workspace：label 可命名（UI 识别 squad-<id>）、所有子任务 tab
	// 固定落在这里（保证同 workspace）、与父 workspace 解耦（父被关不影响子任务）、
	// 回收时父 agent 对 workspace_id 整体 close。source repo = parentCwd 所在 git 仓库。
	const json = await run(
		["herdr", "workspace", "create", "--cwd", parentCwd, "--label", `squad-${bundle.squadId}`, "--no-focus"],
		{ quiet: true },
	);
	try {
		const parsed = JSON.parse(json.trim()) as { result?: { workspace?: { workspace_id?: string } } };
		const id = parsed.result?.workspace?.workspace_id;
		if (id) {
			process.stderr.write(`squad 专属 workspace: ${id}（label=squad-${bundle.squadId}）\n`);
			return id;
		}
	} catch {
		/* 非 JSON 输出走下面 fail */
	}
	fail(`workspace create 未返回 workspace_id，输出: ${json}`);
}

async function launchPane(cwd: string, paneCmd: string, label: string, squadWorkspaceId: string): Promise<string> {
	// 每个子任务独立 tab（herdr tab create → root pane），不再 split 当前 tab：
	// 分裂面板会把 TUI 挤在窄 pane 里且多个 omp 共享同一终端上下文（用户指定）。
	// workspace 固定传 squad 专属 workspace（createSquadWorkspace 产出），所有子 omp 必在同一 workspace。
	const args = ["herdr", "tab", "create", "--cwd", cwd, "--label", label, "--no-focus", "--workspace", squadWorkspaceId];
	const json = await run(args);
	const paneId = extractPaneId(json);
	if (!paneId) fail(`tab create 未返回 root pane id，输出: ${json}`);
	await run(["herdr", "pane", "run", paneId, paneCmd], { quiet: true });
	return paneId;
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

function workerBrief(bundle: Bundle, subtask: Subtask, model: string, briefPath: string): string {
	const lines = [
		`你是 ${subtask.id}（${subtask.title}）的实现者，属于 squad ${bundle.squadId} 的 worker。`,
		`第一步（准备检查）：读 ${shellQuote(briefPath)} 的任务包（.squad.json），完整理解任务、scope、gate、汇报协议、模型档位；`,
		`用 list_models 确认 ${model} 在可用列表；不在列表则 switch_model 切换到该档位可用模型（按实际生效模型为准）；`,
		`然后立刻向 ${bundle.parent.target} 发 "[${subtask.id}] STARTED: <实际生效模型>，任务包已读" —— 父等你全部 STARTED 确认后才正式开工。`,
		`规则：只改 scope 内文件；求助用 intercom ask（不带 to，自动路由父）；`,
		`状态用 intercom send 给 ${bundle.parent.target}，格式 "[${subtask.id}] <STATE>: 一句话"（STATE ∈ STARTED/BLOCKED/REVIEWING/COMPLETE/FAILED，STARTED 只在准备检查通过后发一次）；`,
		`完成标准见任务包 acceptance。开始。`,
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
				"  --dry-run                  只打印将执行的命令，不执行",
				"  --skip-verify              跳过启动后 pane 准备检查（仅父 agent 确需绕过时用）",
				"  --verify-timeout <ms>      pane 准备检查超时（默认 60000）",
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
	const launchedPanes: Array<{ taskId: string; paneId: string; outLog: string }> = [];
	const tmpDir = path.join(os.tmpdir(), `squad-${bundle.squadId}`);
	if (!dryRun) fs.mkdirSync(tmpDir, { recursive: true });

	// worktree 落点仓库：parent.cwd（缺省 = bootstrap 运行目录，即父 omp 会话的 cwd）
	const parentCwd = path.resolve(bundle.parent.cwd ?? process.cwd());

	// 集结先建 squad 专属 workspace：所有子任务 tab 落在同一 workspace（命名 squad-<squadId>）。
	const squadWorkspaceId = dryRun ? null : await createSquadWorkspace(bundle, parentCwd);

	for (const [index, subtask] of bundle.subtasks.entries()) {
		const model = resolveModel(bundle, subtask);
		if (isBanned(model, bundle.modelTiers.banned))
			fail(`${subtask.id} 模型在禁用清单: ${model}（需用户拍板放行）`);

		let cwd: string;
		let briefPath: string;
		if (subtask.isolation === "worktree") {
			cwd = resolveWorktree(subtask, parentCwd);
			briefPath = path.join(cwd, ".squad.json");
			if (!dryRun) {
				if (!(await worktreeExists(cwd, parentCwd))) await createWorktree(subtask, bundle.baseBranch, parentCwd, cwd);
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

		const command = `${envPrefix(bundle, subtask, index)}${shellQuote(piBin())} --model ${shellQuote(model)} ${shellQuote(workerBrief(bundle, subtask, model, briefPath))}`;
		if (dryRun) {
			result.push({ taskId: subtask.id, isolation: subtask.isolation, cwd, worktree: subtask.isolation === "worktree" ? cwd : null, briefPath, dryRunCommand: command });
			return;
		}
		// 用 script 包一层干净 PTY + 输出落盘：pane run 直接注入 TUI 会跟 pane 终端时序竞争
		// （实测 4 个并发只活 1 个）；且落盘日志供父 agent 盯盘/排障。
		const shellFile = path.join(tmpDir, `${subtask.id}.sh`);
		const outLog = path.join(tmpDir, `${subtask.id}.out`);
		fs.writeFileSync(shellFile, `#!/bin/bash\n${command}\n`);
		const paneCmd = `script -q ${shellQuote(outLog)} bash ${shellQuote(shellFile)}`;
		const paneId = await launchPane(cwd, paneCmd, subtask.id, squadWorkspaceId!);
		launchedPanes.push({ taskId: subtask.id, paneId, outLog });
		result.push({ taskId: subtask.id, isolation: subtask.isolation, cwd, worktree: subtask.isolation === "worktree" ? cwd : null, briefPath, paneId, model });
	}

	let verify: "ok" | "failed" | "skipped" = "skipped";
	if (!dryRun && !skipVerify && launchedPanes.length > 0) {
		verify = verifyLaunched(launchedPanes, verifyTimeoutMs);
	} else if (!dryRun && skipVerify) {
		process.stderr.write("准备检查已跳过（--skip-verify），由父 agent 用 intercom children 复核。\n");
	}

	process.stdout.write(JSON.stringify({ squadId: bundle.squadId, squadWorkspaceId, launched: result, verify }, null, 2) + "\n");
	if (verify === "failed") process.exit(1);

	const worktrees = result.filter(r => (r as { worktree?: string }).worktree).length;
	process.stderr.write(
		`集结完成: ${result.length} 个子任务（${worktrees} 个 worktree / ${result.length - worktrees} 个共享区）\n` +
			`父 agent 等全部子任务的 STARTED 汇报（任务包已读 + 模型已核对，见 SKILL.md Phase 1.5）后进入 Phase 2。\n`,
	);
}

main().catch(err => {
	process.stderr.write(`bootstrap 异常终止: ${err instanceof Error ? err.stack : String(err)}\n`);
	process.exit(1);
});