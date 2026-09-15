/**
 * Agent-first domain contract (WP1) — relation validation.
 *
 * Guards the contract that later work packages consume:
 *   - every illegal relation the design names is detected (session tree, schedule
 *     agent binding, Agent Todo ownership, derived WorkspaceContext);
 *   - Session Todo is not redefined here — the module's runtime surface stays
 *     contract-only (see the export-surface test at the bottom);
 *   - no store, no runtime, no second Agent runtime / session store / broker.
 */

import { describe, expect, test } from "bun:test";

import * as domain from "../src/agent-domain";
import {
	type AgentRecord,
	type AgentTodo,
	type DomainSnapshot,
	type DomainViolation,
	isSessionExecutionPolicy,
	type ProjectRecord,
	type SessionNode,
	validateAgents,
	validateAgentTodos,
	validateAgentTodoTransition,
	validateContextItems,
	validateDomain,
	validateProjects,
	validateSchedules,
	validateSessionTree,
	validateTodoBoardPaths,
	validateWorkspaceContexts,
} from "../src/agent-domain";

const AGENT_DIR = "/home/me/.cornfield/agents/hr";
const PROJECT_ROOT = "/repo/cornfield";

function makeAgent(overrides: Partial<AgentRecord> = {}): AgentRecord {
	return { agentId: "hr", agentDir: AGENT_DIR, displayName: "HR Agent", enabled: true, ...overrides };
}

function makeProject(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
	return { projectId: "cornfield", root: PROJECT_ROOT, name: "Cornfield", ...overrides };
}

function makeRootSession(overrides: Partial<SessionNode> = {}): SessionNode {
	return {
		sessionId: "s-root",
		agentId: "hr",
		projectId: "cornfield",
		rootSessionId: "s-root",
		depth: 0,
		kind: "root",
		status: "running",
		executionPolicy: "isolated-process",
		...overrides,
	};
}

function makeChildSession(overrides: Partial<SessionNode> = {}): SessionNode {
	return {
		sessionId: "s-child",
		agentId: "hr",
		projectId: "cornfield",
		parentSessionId: "s-root",
		rootSessionId: "s-root",
		depth: 1,
		kind: "child",
		status: "running",
		executionPolicy: "isolated-process",
		delegationRole: "T1",
		...overrides,
	};
}

