/**
 * Skeleton template assets for agentDir.
 *
 * Each asset is statically imported via Bun's `with { type: "text" }` so the content
 * is bundled at build time — no runtime file reads, no string-literal duplication.
 *
 * Asset layout mirrors the agentDir layout per `packages/coding-agent/docs/agent-design-v1.md` §2:
 *   - 5 always-on files at root: AGENTS.md, mission.md, TOOLS.md, TODO.md, knowledge/external-workspaces.md
 *   - 1 project-level user persona: user.md (overrides / supplements the user-level ~/.omp/user.md)
 *   - runtime files: prompt-includes.json, .gitignore, .omp/config.yml, .omp/SYSTEM.md
 */
import gitignore from "./assets/.gitignore" with { type: "text" };
import ompConfig from "./assets/.omp/config.yml" with { type: "text" };
import ompSystemPrompt from "./assets/.omp/SYSTEM.md" with { type: "text" };
import agentsManifest from "./assets/AGENTS.md" with { type: "text" };
import externalWorkspaces from "./assets/knowledge/external-workspaces.md" with { type: "text" };
import mission from "./assets/mission.md" with { type: "text" };
import promptIncludes from "./assets/prompt-includes.json" with { type: "text" };
import todo from "./assets/TODO.md" with { type: "text" };
import tools from "./assets/TOOLS.md" with { type: "text" };
import user from "./assets/user.md" with { type: "text" };
import lintSkill from "./assets/.omp/skills/lint/SKILL.md" with { type: "text" };

export interface SkeletonFile {
	relPath: string;
	content: string;
}

/**
 * All content-bearing files the skeleton creates.
 * Order is preserved for deterministic output; .gitkeep stubs are generated programmatically in `ensure.ts`.
 *
 * Layout mirrors the agentDir layout per `packages/coding-agent/docs/agent-design-v1.md` §2:
 *   - 5 always-on files at root: AGENTS.md, mission.md, TOOLS.md, TODO.md, knowledge/external-workspaces.md
 *     (loaded into <context> via prompt-includes.json; see `loadProjectContextFiles`)
 *   - 1 project-level user persona: user.md
 *     (overrides / supplements the user-level ~/.omp/user.md that `loadUserProfile` injects into <user>)
 *   - runtime files: prompt-includes.json, .gitignore, .omp/config.yml, .omp/SYSTEM.md
 *
 * `user.md` is intentionally NOT listed in `prompt-includes.json` to avoid being
 * loaded twice (once into <user> by `loadUserProfile`, once into <context> by
 * context discovery). Its purpose is to provide a project-scoped override of the
 * user persona when this agentDir is the active workspace.
 */
export const SKELETON_FILES: readonly SkeletonFile[] = [
	{ relPath: "AGENTS.md", content: agentsManifest },
	{ relPath: "mission.md", content: mission },
	{ relPath: "TOOLS.md", content: tools },
	{ relPath: "TODO.md", content: todo },
	{ relPath: "user.md", content: user },
	{ relPath: "prompt-includes.json", content: promptIncludes },
	{ relPath: ".gitignore", content: gitignore },
	{ relPath: ".omp/config.yml", content: ompConfig },
	{ relPath: ".omp/SYSTEM.md", content: ompSystemPrompt },
	{ relPath: "knowledge/external-workspaces.md", content: externalWorkspaces },
	{ relPath: ".omp/skills/lint/SKILL.md", content: lintSkill },
] as const;
