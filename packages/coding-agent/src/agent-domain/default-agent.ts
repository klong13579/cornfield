/**
 * Default Agent resolution — the policy (WP4), not a store.
 *
 * Source: `docs/proma-comparison/architecture-comparison-proma-diagnosis.md` §10
 *
 *   session.agentId > project.defaultAgentId > workspaceContext.defaultAgentId
 *     > user.globalDefaultAgentId > system bootstrap agent
 *
 * What this module is:
 *   - The precedence chain, the §10 candidate checks (exists, enabled, model,
 *     permission, Project binding) and the `WorkspaceContext` derivation.
 *   - Pure. Declarations and the candidate world arrive as arguments; there is no
 *     disk access, no registry, no settings and no session store here. Composition
 *     lives in `../session/session-agent` (client/session side) and in the gateway.
 *
 * What it deliberately is NOT:
 *   - Not a second Agent registry: candidates are WP1 `AgentRecord` projections
 *     (`./types`); building them is the caller's job.
 *   - Not UI-aware: the input has no channel for "the Agent selected in the UI", so
 *     a Schedule, a gateway webhook or a session restore cannot accidentally read
 *     one (§10). Callers that must not depend on UI state pass only persisted facts.
 *
 * Three rules that are easy to get wrong:
 *   1. A *declared* candidate is an intent. The most specific declaration wins; if it
 *      cannot be honoured the resolution FAILS rather than quietly demoting to a less
 *      specific declaration. Serving a different Agent than the declared one is the
 *      cross-project identity leak §4 warns about (wrong memory, wrong rules).
 *   2. `bootstrap` is consulted only when no scope declared anything at all. It is the
 *      client's own identity for a bare process, not a fallback for a broken intent.
 *   3. Capability verdicts are three-valued because §10 requires the checks: `false`
 *      rejects the candidate, `"unknown"` means nothing probed it — the resolution
 *      reports it as `unverified` instead of absorbing it as valid.
 */

import * as path from "node:path";

import type { WorkspaceDeclaration } from "../skeleton/workspace";
import type { AgentId, AgentRecord, ProjectRecord, WorkspaceContext } from "./types";

/**
 * Scope that named the Agent, most specific first (§10). `bootstrap` is the client's
 * own identity and is never in competition with an explicit declaration.
 */
export type DefaultAgentSource = "session" | "project" | "workspace" | "user" | "bootstrap";

/** Declared scopes, in precedence order. `bootstrap` is deliberately excluded. */
export const DECLARED_AGENT_PRECEDENCE: readonly DefaultAgentSource[] = ["session", "project", "workspace", "user"];

/** Full precedence chain, including the bootstrap rung, for diagnostics and docs. */
export const DEFAULT_AGENT_PRECEDENCE: readonly DefaultAgentSource[] = [...DECLARED_AGENT_PRECEDENCE, "bootstrap"];

/** Capabilities §10 requires a candidate to have. */
export type AgentCapability = "model" | "permission";

/**
 * Verdict of one capability probe.
 *   - `true` — probed and usable.
 *   - `false` — probed and unusable; the candidate is rejected.
 *   - `"unknown"` — nothing probed it. Reported as `unverified`, never as valid.
 */
export type CapabilityVerdict = boolean | "unknown";

/**
 * One candidate Agent plus the capability verdicts the resolver cannot derive itself
 * (the Agent's effective model and permission policy belong to the registry / config
 * layer, not to this module).
 */
export interface AgentCandidateFacts {
	agent: AgentRecord;
	/** `"unknown"` is a statement about the probe, not about the Agent. */
	modelAvailable: CapabilityVerdict;
	permissionAvailable: CapabilityVerdict;
}

/**
 * Which scope named which Agent, as persisted (session header, and later schedules).
 * Provenance travels with the id so a reader never has to re-derive it (§10).
 */
export interface ResolvedAgentRef {
	agentId: AgentId;
	source: DefaultAgentSource;
}

/**
 * What each scope declares for this resolution. Every field is the *persisted* fact of
 * that scope — the input type intentionally has no field a UI could fill with a
 * transient selection (§10).
 *
 * All five rungs have an authority: `sessionAgentId` (caller pin / session header),
 * `projectDefaultAgentId` (`./project-store`), `workspaceDefaultAgentId` (the
 * `WorkspaceDeclaration` of the workspace in force, see `../skeleton/workspace`),
 * `userDefaultAgentId` (`USER_GLOBAL_DEFAULT_AGENT_KEY` in the user's `config.yml`, see
 * `../config/settings-schema`) and `bootstrapAgentId` (the process's own identity).
 */
export interface DefaultAgentDeclarations {
	sessionAgentId?: AgentId;
	projectDefaultAgentId?: AgentId;
	/** §10 rung 3: the `defaultAgentId` declared by the workspace in force. */
	workspaceDefaultAgentId?: AgentId;
	/** §10 rung 4: the client-wide default Agent declared by the user's own settings. */
	userDefaultAgentId?: AgentId;
	/** The client's own Agent for a bare process. Used only when nothing else is declared. */
	bootstrapAgentId?: AgentId;
}

