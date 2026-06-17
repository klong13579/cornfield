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

export async function ensureAgentDir(agentDir: string): Promise<boolean> {
	try {
		await fs.access(agentDir);
		return false; // already exists
	} catch {
		// doesn't exist, create it
	}

	// Create all directories
	for (const dir of AGENT_SKELETON_DIRS) {
		await fs.mkdir(path.join(agentDir, dir), { recursive: true });
	}

	// Create files
	for (const file of AGENT_SKELETON_FILES) {
		const filePath = path.join(agentDir, file.relPath);
		try {
			await fs.access(filePath);
		} catch {
			await fs.writeFile(filePath, file.content, "utf-8");
		}
	}

	return true;
}

function getDefaultAgentDir(accountId: string): string {
	return path.join(os.homedir(), ".omp", "agents", accountId);
}

export function resolveAgentDir(accountId: string, explicitDir?: string): string {
	return explicitDir || getDefaultAgentDir(accountId);
}