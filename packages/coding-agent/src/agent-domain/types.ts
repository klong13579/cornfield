/**
 * Agent-first domain vocabulary and read models (WP1 contract).
 *
 * Concept sources — do not re-derive these elsewhere:
 *   - `docs/proma-comparison/architecture-comparison-proma-diagnosis.md`
 *     §1 核心决策, §6 Session 树与 Worker, §9 TODO 双层与 Agent 绑定,
 *     §10 Default Agent 解析, §37 D4 Todo 归属 Agent, §38 复用优先复核
 *   - `docs/proma-comparison/wp1-agent-domain-contract.md` — owner scope / authority
 *     table and the rule list that `./relations` implements.
 *
 * What this module is:
 *   - The vocabulary: Agent, AgentDir, Project, WorkspaceContext, Session, Schedule,
 *     Worker, ContextItem, AgentTodo.
 *   - Read models (`DomainSnapshot` + records) consumed by the relation validators.
 *
 * What it deliberately is NOT (WP1 gate):
 *   - No store, no schema, no migration, no runtime, no process supervision.
 *   - No second Session Todo — Session Todo is the existing `todo` tool; its types
 *     are re-exported from `../tools/todo-write` at the bottom of this file.
 *   - No second Agent runtime, Session store or intercom broker.
 *   - `WorkspaceContext` is derived per (Agent, Project): it has no id and no store.
 *   - `Worker` is a view over a child `SessionNode`, never a persisted entity.
 *
 * Every record here is a *projection* built from the authority named in
 * `DOMAIN_AUTHORITY`. Nothing in this file defines a new place for a fact to live.
 */

import type { WorkspacePermissionMode } from "../skeleton/workspace";

// ─────────────────────────────────────────────────────────────────────────────
// Concepts, owners and authorities (§11 Phase 0: "标出 owner scope 和权威存储来源")
// ─────────────────────────────────────────────────────────────────────────────

/** Every concept Phase 0 requires a defined owner and authority for. */
export type DomainConcept =
	| "agent"
	| "agentDir"
	| "project"
	| "workspaceContext"
	| "session"
	| "sessionTree"
	| "schedule"
	| "worker"
	| "contextItem"
	| "agentTodo"
	| "sessionTodo"
	| "projectTodo";

/** Which layer owns the truth of a concept. */
export type DomainOwner =
	/** Client-level: survives every session and process. */
	| "client"
	/** Agent-level: owned by one Agent, shared across its sessions/projects. */
	| "agent"
	/** Session-level: born and dies with one session. */
	| "session"
	/** Derived: computed from other concepts, never stored on its own. */
	| "derived"
	/** Owned outside this client (filesystem, gateway, DingTalk). */
	| "external";

export interface ConceptAuthority {
	owner: DomainOwner;
	/** Where the truth lives today, or `null` when no store exists yet. */
	authority: string | null;
	/** Work package that must land the missing store. */
	pending?: string;
}

/**
 * Owner scope + authoritative store for each concept.
 *
 * `Record<DomainConcept, …>` is intentional: adding a concept without stating its
 * owner and authority is a compile error, so the table cannot silently drift.
 */
export const DOMAIN_AUTHORITY: Record<DomainConcept, ConceptAuthority> = {
	agent: {
		owner: "client",
		authority:
			"thin index ~/.cornfield/agent/registry.json (name → path) + declaration <agentDir>/.cornfield/workspace.json (schema v2)",
	},
	agentDir: {
		owner: "external",
		authority: "the filesystem; the path is an Agent's physical home, not a business concept",
	},
	project: {
		owner: "client",
		authority: null,
		pending: "WP4 — today a Project is only implicit in a session's cwd / git toplevel",
	},
	workspaceContext: {
		owner: "derived",
		authority: null,
		pending: "WP4 — resolved per (Agent, Project); never persisted as a top-level object",
	},
	session: {
		owner: "agent",
		authority:
			"session JSONL header (SessionHeader) — ~/.cornfield/agent/sessions/<encoded-cwd>/by-date/ for the default agent, <agentDir>/sessions/ for registry agents (by-date/ when serve writes, flat <safeConvId>.jsonl when the gateway writes)",
	},
	sessionTree: {
		owner: "session",
		authority:
			"partially: SessionHeader.parentSession holds an inconsistent parent reference (a session id on fork, a session file path on branch — SessionInfo reads it as parentSessionPath); depth/rootSessionId/agentId are not persisted at all",
		pending: "WP7/WP8 — persist the full tree node",
	},
	schedule: {
		owner: "client",
		authority:
			"gateway scheduler: task definitions under ~/.cornfield/gateway-data/scheduler/tasks/ (*.json5) + runtime state in the scheduler storage",
	},
	worker: {
		owner: "derived",
		authority: null,
		pending: "never persisted — a Worker is a child Session plus its assignment edge",
	},
	contextItem: {
		owner: "session",
		authority: "session JSONL entries (file mentions) + the session artifacts store",
	},
	agentTodo: {
		owner: "agent",
		authority:
			"`<agentDir>/.cornfield/agent-todos.json` (WP10, structured — §9's Markdown `<agentDir>/TODO.md` was rejected as lossy): one Agent owns its board, `projectId` is an optional binding and the Project owns nothing. Never `<projectRoot>/TODO.md` — that is `projectTodo`",
	},
	sessionTodo: {
		owner: "session",
		authority:
			"session JSONL — `todo` tool result details and `user_todo_edit` custom entries; owned by ../tools/todo-write.ts",
	},
	projectTodo: {
		owner: "client",
		authority: "<projectRoot>/TODO.md, maintained by the `project-todo` skill; never written by a session todo",
	},
};

