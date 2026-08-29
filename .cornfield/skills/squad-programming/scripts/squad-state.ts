/**
 * squad-state — squad 编排状态读写（父进程中断后可恢复）
 *
 * 状态语义（三段启动语义）：
 *   assembled — worker 进程已启动（pane/agent 在），STARTED 尚未被父确认
 *   started   — 准备检查通过（任务包已读 + 模型生效，父经 ask 确认）——worker 停在 GO 闸门等开工
 *   running   — 父已发 GO（幂等，可补发）——worker 实现中
 *   blocked   — worker 上报阻塞/求助（从 assembled/started/running 均可达）
 *   reviewing — worker 自报待验收（实现完成，等父跑 gate）
 *   complete / failed — 终态（failed 也用于取消：note 记 "cancelled: 原因"）
 *
 * 用法：
 *   state.json show                               打印全部子任务状态
 *   state.json list                               只看未终态（== 恢复清单）
 *   state.json update <taskId> <status> [note] [--force]  更新一个子任务状态
 *   state.json reconcile [--max-concurrency N]    计算 GO 发放/待确认/等待计划（幂等，含父中断恢复）
 *
 * 状态机：assembled → started → running → blocked / reviewing → complete / failed
 * 非法转移（如 complete → started）会被拒绝，除非 --force（仅恢复场景使用）。
 * 终态（complete / failed）不可逆，重复设置同一状态是幂等的（仅更新 timestamp）。
 *
 * 零依赖：只 node:fs / os / path。状态文件 ~/.cornfield/squads/<squadId>/state.json
 * （与任务包归档同目录约定）。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type SubtaskState = {
	id: string;
	isolation: "worktree" | "shared-read" | "shared-write";
	branch?: string;
	worktree?: string;
	paneId?: string;
	model?: string;
	briefPath?: string;
	/** 契约式依赖的子任务 id（集结时从任务包回填；reconcile 按它判断 GO 资格）。 */
	deps?: string[];
	status: "assembled" | "started" | "running" | "blocked" | "reviewing" | "complete" | "failed";
	updatedAt: number;
	note?: string;
};

export type SquadState = {
	squadId: string;
	squadVersion?: number;
	taskType?: string;
	baseBranch?: string;
	/** GO 发放的并发槽位上限（reconcile 用；缺省 3）。 */
	maxConcurrency?: number;
	parent: { target: string; sessionId?: string; cwd: string };
	workspaceId?: string;
	createdAt: number;
	/** 写入计数器，每次 writeState 递增。用于检测并发覆盖。 */
	version: number;
	subtasks: SubtaskState[];
};

export const STATE_STATUSES = ["assembled", "started", "running", "blocked", "reviewing", "complete", "failed"] as const;
export const TERMINAL_STATUSES = ["complete", "failed"] as const;

/** 默认并发槽位：同时处于 running/reviewing/blocked 的子任务数上限。 */
export const DEFAULT_MAX_CONCURRENCY = 3;

/**
 * 合法的状态转移矩阵。键=当前状态，值=允许的目标状态。
 * - assembled 允许直转 blocked/failed：准备检查失败（模型缺 key/包不可读）或 pane 死，
 *   worker 首条消息可能是 BLOCKED/FAILED——不允许会卡死父的落账。
 * - started 只在 GO 闸门：转 running = GO 已发；转 reviewing 是容错（父漏记 running、
 *   worker 已回报 REVIEWING）。started → complete 被拒——GO 台账不能丢，恢复场景用 --force。
 */
export const VALID_TRANSITIONS: Record<string, string[]> = {
	assembled: ["started", "blocked", "failed"],
	started: ["running", "blocked", "reviewing", "failed"],
	running: ["blocked", "reviewing", "complete", "failed"],
	blocked: ["started", "running", "reviewing", "complete", "failed"],
	reviewing: ["running", "complete", "failed"],
	complete: [], // 终态 — 不可变
	failed: [],   // 终态 — 不可变
};

export function squadsDir(): string {
	return path.join(os.homedir(), ".cornfield", "squads");
}

export function statePath(squadId: string): string {
	return path.join(squadsDir(), squadId, "state.json");
}

export function loadState(file: string): SquadState {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")) as SquadState;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`无法读取 squad state ${file}: ${message}`);
	}
}

export function writeState(file: string, state: SquadState): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	state.version = (state.version ?? 0) + 1;
	fs.writeFileSync(file, JSON.stringify(state, null, 2) + "\n");
}

