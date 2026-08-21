/**
 * integrate.ts — 整体验证 worktree（squad-programming Phase 3 强制门禁）
 *
 * 作用：把 squad 所有子任务分支合并到一个独立的 integration worktree，
 *      做整体功能验证（合体后起服务、跑子任务 gate 全集、端到端冒烟）。
 *      纯 git worktree，无 herdr pane/agent —— 这是验证区，不占子 agent。
 *
 * 强制门禁（2026-08-21 实测教训）：≥2 个子任务 complete 时必须执行——
 *      契约式依赖（T1 定义/修改、T2 消费）即使文件不相交，单 worktree 的
 *      构建/打包产物也会缺对方改动（实测：T2 单 worktree 打包缺 T1 的
 *      main.ts isPackaged 分支 → 装机白屏）。合体后的产物才是交付物，
 *      不能拿单个子任务的 worktree 产物验收。
 *
 * 用法：
 *   bun run .omp/skills/squad-programming/scripts/integrate.ts <state.json> \
 *     [--link-node-modules] [--dry-run] [--force]
 *
 * 行为：
 *   1. 读 state.json（~/.omp/squads/<squadId>/state.json）→ squadId / baseBranch / subtasks[].branch
 *   2. 建 worktree：.worktrees/<squadId>-integ，分支 <squadId>-integ，base = baseBranch
 *      （已存在 → 报错退出，不覆盖；--force 先清旧区重建）
 *   3. 按子任务数组序逐个 git merge --no-edit <branch>（只合并 status=complete 的）：
 *      - 成功 → ✓ merged <branch>
 *      - 冲突/失败 → 打印冲突文件清单并退出码 1，不自动解决、不继续 merge 后续分支。
 *        冲突信号 = 子任务边界侵入，打回子任务修，而不是在这里打补丁。
 *   4. --link-node-modules：ln -s <主仓库>/node_modules → <integWorktree>/node_modules
 *      （web 类项目验证 build 需要；主仓库 = state.json parent.cwd）
 *   5. 打印验证提示（按子任务 gate.verifiers 跑 + 起服务冒烟）
 */
import * as fs from "node:fs";
import * as path from "node:path";

const [stateFile, ...args] = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const linkModules = args.includes("--link-node-modules");
const force = args.includes("--force");

interface SubtaskState {
	id: string;
	branch: string;
	status: string;
}
interface SquadState {
	squadId: string;
	baseBranch: string;
	parent: { cwd: string };
	subtasks: SubtaskState[];
}

function fail(msg: string): never {
	process.stderr.write(`integrate: ${msg}\n`);
	process.exit(1);
}

function readJSON(file: string): unknown {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (err) {
		fail(`读 ${file} 失败: ${(err as Error).message}`);
	}
}

let repoRoot = process.cwd();

async function run(
	cmd: string[],
	opts: { cwd?: string; fatal?: boolean; timeoutMs?: number } = {},
): Promise<{ code: number; out: string }> {
	const proc = Bun.spawn(cmd, { cwd: opts.cwd ?? repoRoot, stdout: "pipe", stderr: "pipe" });
	const timedOut = await Promise.race([
		proc.exited.then(() => false),
		Bun.sleep(opts.timeoutMs ?? 120_000).then(() => {
			proc.kill();
			return true;
		}),
	]);
	const out = await new Response(proc.stdout).text();
	const err = await new Response(proc.stderr).text();
	const full = out + err;
	const code = timedOut ? 124 : proc.exitCode ?? 1;
	if (code === 0) return { code, out: full };
	if (opts.fatal === false) return { code, out: full };
	fail(`${cmd.join(" ")} 失败 (${timedOut ? "超时" : `exit ${code}`}):\n${full.slice(-800)}`);
	return { code, out: full }; // unreachable
}

