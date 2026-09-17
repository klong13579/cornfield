/**
 * Project 结果形状 —— 客户端级 Project registry（`~/.cornfield/agent/projects.json`，WP4）的 wire 投影。
 *
 * 权威不在本包：Project 的写入与校验由 coding-agent 的 `agent-domain/project-store` 拥有
 * （一个 root 只能声明一个 Project，root 比较按 symlink 归一）。这里只把它的读模型带出来，
 * 字段与 WP1 `ProjectRecord` 同形 —— 不新造第二套语义。
 *
 * 「没有 Project」和「读不到 Project」是两件事，DTO 不区分二者：**由命令的 ok/error 区分**。
 * 存储文件不存在（ENOENT）是明确的空集；文件在但读不出来是错误，绝不能退化成空列表 ——
 * 那会把「声明过但坏了」显示成「没声明过」。
 */

/** 一个已声明的 Project（读模型，与 `ProjectRecord` 同形）。 */
export interface ProjectRecordDto {
	projectId: string;
	/** 绝对项目根（代码项目通常就是 git toplevel）。 */
	root: string;
	name: string;
	/**
	 * 该 Project 的默认 Agent（§10 解析链的第 2 级）。
	 * 缺省 = 没有声明，不要替它填一个。
	 */
	defaultAgentId?: string;
}

/**
 * 会话归属的来源，与 WP1 `ProjectSource` 同形（`agent-domain/types.ts`）：
 *
 *   - `"session"` —— 会话自己的记录说了算（`SessionHeader.projectId`，装配时由调用方解出）；
 *   - `"cwd"` —— 按会话 cwd 与 Project root 匹配算出来的（旧会话的回落）；
 *   - `"none"` —— 没有任何东西声明过归属。
 *
 * wire 面不 import coding-agent 的域类型（依赖方向是反的），所以这里是手抄的一份形状：
 * 加一档要同时改 `agent-domain/types.ts` 的 `ProjectSource`，两个包由形状锁测试盯着。
 */
export type SessionProjectSourceDto = "session" | "cwd" | "none";

/** `list_projects` 的答复。`projects: []` = 确实没有声明过任何 Project。 */
export interface ProjectListDto {
	projects: ProjectRecordDto[];
	/**
	 * 被查询会话落在哪个 Project 里（先读会话记录的权威归属，旧会话才按 cwd 匹配回落）。
	 *
	 * 缺省 = 调用方没有指定会话（没问过）。缺省不是「无 Project」的另一种写法：
	 * 它的含义是「这次没有可以对应的会话上下文」，调用方不得把它当成一个 Project。
	 */
	currentProjectId?: string;
	/**
	 * `currentProjectId` 的来源（见 `SessionProjectSourceDto`），与它同时出现。
	 *
	 * 缺省 = 没问过（没有会话可查）；`"none"` = 问了，确实没有任何东西声明过归属。
	 * 「没问」与「问了、没有」不是同一件事：调用方不得把前者渲染成后者。
	 */
	currentProjectSource?: SessionProjectSourceDto;
}

/**
 * `set_project` 的答复：存储真正落盘的那一份。
 *
 * 调用方拿它替换手上那份 —— `root` 由存储归一（`path.resolve`），不是发出去的那个字符串。
 * 声明失败（root 已被别的 Project 占用 / 存储写不进去）是 ok:false，不返回半份结果。
 */
export interface ProjectUpsertDto {
	project: ProjectRecordDto;
}

/**
 * `delete_project` 的答复：这次真的删掉了哪个 Project。
 *
 * 没有 `deleted` 标记位：「删一个不存在的 Project」是错误（ok:false），不是一次成功的空删除 ——
 * 幂等的 `deleted:false` 会让一个已经不在的 Project 看起来像是刚被这次调用删掉的。
 */
export interface ProjectDeleteDto {
	projectId: string;
}
