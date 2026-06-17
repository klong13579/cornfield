/**
 * Ensure agentDir exists with complete skeleton structure.
 * Creates the directory tree if missing, including a default mission.md.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

const AGENT_SKELETON_FILES: Array<{ relPath: string; content: string }> = [
	{
		relPath: "mission.md",
		content: `# 助手

## 身份
你是一个企业内部助手，名为 **<机器人名>**，为员工提供信息查询、文档辅助、任务跟进等服务。

## 能力
- 解答员工日常问题（流程、制度、联系方式等）
- 协助编写、修改、审查代码
- 查询、总结企业内部知识库内容
- 运行定时任务（日报、周报、提醒等）

## 行为准则
- 始终使用 **中文** 回复
- 友好、专业、简洁
- 不清楚的事情主动询问，不猜测
- 遇到敏感信息（密码、密钥、个人隐私）不记录、不转发
- 遇到不确定的操作（删除、推送、部署）先确认再执行

## 工具
- 使用 read 读取本地文件
- 使用 grep 搜索代码
- 使用 bash 运行命令
- 使用 write/edit 修改文件

⚠️ **请编辑本文件定义本机器人的具体角色与能力。**
`,
	},
	{
		relPath: "profile.yaml",
		content: `# 领域画像
# 定义机器人的知识领域、专业特长、默认语言风格

domain:
  primary: general
  tags: []

language:
  default: zh-CN
  fallback: en-US

style:
  tone: professional
  length: concise
  format: markdown
`,
	},
	{
		relPath: ".gitignore",
		content: `# omp agent directory - 运行时数据
sessions/
cron/logs/
knowledge/
.DS_Store
`,
	},
	{
		relPath: ".agent/SYSTEM.md",
		content: `# 自定义系统提示词（可选）

**重要：** 在 omp 启动时，**本文件内容会覆盖 omp 内置的 system prompt 模板**。
留空（仅保留本注释）或删除本文件表示使用 omp 内置模板。

## 何时覆盖
- 机器人需要不同的语言风格
- 机器人有特殊的安全要求
- 机器人需要不同的输出格式

## 示例
\`\`\`markdown
你是一个仅限中文的企业助手。
你不应读取会话外的文件。
你不应执行 bash 命令。
\`\`\`
`,
	},
	{
		relPath: ".agent/AGENTS.md",
		content: `# 上下文指令

本文件被注入到 system prompt 之后，用于引导 agent 行为。

## 工具使用指引
- 读取文件：使用 \`read\`
- 搜索代码：使用 \`grep\`
- 运行命令：使用 \`bash\`（需要明确）
- 修改文件：使用 \`write\` / \`edit\`

## 回复风格
- 简洁、准确、有依据
- 不确定时主动询问
- 避免重复发送“让我查一下”
`,
	},
	{
		relPath: ".omp/config.yml",
		content: `# omp 配置
# omp --mode rpc 启动时读取本文件 (在 agentDir 下运行)
# 允许为该 agent 覆盖全局配置：模型、主题、工具等

modelRoles:
  default: narwal-plan/minimax-m3   # 该 agent 使用的默认模型
  smol: narwal-plan/minimax-m3       # 轻量任务（文本处理、简单问题）
  slow: narwal-plan/glm-5.2          # 复杂任务（代码生成、深入分析）

theme: dark
`,
	},
	{
		relPath: ".omp/prompt-includes.json",
		content: `{
  "files": []
}
`,
	},
];

const AGENT_SKELETON_DIRS = [
	".agent/skills",
	".agent/prompts",
	".agent/rules",
	".omp",
	"sessions",
	"cron/tasks",
	"cron/logs",
	"scripts",
	"external",
	"knowledge",
];

// Starter files inside otherwise empty directories (design §6.1)
const AGENT_SKELETON_DIR_KEEPERS: Array<{ relPath: string; content: string }> = [
	{
		relPath: ".agent/rules/security.md",
		content: `# 安全规则（示例）

## 禁止操作
- 删除、修改生产数据库
- 发送未经审核的对外通知
- 运行未经审核的脚本

## 需要确认
- 任何 git push 到 main/master
- 任何文件删除操作
`,
	},
	{
		relPath: ".agent/skills/.gitkeep",
		content: "",
	},
	{
		relPath: ".agent/prompts/.gitkeep",
		content: "",
	},
	{
		relPath: "external/.gitkeep",
		content: "",
	},
	{
		relPath: "knowledge/.gitkeep",
		content: "",
	},
	{
		relPath: "scripts/.gitkeep",
		content: "",
	},
	{
		relPath: "sessions/.gitkeep",
		content: "",
	},
	{
		relPath: "cron/tasks/.gitkeep",
		content: "",
	},
	{
		relPath: "cron/logs/.gitkeep",
		content: "",
	},
];

export async function ensureAgentDir(agentDir: string): Promise<boolean> {
	// Check if mission.md exists (the core file determines if initialized)
	const missionPath = path.join(agentDir, "mission.md");
	let missionExists = false;
	try {
		await fs.access(missionPath);
		missionExists = true;
	} catch {
		missionExists = false;
	}
	if (missionExists) {
		// Already initialized — additive update for missing files
		await ensureSkeletonFiles(agentDir);
		return false;
	}

	// Create all directories (idempotent if they exist)
	for (const dir of AGENT_SKELETON_DIRS) {
		await fs.mkdir(path.join(agentDir, dir), { recursive: true });
	}

	// Create all skeleton files
	await ensureSkeletonFiles(agentDir);

	return true;
}

async function ensureSkeletonFiles(agentDir: string): Promise<void> {
	for (const file of [...AGENT_SKELETON_FILES, ...AGENT_SKELETON_DIR_KEEPERS]) {
		const filePath = path.join(agentDir, file.relPath);
		try {
			await fs.access(filePath);
		} catch {
			// Ensure parent directory exists
			await fs.mkdir(path.dirname(filePath), { recursive: true });
			await fs.writeFile(filePath, file.content, "utf-8");
		}
	}
}

function getDefaultAgentDir(accountId: string): string {
	return path.join(os.homedir(), ".omp", "agents", accountId);
}

export function resolveAgentDir(accountId: string, explicitDir?: string): string {
	return explicitDir || getDefaultAgentDir(accountId);
}