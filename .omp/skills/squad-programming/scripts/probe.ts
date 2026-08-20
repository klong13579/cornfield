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
import * as os from "node:os";
import * as path from "node:path";

const stateFile = process.argv[2];
const STALL_AFTER_S = Number(process.env.PROBE_STALL_AFTER_S ?? 240); // 会话 JSONL 静默阈值

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
	const agentsList = await run(["herdr", "agent", "list"]);
	const byCwd = new Map<string, { status: string; sessionPath?: string }>();
	try {
		const ags = (JSON.parse(agentsList.out) as { result: { agents: Array<{ agent_status?: string; cwd?: string; agent_session?: { value?: string } }> } }).result.agents;
		for (const a of ags) {
			if (!a.cwd) continue;
			byCwd.set(a.cwd, { status: a.agent_status ?? "?", sessionPath: a.agent_session?.value });
		}
	} catch {
		/* agent list 解析失败不致命，运行态降级 */
	}

	/** 最近活动时间戳：直接用 herdr agent list 带出的 session JSONL 路径（每回合必写；静默挂起=长时间未写）。 */
	const lastWrite = (worktree: string): number | null => {
		const sessionPath = byCwd.get(worktree)?.sessionPath;
		if (sessionPath) {
			try {
				return fs.statSync(sessionPath).mtimeMs;
			} catch {
				return null;
			}
		}
		// fallback：编码路径推导（herdr 未登记 session 时）
		const rel = worktree.replace(os.homedir(), "").replaceAll("/", "-");
		const today = new Date();
		const pad = (n: number) => String(n).padStart(2, "0");
		const dateDir = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
		const byDate = path.join(os.homedir(), ".omp", "agent", "sessions", rel, "by-date", dateDir);
		try {
			const files = fs.readdirSync(byDate).filter((f) => f.endsWith(".jsonl"));
			if (files.length === 0) return null;
			let latest = 0;
			for (const f of files) {
				const st = fs.statSync(path.join(byDate, f));
				if (st.mtimeMs > latest) latest = st.mtimeMs;
			}
			return latest;
		} catch {
			return null; // 无 session 目录（未写任何日志），不判死只记为 null
		}
	};

	let warn = 0;
	for (const s of active) {
		const problems: string[] = [];
		const runtime = s.worktree ? byCwd.get(s.worktree) : undefined;
		const runtimeLabel = runtime ? runtime.status : "缺位";
		let activity = "";
		// 0. 新近活动：session JSONL 静默挂起检测（进程活着但长时间不写记录 = 卡死/API 挂起）
		if (s.worktree) {
			const lw = lastWrite(s.worktree);
			if (lw !== null) {
				const idleFor = (Date.now() - lw) / 1000;
				activity = `活动 ${Math.round(idleFor)}s 前`;
				if (idleFor > STALL_AFTER_S) problems.push(`静默挂起：会话 ${Math.round(idleFor)}s 未写入（>${STALL_AFTER_S}s）`);
			} else {
				problems.push("会话日志缺失（未找到 session JSONL）");
			}
		}
		// 1. 进程存活（omp + worktree 路径）
		if (s.worktree) {
			const ps = await run(["ps", "aux"]);
			const procLive = ps.out.includes(s.worktree) && ps.out.includes("omp");
			if (!procLive) problems.push("进程未找到（omp 不匹配）");
		}
		// 2. agent 注册（herdr agent list 的运行态）
		if (s.worktree && runtime === undefined) {
			problems.push("agent 缺位（不在 herdr agent list）");
		} else if (runtime?.status === "idle" && s.status === "started") {
			problems.push(`运行态 idle（业务态 ${s.status}，未在推进）`);
		} else if (runtime?.status === "done" && s.status !== "complete") {
			// herdr done = agent 完成回合/进程空闲态；业务态未跟上但运行态 done = 漏报终态，提示父 ask 确认
			problems.push(`运行态 done（业务态 ${s.status}，可能漏报终态，ask 确认）`);
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
		console.log(`[${flag}] ${s.id} 业务=${s.status} | 运行=${runtimeLabel}${activity ? " | " + activity : ""}${s.paneId ? ` @${s.paneId}` : ""}${problems.length ? " — " + problems.join("；") : ""}`);
	}
	console.log(warn > 0 ? `\n[probe] ${warn} 个子任务有告警，父请复核（SKILL 父盯盘段）` : "\n[probe] 全部健康");
	process.exit(warn > 0 ? 1 : 0);
}

void main();