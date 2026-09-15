/**
 * Session ↔ Agent resolution (WP4).
 *
 * The domain policy lives in `../agent-domain/default-agent`; this module composes the
 * world it judges — the Agent registry projection (`../agent-domain/agent-directory`),
 * the Project store (`../agent-domain/project-store`) and the process's own identity —
 * and produces the `ResolvedAgentRef` a session header persists (§10).
 *
 * Where the session's Agent comes from:
 *   1. a caller pin (CLI flag, gateway account, schedule record) — the session's intent;
 *   2. the Agent already recorded in the session header, when resuming or forking;
 *   3. the §10 chain: Project default > workspace default > user default;
 *   4. the process's own Agent (`bootstrap`) when nothing else is declared.
 *
 * Two invariants this module enforces so the recorded Agent is never a plausible lie:
 *
 *   - A session may only record the Agent the process actually runs as. If the chain
 *     resolves a *different* Agent than the process, the resolution fails loudly instead
 *     of writing a header that would not match the running configuration. Launching a
 *     process *as* the resolved Agent (config / model / skills follow it) is a later
 *     work package; until then WP4 refuses rather than pretends.
 *   - Nothing here reads UI or "current selection" state. The input has no channel for
 *     it, so a Schedule, a gateway webhook or a restore cannot inherit one (§10).
 *
 * `unverified` capabilities are reported, never absorbed as valid (see `default-agent`).
 */

import { logger } from "@cornfield/utils";
import {
	type AgentDirectoryEntry,
	findAgentRecord,
	findAgentRecordByDir,
	loadAgentDirectory,
	toCandidates,
} from "../agent-domain/agent-directory";
import {
	type AgentCapability,
	type AgentSelectionFailure,
	type DefaultAgentDeclarations,
	describeAgentSelectionFailure,
	describeAgentSource,
	isDefaultAgentSource,
	type ResolvedAgentRef,
	resolveDefaultAgent,
} from "../agent-domain/default-agent";
import { loadProjects, matchProjectForPath } from "../agent-domain/project-store";
import type { AgentId, AgentRecord, WorkspaceContext } from "../agent-domain/types";
import type { SessionHeader } from "./session-manager";

/**
 * Agent id of a bare cornfield process that is not a registered Agent. Matches the
 * `default` Agent convention used by `omp serve` / the client (`agents.default`).
 */
export const DEFAULT_AGENT_ID = "default";

export interface ResolveSessionAgentInput {
	/** Working directory of the session; also selects the Project. */
	cwd: string;
	/**
	 * Directory this process runs its Agent config from (sdk's `agentDir`, a gateway
	 * account's agentDir). Its registered Agent, when it has one, is the process's own.
	 */
	processAgentDir: string;
	/** Agent pinned by the caller. Wins over the process directory; a conflict with a persisted header fails. */
	pinnedAgentId?: AgentId;
	/** Header of the session being resumed or forked, when there is one. */
	sessionHeader?: SessionHeader | null;
}

/** Where the resolved Agent came from in *this* call. */
export type SessionAgentOrigin = "persisted" | "resolved";

export interface ResolvedSessionAgent {
	ref: ResolvedAgentRef;
	/** Effective context of the Agent on the resolved Project — derived, never stored (§1). */
	workspaceContext: WorkspaceContext;
	/** Capabilities §10 requires but nobody probed (see `default-agent`). */
	unverified: readonly AgentCapability[];
	origin: SessionAgentOrigin;
}

/** A resolution failure, or a conflict between what is declared and what this process is. */
export type SessionAgentFailure =
	| AgentSelectionFailure
	| {
			kind: "agent-session-conflict";
			pinnedAgentId: AgentId;
			persistedAgentId: AgentId;
	  }
	| {
			kind: "agent-process-mismatch";
			agentId: AgentId;
			source: ResolvedAgentRef["source"];
			processAgentId: AgentId;
			processAgentDir: string;
	  };

/** Thrown when a session's Agent cannot be resolved. Carries the machine-readable reason. */
export class SessionAgentError extends Error {
	readonly failure: SessionAgentFailure;

	constructor(failure: SessionAgentFailure, message: string) {
		super(message);
		this.name = "SessionAgentError";
		this.failure = failure;
	}
}

/**
 * Resolve the Agent for a session, or fail with an explicit reason.
 *
 * Callers that must not depend on UI state (Schedule, gateway webhook, session restore)
 * pass only persisted facts — `sessionHeader` / `pinnedAgentId` — and get the same
 * answer in any process, regardless of what a client has selected.
 */