export interface DefaultAgentResolutionInput {
	declarations: DefaultAgentDeclarations;
	/** Live Agents (WP1 projections) with their capability verdicts. */
	candidates: readonly AgentCandidateFacts[];
	/** The Project this session works on. Drives the binding check and `WorkspaceContext`. */
	project?: ProjectRecord;
	/** Working directory the session will run in. */
	cwd: string;
	/** The Agent's workspace declaration, when the caller already loaded it. */
	workspaceDeclaration?: WorkspaceDeclaration;
}

/** Why a candidate could not be used. One member per §10 check. */
export type AgentSelectionFailure =
	| { kind: "no-agent-declared"; cwd: string }
	| { kind: "agent-unknown"; source: DefaultAgentSource; agentId: AgentId }
	| { kind: "agent-disabled"; source: DefaultAgentSource; agentId: AgentId }
	| {
			kind: "agent-capability-unusable";
			source: DefaultAgentSource;
			agentId: AgentId;
			capability: AgentCapability;
	  }
	| {
			kind: "agent-project-binding-violated";
			source: DefaultAgentSource;
			agentId: AgentId;
			projectId: string;
	  };

export interface ResolvedDefaultAgent {
	agent: AgentRecord;
	/** Which scope named this Agent. Persisted with the session (§10). */
	source: DefaultAgentSource;
	/** Effective context of this Agent on this Project — derived, never stored (§1). */
	workspaceContext: WorkspaceContext;
	/** Capabilities §10 requires but nobody probed. Visible, never absorbed as valid. */
	unverified: readonly AgentCapability[];
}

export type DefaultAgentResolution =
	| { ok: true; resolved: ResolvedDefaultAgent }
	| { ok: false; failure: AgentSelectionFailure };

/** Agent-scoped config file, matching `Settings` (`path.join(agentDir, "config.yml")`). */
export const AGENT_CONFIG_FILE_NAME = "config.yml";

/**
 * Resolve the Agent for a session from persisted declarations and a candidate world.
 *
 * Never throws: the failure branch is data so callers can log, surface or map it.
 * See the module doc for why an unusable declaration does not fall through.
 */
export function resolveDefaultAgent(input: DefaultAgentResolutionInput): DefaultAgentResolution {
	const declared = firstDeclaredRung(input.declarations);
	if (declared) {
		return evaluate(declared.source, declared.agentId, input);
	}

	// Nothing declared anywhere: the client's own Agent, and only then.
	const { bootstrapAgentId } = input.declarations;
	if (bootstrapAgentId === undefined) {
		return { ok: false, failure: { kind: "no-agent-declared", cwd: input.cwd } };
	}
	return evaluate("bootstrap", bootstrapAgentId, input);
}

/**
 * Derive the effective `WorkspaceContext` of an Agent on a Project (§1). The field set
 * is WP1's; every value here comes from the Agent, the Project or the workspace
 * declaration, so the `workspace.*` relation rules in `./relations` hold by
 * construction — a mismatch would mean this derivation is wrong, not the caller.
 */
export function deriveWorkspaceContext(input: {
	agent: AgentRecord;
	project?: ProjectRecord;
	cwd: string;
	workspaceDeclaration?: WorkspaceDeclaration;
}): WorkspaceContext {
	const { agent, project, cwd, workspaceDeclaration } = input;
	const context: WorkspaceContext = {
		agentId: agent.agentId,
		agentDir: agent.agentDir,
		cwd,
		modelConfigPath: path.join(agent.agentDir, AGENT_CONFIG_FILE_NAME),
	};
	if (project) {
		context.projectId = project.projectId;
		context.projectRoot = project.root;
	}
	const declaredDefaultAgentId = workspaceDeclaration?.defaultAgentId;
	if (declaredDefaultAgentId !== undefined) {
		context.defaultAgentId = declaredDefaultAgentId;
	}
	const permissionMode = workspaceDeclaration?.permissions?.mode;
	if (permissionMode) {
		context.permissionMode = permissionMode;
	}
	const skillsDir = workspaceDeclaration?.skillsDir;
	if (skillsDir) {
		context.skillsDir = resolveInAgentDir(agent.agentDir, skillsDir);
	}
	const memoryDir = workspaceDeclaration?.knowledge?.memoryDir;
	if (memoryDir) {
		context.memoryDir = resolveInAgentDir(agent.agentDir, memoryDir);
	}
	return context;
}

