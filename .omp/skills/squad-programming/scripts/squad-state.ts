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
 *   state.json update <taskId> <status> [note]    更新一个子任务状态
 *
 * 状态机：assembled → started → blocked / reviewing → complete / failed
 * （恢复时未终态 = assembled / started / blocked / reviewing）
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
	taskType?: string;
	baseBranch?: string;
	parent: { target: string; sessionId?: string; cwd: string };
	workspaceId?: string;
	createdAt: number;
	subtasks: SubtaskState[];
};

export const STATE_STATUSES = ["assembled", "started", "blocked", "reviewing", "complete", "failed"] as const;
export const TERMINAL_STATUSES = ["complete", "failed"] as const;

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
	fs.writeFileSync(file, JSON.stringify(state, null, 2) + "\n");
}

export function updateState(file: string, taskId: string, status: SubtaskState["status"], note?: string): SquadState {
	const state = loadState(file);
	const subtask = state.subtasks.find(s => s.id === taskId);
	if (!subtask) throw new Error(`state 里没有子任务 ${taskId}`);
	if (!(STATE_STATUSES as readonly string[]).includes(status))
		throw new Error(`非法状态 ${status}（${STATE_STATUSES.join("|")}）`);
	subtask.status = status;
	subtask.updatedAt = Date.now();
	if (note) subtask.note = note;
	writeState(file, state);
	return state;
}

export function pendingSubtasks(state: SquadState): SubtaskState[] {
	return state.subtasks.filter(s => !(TERMINAL_STATUSES as readonly string[]).includes(s.status));
}

function main(): void {
	const [file, verb, ...rest] = process.argv.slice(2);
	if (!file || !verb) {
		process.stderr.write("用法: squad-state <state.json> show|list|update <taskId> <status> [note]\n");
		process.exit(1);
	}
	if (verb === "show" || verb === "list") {
		if (rest.length > 0) {
			process.stderr.write("show|list 不带额外参数\n");
			process.exit(1);
		}
	} else if (verb === "update") {
		if (rest.length < 2 || rest.length > 3) {
			process.stderr.write("用法: squad-state <state.json> update <taskId> <status> [note]\n");
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
					workspaceId: state.workspaceId ?? null,
					parent: state.parent,
					createdAt: new Date(state.createdAt).toISOString(),
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
	updateState(file, taskId, status, note);
	process.stderr.write(`已更新 ${taskId} -> ${status}${note ? `（${note}）` : ""}\n`);
}

if (import.meta.main) {
	main();
}