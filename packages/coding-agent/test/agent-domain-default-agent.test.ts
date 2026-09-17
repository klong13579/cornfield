/**
 * WP4 default-Agent resolution policy — the §10 chain and its candidate checks.
 *
 * Pure: everything is injected, so the cases below cover exactly the resolution rules
 * (precedence, the checks, no demotion on a broken declaration, WorkspaceContext
 * derivation) without touching disk or the registry.
 */

import { describe, expect, test } from "bun:test";
import {
	type AgentCandidateFacts,
	AgentSelectionError,
	DEFAULT_AGENT_PRECEDENCE,
	type DefaultAgentDeclarations,
	type DefaultAgentResolutionInput,
	type DefaultAgentSource,
	deriveWorkspaceContext,
	describeAgentSelectionFailure,
	describeAgentSource,
	isDefaultAgentSource,
	resolveDefaultAgent,
} from "@cornfield/coding-agent/agent-domain/default-agent";
import type { AgentRecord, ProjectRecord } from "@cornfield/coding-agent/agent-domain/types";
import { validateWorkspaceContexts } from "../src/agent-domain/relations";
import type { WorkspaceDeclaration } from "../src/skeleton/workspace";

const CWD = "/work/project";

function makeAgent(agentId: string, overrides: Partial<AgentRecord> = {}): AgentRecord {
	return {
		agentId,
		agentDir: `/agents/${agentId}`,
		displayName: agentId,
		enabled: true,
		...overrides,
	};
}

function facts(agent: AgentRecord, overrides: Partial<AgentCandidateFacts> = {}): AgentCandidateFacts {
	return { agent, modelAvailable: true, permissionAvailable: true, ...overrides };
}

function input(overrides: Partial<DefaultAgentResolutionInput> = {}): DefaultAgentResolutionInput {
	return {
		declarations: {},
		candidates: [facts(makeAgent("default"))],
		cwd: CWD,
		...overrides,
	};
}

describe("resolveDefaultAgent precedence (§10)", () => {
	test("walks session > project > workspace > user in that order", () => {
		const candidates = ["s", "p", "w", "u", "default"].map(id => facts(makeAgent(id)));
		const full = {
			sessionAgentId: "s",
			projectDefaultAgentId: "p",
			workspaceDefaultAgentId: "w",
			userDefaultAgentId: "u",
			bootstrapAgentId: "default",
		};

		// Drop the most specific declaration one rung at a time.
		const cases: Array<[Partial<DefaultAgentDeclarations>, string, DefaultAgentSource]> = [
			[{}, "s", "session"],
			[{ sessionAgentId: undefined }, "p", "project"],
			[{ sessionAgentId: undefined, projectDefaultAgentId: undefined }, "w", "workspace"],
			[
				{ sessionAgentId: undefined, projectDefaultAgentId: undefined, workspaceDefaultAgentId: undefined },
				"u",
				"user",
			],
			[
				{
					sessionAgentId: undefined,
					projectDefaultAgentId: undefined,
					workspaceDefaultAgentId: undefined,
					userDefaultAgentId: undefined,
				},
				"default",
				"bootstrap",
			],
		];
		for (const [override, expectedAgentId, expectedSource] of cases) {
			const result = resolveDefaultAgent(input({ declarations: { ...full, ...override }, candidates }));
			if (!result.ok) throw new Error(`expected a resolution, got ${result.failure.kind}`);
			expect(result.resolved.agent.agentId).toBe(expectedAgentId);
			expect(result.resolved.source).toBe(expectedSource);
		}
	});

	test("keeps the documented precedence order", () => {
		expect(DEFAULT_AGENT_PRECEDENCE).toEqual(["session", "project", "workspace", "user", "bootstrap"]);
	});

	test("bootstrap is not consulted while any scope declares an Agent", () => {
		const result = resolveDefaultAgent(
			input({
				declarations: { userDefaultAgentId: "u", bootstrapAgentId: "default" },
				candidates: [facts(makeAgent("u")), facts(makeAgent("default"))],
			}),
		);
		if (!result.ok) throw new Error("expected a resolution");
		expect(result.resolved.agent.agentId).toBe("u");
		expect(result.resolved.source).toBe("user");
	});

	test("a declared candidate is never silently demoted to a weaker scope", () => {
		const result = resolveDefaultAgent(
			input({
				declarations: { projectDefaultAgentId: "gone", userDefaultAgentId: "u" },
				candidates: [facts(makeAgent("u")), facts(makeAgent("default"))],
			}),
		);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.failure).toEqual({ kind: "agent-unknown", source: "project", agentId: "gone" });
	});

	test("a disabled declared candidate fails instead of falling through", () => {
		const result = resolveDefaultAgent(
			input({
				declarations: { projectDefaultAgentId: "hr", userDefaultAgentId: "u" },
				candidates: [facts(makeAgent("hr", { enabled: false })), facts(makeAgent("u"))],
			}),
		);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.failure).toEqual({ kind: "agent-disabled", source: "project", agentId: "hr" });
	});
});

