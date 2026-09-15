/**
 * cron 结果形状（B6 gateway 代理：get_cron_tasks / get_cron_logs；T10C 补写面与 Agent 绑定）。
 * 字段对齐 cornfield-gateway scheduler 的 jobs.json / 执行日志。
 *
 * ## T10C：Schedule 的 Agent 绑定是一个持久化的事实，不是渲染时的猜测
 *
 * `ScheduledTask` 有三代字段：`accountId`（废弃）→ `agentDir`（今天）→ `agentId`（注册表 key）。
 * 一个 Schedule 到点必须按**自己存下来的身份**拉起 Agent，不能读「屏幕上当前选中的 Agent」——
 * 所以 `agentId` 在创建时解析并落盘（`resolveScheduleAgent`：由 agentDir 反查注册表，
 * 或由 agentId 取注册表的 home），`agentResolution` 把「解析到了 / 解析不到 / 根本没绑」三态
 * 分开报，网关侧算好（前端不自己猜、不把坏绑定显示成未绑定）。
 *
 * ## 三种 resolution 的区别（不要把任意两种合并）
 *
 *   registered    agentDir 命中一个已注册 Agent（`agentId` 一定有值）
 *   unregistered  有 agentDir，但它不是任何已注册 Agent 的家 —— 身份未知，必须显示出来
 *   unbound       既没有 agentId 也没有 agentDir —— 不执行（`docs/client/agent-hub.md` §1.7）
 */

/** Schedule 的 Agent 绑定解析状态（网关按注册表算，客户端只显示）。 */
export type ScheduleAgentResolution =
	/** agentDir 命中已注册 Agent；`agentId` 是它的注册表 key。 */
	| "registered"
	/** 有 agentDir，但它不是任何已注册 Agent 的家（旧数据 / 手写配置）。 */
	| "unregistered"
	/** 既无 agentId 也无 agentDir：无绑定，不执行。 */
	| "unbound";

/** 失败重试配置（scheduler `RetryConfig`，不是新概念）。 */
export interface TaskRetryDto {
	maxAttempts: number;
	backoffMs: number[];
	retryOn?: string[];
}

/** 执行结果投递配置（scheduler `ScheduledTask.delivery`）。 */
export interface TaskDeliveryDto {
	channel: string;
	accountId?: string;
	toUserId?: string;
	toConversationId?: string;
	mode: "announce" | "none";
}

/**
 * 定时任务行（对齐 cornfield-gateway ScheduledTask 可见字段）。
 *
 * T10C 新增字段分两组，都是工作台的判断依据而非展示装饰：
 *   绑定   agentId / agentDir / agentDisplayName / agentResolution / agentError / projectIds
 *   可靠性 taskType / timeoutMs / retry / repeatCount / repeatCompleted / delivery / lastDeliveryError / 时间戳
 */
export interface TaskRowDto {
	id: string;
	name: string;
	description?: string;
	/** 启停状态（active/paused/disabled；前端可以此区分暂停与禁用）。 */
	status?: "active" | "paused" | "disabled";
	/** cron / interval / once。 */
	scheduleType: "cron" | "interval" | "once";
	/** 5 字段 cron 表达式（scheduleType=cron 时）。 */
	cron?: string;
	/** 下次触发（毫秒）。 */
	nextRunAt?: number;
	lastRunAt?: number;
	enabled: boolean;
	/**
	 * @deprecated 旧字段。它**不**等于 Agent 身份：历史任务是「accountId 或 agentDir 二者择一」
	 * 存的，旧实现把 agentDir 冒充成 accountId 是本工作台要消灭的假数据。读绑定请用
	 * `agentId` / `agentDir` / `agentResolution`。
	 */
	accountId?: string;
	/** 执行命令（jobs.json command）。 */
	command?: string;
	runCount?: number;
	failCount?: number;
	consecutiveFailures?: number;

	// ── Agent 绑定（T10C） ──
	/** 注册表 key（resolved）。旧数据未解析时缺省。 */
	agentId?: string;
	/** 执行 home（agent 任务的 cwd）。 */
	agentDir?: string;
	/** Agent 的显示名（注册表声明；未注册时缺省 —— 不拿 agentId 冒充）。 */
	agentDisplayName?: string;
	/** 绑定解析三态（见文件头）。 */
	agentResolution: ScheduleAgentResolution;
	/**
	 * 已注册 Agent 是否可用（agentDir 还在）。仅在 `agentResolution === "registered"` 时有值：
	 * `false` = 身份解析到了但家不在了 —— 调度跑不起来，与「未绑定」不是同一件事。
	 */
	agentEnabled?: boolean;
	/** unregistered / unbound 的人话原因（有值 = 这个 Schedule 跑不起来，不静默）。 */
	agentError?: string;
	/**
	 * Agent 声明绑定的 Project id（`workspace.json` projectRoot 命中 Project registry 时）。
	 * `undefined` = 没声明绑定（**不受约束**，不是「没有项目」）。
	 */
	projectIds?: string[];

