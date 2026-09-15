/**
 * `get_skills` / `set_skill_enabled` 结果形状（W3 D5 + B3；T10B 补 scope 五事实）。
 *
 * 一个概念一种表示：serve 端 `server/skill-scope.ts` 的投影**就是**这些类型（它从本文件
 * 引入，不再自建一份同形接口），web-app 也从 `@cornfield/wire` 引入，两端不再各写一遍。
 *
 * 五个事实各自的来源（都是 serve 侧既有事实源，客户端不自己判）：
 *   scope         SKILL.md 路径相对 agentDir / 会话 Project root 的位置
 *   source        discovery 的 `provider:level`（`source` 字段）+ `path`
 *   version       frontmatter 声明（可能没有）+ 内容指纹 + mtime —— 见下方字段说明
 *   activation    本次会话加载了 / 磁盘上有但没进会话 / 被挡住
 *   errors        blocked（具体技能被挡）+ errors（扫描级失败）
 */

/** 技能范围：Agent 自己的家 / 会话所在的 Project / 两者之外（全局用户库等发现源）。 */
export type SkillScope = "agent" | "project" | "global";

/** 激活态：进没进这次会话。 */
export type SkillActivation = "loaded" | "discoverable" | "blocked";

/** 状态：可用 / 被 settings 停用 / 已标记废弃 / 文件读不到。 */
export type SkillStatus = "enabled" | "disabled" | "deprecated" | "unavailable";

/**
 * 一行技能（已加载与已停用同形）。
 *
 * 版本为什么不是一个字段：大量 skill 的 frontmatter **没有** version 且写法不统一
 * （`docs/skills/telemetry.md` §4.1 已验证），所以版本拆成三个独立事实，不把指纹冒充成版本号：
 * `version`（声明，可能没有）、`fingerprint`（内容 sha256 前 8 位）、`updatedAt`（mtime 毫秒）。
 */
export interface SkillScopeRowDto {
	name: string;
	description: string;
	/** discovery 来源标识 `provider:level`（如 `native:project`）。 */
	source: string;
	level: "user" | "project" | "native";
	/** provider id（如 `native` / `claude`）；显示名见 `providerName`。 */
	provider: string;
	/** provider 的显示名（如 `OMP`）；发现器没给就缺省。 */
	providerName?: string;
	/** SKILL.md 绝对路径（来源）；名单里只剩名字、磁盘上找不到时为空串。 */
	path: string;
	scope: SkillScope;
	activation: SkillActivation;
	status: SkillStatus;
	/** frontmatter 声明的版本（缺省 = 没声明，不是空字符串）。 */
	version?: string;
	/** 内容 sha256 前 8 位（文件系统真相，与版本声明无关）。 */
	fingerprint?: string;
	/** mtime（毫秒，整数）。 */
	updatedAt?: number;
	/** 为什么是当前 activation/status（停用来源 / 冲突原因 / 读取失败原因）。 */
	reason?: string;
}

/** 被挡住、进不了会话的技能（同名冲突的落选者等），来源是 discovery 警告。 */
export interface SkillBlockedDto {
	/** 从 SKILL.md 路径推出的技能名。 */
	name: string;
	path: string;
	reason: string;
}

/** 不带技能路径的发现失败（扫描失败等）—— 没有行可挂，只能进错误清单。 */
export interface SkillLoadErrorDto {
	/** 空串 = 没有具体路径（扫描级失败）。 */
	path: string;
	message: string;
}

/** 这份技能列表锚在谁身上 —— 同屏多个 Agent 时，没有它就无法判断看的是谁的技能。 */
export interface SkillScopeFactsDto {
	agentId: string;
	agentDir: string;
	/** 会话根（范围判定用）。 */
	sessionCwd: string;
	/** 会话所属 Project 的 root（未归属 = null）。 */
	projectRoot: string | null;
	/** Project registry 读不出来的原因（有值 = 归属未知，不是未归属）。 */
	projectError: string | null;
}

/** `get_skills` 响应。 */
export interface SkillsResultDto {
	/** 本次会话加载的技能（`session.skills` 同源）。 */
	skills: SkillScopeRowDto[];
	/** 被 settings 停用的技能（两个 settings 键合并，各自带 reason）。 */
	disabled: SkillScopeRowDto[];
	/** 被挡住的技能（发现警告里带路径的那些）。 */
	blocked: SkillBlockedDto[];
	/** 发现阶段错误（警告里不带路径的那些 + 已加载但读不到的文件）。 */
	errors: SkillLoadErrorDto[];
	/** 锚点（agentId / agentDir / 会话根 / Project root）。 */
	scope: SkillScopeFactsDto;
}
