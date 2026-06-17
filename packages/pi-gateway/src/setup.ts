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
		content: `# ${path.basename(process.cwd())} 助手

## 身份
你是一个通用助手，尚未定义具体角色。

## 行为准则
- 友好、专业、简洁
- 不清楚的事情主动询问，不猜测

⚠️ 请编辑此文件定义机器人的角色、能力、行为准则。`,
	},
	{
		relPath: "profile.yaml",
		content: `# 领域画像（可选）
# 定义机器人的知识领域、专业特长
`,
	},
	{
		relPath: ".gitignore",
		content: `# omp agent directory
sessions/
cron/logs/
knowledge/
.DS_Store
`,
	},
	{
		relPath: ".agent/SYSTEM.md",
		content: `# 自定义系统提示词（可选）

在 omp 启动时，本文件内容会 **覆盖** omp 内置的 system prompt 模板。
留空表示使用 omp 内置模板。

## 示例
\`\`\`markdown
你是一个企业内部助手。
只使用中文回复。
\`\`\`
`,
	},
	{
		relPath: ".agent/AGENTS.md",
		content: `# 上下文指令（可选）

本文件被注入到 system prompt 的 *之后*，用于引导 agent 行为。
例如：

## 工具使用
- 使用 read 读取本地文件
- 使用 grep 搜索代码
- 使用 bash 运行命令

## 回复风格
- 简洁、准确
- 不确定时主动询问
`,
	},
	{
		relPath: ".omp/config.yml",
		content: `# omp 配置
# omp --mode rpc 启动时读取本文件
# 允许为该 agent 覆盖全局配置：模型、工具、主题等

# model: narwal-plan/minimax-m3
# tools: []
# theme: dark
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