/**
 * Session Tree 结果形状 —— 父会话对自己委派出去的子会话的底账（serve 端权威数据面）。
 *
 * 权威不在本包：账本由 coding-agent 的 `session/session-tree-manager` 拥有，物理上存在
 * **父会话自己的 JSONL** 里（`session-tree-store` 的 `session_tree_node` custom entry）。
 * 这里只是它的 wire 投影，字段与 WP1 `SessionNode` / `ChildSessionRecord` 同形 ——
 * 本文件不新造第二套会话树语义。
 *
 * 为什么是「一层」而不是整棵树：账本是父会话自己的记录，孙会话在子会话自己的日志里。
 * 一次查询只回答一个会话的直接子会话；要展开深一层，拿子会话的 sessionId 再查一次。
 * 递归到读不出来的层级只会把「不知道」写成空数组。
 */

/** 子会话状态（`SessionNode.status` 词表；completed/failed/cancelled 为终态，不可重开）。 */
export type ChildSessionStatusDto = "running" | "waiting_user" | "completed" | "failed" | "cancelled";

/** 子会话当前阻塞在父会话的什么（父会话记下它，因为它比那次上报活得久）。 */
export interface ChildSessionEscalationDto {
	/** 阻塞类型（`child-session-report` 的两值词表：向父提问 / 等权限裁决）。 */
	blocking: "ask" | "permission";
	/** 子会话自己的话；可为空 —— 一次 `waiting` 上报本身就是证据。 */
	question: string;
	/** 子会话**开始**阻塞的时刻（epoch ms），不是这条上报的时刻。 */
	at: number;
}

/**
 * 一个被委派的子会话，如父会话账本所记。
 *
 * `resultRef` 与 `resultBroughtBackAt` 分开：结果「就绪」与「已带回」是两件事，
 * 只有后者为真时才允许把内容并入父会话上下文（见 `bring_back_child_result`）。
 */
export interface ChildSessionNodeDto {
	sessionId: string;
	parentSessionId: string;
	/** 根祖先的 id；子会话与父会话必然相同。 */
	rootSessionId: string;
	/** 距根的层数：根自身为 0，它的直接子会话为 1。 */
	depth: number;
	agentId: string;
	projectId?: string;
	status: ChildSessionStatusDto;
	/** 这条委派的用途标签（一个目标、一个角色名……）。 */
	delegationRole?: string;
	/** 这条委派要完成什么。 */
	objective?: string;
	/** 子会话上报的结果指针（文件路径等）；缺省 = 尚无结果。 */
	resultRef?: string;
	/** 父会话记下「结果已带回」的时刻（epoch ms）。 */
	resultBroughtBackAt?: number;
	/** 父会话最后见到的子会话进程 pid（重启后判断存活用）。 */
	lastPid?: number;
	escalation?: ChildSessionEscalationDto;
	/** 节点为何处于当前状态（状态本身说不清时的原因）。 */
	statusDetail?: string;
	createdAt: number;
	updatedAt: number;
}

/**
 * `get_session_tree` 的答复。
 *
 * `sessionId` 是账本的 owner（被查询的会话，通常是当前工作台的主会话）；`children` 是
 * 它直接委派出去的子会话。`agentId`/`agentName`/`title` 只是展示用的身份投影，账本
 * 本身不含它们。
 */
export interface SessionTreeDto {
	sessionId: string;
	agentId?: string;
	agentName?: string;
	title?: string;
	children: ChildSessionNodeDto[];
}

/** `bring_back_child_result` 的答复。 */
export interface BroughtBackChildResultDto {
	childSessionId: string;
	resultRef: string;
	/** 被指向的产物内容（serve 端读取；读取失败即 ok:false，不返回半份内容）。 */
	content: string;
	/**
	 * true = 这一次才带回；false = 此前已带回。
	 * 调用方必须用它作为「要不要把结果并入自己的上下文」的门闩 —— 重复注入同一条结果
	 * 是把同一次工作算两遍。
	 */
	firstTime: boolean;
	broughtBackAt: number;
	/** 是否已把内容写进父会话（仅 firstTime 时注入；重复带回不再写）。 */
	injected: boolean;
}
