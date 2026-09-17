/**
 * Project store — the client-level authority for `ProjectRecord` (WP4).
 *
 * WP1's authority table (`./types` `DOMAIN_AUTHORITY.project`) recorded Project as
 * having no store yet: "today a Project is only implicit in a session's cwd / git
 * toplevel", pending WP4. This is that store.
 *
 * Design:
 *   - Client-scope, next to the Agent registry: `~/.cornfield/agent/projects.json`.
 *     A Project is a boundary shared by several Agents, so it cannot live inside one
 *     Agent's agentDir.
 *   - The file stores WP1 `ProjectRecord`s verbatim — it is a store of the read model,
 *     not a second shape. `projectId` is the key; `root` is the absolute project root
 *     and may be declared by at most one Project.
 *   - `defaultAgentId` is the only resolution input that lives here (§10 rung 2).
 *
 * Failure policy: a store that cannot be read is a hard error, never "no Projects".
 * Degrading to an empty store would silently demote the resolution to a less specific
 * declaration and start a session as a different Agent than the Project intends.
 * Callers that want to tolerate a missing file get an empty store for ENOENT only.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { getConfigDirName, isEnoent, resolveEquivalentPath } from "@cornfield/utils";
import { pickDeepestRootIndex } from "@cornfield/wire";
import type { ProjectId, ProjectRecord } from "./types";

export const PROJECT_STORE_VERSION = 1;
export const PROJECTS_FILE_NAME = "projects.json";

export interface ProjectStoreFile {
	version: number;
	projects: Record<ProjectId, ProjectRecord>;
}

/** Resolved at call time so tests can change HOME between calls (see `../skeleton/registry`). */
function homeDir(): string {
	return process.env.HOME ?? os.homedir();
}

/** Path of the Project store. Lazy so `CORNFIELD_CONFIG_DIR` and HOME stay overridable. */
export function projectsFilePath(): string {
	return path.join(homeDir(), getConfigDirName(), "agent", PROJECTS_FILE_NAME);
}

/** Read every declared Project. Throws when the store exists but cannot be trusted. */
export async function loadProjects(): Promise<ProjectRecord[]> {
	const file = projectsFilePath();
	let parsed: unknown;
	try {
		parsed = await Bun.file(file).json();
	} catch (err) {
		if (isEnoent(err)) return [];
		if (err instanceof SyntaxError) {
			throw new Error(`Project store at "${file}" is not valid JSON: ${err.message}`);
		}
		throw err;
	}

	const store = parsed as Partial<ProjectStoreFile> | null;
	if (!store || typeof store !== "object" || typeof store.projects !== "object" || store.projects === null) {
		throw new Error(`Project store at "${file}" is malformed: expected { version, projects }.`);
	}
	if (store.version !== PROJECT_STORE_VERSION) {
		throw new Error(
			`Project store at "${file}" has version ${String(store.version)}; this build reads version ${PROJECT_STORE_VERSION}.`,
		);
	}

	return Object.entries(store.projects).map(([projectId, record]) => {
		const candidate = record as Partial<ProjectRecord> | null;
		if (!candidate || typeof candidate !== "object" || typeof candidate.root !== "string") {
			throw new Error(
				`Project store at "${file}" has a malformed entry for "${projectId}" (root must be a string).`,
			);
		}
		const normalized: ProjectRecord = { projectId, root: candidate.root, name: candidate.name ?? projectId };
		if (candidate.defaultAgentId !== undefined) normalized.defaultAgentId = candidate.defaultAgentId;
		return normalized;
	});
}

/**
 * Find the Project that owns `root` in an already-loaded list. Roots are compared with
 * `resolveEquivalentPath` so a symlinked checkout (`/tmp` → `/private/tmp` on darwin)
 * still matches. Pure: lets a caller with several lookups load the store once.
 */
export function matchProjectByRoot(projects: readonly ProjectRecord[], root: string): ProjectRecord | undefined {
	const wanted = resolveEquivalentPath(root);
	return projects.find(project => resolveEquivalentPath(project.root) === wanted);
}

/** Find the Project that owns `root`. */
export async function findProjectByRoot(root: string): Promise<ProjectRecord | undefined> {
	return matchProjectByRoot(await loadProjects(), root);
}

/**
 * Find the Project a path belongs to: the declared root itself, or the nearest declared
 * ancestor for a path inside it (deepest root wins, so a nested project declaration
 * shadows its parent). Pure, so a caller resolving several paths loads the store once.
 *
 * The rule itself is `pickDeepestRootIndex` in pi-wire — the web client asks the same question
 * about its stats folders and both sides must answer it the same way. What stays on this side
 * is the normalization: `resolveEquivalentPath` (realpath) is a serve-only runtime fact, so the
 * roots handed to the rule are already resolved (a symlinked checkout matches its target).
 */
export function matchProjectForPath(projects: readonly ProjectRecord[], targetPath: string): ProjectRecord | undefined {
	const roots = projects.map(project => resolveEquivalentPath(project.root));
	const index = pickDeepestRootIndex(roots, resolveEquivalentPath(targetPath));
	return index === -1 ? undefined : projects[index];
}

/**
 * Insert or replace a Project. Rejects a second Project claiming a root that another
 * Project already owns — one root maps to one business context, so `defaultAgentId`
 * can only mean one thing.
 */
export async function upsertProject(record: ProjectRecord): Promise<void> {
	const projects = await loadProjects();
	const root = resolveEquivalentPath(record.root);
	for (const existing of projects) {
		if (existing.projectId !== record.projectId && resolveEquivalentPath(existing.root) === root) {
			throw new Error(
				`Project root "${record.root}" is already declared by project "${existing.projectId}"; ` +
					`two Projects cannot share a root.`,
			);
		}
	}
	const next = new Map(projects.map(project => [project.projectId, project]));
	// Store the declaration as given (normalized, not symlink-resolved): the store keeps
	// the path the user declared, while matching resolves symlinks on both sides.
	next.set(record.projectId, { ...record, root: path.resolve(record.root) });
	await writeProjects([...next.values()]);
}

/** Remove a Project. Returns true when it existed. */
export async function removeProject(projectId: ProjectId): Promise<boolean> {
	const projects = await loadProjects();
	const next = projects.filter(project => project.projectId !== projectId);
	if (next.length === projects.length) return false;
	await writeProjects(next);
	return true;
}

async function writeProjects(projects: readonly ProjectRecord[]): Promise<void> {
	const file: ProjectStoreFile = {
		version: PROJECT_STORE_VERSION,
		projects: Object.fromEntries(projects.map(project => [project.projectId, project])),
	};
	const target = projectsFilePath();
	await fs.mkdir(path.dirname(target), { recursive: true });
	await Bun.write(target, `${JSON.stringify(file, null, 2)}\n`);
}
