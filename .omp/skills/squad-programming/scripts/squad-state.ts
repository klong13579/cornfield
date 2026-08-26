/**
 * squad-state — squad 编排状态读写（父进程中断后可恢复）
 *
 * 父 omp 每收到一条子任务状态消息（STARTED/BLOCKED/REVIEWING/COMPLETE/FAILED），就更新
 * state.json 一次；父进程中断重启后，读 state.json 重建每子任务的已知状态，对未终态
 * 子任务逐个用 intercom children + pane 快照复核后继续。
 *
 * 用法：
 *   state.json show                               打印全部子任务状态
 *   state.json list                               只看未终态（== 恢复清单）
 *   state.json update <taskId> <status> [note] [--force]  更新一个子任务状态
 *
 * 状态机：assembled → started → blocked / reviewing → complete / failed
 * 非法转移（如 complete → started）会被拒绝，除非 --force（仅恢复场景使用）。
 * 终态（complete / failed）不可逆，重复设置同一状态是幂等的（仅更新 timestamp）。
 *
 * 零依赖：只 node:fs / os / path。状态文件 ~/.omp/squads/<squadId>/state.json
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
	status: "assembled" | "started" | "blocked" | "reviewing" | "complete" | "failed";
	updatedAt: number;
	note?: string;
};

export type SquadState = {
	squadId: string;
	squadVersion?: number;
	taskType?: string;
	baseBranch?: string;
	parent: { target: string; sessionId?: string; cwd: string };
	workspaceId?: string;
	createdAt: number;
	/** 写入计数器，每次 writeState 递增。用于检测并发覆盖。 */
	version: number;
	subtasks: SubtaskState[];
};

export const STATE_STATUSES = ["assembled", "started", "blocked", "reviewing", "complete", "failed"] as const;
export const TERMINAL_STATUSES = ["complete", "failed"] as const;

/** 合法的状态转移矩阵。键=当前状态，值=允许的目标状态。 */
export const VALID_TRANSITIONS: Record<string, string[]> = {
	assembled: ["started"],
	started: ["blocked", "reviewing", "complete", "failed"],
	blocked: ["started", "reviewing", "complete", "failed"],
	reviewing: ["started", "complete", "failed"],
	complete: [], // 终态 — 不可变
	failed: [],   // 终态 — 不可变
};

export function squadsDir(): string {
	return path.join(os.homedir(), ".omp", "squads");
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
	} else if (verb === "update") {
		if (rest.length < 2 || rest.length > 3) {
			process.stderr.write("用法: squad-state <state.json> update <taskId> <status> [note] [--force]\n");
			process.exit(1);
		}
	} else {
		process.stderr.write(`未知操作: ${verb}（show|list|update）\n`);
		process.exit(1);
	}
	const state = loadState(file);
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
						worktree: s.worktree ?? null,
						branch: s.branch ?? null,
						paneId: s.paneId ?? null,
						updatedAt: new Date(s.updatedAt).toISOString(),
						note: s.note ?? "",
					})),
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