export async function resolveSessionAgent(input: ResolveSessionAgentInput): Promise<ResolvedSessionAgent> {
	const directory = await loadAgentDirectory();
	const agents = directory.map(entry => entry.agent);
	const processAgent = resolveProcessAgent(directory, input);
	const persisted = readPersistedRef(input.sessionHeader);

	if (input.pinnedAgentId && persisted && input.pinnedAgentId !== persisted.agentId) {
		throw new SessionAgentError(
			{
				kind: "agent-session-conflict",
				pinnedAgentId: input.pinnedAgentId,
				persistedAgentId: persisted.agentId,
			},
			`This session is recorded as Agent "${persisted.agentId}" but the caller pins Agent ` +
				`"${input.pinnedAgentId}". Re-pinning a session to another Agent is an explicit switch, not a resolution.`,
		);
	}

	const projects = await loadProjects();
	const project = matchProjectForPath(projects, input.cwd);
	const declarations: DefaultAgentDeclarations = {
		sessionAgentId: input.pinnedAgentId ?? persisted?.agentId,
		projectDefaultAgentId: project?.defaultAgentId,
		// Workspace and user-global defaults have no authority yet; the rungs stay
		// implemented and injected so wiring them needs no policy change.
		workspaceDefaultAgentId: undefined,
		userDefaultAgentId: undefined,
		bootstrapAgentId: processAgent.agent.agentId,
	};

	const resolution = resolveDefaultAgent({
		declarations,
		candidates: toCandidates(mergeDirectoryWithProcessAgent(directory, processAgent)),
		project,
		cwd: input.cwd,
		workspaceDeclaration: resolvedDeclaration(directory, processAgent, declarations),
	});
	if (!resolution.ok) {
		throw new SessionAgentError(resolution.failure, describeAgentSelectionFailure(resolution.failure, agents));
	}

	const { agent, source, workspaceContext, unverified } = resolution.resolved;
	if (agent.agentId !== processAgent.agent.agentId) {
		throw new SessionAgentError(
			{
				kind: "agent-process-mismatch",
				agentId: agent.agentId,
				source,
				processAgentId: processAgent.agent.agentId,
				processAgentDir: processAgent.agent.agentDir,
			},
			`${describeAgentSource(source)} resolves this session to Agent "${agent.agentId}", but this process ` +
				`runs as Agent "${processAgent.agent.agentId}" (${processAgent.agent.agentDir}). ` +
				"Start the session under that Agent's directory instead of recording the wrong Agent.",
		);
	}

	if (unverified.length > 0) {
		logger.debug("session-agent: capabilities not probed", { agentId: agent.agentId, unverified });
	}

	const usePersisted = persisted !== null && agent.agentId === persisted.agentId;
	return {
		ref: { agentId: agent.agentId, source: usePersisted ? persisted.source : source },
		workspaceContext,
		unverified,
		origin: usePersisted ? "persisted" : "resolved",
	};
}

/**
 * The Agent this process runs as: the registered Agent whose agentDir is the process
 * config dir, else the client's built-in default identity for a bare process.
 *
 * A bare `cornfield` in a repo is not a registered Agent — it runs with the client's own
 * config dir. Recording that as Agent `default` is the §10 bootstrap rung, and it is a
 * statement about the process, not an invented identity.
 */
function resolveProcessAgent(
	directory: readonly AgentDirectoryEntry[],
	input: ResolveSessionAgentInput,
): AgentDirectoryEntry {
	const registered = findAgentRecordByDir(directory, input.processAgentDir);
	if (registered) return registered;
	const agent: AgentRecord = {
		agentId: DEFAULT_AGENT_ID,
		agentDir: input.processAgentDir,
		displayName: DEFAULT_AGENT_ID,
		enabled: true,
	};
	return { agent };
}

/** The candidate set the policy judges: the registry projection plus the process's own Agent. */
function mergeDirectoryWithProcessAgent(
	directory: readonly AgentDirectoryEntry[],
	processAgent: AgentDirectoryEntry,
): AgentDirectoryEntry[] {
	if (findAgentRecord(directory, processAgent.agent.agentId)) return [...directory];
	return [...directory, processAgent];
}

/** The declaration of whichever Agent the chain is about to consider. */
function resolvedDeclaration(
	directory: readonly AgentDirectoryEntry[],
	processAgent: AgentDirectoryEntry,
	declarations: DefaultAgentDeclarations,
): AgentDirectoryEntry["declaration"] {
	const candidateId =
		declarations.sessionAgentId ??
		declarations.projectDefaultAgentId ??
		declarations.workspaceDefaultAgentId ??
		declarations.userDefaultAgentId ??
		declarations.bootstrapAgentId;
	if (candidateId === undefined) return undefined;
	const entry = findAgentRecord(directory, candidateId) ?? processAgent;
	return entry.agent.agentId === candidateId ? entry.declaration : undefined;
}

/** The Agent a session header recorded, if any. Absence is not an error (pre-agent sessions). */
export function readPersistedRef(header: SessionHeader | null | undefined): ResolvedAgentRef | null {
	const agentId = header?.agentId;
	if (!agentId) return null;
	const source = header?.agentSource;
	return { agentId, source: isDefaultAgentSource(source) ? source : "session" };
}
