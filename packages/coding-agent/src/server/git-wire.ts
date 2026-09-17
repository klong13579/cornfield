/**
 * `git_changes` 的 serve 侧投影 —— 一个仓库 working tree 的改动**清单**（`GitChangesDto`）。
 *
 * 权威是 git 自己：这里只把 `git status --porcelain=v1 -z` 的事实翻成 wire 形状，不推断
 * 「这次改动是谁做的」（git 不知道，形状里也就没有 sessionId —— 见 pi-wire `results/git.ts`）。
 *
 * ## 为什么是 -z
 *
 * 非 -z 形态的路径是**给人看的**：含空格/反斜杠/控制字符的路径会被引号包起来并转义
 * （受 `core.quotePath` 影响），rename 记录是 `R  from -> to` 这种要猜分隔符的拼接。
 * -z 是逐字节原样 + NUL 分隔 + rename 两段（**先目标、后来源**），是唯一能无歧义还原路径的形态。
 *
 * ## 为什么不复用 wire-server 的 `parseGitPorcelain`
 *
 * 那个是**计数**视图：它把 porcelain 的两轴压成 staged/unstaged/untracked 三个数组，于是
 * 「index 干净」与「字母不认识」都变成「不 push」，rename 的来源路径被丢掉，`??` 之外的
 * 未知字母被静默忽略。本模块要的正好是它丢掉的那些：逐条两轴状态 + 来源路径 + 读不出来的部分。
 * 两者各有用途，谁也不替代谁（`git_status` 答「几条」，本命令答「哪几条」）。
 *
 * ## 失败模型
 *
 * - 不是 git 仓库 / git 命令失败 / 输出整份读不出来（全部记录都无法解析）→ **抛**，由命令回
 *   `ok:false`。空清单是「工作区确实干净」这个**事实**，不能拿它冒充读不到。
 * - 命令成功但有部分事实没读到（记录超过上限被截断、个别记录解析不了）→ 正常返回 + `error`
 *   说清丢了多少、为什么。客户端据此显示「这份清单不完整」，而不是「就这些」。
 */

import type { GitChangeDto, GitChangeStateDto, GitChangesDto } from "@cornfield/wire";
import * as git from "../utils/git";

/**
 * 一次答复最多返回多少条改动。
 *
 * 上限的存在理由是**这不是一个可以无界的资源**：一个没被忽略的 `node_modules`（或一次
 * `npm install` 之后）能让未跟踪文件涨到十万量级，而这条答复会整个进一个 WS 帧。截断不隐藏
 * 事实 —— 条数与原因写进 `error`，调用方知道「还有，没给全」。
 */
export const MAX_GIT_CHANGES = 500;

/** porcelain v1 的两轴字母 → 状态。空格 = 这一轴干净（`null`），不是「未知」。 */
const AXIS_STATES: Record<string, GitChangeStateDto | null> = {
	" ": null,
	M: "modified",
	A: "added",
	D: "deleted",
	R: "renamed",
	C: "copied",
	T: "type-changed",
	"?": "untracked",
	U: "conflicted",
};

/** 未合并（unmerged）的组合：porcelain 只给一个 X/Y 对，两轴都报 conflicted。 */
const UNMERGED_PAIRS = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

export interface GitChangeParseResult {
	changes: GitChangeDto[];
	/** 解析不了的记录**条数**（不带整份原文：坏输入不该把内存也吃掉）。 */
	unreadableCount: number;
	/** 第一条解析不了的记录原文（截断），作为「到底哪里读不出来」的证据。 */
	unreadableSample?: string;
}

/**
 * 解析 `git status --porcelain=v1 -z` 的输出。
 *
 * 记录形状：`XY <path>\0`；rename/copy（X 是 `R`/`C`）后面再跟一段 `\0<来源路径>`。
 * 同一路径可以出现两条记录（例：`D  f` 之后工作区又有一个未跟踪的 `f` 是 `?? f`）——两轴模型
 * 本来就能表达它，这里**合并成一条**（index=deleted、worktree=untracked），而不是让清单里出现
 * 两条同路径、各自有一条轴假装「干净」的假记录。合并时同一轴出现两个**不同**的非空状态 =
 * 这份输出读不准，整条记为读不出来（宁可少报一条，也不编一条）。
 */