describe("resolveDefaultAgent candidate checks (§10)", () => {
	test("unknown Agent is reported with the scope that named it", () => {
		const result = resolveDefaultAgent(input({ declarations: { sessionAgentId: "nope" } }));
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.failure).toEqual({ kind: "agent-unknown", source: "session", agentId: "nope" });
	});

	test("a probed-unusable model rejects the candidate", () => {
		const result = resolveDefaultAgent(
			input({
				declarations: { sessionAgentId: "hr" },
				candidates: [facts(makeAgent("hr"), { modelAvailable: false })],
			}),
		);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.failure).toEqual({
			kind: "agent-capability-unusable",
			source: "session",
			agentId: "hr",
			capability: "model",
		});
	});

	test("a probed-unusable permission rejects the candidate", () => {
		const result = resolveDefaultAgent(
			input({
				declarations: { sessionAgentId: "hr" },
				candidates: [facts(makeAgent("hr"), { permissionAvailable: false })],
			}),
		);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.failure).toEqual({
			kind: "agent-capability-unusable",
			source: "session",
			agentId: "hr",
			capability: "permission",
		});
	});

	test("an unprobed capability resolves but is reported as unverified", () => {
		const result = resolveDefaultAgent(
			input({
				declarations: { sessionAgentId: "hr" },
				candidates: [facts(makeAgent("hr"), { modelAvailable: "unknown", permissionAvailable: "unknown" })],
			}),
		);
		if (!result.ok) throw new Error("expected a resolution");
		expect(result.resolved.unverified).toEqual(["model", "permission"]);
	});

	test("reports only the capabilities nobody probed", () => {
		const result = resolveDefaultAgent(
			input({
				declarations: { sessionAgentId: "hr" },
				candidates: [facts(makeAgent("hr"), { modelAvailable: "unknown" })],
			}),
		);
		if (!result.ok) throw new Error("expected a resolution");
		expect(result.resolved.unverified).toEqual(["model"]);
	});

	test("no declaration and no bootstrap Agent fails explicitly", () => {
		const result = resolveDefaultAgent(input({ candidates: [] }));
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.failure).toEqual({ kind: "no-agent-declared", cwd: CWD });
	});
});

describe("resolveDefaultAgent Project binding", () => {
	const project: ProjectRecord = { projectId: "cornfield", root: "/work/project", name: "Cornfield" };

	test("an absent binding list means unconstrained", () => {
		const result = resolveDefaultAgent(
			input({ declarations: { sessionAgentId: "hr" }, candidates: [facts(makeAgent("hr"))], project }),
		);
		expect(result.ok).toBe(true);
	});

	test("a declared binding list is an upper bound", () => {
		const bound = makeAgent("hr", { projectIds: ["dtc"] });
		const result = resolveDefaultAgent(
			input({ declarations: { sessionAgentId: "hr" }, candidates: [facts(bound)], project }),
		);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.failure).toEqual({
			kind: "agent-project-binding-violated",
			source: "session",
			agentId: "hr",
			projectId: "cornfield",
		});
	});

	test("an empty binding list is still an upper bound (matches ./relations)", () => {
		const bound = makeAgent("hr", { projectIds: [] });
		const result = resolveDefaultAgent(
			input({ declarations: { sessionAgentId: "hr" }, candidates: [facts(bound)], project }),
		);
		expect(result.ok).toBe(false);
	});

	test("the binding check does not run without a Project", () => {
		const bound = makeAgent("hr", { projectIds: ["dtc"] });
		const result = resolveDefaultAgent(input({ declarations: { sessionAgentId: "hr" }, candidates: [facts(bound)] }));
		expect(result.ok).toBe(true);
	});

	test("a matching binding is accepted", () => {
		const bound = makeAgent("hr", { projectIds: ["cornfield"] });
		const result = resolveDefaultAgent(
			input({ declarations: { sessionAgentId: "hr" }, candidates: [facts(bound)], project }),
		);
		expect(result.ok).toBe(true);
	});
});