// ─────────────────────────────────────────────────────────────────────────────
// Identifiers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stable identifiers. These are plain string aliases (the repo does not brand ids);
 * they exist so a signature states *which* id it takes instead of a bare `string`.
 */
export type AgentId = string;
export type ProjectId = string;
export type SessionId = string;
export type AgentTodoId = string;

// ─────────────────────────────────────────────────────────────────────────────
// Agent / AgentDir
// ─────────────────────────────────────────────────────────────────────────────

/**
 * An Agent is the long-lived digital employee: identity, configuration, model
 * policy, permissions, long-term memory and global Skills. It may serve several
 * Projects (§1).
 *
 * This is the read-model projection of the registry entry plus the agentDir
 * declaration — it is not a second profile format. `agentId` is the registry key.
 */
export interface AgentRecord {
	agentId: AgentId;
	/** Absolute path to the agentDir (Agent's physical home). */
	agentDir: string;
	displayName: string;
	/** Lifecycle flag required by the default-agent candidate check (§10). */
	enabled: boolean;
	/**
	 * Projects this Agent is bound to. Absent means "no declared bindings", which
	 * the relation validators read as *unconstrained* (§10 "Project binding 有效").
	 */
	projectIds?: readonly ProjectId[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Project
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A Project is the business/code/file context: a boundary, not an owner. It can be
 * served by several Agents and owns no Agent, Session or Todo (§1, §37).
 */
export interface ProjectRecord {
	projectId: ProjectId;
	/** Absolute project root (the git toplevel for code projects). */
	root: string;
	name: string;
	/** Input to default-agent resolution, below `session.agentId` (§10). */
	defaultAgentId?: AgentId;
}

// ─────────────────────────────────────────────────────────────────────────────
// WorkspaceContext
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The effective working context of one Agent on one Project: which config,
 * permissions, skills and memory are in force for a session started there (§1).
 *
 * Derived, never stored: there is no `workspaceContextId` and no declaration file.
 * If a field here disagrees with the Agent or Project it was derived from, the
 * derivation is wrong — see `./relations`.
 */
export interface WorkspaceContext {
	agentId: AgentId;
	/** Must equal the Agent's agentDir; a mismatch means the context is stale. */
	agentDir: string;
	projectId?: ProjectId;
	/** Must equal the Project's root when `projectId` is set. */
	projectRoot?: string;
	/** Working directory the session will run in. */
	cwd: string;
	/** Agent-scoped model/config source, e.g. `<agentDir>/.cornfield/config.yml`. */
	modelConfigPath: string;
	permissionMode?: WorkspacePermissionMode;
	skillsDir?: string;
	memoryDir?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Session / Session tree / Worker
// ─────────────────────────────────────────────────────────────────────────────

export type SessionKind = "root" | "child";

/**
 * Lifecycle of one session tree node. Terminal states are never reopened — a
 * follow-up is a new node. `waiting_user` is the operator pause, not a failure.
 */
export type SessionStatus = "running" | "waiting_user" | "completed" | "failed" | "cancelled";

/**
 * Execution policy of a *formal* session.
 *
 * Exactly one member, on purpose: §38 removed `in-process` as a Session policy.
 * A formal Child Session is an isolated cornfield process; in-process work stays
 * what it already is — the existing subagent Task (`runSubprocess` + IRC), which
 * never enters the session tree. Use `isSessionExecutionPolicy` at data boundaries.
 */
export type SessionExecutionPolicy = "isolated-process";

/**
 * One node of the persisted session tree (§6). The tree is stored, never
 * reconstructed by the UI: `parentSessionId`, `rootSessionId` and `depth` are
 * facts of the session, not display state.
 */
export interface SessionNode {
	sessionId: SessionId;
	/** Resolved at creation and persisted; never re-derived from a UI selection (§10). */
	agentId: AgentId;
	/** The Project this session works on. Session Todo and Project TODO stay separate. */
	projectId?: ProjectId;
	/** Absent exactly for `kind: "root"`. */
	parentSessionId?: SessionId;
	/** Equals `sessionId` for a root; otherwise the root ancestor's id. */
	rootSessionId: SessionId;
	/** Distance from the root; a root has depth 0. */
	depth: number;
	kind: SessionKind;
	status: SessionStatus;
	executionPolicy: SessionExecutionPolicy;
	/**
	 * Opaque label the parent assigned to this delegation (e.g. a squad task id).
	 * Set exactly on delegated children; the client never interprets it.
	 */
	delegationRole?: string;
	/** What this session was started to do. */
	objective?: string;
	/** Reference to the result artifact/record once produced. */
	resultRef?: string;
	/** When the result was brought back to the parent — distinct from `resultRef` (§6). */
	resultBroughtBackAt?: number;
}

/**
 * A Worker is `AgentSession + TaskAssignment + ParentEdge + ExecutionPolicy` (§1),
 * i.e. a *view* over a delegated child session — not an entity and not a second
 * runtime. `Pick` is used so it cannot drift from the node it is read from.
 */
export type WorkerView = Pick<
	SessionNode,
	"sessionId" | "parentSessionId" | "delegationRole" | "objective" | "executionPolicy"
>;

// ─────────────────────────────────────────────────────────────────────────────
// Schedule
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A Schedule is the *rule* that creates a Root Session, not the session itself (§1).
 *
 * A schedule firing must not consult whatever the UI currently has selected (§10):
 * it carries a persisted, resolvable agent reference. `agentId` is the contract;
 * `agentDir` is the gateway's today-shape (`ScheduledTask.agentDir`, which replaced
 * the deprecated `accountId`) and must resolve to exactly one registered Agent.
 * Legacy `accountId` mapping is the WP2 compat layer's job, not this validator's.
 */
export interface ScheduleRecord {
	scheduleId: string;
	agentId?: AgentId;
	agentDir?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// ContextItem
// ─────────────────────────────────────────────────────────────────────────────

export type ContextItemKind = "file" | "selection" | "artifact" | "url";

/** Something a session referenced. Session-scoped: the owner session is required. */
export interface ContextItem {
	contextItemId: string;
	ownerSessionId: SessionId;
	kind: ContextItemKind;
	/** File path, selection handle, artifact ref or URL, per `kind`. */
	value: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// AgentTodo (§37 D4)
// ─────────────────────────────────────────────────────────────────────────────

export type AgentTodoStatus = "open" | "in_progress" | "completed" | "cancelled";
export type AgentTodoPriority = "low" | "medium" | "high";
export type AgentTodoSource = "agent" | "user" | "schedule" | "session";

/** Minimal reminder marker; notification scheduling is a later work package. */
export interface AgentTodoReminder {
	/** Epoch milliseconds at which the reminder fires. */
	at: number;
}

/**
 * A long-lived todo owned by exactly one Agent, optionally bound to one Project
 * (§37 D4). Notes on the relation semantics:
 *
 *   - A Session advances a Todo; a finished Session never completes a Todo.
 *   - A Schedule may trigger a Todo-related Session; it is not the Todo.
 *   - A Project is only the Todo's business context — it never owns one.
 *   - This is NOT the session `todo` tool (see `Session Todo` below) and NOT the
 *     project board `<projectRoot>/TODO.md`. Writing one Todo into either is the
 *     double-write the contract forbids; see `validateTodoBoardPaths`.
 */
export interface AgentTodo {
	id: AgentTodoId;
	/** Required owner — this is the field that makes the Todo an Agent Todo. */
	agentId: AgentId;
	/** Optional binding; `undefined` means a project-agnostic Todo. */
	projectId?: ProjectId;
	title: string;
	notes?: string;
	status: AgentTodoStatus;
	priority: AgentTodoPriority;
	dueAt?: number;
	reminders?: readonly AgentTodoReminder[];
	/** Sessions that advanced this Todo, newest first. */
	sessionRefs: readonly SessionId[];
	source: AgentTodoSource;
	createdAt: number;
	updatedAt: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The read model the relation validators judge.
 *
 * A snapshot declares facts; it is not a store and has no persistence. Each
 * validator judges only the collections it names — an *omitted* collection is read
 * as "nothing exists", not as "unknown", so a caller holding a partial view must
 * call only the validators it can answer (see `./relations`).
 */
export interface DomainSnapshot {
	agents: readonly AgentRecord[];
	projects: readonly ProjectRecord[];
	sessions: readonly SessionNode[];
	workspaceContexts?: readonly WorkspaceContext[];
	schedules?: readonly ScheduleRecord[];
	todos?: readonly AgentTodo[];
	contextItems?: readonly ContextItem[];
	/**
	 * Both paths must be declared for the board-collision rule to run. WP10 settled the Agent
	 * side (`<agentDir>/.cornfield/agent-todos.json`), so the two cannot collide through the
	 * store; the rule stays for callers that declare paths of their own.
	 */
	todoBoardPaths?: { agentBoard?: string; projectBoard?: string };
}

// ─────────────────────────────────────────────────────────────────────────────
// Session Todo — the existing capability, re-exported so no second one is built
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Session Todo is already implemented: the `todo` tool (`../tools/todo-write.ts`)
 * persists phases/tasks in the session JSONL (`todo` tool result details, plus
 * `user_todo_edit` custom entries) and is rendered inside the session.
 *
 * §38: 原样复用. These re-exports exist so consumers reach for the existing types
 * instead of defining a parallel `SessionTodo` shape. Type-only — erased at runtime.
 * The `project-todo` skill explicitly refuses to touch these ("different system
 * with different storage").
 */
export type { TodoItem, TodoPhase, TodoStatus } from "../tools/todo-write";
