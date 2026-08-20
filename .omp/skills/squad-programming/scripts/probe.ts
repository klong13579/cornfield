/**
 * probe.ts — 子任务健康扫描（squad-programming 父盯盘机制）
 *
 * 作用：父不干等消息。定期对未终态子任务做三路探活：
 *   1. 进程存活（ps 按 worktree 路径匹配 omp）
 *   2. agent 注册（herdr workspace list 的 agent_status）
 *   3. pane 输出尾部 + 错误签名扫描（API 连接断/进程退出/崩溃堆栈等）
 *
 * 用法：
 *   bun run .omp/skills/squad-programming/scripts/probe.ts ~/.omp/squads/<squadId>/state.json
 *
 * 输出：每子任务一行 [OK]/[WARN]；WARN 条件 = 进程死 / agent 缺位 / pane 输出命中错误签名。
 * 有 WARN 退出码 1（供父/CI 判读）。
 *
 * WARN 不是判决书：父收到 WARN 后按 SKILL 规则复核（ask 自报 / pane 快照），
 * 仍无响应才标记 STALLED/BLOCKED。错误签名有白名单语境（如 API 断连后 worker 自愈属正常）。
 */
import * as fs from "node:fs";
import * as path from "node:path";

const stateFile = process.argv[2];

interface SubtaskState {
	id: string;
	paneId?: string;
	worktree?: string;
	status: string;
}
interface SquadState {
	squadId: string;
	subtasks: SubtaskState[];
}

const ERROR_SIGNATURES = [
	/socket connection was closed/i,
	/session not found/i,
	/process exited/i,
	/exit code \d+/i,
	/exited with code \d+/i,
	/command failed/i,
	/command not found/i,
	/cannot find module/i,
	/panic:/i,
	/econnreset/i,
	/etimedout/i,
];

function fail(msg: string): never {
	process.stderr.write(`probe: ${msg}\n`);
	process.exit(2);
}

async function run(cmd: string[]): Promise<{ code: number; out: string }> {
	const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
	const timedOut = await Promise.race([
		proc.exited.then(() => false),
		Bun.sleep(20_000).then(() => {
			proc.kill();
			return true;
		}),
	]);
	const out = await new Response(proc.stdout).text();
	const err = await new Response(proc.stderr).text();
	return { code: timedOut ? 124 : proc.exitCode ?? 1, out: out + err };
}

async function main(): Promise<void> {
	if (!stateFile) fail("缺少 state.json 路径");
	const raw = JSON.parse(fs.readFileSync(stateFile, "utf8")) as SquadState;
	const active = raw.subtasks.filter((s) => !["complete", "failed", "blocked"].includes(s.status) && (s.paneId || s.worktree));
	if (active.length === 0) {
		console.log(`[probe] ${raw.squadId}: 无未终态子任务`);
		process.exit(0);
	}
	const wsList = await run(["herdr", "workspace", "list"]);
	let byCheckout = new Map<string, string>();
	try {
		const ws = (JSON.parse(wsList.out) as { result: { workspaces: Array<{ agent_status?: string; worktree?: { checkout_path?: string } | null }> } }).result.workspaces;
		byCheckout = new Map(ws.filter((w) => w.worktree?.checkout_path).map((w) => [w.worktree!.checkout_path as string, w.agent_status ?? "?"]));
	} catch {
		/* workspace list 解析失败不致命，agent 维度化为 ? */
	}

	let warn = 0;
	for (const s of active) {
		const problems: string[] = [];
		// 1. 进程存活（omp + worktree 路径）
		if (s.worktree) {
			const ps = await run(["ps", "aux"]);
			const procLive = ps.out.includes(s.worktree) && ps.out.includes("omp");
			if (!procLive) problems.push("进程未找到（omp 不匹配）");
		}
		// 2. agent 注册
		if (s.worktree) {
			const st = byCheckout.get(s.worktree);
			if (st === undefined) problems.push("agent 缺位（workspace 树不存在）");
			else if (st === "idle" && s.status === "started") problems.push(`agent idle（未在推进，status=${s.status}）`);
		}
		// 3. pane 输出错误签名
		if (s.paneId) {
			const pane = await run(["herdr", "pane", "read", s.paneId]);
			if (pane.code !== 0) {
				problems.push("pane 读取失败");
			} else {
				const hits = ERROR_SIGNATURES.map((re) => re.exec(pane.out)).filter((m): m is RegExpExecArray => m !== null);
				if (hits.length > 0) problems.push(`错误签名 x${hits.length}: 「${hits[0][0].slice(0, 48)}」`);
			}
		}
		if (problems.length > 0 && problems.some((p) => !p.includes("idle"))) warn++;
		const flag = problems.length === 0 ? "OK" : "WARN";
		console.log(`[${flag}] ${s.id} ${s.status}${s.paneId ? ` @${s.paneId}` : ""}${problems.length ? " — " + problems.join("；") : ""}`);
	}
	console.log(warn > 0 ? `\n[probe] ${warn} 个子任务有告警，父请复核（SKILL 父盯盘段）` : "\n[probe] 全部健康");
	process.exit(warn > 0 ? 1 : 0);
}

void main();