/**
 * Session workspace resolution — the one place that answers "which Project does this session
 * belong to, and which roots may it work in".
 *
 * Four words the domain keeps apart (§1; `../agent-domain/types`):
 *
 *   - **AgentDir** — an Agent's physical home. Identity. Nothing here moves it.
 *   - **Project** — the business/code/file boundary. Its registry (`../agent-domain/project-store`)
 *     is the authority; a Project is *not* a directory, its `root` is where it happens to live.
 *   - **WorkspaceContext** — the derived (Agent, Project) context (§1). `deriveWorkspaceContext`
 *     in `../agent-domain/default-agent` owns that derivation; this module does not repeat it.
 *   - **Session** — one unit of work. It *records* its Project (`SessionHeader.projectId` /
 *     `projectSource`); the roots in force are derived from that record plus the agentDir's own
 *     declaration.
 *
 * The rungs, in order, deciding `projectId` and `projectSource`:
 *
 *   1. `header.projectId` — authoritative. A caller resolved it while assembling the session
 *      (`NewSessionOptions.project`, `SessionManager.setResolvedProject`), or the header simply
 *      records it from an earlier run. It survives a cwd that stops matching: the record is the
 *      assertion, the cwd is not.
 *   2. the Project registry matched against the session's cwd (`matchProjectForPath`, deepest
 *      declared root wins) — the *legacy* rung, for sessions that recorded nothing.
 *   3. nothing. `projectId` stays `undefined` and `projectSource` is `"none"`. Nothing here invents
 *      an id, and an empty string never stands in for "no binding".
 *
 * Failure model — a read that fails is not a declaration that says nothing:
 *
 *   - The Project store throws (`loadProjects` owns that message, including the file it failed on)
 *     and is never degraded to an empty registry: an empty store resolves every session to
 *     unbound, which is a different session than the one the user has.
 *   - A recorded (or caller-named) `projectId` the registry does not declare fails loudly instead
 *     of falling through to the cwd rung. A session bound to a Project that no longer exists has no
 *     root to work in; answering "unbound" would hand it the agentDir and let it run somewhere
 *     nobody declared.
 *   - An `agentDir/.cornfield/workspace.json` that exists but cannot be interpreted fails instead of
 *     silently dropping the roots it declares — the same rule `../server/agent-todos-wire` applies
 *     to the same file, for the same reason: a declaration that cannot be read may well be declaring
 *     something, and reading it as "nothing" widens what the session may touch.
 *
 * What this module is **not**: it does not write. Recording a resolved binding into the header is
 * the caller's decision (`SessionManager.setResolvedProject`), so a read-only consumer — the session
 * index, the ownership projection, the file/tool boundary — can ask the same question without
 * mutating anything.
 */

import * as path from "node:path";

import { resolveEquivalentPath, toError } from "@cornfield/utils";
import { loadProjects, matchProjectForPath } from "../agent-domain/project-store";
import type {
	AgentId,
	ProjectBindingSource,
	ProjectId,
	ProjectRecord,
	ProjectSource,
	ResolvedProjectRef,
} from "../agent-domain/types";
import { readWorkspaceDeclaration, type WorkspaceDeclarationRead, workspaceFilePath } from "../skeleton/workspace";
import type { SessionHeader } from "./session-manager";

/**
 * The facts a live session contributes, and nothing else. `SessionManager` satisfies it
 * structurally (`getHeader` / `getCwd`), so a caller can hand the resolver the session it already
 * has instead of dismantling it into fields.
 */
export interface SessionWorkspaceSource {
	/** The session's persisted header, when it has one. */
	getHeader(): SessionHeader | null;
	/** The session's current working directory. */
	getCwd(): string;
}

/**
 * Either a live session — which carries the header *and* the current cwd — or a bare persisted
 * header, for a session only read from disk. Passing both is a type error, not a silent
 * precedence: two sources for one fact is the ambiguity this module exists to remove.
 */
export type ResolveSessionWorkspaceInput = {
	/**
	 * The Agent's home — the identity root, and the last root in `roots`. Given by the caller,
	 * never derived from the cwd (that would be the Agent/Project confusion §1 warns about).
	 */
	agentDir: string;
	/**
	 * A Project the caller resolved for this session: a session being assembled (which has no
	 * header yet), or an explicit rebind. Treated exactly as a recorded `header.projectId`; a
	 * *different* value in the header is a conflict, not a precedence puzzle.
	 */
	projectId?: ProjectId;
} & (
	| { /** A live session: its header and its current working directory. */ session: SessionWorkspaceSource }
	| { /** A persisted header, when no live session is at hand. */ header?: SessionHeader | null }
);