describe("deriveWorkspaceContext", () => {
	const declaration: WorkspaceDeclaration = {
		schemaVersion: 2,
		id: "hr",
		name: "HR",
		type: "agent",
		root: ".",
		projectRoot: ".",
		permissions: { mode: "plan" },
		skillsDir: ".cornfield/skills/",
		knowledge: { memoryDir: "memory/" },
	} as WorkspaceDeclaration;

	test("derives every field from the Agent, the Project and the declaration", () => {
		const agent = makeAgent("hr", { agentDir: "/agents/hr" });
		const project: ProjectRecord = { projectId: "cornfield", root: "/work/project", name: "Cornfield" };
		const context = deriveWorkspaceContext({
			agent,
			project,
			cwd: "/work/project/sub",
			workspaceDeclaration: declaration,
		});
		expect(context).toEqual({
			agentId: "hr",
			agentDir: "/agents/hr",
			projectId: "cornfield",
			projectRoot: "/work/project",
			cwd: "/work/project/sub",
			modelConfigPath: "/agents/hr/config.yml",
			permissionMode: "plan",
			skillsDir: "/agents/hr/.cornfield/skills",
			memoryDir: "/agents/hr/memory",
		});
	});

	test("omits Project fields when there is no Project", () => {
		const context = deriveWorkspaceContext({ agent: makeAgent("hr"), cwd: CWD });
		expect(context.projectId).toBeUndefined();
		expect(context.projectRoot).toBeUndefined();
		expect(context.permissionMode).toBeUndefined();
		expect(context.skillsDir).toBeUndefined();
		expect(context.memoryDir).toBeUndefined();
	});

	test("keeps absolute declaration paths", () => {
		const context = deriveWorkspaceContext({
			agent: makeAgent("hr", { agentDir: "/agents/hr" }),
			cwd: CWD,
			workspaceDeclaration: { ...declaration, skillsDir: "/shared/skills" },
		});
		expect(context.skillsDir).toBe("/shared/skills");
	});

	test("satisfies the WP1 workspace relation rules", () => {
		const agent = makeAgent("hr", { agentDir: "/agents/hr" });
		const project: ProjectRecord = { projectId: "cornfield", root: "/work/project", name: "Cornfield" };
		const context = deriveWorkspaceContext({ agent, project, cwd: CWD, workspaceDeclaration: declaration });
		expect(
			validateWorkspaceContexts({
				agents: [agent],
				projects: [project],
				sessions: [],
				workspaceContexts: [context],
			}),
		).toEqual([]);
	});
});

describe("failure descriptions and narrowing", () => {
	test("names the scope and the Agent", () => {
		const agents = [makeAgent("hr")];
		expect(
			describeAgentSelectionFailure({ kind: "agent-disabled", source: "project", agentId: "hr" }, agents),
		).toContain("The Project default Agent");
		expect(
			describeAgentSelectionFailure({ kind: "agent-unknown", source: "user", agentId: "gone" }, agents),
		).toContain("user-global");
		expect(describeAgentSelectionFailure({ kind: "no-agent-declared", cwd: CWD }, agents)).toContain("hr");
	});

	test("describeAgentSource covers every rung", () => {
		for (const source of DEFAULT_AGENT_PRECEDENCE) {
			expect(describeAgentSource(source).length).toBeGreaterThan(0);
		}
	});

	test("isDefaultAgentSource rejects anything else", () => {
		expect(isDefaultAgentSource("bootstrap")).toBe(true);
		expect(isDefaultAgentSource("ui-selection")).toBe(false);
		expect(isDefaultAgentSource(undefined)).toBe(false);
	});

	test("AgentSelectionError carries the structured failure", () => {
		const failure = { kind: "agent-unknown", source: "session", agentId: "gone" } as const;
		const error = new AgentSelectionError(failure, [makeAgent("hr")]);
		expect(error.failure).toEqual(failure);
		expect(error.message).toContain("gone");
		expect(error.name).toBe("AgentSelectionError");
	});
});