/**
 * 更新一个子任务的状态。
 *
 * 转移合法性校验规则：
 *   - 同一状态重复设置是幂等的（更新 timestamp 和 note，不抛异常）
 *   - 终态（complete / failed）不可逆，转移到其他状态会抛出错误
 *   - 非法转移（如 assembled → complete）抛出错误
 *   - force=true 跳过所有转移校验（仅父中断恢复场景使用）
 *
 * @param file  state.json 路径
 * @param taskId  子任务 id
 * @param status  新状态
 * @param note    可选备注
 * @param force   跳过转移合法性校验（仅父中断恢复场景使用）
 * @returns 更新后的 SquadState
 * @throws 转移非法时抛出错误，终态不可逆
 */
export function updateState(
	file: string,
	taskId: string,
	status: SubtaskState["status"],
	note?: string,
	force?: boolean,
): SquadState {
	const state = loadState(file);
	const subtask = state.subtasks.find(s => s.id === taskId);
	if (!subtask) throw new Error(`state 里没有子任务 ${taskId}`);
	if (!(STATE_STATUSES as readonly string[]).includes(status))
		throw new Error(`非法状态 ${status}（${STATE_STATUSES.join("|")}）`);

	// 幂等：同一状态重复设置，仅更新 timestamp 和 note，不拦
	if (subtask.status !== status) {
		// 转移合法性校验（force 可跳过，仅恢复场景）
		if (!force) {
			const allowed = VALID_TRANSITIONS[subtask.status];
			if (!allowed) {
				throw new Error(`未知的当前状态: ${subtask.status}`);
			}
			if (!allowed.includes(status)) {
				const desc = allowed.length === 0
					? `终态（${subtask.status}）不可变，不允许转移到 ${status}`
					: `不允许的转移: ${subtask.status} -> ${status}（允许: ${allowed.join(" | ")}）`;
				throw new Error(desc);
			}
		}
		subtask.status = status;
	}

	subtask.updatedAt = Date.now();
	if (note) subtask.note = note;
	writeState(file, state);
	return state;
}

export function pendingSubtasks(state: SquadState): SubtaskState[] {
	return state.subtasks.filter(s => !(TERMINAL_STATUSES as readonly string[]).includes(s.status));
}

/** reconcile 计划：父按它驱动 STARTED 确认、GO 发放与调度等待（幂等，含父中断恢复）。 */
export type ReconcilePlan = {
	/** assembled：STARTED 尚未确认——父用 intercom ask 拉（拉到后 update started）。 */
	needAsk: string[];
	/** started 且 deps 全 complete 且槽位空闲——父发 GO（幂等可补发），发完 update running。 */
	needGo: string[];
	/** started 但 deps 未全 complete（blockedBy = 未 complete 的依赖 id，含 failed 与未知 id）。 */
	waitingDeps: Array<{ id: string; blockedBy: string[] }>;
	/** started、deps 已满足但并发槽位满（按子任务数组序排队）。 */
	waitingConcurrency: string[];
	/** started 但 deps 中有 failed——不可能开工，转用户拍板（重拆/放弃）。 */
	unrunnable: Array<{ id: string; failedDeps: string[] }>;
	/** running/reviewing——已开工，占槽。 */
	inFlight: string[];
	/** blocked——等父/用户决策，占槽。 */
	blocked: string[];
	/** complete/failed。 */
	terminal: string[];
	maxConcurrency: number;
	freeSlots: number;
};

/**
 * 计算 reconcile 计划（纯函数，不写文件）。
 * 槽位口径：running / reviewing / blocked 都占槽（进程活着的 worker）；
 * assembled / started 停在 GO 闸门不占槽。maxConcurrency 显式参数 > state.maxConcurrency > 默认 3。
 */
export function reconcilePlan(state: SquadState, maxConcurrency?: number): ReconcilePlan {
	const cap = maxConcurrency ?? state.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
	const statusOf = new Map(state.subtasks.map(s => [s.id, s.status]));
	const plan: ReconcilePlan = {
		needAsk: [],
		needGo: [],
		waitingDeps: [],
		waitingConcurrency: [],
		unrunnable: [],
		inFlight: [],
		blocked: [],
		terminal: [],
		maxConcurrency: cap,
		freeSlots: 0,
	};
	const goEligible: string[] = [];
	for (const s of state.subtasks) {
		if (s.status === "complete" || s.status === "failed") {
			plan.terminal.push(s.id);
		} else if (s.status === "assembled") {
			plan.needAsk.push(s.id);
		} else if (s.status === "blocked") {
			plan.blocked.push(s.id);
		} else if (s.status === "running" || s.status === "reviewing") {
			plan.inFlight.push(s.id);
		} else {
			// started：GO 闸门候选，按 deps 分流
			const failedDeps = (s.deps ?? []).filter(d => statusOf.get(d) === "failed");
			const incompleteDeps = (s.deps ?? []).filter(d => statusOf.get(d) !== "complete");
			if (failedDeps.length > 0) {
				plan.unrunnable.push({ id: s.id, failedDeps });
			} else if (incompleteDeps.length > 0) {
				plan.waitingDeps.push({ id: s.id, blockedBy: incompleteDeps });
			} else {
				goEligible.push(s.id);
			}
		}
	}
	plan.freeSlots = Math.max(0, cap - plan.inFlight.length - plan.blocked.length);
	plan.needGo = goEligible.slice(0, plan.freeSlots);
	plan.waitingConcurrency = goEligible.slice(plan.freeSlots);
	return plan;
}