export interface ResolvedSessionWorkspace {
	/**
	 * The Agent the session records, echoed so a reader sees the identity root next to the work
	 * root. `undefined` = the session records none — never an invented Agent: resolving *which*
	 * Agent serves a session is `./session-agent`'s answer (§10), and a second answer here would
	 * eventually disagree with it.
	 */
	agentId?: AgentId;
	/** The identity root. */
	agentDir: string;
	/** The Project this session belongs to. `undefined` = nothing named one. */
	projectId?: ProjectId;
	/** That Project's root. Present exactly when `projectId` is. */
	projectRoot?: string;
	/** Where `projectId` came from; `"none"` exactly when `projectId` is `undefined`. */
	projectSource: ProjectSource;
	/**
	 * Every root in force, in precedence order: the Project root (when bound), then the roots the
	 * agentDir declares (`WorkspaceDeclaration.attachedRoots`), then the agentDir itself. Absolute,
	 * de-duplicated by real path (a symlinked checkout counts once).
	 *
	 * The boundary a session may touch is this list — not "somewhere under the Project", and not the
	 * cwd. Unbound with no declaration the list is exactly `[agentDir]`, which is what the file and
	 * tool surface used before Projects existed.
	 */
	roots: readonly string[];
}

/** Why a session's workspace could not be resolved. */
export type SessionWorkspaceFailure =
	| {
			/** A recorded/named Project the registry does not declare. */
			kind: "project-unknown";
			projectId: ProjectId;
			source: ProjectBindingSource;
	  }
	| {
			/** The caller and the session's own record name two different Projects. */
			kind: "project-conflict";
			recordedProjectId: ProjectId;
			callerProjectId: ProjectId;
	  }
	| {
			/**
			 * A declaration exists but cannot be interpreted, so the roots it declares are unknown.
			 * Reading it as "nothing declared" would silently narrow (or, for a caller that treats
			 * `roots` as an allow-list, silently change) the boundary.
			 */
			kind: "workspace-declaration-unreadable";
			path: string;
			reason: string;
	  };

/** Thrown when a session's workspace cannot be resolved. Carries the machine-readable reason. */
export class SessionWorkspaceError extends Error {
	readonly failure: SessionWorkspaceFailure;

	constructor(failure: SessionWorkspaceFailure, message: string) {
		super(message);
		this.name = "SessionWorkspaceError";
		this.failure = failure;
	}
}

/**
 * Resolve the Project and the roots of a session, or fail with an explicit reason.
 *
 * Pure apart from the two files it reads (the Project registry, the agentDir's declaration), both
 * read fresh on every call so a process pointed at another HOME — and a test that changes HOME
 * between calls — reads *that* client's declarations.
 */
export async function resolveSessionWorkspace(input: ResolveSessionWorkspaceInput): Promise<ResolvedSessionWorkspace> {
	const header = "session" in input ? input.session.getHeader() : (input.header ?? null);
	const cwd = "session" in input ? input.session.getCwd() : header?.cwd;

	const recorded = readPersistedProject(header);
	if (recorded && input.projectId !== undefined && recorded.projectId !== input.projectId) {
		throw new SessionWorkspaceError(
			{
				kind: "project-conflict",
				recordedProjectId: recorded.projectId,
				callerProjectId: input.projectId,
			},
			`This session is recorded as belonging to project "${recorded.projectId}" but the caller names ` +
				`project "${input.projectId}". Re-binding a session to another Project is an explicit switch, ` +
				"not a resolution.",
		);
	}

	// A caller-named Project *is* the session's own declaration — for a session without a header it
	// is the only one there is — so it enters at rung 1 with provenance `"session"`.
	const named: ResolvedProjectRef | null =
		input.projectId !== undefined ? { projectId: input.projectId, source: "session" } : recorded;

	const projects = await loadProjects();
	const project = named ? requireProject(projects, named) : matchCwd(projects, cwd);

	const attachedRoots = await readAttachedRoots(input.agentDir);
	return {
		agentId: header?.agentId,
		agentDir: input.agentDir,
		projectId: project?.projectId,
		projectRoot: project?.root,
		projectSource: project ? (named ? named.source : "cwd") : "none",
		roots: rootsInForce(project?.root, attachedRoots, input.agentDir),
	};
}

