/**
 * 范围（scope）判定 —— 全仓**唯一一份**规则：一条路径落在哪个锚点下。
 *
 * 词表 `agent | project | global` 是两端共用的：技能页（`SkillScopeRowDto.scope`）与
 * composer 的上下文条目（web-app 的 `ContextItem.scope`）问的是同一件事 —— 这个文件属于
 * Agent 自己的家 / 会话所在的 Project / 两者之外。两处说法必须一致，所以规则也只留一份：
 * serve 的 `server/skill-scope.ts` 与 web-app 都调这里的 `classifyScope`，没有人再实现第二遍。
 *
 * 判定顺序即优先级：agentDir 在 Project 里时（registry agent 的会话 cwd = agentDir）
 * 「属于这个 Agent」比「落在某个项目路径下」更具体，所以先判 agentDir。
 *
 * 路径包含判定由调用方传入（`contains`），本函数不自己写：归一能力是**运行时事实**不是规则 ——
 * serve 用 `@cornfield/utils` 的 pathIsWithin（realpath + 分隔符边界），浏览器做不到 realpath
 * （也绝不假装做到），只能做文本归一。规则只有一条，归一各按各的运行时的真实能力来。
 */

/** 一条路径的归属范围：Agent 自己的家 / 会话所在的 Project / 两者之外（全局用户库等）。 */
export type Scope = "agent" | "project" | "global";

/** 判定依据：三个绝对路径锚点（调用方按 Agent / 会话 / Project 解析后传入）。 */
export interface ScopeAnchors {
	/** Agent 的物理 home。 */
	agentDir: string;
	/** 会话根（未 attach 的 agent：传 agentDir —— 它就是那个 agent 的会话根）。 */
	sessionCwd: string;
	/** 会话所属 Project 的 root（未归属 = 缺省，不是空串）。 */
	projectRoot?: string;
}

/** root 是否包含 candidate（含 root 自身）。各运行时按自己的归一能力实现。 */
export type PathContainment = (root: string, candidate: string) => boolean;

/** 一条绝对路径 + 锚点 → 范围。判定顺序即优先级（见文件头）。 */
export function classifyScope(filePath: string, anchors: ScopeAnchors, contains: PathContainment): Scope {
	if (contains(anchors.agentDir, filePath)) return "agent";
	if (anchors.projectRoot && contains(anchors.projectRoot, filePath)) return "project";
	if (contains(anchors.sessionCwd, filePath)) return "project";
	return "global";
}