function makeTodo(overrides: Partial<AgentTodo> = {}): AgentTodo {
	return {
		id: "todo-1",
		agentId: "hr",
		title: "整理招聘看板",
		status: "open",
		priority: "medium",
		sessionRefs: [],
		source: "user",
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

function makeSnapshot(overrides: Partial<DomainSnapshot> = {}): DomainSnapshot {
	return { agents: [makeAgent()], projects: [makeProject()], sessions: [], ...overrides };
}

function rules(violations: readonly DomainViolation[]): string[] {
	return violations.map(violation => violation.rule);
}

describe("validateAgents", () => {
	test("accepts a well-formed agent", () => {
		expect(validateAgents(makeSnapshot())).toEqual([]);
	});

	test("rejects a relative agentDir", () => {
		const violations = validateAgents(makeSnapshot({ agents: [makeAgent({ agentDir: "agents/hr" })] }));
		expect(rules(violations)).toEqual(["agent.dir-not-absolute"]);
	});

	test("rejects one agentDir owned by two agents", () => {
		const violations = validateAgents(
			makeSnapshot({
				agents: [makeAgent(), makeAgent({ agentId: "software" })],
			}),
		);
		expect(rules(violations)).toEqual(["agent.dir-shared"]);
		expect(violations[0]?.message).toContain('"hr"');
	});

	test("compares agentDirs modulo separators and trailing slash", () => {
		const violations = validateAgents(
			makeSnapshot({ agents: [makeAgent(), makeAgent({ agentId: "software", agentDir: `${AGENT_DIR}/` })] }),
		);
		expect(rules(violations)).toEqual(["agent.dir-shared"]);
	});

	test("rejects a duplicated agentId", () => {
		const violations = validateAgents(makeSnapshot({ agents: [makeAgent(), makeAgent()] }));
		expect(rules(violations)).toEqual(["snapshot.id-duplicated"]);
	});
});

describe("validateProjects", () => {
	test("accepts a project without a default agent", () => {
		expect(validateProjects(makeSnapshot())).toEqual([]);
	});

	test("rejects a default agent that does not exist", () => {
		const violations = validateProjects(makeSnapshot({ projects: [makeProject({ defaultAgentId: "ghost" })] }));
		expect(rules(violations)).toEqual(["project.default-agent-missing"]);
	});

	test("rejects a disabled default agent", () => {
		const violations = validateProjects(
			makeSnapshot({ agents: [makeAgent({ enabled: false })], projects: [makeProject({ defaultAgentId: "hr" })] }),
		);
		expect(rules(violations)).toEqual(["project.default-agent-disabled"]);
	});

	test("rejects a relative project root", () => {
		const violations = validateProjects(makeSnapshot({ projects: [makeProject({ root: "cornfield" })] }));
		expect(rules(violations)).toEqual(["project.root-not-absolute"]);
	});
});

describe("validateSessionTree", () => {
	test("accepts a root with a delegated child", () => {
		const snapshot = makeSnapshot({ sessions: [makeRootSession(), makeChildSession()] });
		expect(validateSessionTree(snapshot)).toEqual([]);
	});

	test("rejects a child without a parent", () => {
		const snapshot = makeSnapshot({ sessions: [{ ...makeChildSession(), parentSessionId: undefined }] });
		expect(rules(validateSessionTree(snapshot))).toEqual(["session.parent-undeclared"]);
	});

	test("rejects a session that is its own parent", () => {
		const snapshot = makeSnapshot({
			sessions: [makeChildSession({ parentSessionId: "s-child", rootSessionId: "s-child" })],
		});
		expect(rules(validateSessionTree(snapshot))).toEqual(["session.parent-self"]);
	});

	test("rejects an unknown parent without cascading into derived relations", () => {
		const snapshot = makeSnapshot({ sessions: [makeChildSession({ parentSessionId: "ghost" })] });
		expect(rules(validateSessionTree(snapshot))).toEqual(["session.parent-missing"]);
	});

	test("reports a two-node cycle exactly once and terminates", () => {
		const snapshot = makeSnapshot({
			sessions: [
				makeChildSession({ sessionId: "s-a", parentSessionId: "s-b", rootSessionId: "s-a", depth: 1 }),
				makeChildSession({ sessionId: "s-b", parentSessionId: "s-a", rootSessionId: "s-a", depth: 2 }),
			],
		});
		const violations = validateSessionTree(snapshot);
		expect(violations.filter(violation => violation.rule === "session.cycle")).toHaveLength(1);
	});

	test("rejects a depth that does not follow the parent", () => {
		const snapshot = makeSnapshot({ sessions: [makeRootSession(), makeChildSession({ depth: 3 })] });
		expect(rules(validateSessionTree(snapshot))).toEqual(["session.depth-mismatch"]);
	});

	test("rejects a child whose root differs from the parent's root", () => {
		const snapshot = makeSnapshot({
			sessions: [makeRootSession(), makeChildSession({ rootSessionId: "s-other" })],
		});
		expect(rules(validateSessionTree(snapshot))).toEqual(["session.root-mismatch"]);
	});

	test("rejects a child in another agent than its parent", () => {
		const snapshot = makeSnapshot({
			agents: [makeAgent(), makeAgent({ agentId: "software", agentDir: "/home/me/.cornfield/agents/sw" })],
			sessions: [makeRootSession(), makeChildSession({ agentId: "software" })],
		});
		expect(rules(validateSessionTree(snapshot))).toEqual(["session.parent-agent-mismatch"]);
	});

	test("rejects a child in another project than its parent", () => {
		const snapshot = makeSnapshot({
			projects: [makeProject(), makeProject({ projectId: "dtc", root: "/repo/dtc" })],
			sessions: [makeRootSession(), makeChildSession({ projectId: "dtc" })],
		});
		expect(rules(validateSessionTree(snapshot))).toEqual(["session.parent-project-mismatch"]);
	});

	test("rejects a session that declares a parent but is not a child", () => {
		const snapshot = makeSnapshot({
			sessions: [
				makeRootSession(),
				makeRootSession({ sessionId: "s-b", parentSessionId: "s-root", depth: 1, rootSessionId: "s-root" }),
			],
		});
		expect(rules(validateSessionTree(snapshot))).toEqual(["session.kind-mismatch"]);
	});

	test("rejects a root with a non-zero depth or a foreign rootSessionId", () => {
		const snapshot = makeSnapshot({
			sessions: [makeRootSession({ depth: 2, rootSessionId: "s-elsewhere" })],
		});
		const violations = validateSessionTree(snapshot);
		expect(rules(violations)).toEqual(["session.root-invalid"]);
		expect(violations[0]?.message).toContain("depth is 2");
	});

	test("rejects a delegated root — a Worker is always a child", () => {
		const snapshot = makeSnapshot({ sessions: [makeRootSession({ delegationRole: "T1" })] });
		expect(rules(validateSessionTree(snapshot))).toEqual(["session.delegated-root"]);
	});

	test("rejects a result brought back before it exists", () => {
		const snapshot = makeSnapshot({ sessions: [makeRootSession({ resultBroughtBackAt: 1 })] });
		expect(rules(validateSessionTree(snapshot))).toEqual(["session.result-not-ready"]);
	});

	test("accepts a result that is ready and brought back", () => {
		const snapshot = makeSnapshot({
			sessions: [makeRootSession({ resultRef: "artifact://r1", resultBroughtBackAt: 1 })],
		});
		expect(validateSessionTree(snapshot)).toEqual([]);
	});

	test("rejects a session of an unknown or disabled agent", () => {
		const unknown = makeSnapshot({ agents: [], sessions: [makeRootSession()] });
		expect(rules(validateSessionTree(unknown))).toEqual(["session.agent-missing"]);

		const disabled = makeSnapshot({ agents: [makeAgent({ enabled: false })], sessions: [makeRootSession()] });
		expect(rules(validateSessionTree(disabled))).toEqual(["session.agent-disabled"]);
	});

	test("rejects a session bound to an unknown project", () => {
		const snapshot = makeSnapshot({ sessions: [makeRootSession({ projectId: "ghost" })] });
		expect(rules(validateSessionTree(snapshot))).toEqual(["session.project-missing"]);
	});
});

describe("validateWorkspaceContexts", () => {
	const base = {
		agentId: "hr",
		agentDir: AGENT_DIR,
		projectId: "cornfield",
		projectRoot: PROJECT_ROOT,
		cwd: `${PROJECT_ROOT}/packages/coding-agent`,
		modelConfigPath: `${AGENT_DIR}/.cornfield/config.yml`,
	};

	test("accepts a context derived from its agent and project", () => {
		expect(validateWorkspaceContexts(makeSnapshot({ workspaceContexts: [base] }))).toEqual([]);
	});

	test("rejects a context whose agentDir is not the agent's home", () => {
		const snapshot = makeSnapshot({ workspaceContexts: [{ ...base, agentDir: "/tmp/elsewhere" }] });
		expect(rules(validateWorkspaceContexts(snapshot))).toEqual(["workspace.agent-dir-mismatch"]);
	});

	test("rejects a context for an unknown or disabled agent", () => {
		const unknown = makeSnapshot({ agents: [], workspaceContexts: [base] });
		expect(rules(validateWorkspaceContexts(unknown))).toEqual(["workspace.agent-missing"]);

		const disabled = makeSnapshot({
			agents: [makeAgent({ enabled: false })],
			workspaceContexts: [base],
		});
		expect(rules(validateWorkspaceContexts(disabled))).toEqual(["workspace.agent-disabled"]);
	});

	test("rejects a projectRoot without a projectId", () => {
		const { projectId: _projectId, ...withoutProject } = base;
		const snapshot = makeSnapshot({ workspaceContexts: [withoutProject] });
		expect(rules(validateWorkspaceContexts(snapshot))).toEqual(["workspace.project-undeclared"]);
	});

	test("rejects a projectRoot that is not the project's root", () => {
		const snapshot = makeSnapshot({ workspaceContexts: [{ ...base, projectRoot: "/repo/other" }] });
		expect(rules(validateWorkspaceContexts(snapshot))).toEqual(["workspace.project-root-mismatch"]);
	});

	test("rejects a project outside the agent's declared bindings", () => {
		const snapshot = makeSnapshot({
			agents: [makeAgent({ projectIds: ["dtc"] })],
			workspaceContexts: [base],
		});
		expect(rules(validateWorkspaceContexts(snapshot))).toEqual(["agent.project-binding-violated"]);
	});

	test("rejects a context bound to an unknown project", () => {
		const snapshot = makeSnapshot({ projects: [], workspaceContexts: [base] });
		expect(rules(validateWorkspaceContexts(snapshot))).toEqual(["workspace.project-missing"]);
	});
});

describe("validateSchedules", () => {
	test("accepts a schedule carrying a resolvable agentId", () => {
		expect(validateSchedules(makeSnapshot({ schedules: [{ scheduleId: "daily", agentId: "hr" }] }))).toEqual([]);
	});

	test("accepts a legacy agentDir that resolves to one agent", () => {
		expect(validateSchedules(makeSnapshot({ schedules: [{ scheduleId: "daily", agentDir: AGENT_DIR }] }))).toEqual(
			[],
		);
	});

	test("rejects an agentId that does not exist, and a disabled one", () => {
		const unknown = makeSnapshot({ schedules: [{ scheduleId: "daily", agentId: "ghost" }] });
		expect(rules(validateSchedules(unknown))).toEqual(["schedule.agent-missing"]);

		const disabled = makeSnapshot({
			agents: [makeAgent({ enabled: false })],
			schedules: [{ scheduleId: "daily", agentId: "hr" }],
		});
		expect(rules(validateSchedules(disabled))).toEqual(["schedule.agent-disabled"]);
	});

	test("rejects a schedule that cannot resolve an agent without the UI selection", () => {
		const withoutBinding = makeSnapshot({ schedules: [{ scheduleId: "daily" }] });
		expect(rules(validateSchedules(withoutBinding))).toEqual(["schedule.agent-unresolved"]);

		const staleDir = makeSnapshot({ schedules: [{ scheduleId: "daily", agentDir: "/tmp/removed" }] });
		const violations = validateSchedules(staleDir);
		expect(rules(violations)).toEqual(["schedule.agent-unresolved"]);
		expect(violations[0]?.message).toContain("/tmp/removed");
	});
});

describe("validateAgentTodos", () => {
	const sessions = [makeRootSession()];

	test("accepts a todo advanced by a session of the same agent", () => {
		const snapshot = makeSnapshot({
			sessions,
			todos: [makeTodo({ projectId: "cornfield", sessionRefs: ["s-root"] })],
		});
		expect(validateAgentTodos(snapshot)).toEqual([]);
	});

	test("accepts a project-agnostic todo", () => {
		const snapshot = makeSnapshot({ sessions, todos: [makeTodo()] });
		expect(validateAgentTodos(snapshot)).toEqual([]);
	});

	test("rejects a todo whose owner agent is unknown or disabled", () => {
		const unknown = makeSnapshot({ agents: [], todos: [makeTodo()] });
		expect(rules(validateAgentTodos(unknown))).toEqual(["todo.agent-missing"]);

		const disabled = makeSnapshot({ agents: [makeAgent({ enabled: false })], todos: [makeTodo()] });
		expect(rules(validateAgentTodos(disabled))).toEqual(["todo.agent-disabled"]);
	});

	test("rejects a todo bound to an unknown project", () => {
		const snapshot = makeSnapshot({ todos: [makeTodo({ projectId: "ghost" })] });
		expect(rules(validateAgentTodos(snapshot))).toEqual(["todo.project-missing"]);
	});

	test("rejects a todo bound to a project outside the agent's bindings", () => {
		const snapshot = makeSnapshot({
			agents: [makeAgent({ projectIds: ["dtc"] })],
			todos: [makeTodo({ projectId: "cornfield" })],
		});
		expect(rules(validateAgentTodos(snapshot))).toEqual(["agent.project-binding-violated"]);
	});

	test("rejects a dangling sessionRef", () => {
		const snapshot = makeSnapshot({ sessions, todos: [makeTodo({ sessionRefs: ["s-ghost"] })] });
		expect(rules(validateAgentTodos(snapshot))).toEqual(["todo.session-ref-missing"]);
	});

	test("rejects a sessionRef owned by another agent", () => {
		const snapshot = makeSnapshot({
			agents: [makeAgent(), makeAgent({ agentId: "software", agentDir: "/home/me/.cornfield/agents/sw" })],
			sessions: [makeRootSession({ agentId: "software" })],
			todos: [makeTodo({ sessionRefs: ["s-root"] })],
		});
		expect(rules(validateAgentTodos(snapshot))).toEqual(["todo.session-ref-agent-mismatch"]);
	});

	test("rejects a sessionRef that ran outside the todo's project", () => {
		const snapshot = makeSnapshot({
			projects: [makeProject(), makeProject({ projectId: "dtc", root: "/repo/dtc" })],
			sessions: [makeRootSession({ projectId: "dtc" })],
			todos: [makeTodo({ projectId: "cornfield", sessionRefs: ["s-root"] })],
		});
		expect(rules(validateAgentTodos(snapshot))).toEqual(["todo.session-ref-project-mismatch"]);
	});
});

describe("validateAgentTodoTransition", () => {
	test("accepts the forward lifecycle", () => {
		expect(validateAgentTodoTransition("t", "open", "in_progress")).toBeNull();
		expect(validateAgentTodoTransition("t", "in_progress", "completed")).toBeNull();
		expect(validateAgentTodoTransition("t", "open", "cancelled")).toBeNull();
	});

	test("treats same → same as an idempotent no-op", () => {
		expect(validateAgentTodoTransition("t", "completed", "completed")).toBeNull();
		expect(validateAgentTodoTransition("t", "cancelled", "cancelled")).toBeNull();
	});

	test("rejects reopening a terminal todo", () => {
		const violation = validateAgentTodoTransition("todo-1", "completed", "open");
		expect(violation?.rule).toBe("todo.status-transition");
		expect(violation?.subject).toBe("todo-1");
		expect(validateAgentTodoTransition("t", "cancelled", "in_progress")?.rule).toBe("todo.status-transition");
	});
});

describe("validateContextItems", () => {
	test("accepts a context item owned by a known session", () => {
		const snapshot = makeSnapshot({
			sessions: [makeRootSession()],
			contextItems: [{ contextItemId: "c1", ownerSessionId: "s-root", kind: "file", value: "AGENTS.md" }],
		});
		expect(validateContextItems(snapshot)).toEqual([]);
	});

	test("rejects a context item whose owner session is gone", () => {
		const snapshot = makeSnapshot({
			contextItems: [{ contextItemId: "c1", ownerSessionId: "s-gone", kind: "file", value: "AGENTS.md" }],
		});
		expect(rules(validateContextItems(snapshot))).toEqual(["context-item.owner-missing"]);
	});
});

describe("validateTodoBoardPaths", () => {
	test("stays inert while the AgentTodo store is undecided", () => {
		expect(validateTodoBoardPaths(makeSnapshot())).toEqual([]);
		expect(
			validateTodoBoardPaths(makeSnapshot({ todoBoardPaths: { projectBoard: `${PROJECT_ROOT}/TODO.md` } })),
		).toEqual([]);
	});

	test("accepts two distinct boards", () => {
		const snapshot = makeSnapshot({
			todoBoardPaths: { agentBoard: `${AGENT_DIR}/TODO.md`, projectBoard: `${PROJECT_ROOT}/TODO.md` },
		});
		expect(validateTodoBoardPaths(snapshot)).toEqual([]);
	});

	test("rejects the AgentTodo board resolving to the Project TODO", () => {
		const snapshot = makeSnapshot({
			todoBoardPaths: { agentBoard: `${PROJECT_ROOT}/TODO.md`, projectBoard: `${PROJECT_ROOT}/TODO.md/` },
		});
		expect(rules(validateTodoBoardPaths(snapshot))).toEqual(["todo.board-collision"]);
	});
});

describe("isSessionExecutionPolicy", () => {
	test("accepts the only formal session policy", () => {
		expect(isSessionExecutionPolicy("isolated-process")).toBe(true);
	});

	test("rejects the removed in-process policy", () => {
		expect(isSessionExecutionPolicy("in-process")).toBe(false);
		expect(isSessionExecutionPolicy("")).toBe(false);
	});
});

describe("validateDomain", () => {
	test("accepts a consistent snapshot", () => {
		const snapshot = makeSnapshot({
			sessions: [makeRootSession(), makeChildSession()],
			workspaceContexts: [
				{
					agentId: "hr",
					agentDir: AGENT_DIR,
					projectId: "cornfield",
					projectRoot: PROJECT_ROOT,
					cwd: PROJECT_ROOT,
					modelConfigPath: `${AGENT_DIR}/.cornfield/config.yml`,
				},
			],
			schedules: [{ scheduleId: "daily", agentId: "hr" }],
			todos: [makeTodo({ projectId: "cornfield", sessionRefs: ["s-child"] })],
			contextItems: [{ contextItemId: "c1", ownerSessionId: "s-root", kind: "artifact", value: "artifact://a1" }],
			todoBoardPaths: { agentBoard: `${AGENT_DIR}/TODO.md`, projectBoard: `${PROJECT_ROOT}/TODO.md` },
		});
		expect(validateDomain(snapshot)).toEqual([]);
	});

	test("aggregates violations across concepts", () => {
		const snapshot = makeSnapshot({
			agents: [makeAgent({ agentDir: "relative/dir", enabled: false })],
			sessions: [makeRootSession({ projectId: "ghost" })],
			todos: [makeTodo({ projectId: "ghost", sessionRefs: ["s-ghost"] })],
			schedules: [{ scheduleId: "daily" }],
		});
		const found = rules(validateDomain(snapshot));
		expect(found).toContain("agent.dir-not-absolute");
		expect(found).toContain("session.agent-disabled");
		expect(found).toContain("session.project-missing");
		expect(found).toContain("todo.project-missing");
		expect(found).toContain("todo.session-ref-missing");
		expect(found).toContain("schedule.agent-unresolved");
	});
});

describe("public surface", () => {
	test("stays contract-only: no store, no runtime, no second Session Todo", () => {
		expect(Object.keys(domain).sort()).toEqual([
			"DOMAIN_AUTHORITY",
			"isSessionExecutionPolicy",
			"validateAgentTodoTransition",
			"validateAgentTodos",
			"validateAgents",
			"validateContextItems",
			"validateDomain",
			"validateProjects",
			"validateSchedules",
			"validateSessionTree",
			"validateTodoBoardPaths",
			"validateWorkspaceContexts",
		]);
	});

	test("declares an owner and an authority for every concept", () => {
		for (const [concept, authority] of Object.entries(domain.DOMAIN_AUTHORITY)) {
			expect(authority.authority !== null || authority.pending !== undefined).toBe(true);
			expect(concept.length).toBeGreaterThan(0);
		}
	});
});
