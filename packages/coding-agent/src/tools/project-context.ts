import * as path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@cornfield/agent";
import { getProjectDir } from "@cornfield/utils";
import { Type } from "@sinclair/typebox";
import { loadProjectContextFiles } from "../system-prompt";
import * as git from "../utils/git";
import type { ToolSession } from "./index";
import { RUNNERS } from "./recipe/runners";
import type { DetectedRunner } from "./recipe/runner";

const projectContextSchema = Type.Object({});

type ProjectContextDetails = {
  cwd: string;
  projectRoot: string | null;
  git: { root: string | null; status: git.GitStatusSummary | null; head: string | null; error?: string };
  contextFiles: { paths: string[]; count: number; error?: string };
  todo: { exists: boolean; path: string | null; summary: string | null; error?: string };
  recipes: { runners: Array<{ id: string; label: string; tasks: string[] }>; error?: string };
  errors: string[];
};

const TODO_MAX_LINES = 12;

export class ProjectContextTool implements AgentTool<typeof projectContextSchema, ProjectContextDetails> {
  readonly name = "project_context";
  readonly label = "ProjectContext";
  readonly description = "Inspect structured project context: roots, git status, context files, TODO, and available recipes.";
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
      todo: { exists: false, path: null, summary: null },
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

    const todoPath = path.join(details.projectRoot ?? cwd, "TODO.md");
    try {
      const content = await Bun.file(todoPath).text();
      details.todo.exists = true;
      details.todo.path = todoPath;
      const lines = content.split("\n").slice(0, TODO_MAX_LINES);
      details.todo.summary = lines.join("\n").trim() || null;
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        // TODO.md is optional; absence is a normal result.
      } else {
        details.todo.error = error instanceof Error ? error.message : String(error);
        errors.push(`TODO: ${details.todo.error}`);
      }
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
