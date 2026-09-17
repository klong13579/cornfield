/**
 * agentDir 里有哪些文件、每一个是干什么的 —— 单一真相。
 *
 * 这份清单曾经散在三处，各自漂移：
 *   - `cli/agent-cli.ts` 的 `ALWAYS_ON` / `RUNTIME_HARD_DEPS` / `RUNTIME_RECOMMENDED`（validate 用）；
 *   - web-app Prompts tab 自己硬编码的一份 7 项清单（已漂移成 `.omp/SYSTEM.md` 这种旧路径，
 *     还挂着两个全仓库只有它提过的文件）；
 *   - `./assets.ts` 的布局注释（骨架真正写出哪些文件）。
 *
 * 所以这里按骨架**实际写出的文件**逐条登记（顺序即 `SKELETON_FILES` 的写出顺序，
 * 见 `./assets.ts`），其余三方都从它推导。
 *
 * 两个正交的维度，别混：
 *   - `requirement`：`cornfield agent validate` 该按什么级别要求它（见 `cli/agent-cli.ts`）。
 *   - `surface`：它的内容是不是 prompt 面（会不会被读进模型上下文）—— 决定「Prompt 源」
 *     这类视图是否列出它。配置面（config.yml）、技能面（SKILL.md）、忽略规则（.gitignore）
 *     都不是 prompt 面，即使它们就在 agentDir 里。
 */

/** 一个 agentDir 文件的必需程度（`cornfield agent validate` 的检查分级）。 */
export type AgentDirFileRequirement =
	/** 缺失即 error：内容文件，always-on 注入模型上下文。 */
	| "always-on"
	/** 缺失即 error：运行时读的硬依赖（缺了起不来 / 行为不对）。 */
	| "hard-dep"
	/** 缺失只是 warning：有默认行为可回落。 */
	| "recommended"
	/** 骨架会写出来，但缺失不算问题（历史 validate 也不检查）。 */
	| "optional";

/** 文件属于 prompt 面（读进模型上下文）还是其它面（配置 / 技能 / 忽略规则）。 */
export type AgentDirFileSurface = "prompt" | "other";

export interface AgentDirFile {
	/** agentDir 内相对路径。 */
	relPath: string;
	/** 展示名（列表行标题）。 */
	title: string;
	/** 它在运行时真实起什么作用。 */
	description: string;
	requirement: AgentDirFileRequirement;
	surface: AgentDirFileSurface;
}

/**
 * 骨架写出的每个文件的元数据（与 `SKELETON_FILES` 一一对应）。
 *
 * 关于 `user.md` 为什么是 prompt 面却不进 `prompt-includes.json`：见 `./assets.ts` 的注释
 * ——`loadUserProfile` 已把它注入 `<user>`，列进 includes 会被当 `<context>` 再加载一遍。
 */
export const AGENT_DIR_FILES: readonly AgentDirFile[] = [
	{
		relPath: "AGENTS.md",
		title: "硬约束与文件地图",
		description:
			"全局硬约束清单与文件地图。启动时无条件读取：带 MUST NOT / NEVER 的行抽进 <hard-constraints>，其余内容注入 <context>。",
		requirement: "always-on",
		surface: "prompt",
	},
	{
		relPath: "mission.md",
		title: "身份与职责",
		description: "本 agent 的身份、职责与能力边界（人设的来源）。经 prompt-includes.json 注入 <context>。",
		requirement: "always-on",
		surface: "prompt",
	},
	{
		relPath: "TOOLS.md",
		title: "工具级规则",
		description:
			"各工具的 MUST / MUST NOT 规则，与工具说明同处一地。always-on 注入 <context>，其中 MUST/NOT 级别行抽进 <hard-constraints>。",
		requirement: "always-on",
		surface: "prompt",
	},
	{
		relPath: "TODO.md",
		title: "当前任务看板",
		description: "当前任务状态，由 agent 随进展更新；always-on 注入 <context>，TUI 欢迎页也读它。",
		requirement: "always-on",
		surface: "prompt",
	},
	{
		relPath: "user.md",
		title: "项目级人设",
		description:
			"agentDir 级的用户画像，作为用户级 ~/.cornfield/user.md 在本项目的覆盖层（两者都在时 agentDir 级优先）。刻意不列进 prompt-includes.json：loadUserProfile 已把它注入 <user>，列进去会被当 <context> 再加载一遍。",
		requirement: "optional",
		surface: "prompt",
	},
	{
		relPath: "prompt-includes.json",
		title: "always-on 注入清单",
		description: "声明哪些文件被当作 always-on 注入 <context>（顶层 files 数组），启动时读取。",
		requirement: "recommended",
		surface: "prompt",
	},
	{
		relPath: ".gitignore",
		title: "忽略规则",
		description:
			"忽略运行时产物：sessions/、cron/logs/、.cornfield/evolution/、.cornfield/*（负向规则保留 config.yml、SYSTEM.md、skills/）、*.log、*.bak。",
		requirement: "recommended",
		surface: "other",
	},
	{
		relPath: ".cornfield/config.yml",
		title: "运行配置",
		description: "模型路由 / 角色绑定 / 工具开关 / 主题等运行配置；启动时读取，缺失即硬依赖缺失。",
		requirement: "hard-dep",
		surface: "other",
	},
	{
		relPath: ".cornfield/SYSTEM.md",
		title: "系统提示词基线",
		description:
			"自定义系统提示词模板：非空时替换 CornField 内置提示词（gateway agent 的基线行为）。留空则回落内置提示词。",
		requirement: "recommended",
		surface: "prompt",
	},
	{
		relPath: "knowledge/external-workspaces.md",
		title: "外部数据源登记",
		description: "外部工作区与数据源的登记表（参考文档，本身不触发同步）。经 prompt-includes.json 注入 <context>。",
		requirement: "always-on",
		surface: "prompt",
	},
	{
		relPath: ".cornfield/skills/lint/SKILL.md",
		title: "lint 技能",
		description:
			"骨架自带的 lint 技能定义（name/description 在 frontmatter），按需经 skill:// 读取，不常驻上下文。模板内容需按业务改写。",
		requirement: "optional",
		surface: "other",
	},
];

/**
 * 按必需程度取相对路径，保持 `AGENT_DIR_FILES` 的声明顺序（= 骨架写出顺序）。
 * `cli/agent-cli.ts` 的三个校验集就是从这里推导的。
 */
export function agentDirFilesWithRequirement(requirement: AgentDirFileRequirement): string[] {
	return AGENT_DIR_FILES.filter(file => file.requirement === requirement).map(file => file.relPath);
}

/** prompt 面文件（`surface: "prompt"`），声明顺序同上。 */
export const AGENT_DIR_PROMPT_FILES: readonly AgentDirFile[] = AGENT_DIR_FILES.filter(
	file => file.surface === "prompt",
);