	// ── 生命周期 / 可靠性（T10C：工作台按它们区分重复执行、失败重试、超时） ──
	/** shell / agent（缺省按 scheduler 语义视为 shell）。 */
	taskType?: "shell" | "agent";
	timeoutMs?: number;
	retry?: TaskRetryDto;
	/** 总执行次数上限（null/undefined = 不限）。 */
	repeatCount?: number;
	/** 已执行次数（配合 repeatCount 判断「跑完了」）。 */
	repeatCompleted?: number;
	delivery?: TaskDeliveryDto;
	/** 最近一次投递失败原因（投递失败 ≠ 任务失败，两者分开看）。 */
	lastDeliveryError?: string;
	createdAt: number;
	updatedAt: number;
}

/** cron 执行日志条目（output/stderr 服务端已截断 2KB）。 */
export interface CronLogEntryDto {
	taskId: string;
	id: string;
	ts: number;
	status: string;
	exitCode: number | null;
	durationMs: number | null;
	output?: string;
	outputTruncated?: boolean;
	stderr?: string;
	/**
	 * agent 任务的 OMP 会话 JSONL 绝对路径（Session scope 的权威链接）。
	 * 缺省 = shell 任务、或该次执行没落到会话文件。**不**用文件名猜。
	 */
	agentSessionPath?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 写面（T10C：调度定义 CRUD 走 wire —— docs/client/agent-hub.md §1.7/§7-P1）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 新建调度定义的输入。
 *
 * `agentId` / `agentDir` 至少要有一个：网关用 agent-domain 解析成 `{ agentId, agentDir }`
 * 再落盘（解析不到 → ok:false，不写一条无主的 Schedule）。只给 agentDir 时反查注册表，
 * 命中就把 agentId 一起落盘 —— 这正是「持久化 resolved agentId」。
 */
export interface CronCreateInput {
	name: string;
	/** 5 字段 cron / interval / once（与 `parseSchedule` 同语法）。 */
	cron: string;
	/** agent 任务的 prompt 或 shell 任务的命令行。 */
	command: string;
	description?: string;
	scheduleType?: "cron" | "interval" | "once";
	taskType?: "shell" | "agent";
	/** 注册表 key；与 agentDir 至少给一个。 */
	agentId?: string;
	/** Agent 的 home；与 agentId 至少给一个。 */
	agentDir?: string;
	model?: string;
	provider?: string;
	enabledToolsets?: string[];
	timeoutMs?: number;
	repeatCount?: number;
	retry?: TaskRetryDto;
	skills?: string[];
	preScript?: string;
	delivery?: TaskDeliveryDto;
	/** 缺省 active。 */
	status?: "active" | "paused";
}

/** 更新调度定义：只带要改的字段（缺省 = 不改）。 */
export interface CronUpdateInput {
	name?: string;
	cron?: string;
	command?: string;
	description?: string;
	status?: "active" | "paused" | "disabled";
	taskType?: "shell" | "agent";
	/**
	 * 改绑 Agent（恢复旧 Schedule 的绑定走这条）。解析不到 → ok:false，原绑定不动。
	 *
	 * 声明式语义：
	 * - 两个字段都不给 = 不动绑定（只有改别的字段时才这样）；
	 * - 只给 `agentId` → 落盘该 Agent 的注册 home；
	 * - 只给 `agentDir` → **整个绑定换成该目录**（identity 重算或清掉），不隐式保留旧 agentId；
	 * - 两个都给 → 必须一致（指向同一个 Agent），不一致 → ok:false；
	 * - `unbind: true` → 清空绑定（与上面两个字段互斥）。
	 */
	agentId?: string;
	agentDir?: string;
	/** 显式清空绑定：行保留、不执行；与 agentId/agentDir 互斥。 */
	unbind?: boolean;
	model?: string;
	provider?: string;
	enabledToolsets?: string[];
	timeoutMs?: number;
	repeatCount?: number;
	retry?: TaskRetryDto;
	skills?: string[];
	preScript?: string;
	delivery?: TaskDeliveryDto;
}

/** 写面统一响应：回写落盘后的行（含重新解析的绑定状态），调用方据此刷新而不重读全表。 */
export interface CronTaskWriteResultDto {
	task: TaskRowDto;
}

/** `cron_remove` 响应。 */
export interface CronRemoveResultDto {
	/** 被删掉的任务名（已不存在时请求本身失败，不静默成功）。 */
	removed: string;
}

/** `cron_test_run` 响应（gateway `TestRunStarted` 的 wire 形状）。 */
export interface CronTestRunResultDto {
	kind: "started";
	name: string;
	/** 钳制后的触发延迟（毫秒）。 */
	inMs: number;
	/** 孤儿回收截止（startedAt + inMs + 90s）。 */
	expiresAt: number;
	startedAt: number;
}