async function main(): Promise<void> {
	if (!stateFile) fail("缺少 state.json 路径（~/.omp/squads/<squadId>/state.json）");
	const raw = readJSON(stateFile) as SquadState;
	if (!raw.squadId || !raw.baseBranch || !Array.isArray(raw.subtasks)) fail("state.json 结构缺失 squadId/baseBranch/subtasks");
	repoRoot = raw.parent?.cwd ?? repoRoot;
	const integDir = path.join(repoRoot, ".worktrees", `${raw.squadId}-integ`);
	const integBranch = `${raw.squadId}-integ`;
	const branches = raw.subtasks.filter((s) => s.status === "complete" && s.branch).map((s) => s.branch);
	if (branches.length === 0) fail("没有 complete 状态的子任务分支可合并");
	if (branches.length === 1) {
		console.log(
			`[integrate] 仅 ${branches.length} 个 complete 分支——单子任务豁免合体（SKILL.md Phase 3 强制门禁豁免），但仍建议确认该分支是完整交付物`,
		);
	}

	console.log(`[integrate] squad ${raw.squadId} · 合并 ${branches.length} 个分支: ${branches.join(", ")}`);

	if (fs.existsSync(integDir)) {
		if (!force) fail(`integration worktree 已存在: ${integDir}（--force 重建，或直接进去验证）`);
		if (!dryRun) {
			const probe = await run(["git", "-C", integDir, "status", "--porcelain"], { fatal: false });
			if (probe.code === 0 && probe.out.trim() !== "") fail(`integration worktree 有未提交改动（${integDir}），先处理再 --force`);
			await run(["git", "worktree", "remove", "--force", integDir]);
			await run(["git", "branch", "-D", integBranch], { fatal: false });
			console.log(`[integrate] 已清旧区 ${integDir}`);
		}
	}

	if (dryRun) {
		console.log(`[dry-run] git worktree add ${integDir} -b ${integBranch} ${raw.baseBranch}`);
		for (const b of branches) console.log(`[dry-run] git merge --no-edit ${b}`);
		if (linkModules) console.log(`[dry-run] ln -s ${path.join(repoRoot, "node_modules")} ${path.join(integDir, "node_modules")}`);
		console.log("[dry-run] 未执行任何命令");
		return;
	}

	console.log(`[integrate] 建 worktree: ${integDir} (-b ${integBranch}, base=${raw.baseBranch})`);
	await run(["git", "worktree", "add", integDir, "-b", integBranch, raw.baseBranch]);
	if (linkModules) {
		await run(["ln", "-s", path.join(repoRoot, "node_modules"), path.join(integDir, "node_modules")], { fatal: false });
	}

	for (const b of branches) {
		console.log(`[integrate] git merge --no-edit ${b}`);
		const r = await run(["git", "merge", "--no-edit", b], { cwd: integDir, fatal: false });
		if (r.code !== 0) {
			const conflicts = r.out.match(/CONFLICT .+/g) ?? [];
			process.stderr.write(`✗ ${b} merge 冲突（${conflicts.length} 处），停在 ${b}，未合并后续分支\n`);
			for (const c of conflicts) process.stderr.write(`  ${c}\n`);
			process.stderr.write("冲突 = 子任务边界侵入。不要在这里打补丁：打回该子任务修复后 --force 重建 integration 重来。\n");
			process.exit(1);
		}
		console.log(`  ✓ merged ${b}`);
	}

	console.log(`\n[integrate] 完成。验证区: ${integDir}（分支 ${integBranch}）`);
	const pkgDirs = fs
		.readdirSync(path.join(integDir, "packages"), { withFileTypes: true })
		.filter((d) => d.isDirectory() && fs.existsSync(path.join(integDir, "packages", d.name, "package.json")))
		.map((d) => d.name);
	if (pkgDirs.length > 0) {
		console.log(`[integrate] 含 package 子目录（${pkgDirs.join("/")}）——在对应子目录跑 gate verifiers:`);
		for (const d of pkgDirs) console.log(`  cd ${path.join(integDir, "packages", d)} && bun run check && bun run build`);
	}
	console.log("[integrate] 然后按需起服务做整体功能冒烟（web → dev server + 浏览器；CLI → smoke 命令）。");
}

void main();