export function parseGitChangeEntries(text: string): GitChangeParseResult {
	const tokens = text.split("\0");
	const byPath = new Map<string, GitChangeDto>();
	let unreadableCount = 0;
	let unreadableSample: string | undefined;
	const unreadable = (record: string): void => {
		unreadableCount += 1;
		unreadableSample ??= record.slice(0, 80);
	};

	for (let i = 0; i < tokens.length; i += 1) {
		const record = tokens[i] ?? "";
		// -z 的末尾（以及记录之间）会有空段：它不是记录。
		if (record === "") continue;
		const x = record[0] ?? "";
		const y = record[1] ?? "";
		// 状态两字母之后必须是一个空格，路径至少一个字符：`"XY path"` 最短 4 字节。
		if (record.length < 4 || record[2] !== " ") {
			unreadable(record);
			continue;
		}
		const path = record.slice(3);
		let oldPath: string | undefined;
		if (x === "R" || x === "C") {
			const from = tokens[i + 1];
			// -z 的 rename 记录：第一段是目标路径，第二段是来源路径（缺第二段 = 记录被截断）。
			if (from === undefined || from === "") {
				unreadable(record);
				continue;
			}
			oldPath = from;
			i += 1;
		}
		const axes = readAxes(x, y);
		if (!axes) {
			unreadable(record);
			continue;
		}
		const existing = byPath.get(path);
		if (!existing) {
			const change: GitChangeDto = { path, index: axes.index, worktree: axes.worktree };
			if (oldPath !== undefined) change.oldPath = oldPath;
			byPath.set(path, change);
			continue;
		}
		const merged: GitChangeDto = { ...existing };
		let collision = false;
		for (const axis of ["index", "worktree"] as const) {
			const next = axes[axis];
			if (next === null) continue;
			if (merged[axis] === null) merged[axis] = next;
			else if (merged[axis] !== next) collision = true;
		}
		if (oldPath !== undefined && merged.oldPath === undefined) merged.oldPath = oldPath;
		if (collision) {
			unreadable(record);
			continue;
		}
		byPath.set(path, merged);
	}

	return unreadableSample === undefined
		? { changes: [...byPath.values()], unreadableCount }
		: { changes: [...byPath.values()], unreadableCount, unreadableSample };
}

/** 两轴状态；`undefined` = 这对字母读不出来（不认识，或 `?` 出现在不该出现的轴上）。 */
function readAxes(
	x: string,
	y: string,
): { index: GitChangeStateDto | null; worktree: GitChangeStateDto | null } | undefined {
	if (UNMERGED_PAIRS.has(`${x}${y}`)) return { index: "conflicted", worktree: "conflicted" };
	if (x === "?" && y === "?") return { index: null, worktree: "untracked" };
	// `?` 只在 worktree 轴上有意义（porcelain 的 `??`）；单独出现在 X 轴 = 读不准。
	if (x === "?" || y === "?") return undefined;
	const index = axisState(x);
	const worktree = axisState(y);
	if (index === undefined || worktree === undefined) return undefined;
	return { index, worktree };
}

function axisState(letter: string): GitChangeStateDto | null | undefined {
	return Object.hasOwn(AXIS_STATES, letter) ? AXIS_STATES[letter] : undefined;
}

/**
 * 读一个目录所在仓库的 working tree 改动清单。
 *
 * `cwd` 是**目标会话工作的那个根**（`src/server/wire-server.ts` 的 `resolveWorkRoot`：
 * 绑定了 Project 就是它的 root，未绑定就是 agentDir）—— 与 `git_status` / `git_diff` 同一个目录，
 * 同一个仓库、同一份事实，所以「几条」与「哪几条」不会互相打架。worktree 是整棵（含 cwd 之外的路径），
 * `path` 一律相对 `repoRoot`（git 自己就是这么给的，不按 cwd 相对化）。
 */
export async function readGitChanges(cwd: string): Promise<GitChangesDto> {
	const repoRoot = await git.repo.root(cwd);
	if (!repoRoot) throw new Error(`not a git repository: ${cwd}`);
	const raw = await git.status(cwd, { porcelainV1: true, untrackedFiles: "all", z: true });
	return projectGitChanges(repoRoot, raw);
}

/**
 * `repoRoot` 与 `git status --porcelain=v1 -z` 原文 → 答复。
 *
 * 与 I/O 分开是因为这一段是有判定的：排序、条数上限、以及「读不出来」的三种出路。
 * 它吃什么就吐什么，离了 git 也能问「这份原文会得到什么答复」。
 */
export function projectGitChanges(repoRoot: string, statusText: string): GitChangesDto {
	const parsed = parseGitChangeEntries(statusText);
	// 一条都读不出来 = 这份工作区根本没读到，不是「没有改动」：空清单会被读成后者。
	if (parsed.changes.length === 0 && parsed.unreadableCount > 0) {
		throw new Error(
			`git status 的 ${parsed.unreadableCount} 条记录全部无法解析（首条：` +
				`${JSON.stringify(parsed.unreadableSample ?? "")}）`,
		);
	}

	const sorted = parsed.changes.sort(compareByPath);
	const notes: string[] = [];
	if (parsed.unreadableCount > 0) {
		notes.push(
			`git status 有 ${parsed.unreadableCount} 条记录无法解析（首条：` +
				`${JSON.stringify(parsed.unreadableSample ?? "")}），清单可能不完整`,
		);
	}
	const truncated = sorted.length > MAX_GIT_CHANGES;
	if (truncated) {
		notes.push(`工作区共 ${sorted.length} 条改动，只返回按 path 升序的前 ${MAX_GIT_CHANGES} 条`);
	}
	const dto: GitChangesDto = { repoRoot, changes: sorted.slice(0, MAX_GIT_CHANGES) };
	if (notes.length > 0) dto.error = notes.join("；");
	return dto;
}

/** 按 `path` 升序（字节序比较，不用 locale 排序：同一份清单在任何机器上都得到同一个顺序）。 */
function compareByPath(a: GitChangeDto, b: GitChangeDto): number {
	if (a.path < b.path) return -1;
	if (a.path > b.path) return 1;
	return 0;
}
