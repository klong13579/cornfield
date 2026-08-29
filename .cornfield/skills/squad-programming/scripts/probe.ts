/**
 * probe.ts — 子任务健康扫描（squad-programming 父盯盘机制）
 *
 * 作用：父不干等消息。定期对未终态子任务做三路探活：
 *   1. 进程存活（ps 按 worktree 路径匹配 cornfield）
 *   2. agent 注册（herdr workspace list 的 agent_status）
 *   3. pane 输出尾部 + 错误签名扫描（API 连接断/进程退出/崩溃堆栈等）
 *
 * 用法：
 *   bun run .cornfield/skills/squad-programming/scripts/probe.ts ~/.cornfield/squads/<squadId>/state.json
 *
 * 输出：每子任务一行 [OK]/[WARN]；WARN 条件 = 进程死 / agent 缺位 / pane 输出命中错误签名。
 * 有 WARN 退出码 1（供父/CI 判读）。
 *
 * WARN 不是判决书：父收到 WARN 后按 SKILL 规则复核（ask 自报 / pane 快照），
 * 仍无响应才标记 STALLED/BLOCKED。错误签名有白名单语境（如 API 断连后 worker 自愈属正常）。
 */
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

const stateFile = process.argv[2];
const STALL_AFTER_S = Number(process.env.PROBE_STALL_AFTER_S ?? 240); // 会话 JSONL 静默阈值

interface SessionInfo {
	id: string;
	name?: string;
	cwd?: string;
	model?: string;
	pid?: number;
	startedAt?: number;
	lastActivity?: number;
	status?: string;
	parentId?: string;
}

/**
 * probeIntercomSessions — 直连 intercom broker 拉会话状态（不绕 herdr）。
 * broker = cornfield-gateway 托管的全局 IPC（~/.cornfield/intercom/broker.sock），
 * length-prefixed JSON 帧（4 字节大端长度 + payload）。
 * 发 {type:"list",requestId} → 收 {type:"sessions",sessions:SessionInfo[]}。
 * SessionInfo.status 即 cornfield 自身状态机（working/idle/done 等同源数据，herdr 只是镜像），
 * lastActivity 毫秒时间戳 = 活动新鲜度（不用再去 stat session JSONL）。
 */