/** Actionable, one-line description of a failed resolution. */
export function describeAgentSelectionFailure(failure: AgentSelectionFailure, agents: readonly AgentRecord[]): string {
	switch (failure.kind) {
		case "no-agent-declared": {
			const known = agents.map(agent => agent.agentId).join(", ");
			return (
				`No Agent is declared for "${failure.cwd}" and no bootstrap Agent is available. ` +
				`Pick an Agent explicitly (registered: ${known || "none"}).`
			);
		}
		case "agent-unknown":
			return (
				`${describeAgentSource(failure.source)} names Agent "${failure.agentId}", which is not registered. ` +
				"Register it or point the declaration at an existing Agent."
			);
		case "agent-disabled":
			return (
				`${describeAgentSource(failure.source)} names Agent "${failure.agentId}", which is disabled ` +
				"(its agentDir is missing). Re-enable it or pick another Agent."
			);
		case "agent-capability-unusable":
			return (
				`${describeAgentSource(failure.source)} names Agent "${failure.agentId}", whose ${failure.capability} ` +
				"is not available. Fix that Agent's configuration or pick another Agent."
			);
		case "agent-project-binding-violated":
			return (
				`${describeAgentSource(failure.source)} names Agent "${failure.agentId}", which is not bound to project ` +
				`"${failure.projectId}". Bind it or pick another Agent.`
			);
	}
}

/** Error wrapper for callers that must fail hard instead of branching on the failure. */
export class AgentSelectionError extends Error {
	readonly failure: AgentSelectionFailure;

	constructor(failure: AgentSelectionFailure, agents: readonly AgentRecord[]) {
		super(describeAgentSelectionFailure(failure, agents));
		this.name = "AgentSelectionError";
		this.failure = failure;
	}
}

/** Narrow a string to a resolved source at data boundaries (persisted session headers). */
export function isDefaultAgentSource(value: unknown): value is DefaultAgentSource {
	return (
		value === "session" || value === "project" || value === "workspace" || value === "user" || value === "bootstrap"
	);
}

function declaredAgentId(declarations: DefaultAgentDeclarations, source: DefaultAgentSource): AgentId | undefined {
	switch (source) {
		case "session":
			return declarations.sessionAgentId;
		case "project":
			return declarations.projectDefaultAgentId;
		case "workspace":
			return declarations.workspaceDefaultAgentId;
		case "user":
			return declarations.userDefaultAgentId;
		case "bootstrap":
			return declarations.bootstrapAgentId;
	}
}

/**
 * The most specific rung that actually declares something, or `undefined` when nothing
 * declared. Exported for callers whose declarations arrive one rung at a time: a rung
 * backed by a file must not be read — nor its unreadable file raised — before the policy
 * will consult it, and only the precedence order can say whether it will. Asking the
 * policy is the point: a caller deciding that itself stops following the order above the
 * moment the order changes.
 */
export function firstDeclaredRung(
	declarations: DefaultAgentDeclarations,
): { source: DefaultAgentSource; agentId: AgentId } | undefined {
	for (const source of DECLARED_AGENT_PRECEDENCE) {
		const agentId = declaredAgentId(declarations, source);
		if (agentId !== undefined) return { source, agentId };
	}
	return undefined;
}

function evaluate(
	source: DefaultAgentSource,
	agentId: AgentId,
	input: DefaultAgentResolutionInput,
): DefaultAgentResolution {
	const candidate = input.candidates.find(entry => entry.agent.agentId === agentId);
	if (!candidate) {
		return { ok: false, failure: { kind: "agent-unknown", source, agentId } };
	}
	const { agent } = candidate;
	if (!agent.enabled) {
		return { ok: false, failure: { kind: "agent-disabled", source, agentId } };
	}
	if (candidate.modelAvailable === false) {
		return { ok: false, failure: { kind: "agent-capability-unusable", source, agentId, capability: "model" } };
	}
	if (candidate.permissionAvailable === false) {
		return { ok: false, failure: { kind: "agent-capability-unusable", source, agentId, capability: "permission" } };
	}
	// Absent bindings are unconstrained; a declared list — including an empty one — is an
	// upper bound (same reading as `./relations` `agent.project-binding-violated`).
	const { project } = input;
	if (project && agent.projectIds !== undefined && !agent.projectIds.includes(project.projectId)) {
		return {
			ok: false,
			failure: { kind: "agent-project-binding-violated", source, agentId, projectId: project.projectId },
		};
	}

	const unverified: AgentCapability[] = [];
	if (candidate.modelAvailable === "unknown") unverified.push("model");
	if (candidate.permissionAvailable === "unknown") unverified.push("permission");

	return {
		ok: true,
		resolved: {
			agent,
			source,
			workspaceContext: deriveWorkspaceContext({
				agent,
				project,
				cwd: input.cwd,
				workspaceDeclaration: input.workspaceDeclaration,
			}),
			unverified,
		},
	};
}

/** Declaration paths are relative to the agentDir root; absolute paths pass through. */
function resolveInAgentDir(agentDir: string, declarationPath: string): string {
	return path.isAbsolute(declarationPath) ? path.normalize(declarationPath) : path.resolve(agentDir, declarationPath);
}

/** Which scope named the Agent, phrased for a human reading a failure. */
export function describeAgentSource(source: DefaultAgentSource): string {
	switch (source) {
		case "session":
			return "This session's Agent";
		case "project":
			return "The Project default Agent";
		case "workspace":
			return "The workspace default Agent";
		case "user":
			return "The user-global default Agent";
		case "bootstrap":
			return "The bootstrap Agent";
	}
}
