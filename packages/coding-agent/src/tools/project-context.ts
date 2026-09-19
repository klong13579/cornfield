import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@cornfield/agent";
import { getProjectDir } from "@cornfield/utils";
import { Type } from "@sinclair/typebox";
import { loadProjectContextFiles } from "../system-prompt";
import * as git from "../utils/git";
import type { ToolSession } from "./index";
import type { DetectedRunner } from "./recipe/runner";
import { RUNNERS } from "./recipe/runners";

const projectContextSchema = Type.Object({});

/**
 * `todo` 字段已删（2026-09-19）：这里曾把 `<projectRoot>/TODO.md` 的内容报给模型，而 TODO.md 已退出
 * Agent 的任务流程（历史留档；当前任务在那个 Agent 的任务板 `<agentDir>/.cornfield/agent-todos.json`）。
 * 继续报一份不再维护的存档，就是拿过期内容当事实——模型没有第二个信号能分辨它。
 */
type ProjectContextDetails = {
	cwd: string;
	projectRoot: string | null;
	git: { root: string | null; status: git.GitStatusSummary | null; head: string | null; error?: string };
	contextFiles: { paths: string[]; count: number; error?: string };
	recipes: { runners: Array<{ id: string; label: string; tasks: string[] }>; error?: string };
	errors: string[];
};

export class ProjectContextTool implements AgentTool<typeof projectContextSchema, ProjectContextDetails> {
	readonly name = "project_context";
	readonly label = "ProjectContext";
	readonly loadMode = "essential" as const;
	readonly summary = "Orients the agent in the current project: root, git state, project docs, and available recipes.";
	readonly description =
		"Inspect structured project context: roots, git status, context files, and available recipes.";
	readonly parameters = projectContextSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		_params: Record<string, never>,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<ProjectContextDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<ProjectContextDetails>> {
		const cwd = this.session.cwd || getProjectDir();
		const errors: string[] = [];
		const details: ProjectContextDetails = {
			cwd,
			projectRoot: null,
			git: { root: null, status: null, head: null },
			contextFiles: { paths: [], count: 0 },
			recipes: { runners: [] },
			errors,
		};

		try {
			details.projectRoot = await git.repo.root(cwd);
		} catch (error) {
			details.git.error = error instanceof Error ? error.message : String(error);
			errors.push(`git root: ${details.git.error}`);
		}
		details.git.root = details.projectRoot;
		try {
			details.git.status = await git.status.summary(cwd);
		} catch (error) {
			details.git.error = error instanceof Error ? error.message : String(error);
			errors.push(`git status: ${details.git.error}`);
		}
		try {
			details.git.head = await git.head.resolve(cwd).then(head => head?.commit ?? null);
		} catch (error) {
			details.git.error = error instanceof Error ? error.message : String(error);
			errors.push(`git head: ${details.git.error}`);
		}

		try {
			const files = this.session.contextFiles ?? (await loadProjectContextFiles({ cwd }));
			details.contextFiles.paths = files.map(file => file.path);
			details.contextFiles.count = files.length;
		} catch (error) {
			details.contextFiles.error = error instanceof Error ? error.message : String(error);
			errors.push(`context files: ${details.contextFiles.error}`);
		}

		try {
			const detected = (await Promise.all(RUNNERS.map(runner => runner.detect(cwd)))).filter(
				(runner): runner is DetectedRunner => runner !== null && runner.tasks.length > 0,
			);
			details.recipes.runners = detected.map(runner => ({
				id: runner.id,
				label: runner.label,
				tasks: runner.tasks.map(task => task.name),
			}));
		} catch (error) {
			details.recipes.error = error instanceof Error ? error.message : String(error);
			errors.push(`recipes: ${details.recipes.error}`);
		}

		return {
			content: [{ type: "text", text: JSON.stringify(details) }],
			details,
		};
	}
}

export type { ProjectContextDetails };
export { projectContextSchema };