/** reconcile 计划的人读行动指引（stderr；stdout 始终是 JSON 计划本身）。 */
function describePlan(plan: ReconcilePlan): string {
	const lines: string[] = [];
	if (plan.needAsk.length > 0) {
		lines.push(`needAsk: 对 ${plan.needAsk.join(", ")} 逐个 intercom ask 拉 STARTED/当前状态，确认后 update <id> started`);
	}
	if (plan.needGo.length > 0) {
		lines.push(`needGo: 向 ${plan.needGo.join(", ")} 发 GO（intercom send "[<id>] GO: 开工"，幂等可补发），发完立即 update <id> running`);
	}
	if (plan.waitingDeps.length > 0) {
		for (const w of plan.waitingDeps) lines.push(`waitingDeps: ${w.id} 等依赖 ${w.blockedBy.join(", ")} complete`);
	}
	if (plan.waitingConcurrency.length > 0) {
		lines.push(`waitingConcurrency: ${plan.waitingConcurrency.join(", ")} 依赖已满足但槽位满（占用中：${[...plan.inFlight, ...plan.blocked].join(", ") || "无"}）`);
	}
	if (plan.unrunnable.length > 0) {
		for (const u of plan.unrunnable) lines.push(`unrunnable: ${u.id} 依赖 ${u.failedDeps.join(", ")} 已 failed——转用户拍板（重拆/放弃）`);
	}
	if (lines.length === 0) lines.push("无需动作：无待确认/待开工/等待项");
	return lines.join("\n");
}

function main(): void {
	const args = process.argv.slice(2);
	const forceIndex = args.indexOf("--force");
	const force = forceIndex >= 0;
	if (forceIndex >= 0) args.splice(forceIndex, 1);

	const [file, verb, ...rest] = args;
	if (!file || !verb) {
		process.stderr.write("用法: squad-state <state.json> show|list|update <taskId> <status> [note] [--force]\n");
		process.exit(1);
	}
	if (verb === "show" || verb === "list") {
		if (rest.length > 0) {
			process.stderr.write("show|list 不带额外参数\n");
			process.exit(1);
		}
	} else if (verb === "reconcile") {
		if (rest.length > 1 || (rest.length === 1 && !rest[0]!.startsWith("--max-concurrency="))) {
			process.stderr.write("用法: squad-state <state.json> reconcile [--max-concurrency=N]\n");
			process.exit(1);
		}
	} else {
		process.stderr.write(`未知操作: ${verb}（show|list|update|reconcile）\n`);
		process.exit(1);
	}
	const state = loadState(file);
	if (verb === "reconcile") {
		const flag = rest[0];
		const cap = flag ? Number(flag.slice("--max-concurrency=".length)) : undefined;
		const plan = reconcilePlan(state, cap !== undefined && Number.isFinite(cap) && cap >= 1 ? cap : undefined);
		process.stderr.write(describePlan(plan) + "\n");
		process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
		return;
	}
	if (verb === "show" || verb === "list") {
		const subs = verb === "list" ? pendingSubtasks(state) : state.subtasks;
		process.stdout.write(
			JSON.stringify(
				{
					squadId: state.squadId,
					squadVersion: state.squadVersion ?? null,
					workspaceId: state.workspaceId ?? null,
					parent: state.parent,
					createdAt: new Date(state.createdAt).toISOString(),
					version: state.version,
				subtasks: subs.map(s => ({
					id: s.id,
					status: s.status,
					deps: s.deps ?? [],
					worktree: s.worktree ?? null,
					branch: s.branch ?? null,
					paneId: s.paneId ?? null,
					updatedAt: new Date(s.updatedAt).toISOString(),
					note: s.note ?? "",
				})),
				maxConcurrency: state.maxConcurrency ?? null,
			},
				null,
				2,
			) + "\n",
		);
		return;
	}
	// update
	const [taskId, status, note] = rest as [string, SubtaskState["status"], string | undefined];
	try {
		updateState(file, taskId, status, note, force);
		process.stderr.write(`已更新 ${taskId} -> ${status}${note ? `（${note}）` : ""}\n`);
	} catch (err) {
		process.stderr.write(`更新失败: ${err instanceof Error ? err.message : String(err)}\n`);
		process.exit(1);
	}
}

if (import.meta.main) {
	main();
}