/**
 * Workspace declaration (schema v2).
 *
 * `.cornfield/workspace.json` inside an agentDir is the **source of truth** for the
 * workspace's structured metadata. `~/.cornfield/agent/registry.json` stays a thin
 * index (name → path + minimal cache) so enumeration never needs to open every
 * directory.
 *
 * Design (registry v2):
 *   - The declaration travels with the directory: `cp -r` / `git clone` an
 *     agentDir and you carry the whole workspace. All in-dir paths are
 *     relative to the agentDir root so the declaration is portable.
 *   - The registry only answers "which agents exist, where". All semantics
 *     (knowledge layers, permissions, model, scope) come from this file.
 *   - `ensureWorkspace` backfills a missing declaration with defaults so old
 *     agentDirs and gateway account dirs are upgraded with zero file moves.
 *
 * Machine metadata only — the human-facing identity files (mission.md,
 * AGENTS.md, …) stay at the agentDir root.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { isEnoent } from "@cornfield/utils";

export const WORKSPACE_DIR_NAME = ".cornfield";
export const WORKSPACE_FILE_NAME = "workspace.json";
export const WORKSPACE_SCHEMA_VERSION = 2;

/** Knowledge layer declarations (omp-flavored six-layer boundary). */
export interface WorkspaceKnowledgePaths {
	/** Identity file (human face of the agent). */
	identity?: string;
	/** Rule files consulted by the agent. */
	rules?: string[];
	/** Domain knowledge (read-only reference). */
	docsDir?: string;
	/** Per-workspace collaboration memory (writable). */
	memoryDir?: string;
	/** Memory index file (thematic index only). */
	memoryIndex?: string;
	/** Deliverables / generated output (writable, cleanable). */
	outputDir?: string;
}

export interface WorkspaceModelConfig {
	default?: string;
	thinking?: string;
}

export type WorkspacePermissionMode = "auto" | "plan" | "bypass";

export interface WorkspaceDeclaration {
	/** Schema version of this declaration. Must equal WORKSPACE_SCHEMA_VERSION. */
	schemaVersion: number;
	/** Stable id (usually the registry key). */
	id: string;
	/** Human-facing display name. */
	name: string;
	type: "agent";
	/** AgentDir root, relative to this file's directory ("."). */
	root: string;
	/** Primary project root for evolution scoping (relative, or absolute for external). */
	projectRoot: string;
	/**
	 * Agent id this workspace declares as its default (§10 rung 3 of the default-Agent
	 * chain). Absent means the workspace declares nothing — the chain falls to the
	 * user-global default and then to the process's own Agent.
	 *
	 * Never defaulted: `ensureWorkspace` does not invent one, and the reader does not
	 * normalize the value. An id that names no Agent (or a disabled one) is a broken
	 * declaration, rejected where the resolution consumes it, not repaired here.
	 */
	defaultAgentId?: string;
	/** Additional directories the agent may read/write (absolute, machine-specific). */
	attachedRoots?: string[];
	model?: WorkspaceModelConfig;
	permissions?: { mode: WorkspacePermissionMode };
	knowledge?: WorkspaceKnowledgePaths;
	skillsDir?: string;
	mcp?: string;
	sessionsDir?: string;
	/** Team membership (RBAC) — reserved for future workspace sharing. */
	members?: string[];
	createdAt?: string;
	updatedAt?: string;
}

/** Absolute path of the declaration inside an agentDir. */
export function workspaceFilePath(agentDir: string): string {
	return path.join(agentDir, WORKSPACE_DIR_NAME, WORKSPACE_FILE_NAME);
}

/**
 * What reading an agentDir's declaration found, with **three** cases kept apart.
 *
 * "No declaration" and "a declaration I cannot read" are different facts, and a caller
 * that decides something from the declaration (`declaredProjectIds`, model config,
 * knowledge paths) must not treat the second as the first: a declaration that exists but
 * cannot be interpreted may well be declaring something.
 */
export type WorkspaceDeclarationRead =
	| { state: "declared"; declaration: WorkspaceDeclaration }
	| { state: "absent" }
	| { state: "invalid"; reason: string };

/**
 * Read `agentDir/.cornfield/workspace.json` without collapsing its outcomes.
 *
 * ENOENT → `absent`. A file that is not a schema-v2 declaration (bad JSON, wrong
 * `schemaVersion`, no `id`) → `invalid` with the reason. Any other I/O error propagates:
 * "I could not look" is not an answer about the declaration's contents.
 */
export async function readWorkspaceDeclaration(agentDir: string): Promise<WorkspaceDeclarationRead> {
	let parsed: unknown;
	try {
		parsed = await Bun.file(workspaceFilePath(agentDir)).json();
	} catch (err) {
		if (isEnoent(err)) return { state: "absent" };
		if (err instanceof SyntaxError) return { state: "invalid", reason: `not valid JSON: ${err.message}` };
		throw err;
	}
	if (
		parsed &&
		typeof parsed === "object" &&
		typeof (parsed as WorkspaceDeclaration).id === "string" &&
		(parsed as WorkspaceDeclaration).schemaVersion === WORKSPACE_SCHEMA_VERSION
	) {
		return { state: "declared", declaration: parsed as WorkspaceDeclaration };
	}
	return { state: "invalid", reason: `not a schema-v${WORKSPACE_SCHEMA_VERSION} declaration` };
}

/**
 * Load the declaration from `agentDir/.cornfield/workspace.json`.
 * Returns null when missing or not a valid v2 declaration (never throws for
 * missing files — callers fall back to registry cache / defaults).
 *
 * The tolerant reading, for metadata whose absence needs no repair. Callers that make a
 * decision *from* the declaration use {@link readWorkspaceDeclaration} instead, so
 * "could not read it" stops looking like "nothing declared".
 */
export async function loadWorkspace(agentDir: string): Promise<WorkspaceDeclaration | null> {
	const read = await readWorkspaceDeclaration(agentDir);
	return read.state === "declared" ? read.declaration : null;
}

/**
 * Write the declaration if missing (additive, never overwrites an existing
 * valid declaration). Used by `omp agent init` / `register` and the gateway
 * account path so every agentDir converges on the v2 shape with zero moves.
 *
 * Defaults mirror the default skeleton layout; `projectRoot` defaults to the
 * agentDir itself, which matches the business-agent case (agentDir == project).
 */
export async function ensureWorkspace(
	agentDir: string,
	input: { name: string; id?: string },
): Promise<WorkspaceDeclaration> {
	const existing = await loadWorkspace(agentDir);
	if (existing) return existing;

	const now = new Date().toISOString();
	const declaration: WorkspaceDeclaration = {
		schemaVersion: WORKSPACE_SCHEMA_VERSION,
		id: input.id ?? input.name,
		name: input.name,
		type: "agent",
		root: ".",
		projectRoot: ".",
		knowledge: {
			identity: "mission.md",
			rules: ["AGENTS.md", "TOOLS.md", ".cornfield/SYSTEM.md"],
			docsDir: "knowledge/handbook/",
			memoryDir: "memory/",
			memoryIndex: "memory/MEMORY.md",
		},
		skillsDir: ".cornfield/skills/",
		mcp: ".mcp.json",
		sessionsDir: "sessions/",
		members: [],
		createdAt: now,
		updatedAt: now,
	};

	const dir = path.join(agentDir, WORKSPACE_DIR_NAME);
	await fs.mkdir(dir, { recursive: true });
	await Bun.write(workspaceFilePath(agentDir), `${JSON.stringify(declaration, null, 2)}\n`);
	return declaration;
}
