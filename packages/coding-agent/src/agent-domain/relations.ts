/**
 * Illegal-relation validation for the agent-first domain (WP1).
 *
 * Every rule here encodes one relation the design decisions fix; the rule id is the
 * thing to grep when a violation fires. Sources are noted per rule against
 * `docs/proma-comparison/wp1-agent-domain-contract.md` and the diagnosis doc.
 *
 * Failure model — read this before calling:
 *   - Each validator judges only the collections its snapshot *declares*. An omitted
 *     collection is read as "nothing exists", not as "unknown". A caller holding a
 *     partial view must therefore call the narrow validator it can answer
 *     (`validateSessionTree`, `validateAgentTodos`, …) instead of `validateDomain`.
 *   - When a parent session is not in the snapshot, the child's derived relations
 *     (depth, root, parent agent/project equality) are *not* judged: the missing
 *     parent is reported once and the cascade is suppressed.
 *   - Results are data, never a boolean: an empty array means "no violation found
 *     under the declared snapshot", which is not the same as "valid on disk".
 */

import type {
	AgentId,
	AgentRecord,
	AgentTodoStatus,
	DomainSnapshot,
	ProjectRecord,
	SessionExecutionPolicy,
	SessionId,
	SessionNode,
} from "./types";

/** One broken relation. `subject` names the offending object. */
export interface DomainViolation {
	rule: DomainViolationRule;
	subject: string;
	message: string;
}

export type DomainViolationRule =
	| "snapshot.id-duplicated"
	| "agent.dir-not-absolute"
	| "agent.dir-shared"
	| "agent.project-binding-violated"
	| "project.root-not-absolute"
	| "project.default-agent-missing"
	| "project.default-agent-disabled"
	| "session.agent-missing"
	| "session.agent-disabled"
	| "session.project-missing"
	| "session.root-invalid"
	| "session.parent-undeclared"
	| "session.kind-mismatch"
	| "session.parent-missing"
	| "session.parent-self"
	| "session.parent-agent-mismatch"
	| "session.parent-project-mismatch"
	| "session.depth-mismatch"
	| "session.root-mismatch"
	| "session.cycle"
	| "session.delegated-root"
	| "session.result-not-ready"
	| "workspace.agent-missing"
	| "workspace.agent-disabled"
	| "workspace.agent-dir-mismatch"
	| "workspace.project-missing"
	| "workspace.project-root-mismatch"
	| "workspace.project-undeclared"
	| "schedule.agent-missing"
	| "schedule.agent-disabled"
	| "schedule.agent-unresolved"
	| "todo.agent-missing"
	| "todo.agent-disabled"
	| "todo.project-missing"
	| "todo.session-ref-missing"
	| "todo.session-ref-agent-mismatch"
	| "todo.session-ref-project-mismatch"
	| "todo.status-transition"
	| "todo.board-collision"
	| "context-item.owner-missing";

// ─────────────────────────────────────────────────────────────────────────────
// Reference helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Absolute-path check without `node:path`, so the contract stays usable from the
 * browser client. Accepts POSIX (`/…`) and Windows drive (`C:\…`) forms.
 */
function isAbsolutePath(value: string): boolean {
	if (value.startsWith("/") || value.startsWith("\\")) return true;
	return /^[A-Za-z]:[\\/]/.test(value);
}

/** Compare path identity: one separator flavour, no duplicate or trailing separators. */
function normalizePath(value: string): string {
	const unified = value.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
	return unified.length > 1 ? unified.replace(/\/+$/, "") : unified;
}

const SESSION_EXECUTION_POLICIES: readonly string[] = ["isolated-process"];

/**
 * Boundary guard for data read from disk (session JSONL, scheduler files).
 * `isolated-process` is the only formal Session policy: §38 removed `in-process`,
 * which stays the in-process subagent Task (`runSubprocess` + IRC) and never
 * becomes a session-tree node.
 */
export function isSessionExecutionPolicy(value: string): value is SessionExecutionPolicy {
	return SESSION_EXECUTION_POLICIES.includes(value);
}

interface DomainIndexes {
	agentById: ReadonlyMap<AgentId, AgentRecord>;
	agentByDir: ReadonlyMap<string, AgentRecord>;
	projectById: ReadonlyMap<string, ProjectRecord>;
	sessionById: ReadonlyMap<SessionId, SessionNode>;
}

