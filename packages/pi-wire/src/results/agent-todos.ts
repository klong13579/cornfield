/**
 * Agent Todo 结果形状 —— Agent 级 Todo 板（WP10 / §37 D4）的 wire 投影。
 *
 * 权威不在本包：Todo 的存储、生命周期、时间戳与 `sessionRefs` 由 coding-agent 的
 * `agent-domain/agent-todo-store` 拥有（`<agentDir>/.cornfield/agent-todos.json`），
 * owner / Project 绑定关系由 `agent-domain/relations` 判。这里只把它的读模型带出来，
 * 字段与 WP1 `AgentTodo` 同形 —— 不新造第二套语义，也不在本包定义任何存储行为。
 *
 * 三块板子不是一回事（§9 / §37），DTO 只描述其中一块：
 *   - **Agent Todo**（本文件）：owner 是 Agent，`projectId` 是可选的业务上下文；
 *   - Session Todo：会话 JSONL 里的 `todo` 工具结果（`WireTodoPhase`），会话结束即结束；
 *   - Project TODO：`<projectRoot>/TODO.md`，由 `project-todo` skill 维护，不是本文件的形状。
 *
 * 「没有任务」和「读不到」是两件事，DTO 不区分二者：**由命令的 ok/error 区分**。
 * 存储文件不存在（ENOENT）是明确的空板；文件在但损坏/版本不符是错误，绝不能退化成空板 ——
 * 那会把「记过但读坏了」显示成「没有任务」。
 */

/**
 * Todo 生命周期（终态不可重开：完成了不会再回到进行中）。
 *
 * 词表（哪些转移合法、哪些要渲染成按钮）见 `../agent-todo-lifecycle.ts` —— 全仓唯一一份，
 * serve 的校验与 web-app 的按钮集合都读它。
 */
export type AgentTodoStatusDto = "open" | "in_progress" | "completed" | "cancelled";
export type AgentTodoPriorityDto = "low" | "medium" | "high";
/** 这条 Todo 是谁提出的 —— 展示用来源标注，不是权限。 */
export type AgentTodoSourceDto = "agent" | "user" | "schedule" | "session";

/** 提醒标记（最小形状；提醒的调度是后续工作包，本文件不描述调度行为）。 */
export interface AgentTodoReminderDto {
	/** 触发时刻，Epoch 毫秒。 */
	at: number;
}

/**
 * 一条长期任务（读模型，与 WP1 `AgentTodo` 同形）。
 *
 * 两个字段由存储拥有，调用方**不能**通过 `set_agent_todo` 改：
 *   - `createdAt` / `updatedAt`：创建时盖章、每次写入重盖（客户端时钟不得重排别人的板子）；
 *   - `sessionRefs`：记录哪些会话推进过它。只能原样送回读到的值；要改会 ok:false，
 *     而不是默默丢掉 —— 静默丢弃是让调用方以为自己写进去了。
 */
export interface AgentTodoDto {
	id: string;
	/** 必填的唯一 owner：这条 Todo 属于哪个 Agent。 */
	agentId: string;
	/** 可选绑定；缺省 = 通用任务（不属于任何 Project）。Project 只是上下文，不拥有 Todo。 */
	projectId?: string;
	title: string;
	notes?: string;
	status: AgentTodoStatusDto;
	priority: AgentTodoPriorityDto;
	/** Epoch 毫秒。 */
	dueAt?: number;
	reminders?: readonly AgentTodoReminderDto[];
	/** 只读：记录哪些会话推进过它，不由调用方写。 */
	sessionRefs: readonly string[];
	source: AgentTodoSourceDto;
	createdAt: number;
	updatedAt: number;
}

/**
 * `list_agent_todos` 的答复：一个 Agent 的整块板子。
 *
 * `agentId` 随板子一起回，因为「这是谁的板子」和「板子上有什么」是两件事：前端按它判定
 * 这次响应是不是当前焦点 Agent 的（迟到的响应不得落进别人的视图）。
 */
export interface AgentTodoListDto {
	agentId: string;
	/**
	 * 该 Agent **声明过**的 Project 绑定（写面的上限，来自
	 * `agent-directory.declaredProjectIds`）。
	 *
	 * 缺省 = 没有声明绑定（未约束），**不是**「一个 Project 都不能绑」；声明存在但读不出来
	 * 时命令直接 ok:false，不会用缺省冒充。
	 */
	projectIds?: string[];
	todos: AgentTodoDto[];
}

/** `set_agent_todo` 的答复：存储真正落盘的那一份（调用方拿它替换手上那份）。 */
export interface AgentTodoUpsertDto {
	todo: AgentTodoDto;
}

/** `delete_agent_todo` 的答复。`deleted:false` = 本来就不在板上（幂等，不是错误）。 */
export interface AgentTodoDeleteDto {
	deleted: boolean;
}