async function probeIntercomSessions(): Promise<Map<string, { status?: string; lastActivity?: number; sessionPath?: string }>> {
	const out = new Map<string, { status?: string; lastActivity?: number; sessionPath?: string }>();
	const sockPath = path.join(os.homedir(), ".cornfield", "intercom", "broker.sock");
	if (!fs.existsSync(sockPath)) return out; // broker 不可用 → 调用方回落
	const requestId = crypto.randomUUID();
	const regMsg = JSON.stringify({
		type: "register",
		session: { name: "cornfield-probe", cwd: "/", pid: process.pid, model: "", startedAt: Date.now(), lastActivity: Date.now() },
	});
	const listMsg = JSON.stringify({ type: "list", requestId });
	const frameOf = (payload: string): Buffer => {
		const b = Buffer.from(payload);
		const f = Buffer.alloc(4 + b.length);
		f.writeUInt32BE(b.length, 0);
		b.copy(f, 4);
		return f;
	};
	try {
		const result = await new Promise<{ sessions?: Array<Record<string, unknown>> }>((resolve, reject) => {
			const sock = net.createConnection(sockPath);
			const timer = setTimeout(() => {
				sock.destroy();
				reject(new Error("broker timeout"));
			}, 5000);
			let buf = Buffer.alloc(0);
			let registered = false;
			sock.on("connect", () => sock.write(frameOf(regMsg)));
			sock.on("data", (chunk) => {
				buf = Buffer.concat([buf, chunk]);
				while (buf.length >= 4) {
					const len = buf.readUInt32BE(0);
					if (buf.length < 4 + len) break;
					const msg = JSON.parse(buf.subarray(4, 4 + len).toString("utf8"));
					buf = buf.subarray(4 + len);
					if (!registered && msg.type === "registered") {
						registered = true;
						sock.write(frameOf(listMsg));
					} else if (registered && msg.type === "sessions" && msg.requestId === requestId) {
						clearTimeout(timer);
						sock.end();
						resolve(msg as { sessions?: Array<Record<string, unknown>> });
						return;
					}
				}
			});
			sock.on("error", (err) => {
				clearTimeout(timer);
				reject(err);
			});
		});
		for (const s of result.sessions ?? []) {
			const si = s as unknown as SessionInfo;
			if (!si.cwd) continue;
			out.set(si.cwd, { status: si.status, lastActivity: si.lastActivity, sessionPath: undefined });
		}
	} catch (err) {
		process.stderr.write(`probe: broker 查询失败（回落到 herdr）: ${(err as Error).message}\n`);
	}
	return out;
}

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
	const byCwd = await probeIntercomSessions();

	/** 最近活动时间戳：优先 broker 的 lastActivity（毫秒），缺失时回落到 session JSONL 文件 mtime。 */
	const lastWrite = (worktree: string): number | null => {
		const viaBroker = byCwd.get(worktree);
		if (viaBroker?.lastActivity) return viaBroker.lastActivity;
		const sessionPath = byCwd.get(worktree)?.sessionPath;
		if (sessionPath) {
			try {
				return fs.statSync(sessionPath).mtimeMs;
			} catch {
				return null;
			}
		}
		// fallback：编码路径推导（未登记 session 时）
		const rel = worktree.replace(os.homedir(), "").replaceAll("/", "-");
		const today = new Date();
		const pad = (n: number) => String(n).padStart(2, "0");
		const dateDir = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
		const byDate = path.join(os.homedir(), ".cornfield", "agent", "sessions", rel, "by-date", dateDir);
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
		// 0. 新近活动：session JSONL 静默挂起检测（进程活着但长时间不写记录 = 卡死/API 挂起）。
		// 只对 running 判停滞：assembled/started 停在 GO 闸门、reviewing 等验收——静默属预期。
		if (s.worktree) {
			const lw = lastWrite(s.worktree);
			if (lw !== null) {
				const idleFor = (Date.now() - lw) / 1000;
				activity = `活动 ${Math.round(idleFor)}s 前`;
				if (s.status === "running" && idleFor > STALL_AFTER_S)
					problems.push(`静默挂起：会话 ${Math.round(idleFor)}s 未写入（>${STALL_AFTER_S}s）`);
			} else if (s.status === "running") {
				// 已开工但找不到会话日志 = 异常；闸门阶段日志还没写属正常
				problems.push("会话日志缺失（未找到 session JSONL）");
			}
		}
		// 1. 进程存活（cornfield + worktree 路径）
		if (s.worktree) {
			const ps = await run(["ps", "aux"]);
			const procLive = ps.out.includes(s.worktree) && ps.out.includes("cornfield");
			if (!procLive) problems.push("进程未找到（cornfield 不匹配）");
		}
		// 2. agent 注册（herdr agent list 的运行态）
		if (s.worktree && runtime === undefined) {
			problems.push("agent 缺位（不在 herdr agent list）");
		} else if (runtime?.status === "idle" && s.status === "running") {
			// idle 只在业务态 running 时可疑；assembled/started 停在 GO 闸门、blocked 等决策——idle 属预期
			problems.push(`运行态 idle（业务态 ${s.status}，未在推进）`);
		} else if (runtime?.status === "done" && !(s.status === "complete" || s.status === "failed" || s.status === "blocked")) {
			// herdr done = agent 完成回合/进程空闲态；业务态未跟上但运行态 done = 漏报终态，提示父 ask 确认
			problems.push(`运行态 done（业务态 ${s.status}，可能漏报终态，ask 确认）`);
		}
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