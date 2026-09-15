/**
 * Agent directory — the WP1 `AgentRecord` read model projected from the existing
 * registry + workspace declaration.
 *
 * `./types` defines `AgentRecord` as "the read-model projection of the registry entry
 * plus the agentDir declaration — it is not a second profile format". This module is
 * that projection, and it is the only source of candidates for `./default-agent`.
 *
 * What it reads (never writes):
 *   - `~/.cornfield/agent/registry.json` via `../skeleton/registry` (thin name → path index),
 *   - `<agentDir>/.cornfield/workspace.json` via `../skeleton/workspace` (schema v2).
 *
 * Two fields have no authority yet, so they are derived from what exists:
 *   - `enabled` — the registry has no enable/disable flag. An entry whose agentDir is
 *     gone is not usable, which is how `findStaleEntries()` already reads it.
 *   - `projectIds` — declared bindings come from the declaration's `projectRoot` when
 *     that root is a declared Project (WP1: an absent list means *unconstrained*).
 * WP2 (Agent Profile Registry) owns the real profile fields; when it lands, this
 * projection must read them instead of deriving them.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { resolveEquivalentPath } from "@cornfield/utils";
import { listRegistered } from "../skeleton/registry";
import { loadWorkspace, type WorkspaceDeclaration } from "../skeleton/workspace";
import type { AgentCandidateFacts } from "./default-agent";
import { loadProjects, matchProjectByRoot } from "./project-store";
import type { AgentId, AgentRecord, ProjectRecord } from "./types";

export interface AgentDirectoryEntry {
	agent: AgentRecord;
	/** Parsed `<agentDir>/.cornfield/workspace.json`, when the agentDir declares one. */
	declaration?: WorkspaceDeclaration;
}

/**
 * Every registered Agent as a WP1 read model.
 *
 * Nothing is probed for model/permission availability here: those verdicts belong to
 * the registry / config layer, and the resolver reports them as `"unknown"` rather
 * than assuming they hold.
 */
export async function loadAgentDirectory(): Promise<AgentDirectoryEntry[]> {
	const registered = await listRegistered();
	const projects = await loadProjects();
	const entries: AgentDirectoryEntry[] = [];

	for (const { name, entry } of registered) {
		// Keep the registry's own path (normalized, not symlink-resolved): `AgentRecord.agentDir`
		// is what the user registered. Symlinks are resolved only where paths are *compared*,
		// in `findAgentRecordByDir`.
		const agentDir = path.resolve(entry.path);
		const declaration = (await loadWorkspace(agentDir)) ?? undefined;
		const record: AgentRecord = {
			agentId: name,
			agentDir,
			displayName: declaration?.name ?? entry.displayName ?? name,
			enabled: await directoryExists(agentDir),
		};
		const projectIds = declaredProjectIds(agentDir, declaration, projects);
		if (projectIds) record.projectIds = projectIds;
		entries.push({ agent: record, declaration });
	}
	return entries;
}

/** Candidate facts for the resolver, with capability verdicts left `"unknown"`. */
export function toCandidates(entries: readonly AgentDirectoryEntry[]): AgentCandidateFacts[] {
	return entries.map(({ agent }) => ({ agent, modelAvailable: "unknown", permissionAvailable: "unknown" }));
}

/** Exact agentId lookup. */
export function findAgentRecord(
	entries: readonly AgentDirectoryEntry[],
	agentId: AgentId,
): AgentDirectoryEntry | undefined {
	return entries.find(entry => entry.agent.agentId === agentId);
}

/**
 * Lookup by agentDir — the compatibility path for callers that only know the directory
 * (the CLI process's config dir, `account.agentDir`, a gateway account). Compared with
 * `resolveEquivalentPath` so symlinked paths still match.
 */
export function findAgentRecordByDir(
	entries: readonly AgentDirectoryEntry[],
	agentDir: string,
): AgentDirectoryEntry | undefined {
	const wanted = resolveEquivalentPath(agentDir);
	return entries.find(entry => resolveEquivalentPath(entry.agent.agentDir) === wanted);
}

function declaredProjectIds(
	agentDir: string,
	declaration: WorkspaceDeclaration | undefined,
	projects: readonly ProjectRecord[],
): string[] | undefined {
	const projectRoot = declaration?.projectRoot;
	if (!projectRoot) return undefined;
	const absoluteRoot = path.isAbsolute(projectRoot) ? projectRoot : path.resolve(agentDir, projectRoot);
	const project = matchProjectByRoot(projects, absoluteRoot);
	return project ? [project.projectId] : undefined;
}

async function directoryExists(dir: string): Promise<boolean> {
	try {
		return (await fs.stat(dir)).isDirectory();
	} catch {
		return false;
	}
}
