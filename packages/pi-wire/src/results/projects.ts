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

/** `list_projects` 的答复。`projects: []` = 确实没有声明过任何 Project。 */
export interface ProjectListDto {
	projects: ProjectRecordDto[];
	/**
	 * 被查询会话落在哪个 Project 里（按 WP4 的 root 匹配规则算）。
	 *
	 * 缺省 = 没匹配上，或调用方没有指定会话。缺省不是「无 Project」的另一种写法：
	 * 它的含义是「这次没有可以对应的会话上下文」，调用方不得把它当成一个 Project。
	 */
	currentProjectId?: string;
}