function buildIndexes(snapshot: DomainSnapshot): DomainIndexes {
	const agentById = new Map<AgentId, AgentRecord>();
	const agentByDir = new Map<string, AgentRecord>();
	for (const agent of snapshot.agents) {
		if (!agentById.has(agent.agentId)) agentById.set(agent.agentId, agent);
		if (!agentByDir.has(normalizePath(agent.agentDir))) agentByDir.set(normalizePath(agent.agentDir), agent);
	}
	const projectById = new Map<string, ProjectRecord>();
	for (const project of snapshot.projects) {
		if (!projectById.has(project.projectId)) projectById.set(project.projectId, project);
	}
	const sessionById = new Map<SessionId, SessionNode>();
	for (const session of snapshot.sessions) {
		if (!sessionById.has(session.sessionId)) sessionById.set(session.sessionId, session);
	}
	return { agentById, agentByDir, projectById, sessionById };
}

/** Report an id that appears twice in one collection — the snapshot then has no single truth. */
function validateUniqueIds(concept: string, ids: readonly string[]): DomainViolation[] {
	const violations: DomainViolation[] = [];
	const seen = new Set<string>();
	for (const id of ids) {
		if (seen.has(id)) {
			violations.push({
				rule: "snapshot.id-duplicated",
				subject: `${concept}:${id}`,
				message: `snapshot declares ${concept} "${id}" more than once`,
			});
		}
		seen.add(id);
	}
	return violations;
}

