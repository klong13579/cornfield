/**
 * What a spawned child session is told about itself, in environment variables.
 *
 * A spawned child `cornfield` process learns both halves of its identity from
 * environment variables only — no handshake frame carries them: who its parent
 * is (the orchestrator edge, read back by `./index.ts`) and which Agent it must
 * run as (the config home the SDK boots from, read back by
 * `@cornfield/utils#getAgentDir`). The names and their meaning therefore live
 * here, once, for every writer:
 *
 *   - `./project-agent.ts` — a child launched into a Herdr pane (shell prefix),
 *   - `../session/session-tree-manager.ts` — a formal Child Session (env map).
 *
 * Defaults are deliberately NOT here: a pane child calls itself `project-pane`
 * while a formal Child Session calls itself after its delegation role, and a pane
 * child inherits the launching shell's Agent home while a delegation must name
 * one — each caller resolves its own defaults, this module owns the contract.
 */

/** Environment variables that carry a child session's identity into its process. */
export const CHILD_SESSION_ENV = {
	/** Parent session name or stable id. */
	orchestratorTarget: "PI_SUBAGENT_ORCHESTRATOR_TARGET",
	/** The parent's exact intercom session id — what the child registers as its `parentId`. */
	orchestratorSessionId: "PI_SUBAGENT_ORCHESTRATOR_SESSION_ID",
	/** Unique id of this launch, surfaced in the child's reports back to the parent. */
	runId: "PI_SUBAGENT_RUN_ID",
	/** Agent kind label the child shows in reports back to the parent. */
	childAgent: "PI_SUBAGENT_CHILD_AGENT",
	/** Child index within the run. */
	childIndex: "PI_SUBAGENT_CHILD_INDEX",
	/**
	 * The Agent home this child must run as (`CORNFIELD_AGENT_DIR`).
	 *
	 * This is the only channel that decides which Agent a child *is*: the SDK
	 * resolves the process's Agent from its config directory, never from its cwd,
	 * so a delegation to another Agent that does not set this launches a process
	 * carrying the parent's settings, skills and persisted identity while its
	 * ledger entry names someone else.
	 */
	agentDir: "CORNFIELD_AGENT_DIR",
} as const;

/** The identity a child is launched with — every field already defaulted by the caller. */
export interface ChildSessionEdge {
	/** Parent session name or stable id. */
	parentTarget: string;
	/**
	 * The parent's exact intercom session id. Falls back to `parentTarget` when
	 * the caller has no exact id, which matches the child-side resolution in
	 * `./index.ts`.
	 */
	parentSessionId?: string;
	runId: string;
	agent: string;
	index: string;
	/**
	 * The Agent home the child must run as. Omitted = inherit the launching
	 * process's own Agent (the Herdr pane case); a formal Child Session must always
	 * state it, because its ledger entry claims an Agent the child has to be.
	 */
	agentDir?: string;
}

/**
 * Render a child's identity as an environment map.
 *
 * `null` values are never produced: a caller that cannot name its parent must
 * not spawn a child at all (an env var set to the string "undefined" would
 * register a parent edge pointing at a session that does not exist).
 */
export function childSessionEnv(edge: ChildSessionEdge): Record<string, string> {
	const env: Record<string, string> = {
		[CHILD_SESSION_ENV.orchestratorTarget]: edge.parentTarget,
		[CHILD_SESSION_ENV.orchestratorSessionId]: edge.parentSessionId ?? edge.parentTarget,
		[CHILD_SESSION_ENV.runId]: edge.runId,
		[CHILD_SESSION_ENV.childAgent]: edge.agent,
		[CHILD_SESSION_ENV.childIndex]: edge.index,
	};
	// Omitted rather than defaulted: an empty value would point the child's whole
	// config discovery at a directory that does not exist.
	if (edge.agentDir) env[CHILD_SESSION_ENV.agentDir] = edge.agentDir;
	return env;
}
