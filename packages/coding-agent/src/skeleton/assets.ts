/**
 * Skeleton template assets for agentDir.
 *
 * Each asset is statically imported via Bun's `with { type: "text" }` so the content
 * is bundled at build time — no runtime file reads, no string-literal duplication.
 *
 * Asset layout mirrors the agentDir layout per `packages/agent/docs/agent-design-v1.md` §2:
 *   - 5 always-on files at root: AGENTS.md, mission.md, TOOLS.md, TODO.md, knowledge/external-workspaces.md
 *   - runtime files: prompt-includes.json, .gitignore, .omp/config.yml, .agent/SYSTEM.md
 */

import systemPrompt from "./assets/.agent/SYSTEM.md" with { type: "text" };
import gitignore from "./assets/.gitignore" with { type: "text" };
import ompConfig from "./assets/.omp/config.yml" with { type: "text" };
import agentsManifest from "./assets/AGENTS.md" with { type: "text" };
import externalWorkspaces from "./assets/knowledge/external-workspaces.md" with { type: "text" };
import mission from "./assets/mission.md" with { type: "text" };
import promptIncludes from "./assets/prompt-includes.json" with { type: "text" };
import todo from "./assets/TODO.md" with { type: "text" };
import tools from "./assets/TOOLS.md" with { type: "text" };

export interface SkeletonFile {
	relPath: string;
	content: string;
}

/**
 * All content-bearing files the skeleton creates.
 * Order is preserved for deterministic output; .gitkeep stubs are generated programmatically in `ensure.ts`.
 */
export const SKELETON_FILES: readonly SkeletonFile[] = [
	{ relPath: "AGENTS.md", content: agentsManifest },
	{ relPath: "mission.md", content: mission },
	{ relPath: "TOOLS.md", content: tools },
	{ relPath: "TODO.md", content: todo },
	{ relPath: "prompt-includes.json", content: promptIncludes },
	{ relPath: ".gitignore", content: gitignore },
	{ relPath: ".omp/config.yml", content: ompConfig },
	{ relPath: ".agent/SYSTEM.md", content: systemPrompt },
	{ relPath: "knowledge/external-workspaces.md", content: externalWorkspaces },
] as const;