/**
 * The Project a session header recorded, if any. `null` = the header records none, which is not an
 * error (a session assembled by a caller that had no Project to pass, or one written before
 * Projects were recorded).
 *
 * A header that carries an id but no source we recognise is still the session's own record — the
 * same reading `./session-agent` gives a header that carries an `agentId` and no source. The
 * alternative, inventing `"cwd"`, would claim the id was inferred from a directory nobody looked
 * at.
 */
export function readPersistedProject(header: SessionHeader | null | undefined): ResolvedProjectRef | null {
	const projectId = header?.projectId;
	if (!projectId) return null;
	const source = header?.projectSource;
	return { projectId, source: source === "cwd" ? "cwd" : "session" };
}

/**
 * Rung 1/2 for a caller-named or recorded Project: the registry must declare it. A reference that
 * resolves to nothing is a failure, not an unbound session (`./session-workspace` module doc).
 */
function requireProject(projects: readonly ProjectRecord[], ref: ResolvedProjectRef): ProjectRecord {
	const project = projects.find(candidate => candidate.projectId === ref.projectId);
	if (project) return project;
	throw new SessionWorkspaceError(
		{ kind: "project-unknown", projectId: ref.projectId, source: ref.source },
		ref.source === "session"
			? `This session is recorded as belonging to project "${ref.projectId}", which the Project registry does ` +
					"not declare. Declare it again or start a session without that binding: a session must not run " +
					"outside the Project it says it works on."
			: `Project "${ref.projectId}" is not declared in the Project registry.`,
	);
}

/**
 * Rung 2: the legacy fallback for a session that recorded nothing. Skipped when no cwd is known —
 * matching an unknown directory against the registry would answer with a Project nobody claimed.
 */
function matchCwd(projects: readonly ProjectRecord[], cwd: string | undefined): ProjectRecord | undefined {
	if (!cwd) return undefined;
	return matchProjectForPath(projects, cwd);
}

/**
 * The roots the agentDir itself declares, resolved the way every declaration path in
 * `../skeleton/workspace` is (relative to the agentDir, absolute paths pass through).
 *
 * `readWorkspaceDeclaration` keeps "no declaration" (ENOENT) apart from "a declaration I cannot
 * interpret"; the second is fatal here because it is exactly the case that may be declaring roots.
 * Other I/O errors propagate from that reader untouched.
 */
async function readAttachedRoots(agentDir: string): Promise<string[]> {
	const file = workspaceFilePath(agentDir);
	let read: WorkspaceDeclarationRead;
	try {
		read = await readWorkspaceDeclaration(agentDir);
	} catch (err) {
		throw new SessionWorkspaceError(
			{ kind: "workspace-declaration-unreadable", path: file, reason: toError(err).message },
			`The workspace declaration at "${file}" could not be read, so the roots it declares are unknown. ` +
				"Fix or remove that file: a session must not be bounded by roots nobody declared.",
		);
	}
	switch (read.state) {
		case "declared":
			return (read.declaration.attachedRoots ?? []).map(root => path.resolve(agentDir, root));
		case "absent":
			return [];
		case "invalid":
			throw new SessionWorkspaceError(
				{ kind: "workspace-declaration-unreadable", path: file, reason: read.reason },
				`The workspace declaration at "${file}" is ${read.reason}, so the roots it declares cannot be ` +
					"determined. Fix or remove that file (a missing declaration simply declares no extra roots).",
			);
	}
}

/**
 * The roots in force, de-duplicated by real path (`resolveEquivalentPath`), keeping the first —
 * declared — spelling of each. Precedence order is the contract: the Project root leads, so a
 * consumer that needs "the Project's root" reads position 0, and the agentDir trails, so an unbound
 * session's list is exactly the agentDir.
 */
function rootsInForce(projectRoot: string | undefined, attachedRoots: readonly string[], agentDir: string): string[] {
	const roots: string[] = [];
	const seen = new Set<string>();
	for (const candidate of [...(projectRoot ? [projectRoot] : []), ...attachedRoots, agentDir]) {
		const absolute = path.resolve(candidate);
		const key = resolveEquivalentPath(absolute);
		if (seen.has(key)) continue;
		seen.add(key);
		roots.push(absolute);
	}
	return roots;
}
