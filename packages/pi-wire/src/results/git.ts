/**
 * `git_changes` 结果形状 —— 一个仓库 working tree 的改动清单（serve 端权威数据面）。
 *
 * 权威不在本包：改动是 git 自己的事实（`git status` 读出来的工作区状态），这里只是它的 wire
 * 投影。与既有 `git_status` 的关系：那条命令给的是**计数**（staged/unstaged/untracked 三个
 * 数），本命令给的是**逐条清单** —— 计数答不了「改的是哪几个文件」，清单答不了「一共几条」，
 * 两者各有各的用途，谁也不替代谁（客户端不许拿计数去凑清单）。
 *
 * 一件事上格外小心：**改动不能按会话归属**。git 只知道「这个路径与 HEAD/index 不同」，
 * 不知道是哪次 agent 运行改的 —— 所以本形状里没有 `sessionId` 之类的字段。一个「属于某会话
 * 的改动」是编出来的事实（同一个工作区被两个会话改过时，它连唯一答案都没有）；要按
 * Root/Child Session 分组，只能按「这份清单是拿哪个 agent/session 去问的」分组。
 */

/**
 * 一条路径在某一轴上的改动状态（词表 = `git status --porcelain` 的字母 + 未跟踪/冲突两态）。
 */
export type GitChangeStateDto =
	| "modified"
	| "added"
	| "deleted"
	| "renamed"
	| "copied"
	| "type-changed"
	/** 未跟踪（porcelain 的 `??`）：只可能出现在 worktree 轴上。 */
	| "untracked"
	/** 未合并/冲突（porcelain 的 `UU`/`AA`/`DD`/`AU`/`UA`/`DU`/`UD`）。 */
	| "conflicted";

/**
 * 一条改动。
 *
 * 为什么是两条轴而不是一个 `status`：一个文件可以**同时**是「已 staged 修改」和「工作区又
 * 改了一版」（porcelain 的 `MM`）—— 这是 git 本来就分开记的两个事实，合成一个字段必然丢掉
 * 一个，「准备提交的」与「还没 add 的」也就分不出来了。
 *
 * 冲突（unmerged）时两轴都报 `conflicted`：porcelain 只给一个 X/Y 对，git 不把冲突拆成
 * 「索引侧 / 工作区侧」，这里不替它编一个拆分方式；`conflicted` 一旦出现，调用方就应按
 * 「这个路径需要人工合并」处理，不要去看另一轴推谁改了哪边。
 */
export interface GitChangeDto {
	/**
	 * 仓库相对路径（正斜杠，相对 `repoRoot`）；rename/copy 时是**目标**路径
	 * （来源见 `oldPath`）。
	 */
	path: string;
	/** rename/copy 的来源路径；其余情况缺省（不是空串）。 */
	oldPath?: string;
	/** HEAD → index（porcelain 的 X）。`null` = 这一轴干净，不是「未知」。 */
	index: GitChangeStateDto | null;
	/** index → worktree（porcelain 的 Y）。`null` = 这一轴干净；`untracked` 只在这里有值。 */
	worktree: GitChangeStateDto | null;
}

/**
 * `git_changes` 的答复。
 *
 * `changes` 是**清单的全部**：空数组 = 工作区确实干净（读到了，一条也没有），
 * 不是「没读到」—— 没读到（不是 git 仓库 / git 失败 / 未知 agent）整条命令 ok:false，
 * 那才是「不知道」。用空数组冒充读失败，用户会得到「什么都没改」这个反的结论。
 */
export interface GitChangesDto {
	/** 仓库根绝对路径（改动路径相对它解析）。 */
	repoRoot: string;
	/** 按 `path` 升序的改动清单（顺序稳定，UI 不再排序也不会跳）。 */
	changes: GitChangeDto[];
	/**
	 * 本次答复的降级原因：命令成功、`changes` 有效，但**有一项事实没读到**
	 * （例如未跟踪文件枚举被上限截断 —— 那些文件不在 `changes` 里，沉默就等于告诉调用方
	 * 「工作区就这些改动」）。**整份读不到不走这里**，那是 ok:false。
	 *
	 * 缺省 = 这份清单是完整的。
	 */
	error?: string;
}
