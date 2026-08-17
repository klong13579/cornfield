/**
 * Ask-target routing decision for the `intercom` tool's `ask` action.
 *
 * The ask action needs a deterministic, testable answer to "who does this ask
 * go to?" before any broker round-trip happens. The rule:
 *
 *   1. a `cwd` target always wins (resolve against that directory, with an
 *      optional `to` acting as a filter),
 *   2. otherwise an explicit `to` wins,
 *   3. otherwise, in child mode (a parent was declared via PI_SUBAGENT_* env),
 *      the ask routes to the parent for judgment,
 *   4. otherwise there is no target ("missing") and the caller reports the
 *      missing-parameter error.
 *
 * The cwd-message carries the non-empty `cwd` itself: the invariant "a cwd
 * ask always has a cwd" is enforced here (the argument is truthy-checked
 * once, inside this function) and expressed through the type, so the caller
 * never re-checks the raw parameter or reaches for a guard cast.
 */

/** Minimal shape of the child-orchestrator metadata the intercom extension
 *  reads from PI_SUBAGENT_* env vars. Structural subset of ChildOrchestratorMetadata. */
export interface ChildOrchestratorMetadataLike {
	/** Parent session name or id (PI_SUBAGENT_ORCHESTRATOR_TARGET). */
	orchestratorTarget: string;
	/** Parent's intercom session id when known (PI_SUBAGENT_ORCHESTRATOR_SESSION_ID). */
	orchestratorSessionId?: string;
}

export type AskRouting =
	/** Resolve the target within this non-empty cwd; `to` is an optional filter. */
	| { mode: "cwd"; cwd: string; to: string | undefined }
	/** Resolve `to` directly against the broker roster. */
	| { mode: "explicit"; to: string }
	/** Route to the declared parent (child mode, no explicit target). */
	| { mode: "parent"; parentTarget: string }
	/** No target at all — the caller reports the missing-parameter error. */
	| { mode: "missing" };

export function resolveAskRouting(input: {
	to?: string;
	cwd?: string;
	childMetadata: ChildOrchestratorMetadataLike | null;
}): AskRouting {
	const { to, cwd, childMetadata } = input;
	if (cwd) {
		// `cwd` is truthy here, so the value stored in the message is the
		// non-empty string the resolver needs. The caller matches on
		// `mode === "cwd"` and reads `routing.cwd` — no raw-parameter guard.
		return { mode: "cwd", cwd, to };
	}
	if (to) {
		return { mode: "explicit", to };
	}
	if (childMetadata) {
		return {
			mode: "parent",
			parentTarget: childMetadata.orchestratorSessionId ?? childMetadata.orchestratorTarget,
		};
	}
	return { mode: "missing" };
}