/** An Agent's declared project bindings are a ceiling: nothing may reference outside them. */
function checkProjectBinding(agent: AgentRecord | undefined, projectId: string, subject: string): DomainViolation[] {
	if (!agent?.projectIds || agent.projectIds.includes(projectId)) return [];
	return [
		{
			rule: "agent.project-binding-violated",
			subject,
			message: `agent "${agent.agentId}" does not declare a binding to project "${projectId}"`,
		},
	];
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-concept validators
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Agent ↔ AgentDir. An agentDir is an Agent's physical home: exactly one Agent owns
 * it, and it is an absolute path (§1, §4).
 */
export function validateAgents(snapshot: DomainSnapshot): DomainViolation[] {
	const violations: DomainViolation[] = [];
	const ownerByDir = new Map<string, AgentId>();
	for (const agent of snapshot.agents) {
		if (!isAbsolutePath(agent.agentDir)) {
			violations.push({
				rule: "agent.dir-not-absolute",
				subject: agent.agentId,
				message: `agentDir "${agent.agentDir}" is not an absolute path`,
			});
		}
		const key = normalizePath(agent.agentDir);
		const owner = ownerByDir.get(key);
		if (owner === undefined) {
			ownerByDir.set(key, agent.agentId);
		} else if (owner !== agent.agentId) {
			violations.push({
				rule: "agent.dir-shared",
				subject: agent.agentId,
				message: `agentDir "${agent.agentDir}" is already the home of agent "${owner}"; one agentDir belongs to one Agent`,
			});
		}
	}
	const agentIds = snapshot.agents.map(agent => agent.agentId);
	return [...violations, ...validateUniqueIds("agent", agentIds)];
}

/** Project → its default Agent must exist and be enabled (§10). */
export function validateProjects(snapshot: DomainSnapshot): DomainViolation[] {
	const { agentById } = buildIndexes(snapshot);
	const violations: DomainViolation[] = [];
	for (const project of snapshot.projects) {
		if (!isAbsolutePath(project.root)) {
			violations.push({
				rule: "project.root-not-absolute",
				subject: project.projectId,
				message: `project root "${project.root}" is not an absolute path`,
			});
		}
		if (project.defaultAgentId === undefined) continue;
		const agent = agentById.get(project.defaultAgentId);
		if (!agent) {
			violations.push({
				rule: "project.default-agent-missing",
				subject: project.projectId,
				message: `defaultAgentId "${project.defaultAgentId}" is not a known Agent`,
			});
		} else if (!agent.enabled) {
			violations.push({
				rule: "project.default-agent-disabled",
				subject: project.projectId,
				message: `defaultAgentId "${project.defaultAgentId}" is disabled`,
			});
		}
	}
	const projectIds = snapshot.projects.map(project => project.projectId);
	return [...violations, ...validateUniqueIds("project", projectIds)];
}

/**
 * Session tree (§6). The parent edge is authoritative and must be internally
 * consistent: one Agent and one Project per chain, correct depth and root, no
 * cycle, and delegated children only (a Worker is never a root).
 */
export function validateSessionTree(snapshot: DomainSnapshot): DomainViolation[] {
	const indexes = buildIndexes(snapshot);
	const { agentById, projectById, sessionById } = indexes;
	const violations: DomainViolation[] = [];
	const reportedCycles = new Set<string>();

	for (const session of snapshot.sessions) {
		const subject = session.sessionId;
		const agent = agentById.get(session.agentId);
		if (!agent) {
			violations.push({
				rule: "session.agent-missing",
				subject,
				message: `agentId "${session.agentId}" is not a known Agent; a session's agent is resolved at creation and persisted (§10)`,
			});
		} else if (!agent.enabled) {
			violations.push({
				rule: "session.agent-disabled",
				subject,
				message: `agentId "${session.agentId}" is disabled`,
			});
		}
		if (session.projectId !== undefined && !projectById.has(session.projectId)) {
			violations.push({
				rule: "session.project-missing",
				subject,
				message: `projectId "${session.projectId}" is not a known Project`,
			});
		}
		if (session.resultBroughtBackAt !== undefined && session.resultRef === undefined) {
			violations.push({
				rule: "session.result-not-ready",
				subject,
				message: "resultBroughtBackAt is set without a resultRef; a result is ready before it is brought back (§6)",
			});
		}

		if (session.parentSessionId === undefined) {
			if (session.kind === "child") {
				violations.push({
					rule: "session.parent-undeclared",
					subject,
					message: 'session is kind "child" but declares no parent',
				});
				continue;
			}
			const reasons: string[] = [];
			if (session.depth !== 0) reasons.push(`depth is ${session.depth}, expected 0`);
			if (session.rootSessionId !== session.sessionId) {
				reasons.push(`rootSessionId "${session.rootSessionId}" is not this session`);
			}
			if (reasons.length > 0) {
				violations.push({
					rule: "session.root-invalid",
					subject,
					message: `parentless session is not a well-formed root: ${reasons.join("; ")}`,
				});
			}
			if (session.delegationRole !== undefined) {
				violations.push({
					rule: "session.delegated-root",
					subject,
					message: `root session carries delegationRole "${session.delegationRole}"; a Worker is always a child (§6)`,
				});
			}
			continue;
		}

		if (session.parentSessionId === session.sessionId) {
			violations.push({
				rule: "session.parent-self",
				subject,
				message: "session is its own parent",
			});
			continue;
		}

		const parent = sessionById.get(session.parentSessionId);
		if (!parent) {
			violations.push({
				rule: "session.parent-missing",
				subject,
				message: `parentSessionId "${session.parentSessionId}" is not in the snapshot`,
			});
			continue;
		}

		if (session.kind !== "child") {
			violations.push({
				rule: "session.kind-mismatch",
				subject,
				message: `session declares parentSessionId "${session.parentSessionId}" but kind is "${session.kind}"; a session with a parent is a child`,
			});
		}
		if (parent.agentId !== session.agentId) {
			violations.push({
				rule: "session.parent-agent-mismatch",
				subject,
				message: `parent belongs to agent "${parent.agentId}" but this session belongs to "${session.agentId}"`,
			});
		}
		if (parent.projectId !== session.projectId) {
			violations.push({
				rule: "session.parent-project-mismatch",
				subject,
				message: `child projectId ${describeId(session.projectId)} differs from parent projectId ${describeId(parent.projectId)}`,
			});
		}
		if (parent.depth + 1 !== session.depth) {
			violations.push({
				rule: "session.depth-mismatch",
				subject,
				message: `depth is ${session.depth}, expected ${parent.depth + 1} (parent depth ${parent.depth})`,
			});
		}
		if (parent.rootSessionId !== session.rootSessionId) {
			violations.push({
				rule: "session.root-mismatch",
				subject,
				message: `rootSessionId "${session.rootSessionId}" differs from the parent's "${parent.rootSessionId}"`,
			});
		}

		const cycle = findCycle(session, sessionById);
		if (cycle !== null && !reportedCycles.has(cycle)) {
			reportedCycles.add(cycle);
			violations.push({
				rule: "session.cycle",
				subject,
				message: `parent chain never reaches a root: ${cycle.split("|").join(" → ")}`,
			});
		}
	}

	const sessionIds = snapshot.sessions.map(session => session.sessionId);
	return [...violations, ...validateUniqueIds("session", sessionIds)];
}

function describeId(id: string | undefined): string {
	return id === undefined ? "(none)" : `"${id}"`;
}

/**
 * Walk the ancestor chain and return a canonical key for the cycle it runs into.
 *
 * The key contains the cycle members only: a tail chain that merely leads into the
 * cycle must not become part of the key, otherwise every tail node re-reports the
 * same cycle under a different key (`c → a → b → a` vs `a → b → a`). The key is the
 * walk suffix starting at the repeated node, sorted for determinism.
 *
 * Returns `null` when the chain reaches a root, or leaves the snapshot (the missing
 * parent is reported by the caller).
 */
function findCycle(start: SessionNode, byId: ReadonlyMap<SessionId, SessionNode>): string | null {
	const path: SessionId[] = [start.sessionId];
	let current = start;
	for (let step = 0; step <= byId.size; step++) {
		const parentId = current.parentSessionId;
		if (parentId === undefined) return null;
		const parent = byId.get(parentId);
		if (!parent) return null;
		const cycleStart = path.indexOf(parent.sessionId);
		if (cycleStart !== -1) return [...path.slice(cycleStart)].sort().join("|");
		path.push(parent.sessionId);
		current = parent;
	}
	return [...path].sort().join("|");
}

/**
 * WorkspaceContext is derived, so every field must still agree with what it was
 * derived from: the Agent's agentDir, and the Project's id and root (§4).
 */
export function validateWorkspaceContexts(snapshot: DomainSnapshot): DomainViolation[] {
	const { agentById, projectById } = buildIndexes(snapshot);
	const violations: DomainViolation[] = [];
	for (const context of snapshot.workspaceContexts ?? []) {
		const subject = `${context.agentId}${context.projectId ? `@${context.projectId}` : ""}`;
		const agent = agentById.get(context.agentId);
		if (!agent) {
			violations.push({
				rule: "workspace.agent-missing",
				subject,
				message: `agentId "${context.agentId}" is not a known Agent`,
			});
		} else {
			if (!agent.enabled) {
				violations.push({
					rule: "workspace.agent-disabled",
					subject,
					message: `agentId "${context.agentId}" is disabled`,
				});
			}
			if (normalizePath(context.agentDir) !== normalizePath(agent.agentDir)) {
				violations.push({
					rule: "workspace.agent-dir-mismatch",
					subject,
					message: `context agentDir "${context.agentDir}" is not the Agent's home "${agent.agentDir}"`,
				});
			}
		}

		if (context.projectId === undefined) {
			if (context.projectRoot !== undefined) {
				violations.push({
					rule: "workspace.project-undeclared",
					subject,
					message: `context carries projectRoot "${context.projectRoot}" without a projectId; a filesystem root is not a Project (§4)`,
				});
			}
			continue;
		}

		const project = projectById.get(context.projectId);
		if (!project) {
			violations.push({
				rule: "workspace.project-missing",
				subject,
				message: `projectId "${context.projectId}" is not a known Project`,
			});
		} else if (
			context.projectRoot !== undefined &&
			normalizePath(context.projectRoot) !== normalizePath(project.root)
		) {
			violations.push({
				rule: "workspace.project-root-mismatch",
				subject,
				message: `context projectRoot "${context.projectRoot}" is not the Project root "${project.root}"`,
			});
		}
		violations.push(...checkProjectBinding(agent, context.projectId, subject));
	}
	return violations;
}

/**
 * A schedule creates a Root Session and must not read the UI's current selection:
 * it carries a persisted, resolvable agent reference (§10).
 */
export function validateSchedules(snapshot: DomainSnapshot): DomainViolation[] {
	const { agentById, agentByDir } = buildIndexes(snapshot);
	const violations: DomainViolation[] = [];
	for (const schedule of snapshot.schedules ?? []) {
		const subject = schedule.scheduleId;
		if (schedule.agentId !== undefined) {
			const agent = agentById.get(schedule.agentId);
			if (!agent) {
				violations.push({
					rule: "schedule.agent-missing",
					subject,
					message: `agentId "${schedule.agentId}" is not a known Agent`,
				});
			} else if (!agent.enabled) {
				violations.push({
					rule: "schedule.agent-disabled",
					subject,
					message: `agentId "${schedule.agentId}" is disabled`,
				});
			}
			continue;
		}
		if (schedule.agentDir === undefined || !agentByDir.has(normalizePath(schedule.agentDir))) {
			violations.push({
				rule: "schedule.agent-unresolved",
				subject,
				message: schedule.agentDir
					? `agentDir "${schedule.agentDir}" matches no registered Agent`
					: "schedule carries neither agentId nor a resolvable agentDir; a firing schedule must not fall back to the current UI selection (§10)",
			});
		}
	}
	return violations;
}

/**
 * AgentTodo ownership and references (§37 D4). The Agent owns the Todo; a Project
 * is only its context; the sessions that advanced it must belong to the same Agent.
 */
export function validateAgentTodos(snapshot: DomainSnapshot): DomainViolation[] {
	const { agentById, projectById, sessionById } = buildIndexes(snapshot);
	const violations: DomainViolation[] = [];
	for (const todo of snapshot.todos ?? []) {
		const subject = todo.id;
		const agent = agentById.get(todo.agentId);
		if (!agent) {
			violations.push({
				rule: "todo.agent-missing",
				subject,
				message: `agentId "${todo.agentId}" is not a known Agent; an AgentTodo's agentId is required (§37 D4)`,
			});
		} else if (!agent.enabled) {
			violations.push({
				rule: "todo.agent-disabled",
				subject,
				message: `agentId "${todo.agentId}" is disabled`,
			});
		}
		if (todo.projectId !== undefined) {
			if (!projectById.has(todo.projectId)) {
				violations.push({
					rule: "todo.project-missing",
					subject,
					message: `projectId "${todo.projectId}" is not a known Project`,
				});
			}
			violations.push(...checkProjectBinding(agent, todo.projectId, subject));
		}

		for (const ref of todo.sessionRefs) {
			const session = sessionById.get(ref);
			if (!session) {
				violations.push({
					rule: "todo.session-ref-missing",
					subject,
					message: `sessionRef "${ref}" is not in the snapshot`,
				});
				continue;
			}
			if (session.agentId !== todo.agentId) {
				violations.push({
					rule: "todo.session-ref-agent-mismatch",
					subject,
					message: `sessionRef "${ref}" belongs to agent "${session.agentId}", not the owning agent "${todo.agentId}"`,
				});
				continue;
			}
			if (todo.projectId !== undefined && session.projectId !== todo.projectId) {
				violations.push({
					rule: "todo.session-ref-project-mismatch",
					subject,
					message: `sessionRef "${ref}" ran in project ${describeId(session.projectId)}, not the Todo's project "${todo.projectId}"`,
				});
			}
		}
	}
	return violations;
}

/** A ContextItem is session-scoped: it cannot outlive the session that referenced it. */
export function validateContextItems(snapshot: DomainSnapshot): DomainViolation[] {
	const { sessionById } = buildIndexes(snapshot);
	const violations: DomainViolation[] = [];
	for (const item of snapshot.contextItems ?? []) {
		if (!sessionById.has(item.ownerSessionId)) {
			violations.push({
				rule: "context-item.owner-missing",
				subject: item.contextItemId,
				message: `ownerSessionId "${item.ownerSessionId}" is not in the snapshot`,
			});
		}
	}
	return violations;
}

/**
 * The Agent Todo board must never be the Project TODO file (§9: one file, one
 * concept; no double write, no context-dependent choice of "which TODO.md").
 *
 * The AgentTodo store is still undecided (§37), so this rule is inert until a caller
 * declares both paths — at which point choosing the same file is the error.
 */
export function validateTodoBoardPaths(snapshot: DomainSnapshot): DomainViolation[] {
	const board = snapshot.todoBoardPaths;
	if (!board?.agentBoard || !board.projectBoard) return [];
	if (normalizePath(board.agentBoard) !== normalizePath(board.projectBoard)) return [];
	return [
		{
			rule: "todo.board-collision",
			subject: board.agentBoard,
			message: `the Agent Todo board and the Project TODO resolve to the same file "${board.agentBoard}"; they are different concepts with different owners (§9, §37)`,
		},
	];
}

/** Legal AgentTodo lifecycle. Same → same is a legal no-op; terminal states are terminal. */
const AGENT_TODO_TRANSITIONS: Record<AgentTodoStatus, readonly AgentTodoStatus[]> = {
	open: ["open", "in_progress", "completed", "cancelled"],
	in_progress: ["open", "in_progress", "completed", "cancelled"],
	completed: ["completed"],
	cancelled: ["cancelled"],
};

/**
 * A Todo is completed by an explicit actor, never by a Session reaching a terminal
 * status: session end does not complete a Todo (§37).
 */
export function validateAgentTodoTransition(
	todoId: string,
	from: AgentTodoStatus,
	to: AgentTodoStatus,
): DomainViolation | null {
	if (AGENT_TODO_TRANSITIONS[from].includes(to)) return null;
	return {
		rule: "todo.status-transition",
		subject: todoId,
		message: `illegal AgentTodo transition ${from} → ${to}`,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Aggregate
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run every rule over one snapshot.
 *
 * Use only when the snapshot is complete for the concepts it declares — see the
 * failure model at the top of this file and prefer the narrow validators when a
 * caller holds a partial view.
 */
export function validateDomain(snapshot: DomainSnapshot): DomainViolation[] {
	return [
		...validateAgents(snapshot),
		...validateProjects(snapshot),
		...validateSessionTree(snapshot),
		...validateWorkspaceContexts(snapshot),
		...validateSchedules(snapshot),
		...validateAgentTodos(snapshot),
		...validateContextItems(snapshot),
		...validateTodoBoardPaths(snapshot),
	];
}
