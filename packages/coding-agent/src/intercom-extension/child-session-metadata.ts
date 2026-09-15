/**
 * The orchestrator (parent) edge of a child session, as the intercom broker
 * needs to see it.
 *
 * A spawned child `cornfield` process learns who its parent is from environment
 * variables only — no handshake frame carries the edge. The names and their
 * meaning therefore live here, once, for every writer:
 *
 *   - `./project-agent.ts` — a child launched into a Herdr pane (shell prefix),
 *   - `./child-session-edge.ts` — a formal Child Session process (env map).
 *
 * The reader is `./index.ts` (`readChildOrchestratorMetadata`), which turns the
 * same names back into the `parentId` the child registers with on the broker.
 *
 * Defaults are deliberately NOT here: a pane child calls itself `project-pane`
 * while a formal Child Session calls itself after its delegation role — each
 * caller resolves its own defaults, this module owns the contract.
 */

/** Environment variables that carry the orchestrator edge into a child process. */
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
} as const;

/** A resolved orchestrator edge — every field already defaulted by the caller. */
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
}

/**
 * Render the orchestrator edge as an environment map.
 *
 * `null` values are never produced: a caller that cannot name its parent must
 * not spawn a child at all (an env var set to the string "undefined" would
 * register a parent edge pointing at a session that does not exist).
 */
export function childSessionEnv(edge: ChildSessionEdge): Record<string, string> {
	return {
		[CHILD_SESSION_ENV.orchestratorTarget]: edge.parentTarget,
		[CHILD_SESSION_ENV.orchestratorSessionId]: edge.parentSessionId ?? edge.parentTarget,
		[CHILD_SESSION_ENV.runId]: edge.runId,
		[CHILD_SESSION_ENV.childAgent]: edge.agent,
		[CHILD_SESSION_ENV.childIndex]: edge.index,
	};
}
