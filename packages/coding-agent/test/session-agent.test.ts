/**
 * WP4 session ↔ Agent resolution: the composition (registry projection + Project store
 * + the process's own identity) and the session-header persistence it feeds.
 *
 * Uses real temp HOME/dirs and real files throughout — the point of these cases is that
 * resolution reads persisted facts and fails explicitly, which a mocked store would not
 * exercise.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadProjects, projectsFilePath, upsertProject } from "@cornfield/coding-agent/agent-domain/project-store";
import { validateWorkspaceContexts } from "@cornfield/coding-agent/agent-domain/relations";
import {
	readPersistedRef,
	resolveSessionAgent,
	SessionAgentError,
	type SessionAgentFailure,
	userConfigFilePath,
} from "@cornfield/coding-agent/session/session-agent";
import { type SessionHeader, SessionManager } from "@cornfield/coding-agent/session/session-manager";
import { registerAgent } from "@cornfield/coding-agent/skeleton/registry";

const ENV_KEYS = ["HOME", "CORNFIELD_CONFIG_DIR"] as const;

let home: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(async () => {
	savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	home = await fs.mkdtemp(path.join(os.tmpdir(), "cornfield-wp4-"));
	process.env.HOME = home;
	delete process.env.CORNFIELD_CONFIG_DIR;
});

afterEach(async () => {
	for (const key of ENV_KEYS) {
		const value = savedEnv[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	await fs.rm(home, { recursive: true, force: true });
});

/** Write a schema-v2 workspace declaration into an agentDir (registered or not). */
async function writeWorkspaceDeclaration(agentDir: string, declaration: Record<string, unknown> = {}): Promise<void> {
	await fs.mkdir(path.join(agentDir, ".cornfield"), { recursive: true });
	await Bun.write(
		path.join(agentDir, ".cornfield", "workspace.json"),
		`${JSON.stringify({
			schemaVersion: 2,
			id: path.basename(agentDir),
			name: path.basename(agentDir),
			type: "agent",
			root: ".",
			projectRoot: ".",
			skillsDir: ".cornfield/skills/",
			...declaration,
		})}\n`,
	);
}

/** Create an agentDir on disk and register it, so it is a live Agent. */
async function makeRegisteredAgent(
	agentId: string,
	displayName = agentId,
	declaration: Record<string, unknown> = {},
): Promise<string> {
	const agentDir = path.join(home, "agents", agentId);
	await fs.mkdir(agentDir, { recursive: true });
	await registerAgent(agentId, agentDir);
	await writeWorkspaceDeclaration(agentDir, { id: agentId, name: displayName, ...declaration });
	return agentDir;
}

/** Declare the client-wide default Agent in the user's own config.yml (§10 rung 4). */
async function setUserGlobalDefaultAgent(agentId: string): Promise<void> {
	const file = userConfigFilePath();
	await fs.mkdir(path.dirname(file), { recursive: true });
	await Bun.write(file, `user:\n  globalDefaultAgentId: ${agentId}\n`);
}

/** Write arbitrary content into the user's own config.yml. */
async function writeUserConfig(content: string): Promise<void> {
	const file = userConfigFilePath();
	await fs.mkdir(path.dirname(file), { recursive: true });
	await Bun.write(file, content);
}

async function failureOf(promise: Promise<unknown>): Promise<SessionAgentFailure> {
	try {
		await promise;
	} catch (err) {
		if (err instanceof SessionAgentError) return err.failure;
		throw err;
	}
	throw new Error("expected the resolution to fail");
}

describe("resolveSessionAgent bootstrap", () => {
	test("a bare process resolves to the client's own Agent identity", async () => {
		const cwd = path.join(home, "work");
		await fs.mkdir(cwd, { recursive: true });
		const processAgentDir = path.join(home, ".cornfield", "agent");

		const resolved = await resolveSessionAgent({ cwd, processAgentDir });

		expect(resolved.ref).toEqual({ agentId: "default", source: "bootstrap" });
		expect(resolved.origin).toBe("resolved");
		expect(resolved.workspaceContext.agentId).toBe("default");
		expect(resolved.workspaceContext.agentDir).toBe(processAgentDir);
		expect(resolved.workspaceContext.cwd).toBe(cwd);
		expect(resolved.unverified).toEqual(["model", "permission"]);
	});

	test("a process running inside a registered Agent's home resolves to that Agent", async () => {
		const agentDir = await makeRegisteredAgent("hr", "HR");
		const cwd = path.join(home, "work");
		await fs.mkdir(cwd, { recursive: true });

		const resolved = await resolveSessionAgent({ cwd, processAgentDir: agentDir });

		expect(resolved.ref.agentId).toBe("hr");
		expect(resolved.workspaceContext.skillsDir).toBe(path.join(agentDir, ".cornfield", "skills"));
	});
});

describe("resolveSessionAgent pins", () => {
	test("a caller pin is recorded with the session scope", async () => {
		const agentDir = await makeRegisteredAgent("hr");
		const cwd = path.join(home, "work");
		await fs.mkdir(cwd, { recursive: true });

		const resolved = await resolveSessionAgent({ cwd, processAgentDir: agentDir, pinnedAgentId: "hr" });
		expect(resolved.ref).toEqual({ agentId: "hr", source: "session" });
	});

	test("a pin for another Agent than this process fails instead of lying", async () => {
		const agentDir = await makeRegisteredAgent("hr");
		await makeRegisteredAgent("sw");
		const cwd = path.join(home, "work");
		await fs.mkdir(cwd, { recursive: true });

		const failure = await failureOf(resolveSessionAgent({ cwd, processAgentDir: agentDir, pinnedAgentId: "sw" }));
		expect(failure).toMatchObject({ kind: "agent-process-mismatch", agentId: "sw", processAgentId: "hr" });
	});

	test("a pin that contradicts the persisted header fails", async () => {
		const agentDir = await makeRegisteredAgent("hr");
		await makeRegisteredAgent("sw");
		const cwd = path.join(home, "work");
		await fs.mkdir(cwd, { recursive: true });

		const failure = await failureOf(
			resolveSessionAgent({
				cwd,
				processAgentDir: agentDir,
				pinnedAgentId: "sw",
				sessionHeader: { agentId: "hr", agentSource: "project" } as SessionHeader,
			}),
		);
		expect(failure).toEqual({ kind: "agent-session-conflict", pinnedAgentId: "sw", persistedAgentId: "hr" });
	});
});

describe("resolveSessionAgent Project defaults", () => {
	test("a Project default for this process's Agent is honored", async () => {
		const agentDir = await makeRegisteredAgent("hr");
		const cwd = path.join(home, "work");
		await fs.mkdir(cwd, { recursive: true });
		await upsertProject({ projectId: "hr-project", root: cwd, name: "HR", defaultAgentId: "hr" });

		const resolved = await resolveSessionAgent({ cwd, processAgentDir: agentDir });
		expect(resolved.ref).toEqual({ agentId: "hr", source: "project" });
		expect(resolved.workspaceContext.projectId).toBe("hr-project");
		expect(resolved.workspaceContext.projectRoot).toBe(cwd);
	});

	test("a Project default inside the Project finds the Project", async () => {
		const agentDir = await makeRegisteredAgent("hr");
		const root = path.join(home, "repo");
		const nested = path.join(root, "packages", "app");
		await fs.mkdir(nested, { recursive: true });
		await upsertProject({ projectId: "repo", root, name: "Repo", defaultAgentId: "hr" });

		const resolved = await resolveSessionAgent({ cwd: nested, processAgentDir: agentDir });
		expect(resolved.workspaceContext.projectId).toBe("repo");
		expect(resolved.workspaceContext.cwd).toBe(nested);
	});

	test("a Project default for another Agent names the launcher's mistake", async () => {
		const agentDir = await makeRegisteredAgent("hr");
		const otherDir = await makeRegisteredAgent("sw");
		const cwd = path.join(home, "work");
		await fs.mkdir(cwd, { recursive: true });
		await upsertProject({ projectId: "sw-project", root: cwd, name: "SW", defaultAgentId: "sw" });

		const failure = await failureOf(resolveSessionAgent({ cwd, processAgentDir: agentDir }));
		expect(failure).toMatchObject({ kind: "agent-process-mismatch", agentId: "sw", source: "project" });
		expect(failure).toMatchObject({ processAgentDir: agentDir });
		expect(otherDir).not.toBe(agentDir);
	});

	test("a Project default naming an unregistered Agent does not fall through to bootstrap", async () => {
		const agentDir = await makeRegisteredAgent("hr");
		const cwd = path.join(home, "work");
		await fs.mkdir(cwd, { recursive: true });
		await upsertProject({ projectId: "gone", root: cwd, name: "Gone", defaultAgentId: "unregistered" });

		const failure = await failureOf(resolveSessionAgent({ cwd, processAgentDir: agentDir }));
		expect(failure).toEqual({ kind: "agent-unknown", source: "project", agentId: "unregistered" });
	});
});

describe("resolveSessionAgent workspace and user-global defaults", () => {
	test("a workspace declaration wins over the user-global default", async () => {
		const agentDir = await makeRegisteredAgent("hr", "HR", { defaultAgentId: "hr" });
		await makeRegisteredAgent("sw");
		const cwd = path.join(home, "work");
		await fs.mkdir(cwd, { recursive: true });
		// A stronger-than-bootstrap answer exists on both new rungs; the workspace is rung 3.
		await setUserGlobalDefaultAgent("sw");

		const resolved = await resolveSessionAgent({ cwd, processAgentDir: agentDir });
		expect(resolved.ref).toEqual({ agentId: "hr", source: "workspace" });
		// The declaration is mirrored onto the context, which is what the relations rules read.
		expect(resolved.workspaceContext.defaultAgentId).toBe("hr");
	});

	test("the user-global default is honored when the workspace declares none", async () => {
		const agentDir = await makeRegisteredAgent("hr");
		const cwd = path.join(home, "work");
		await fs.mkdir(cwd, { recursive: true });
		await setUserGlobalDefaultAgent("hr");

		const resolved = await resolveSessionAgent({ cwd, processAgentDir: agentDir });
		// Not "bootstrap": the value came from the settings file, not from the process.
		expect(resolved.ref).toEqual({ agentId: "hr", source: "user" });
		// The workspace declared nothing, so the context must not claim a workspace default.
		expect(resolved.workspaceContext.defaultAgentId).toBeUndefined();
	});

	test("an explicit session pin outranks both new declarations", async () => {
		// The workspace declares another Agent and so does the user config; the pin still wins.
		const agentDir = await makeRegisteredAgent("hr", "HR", { defaultAgentId: "sw" });
		await makeRegisteredAgent("sw");
		const cwd = path.join(home, "work");
		await fs.mkdir(cwd, { recursive: true });
		await setUserGlobalDefaultAgent("sw");

		const resolved = await resolveSessionAgent({ cwd, processAgentDir: agentDir, pinnedAgentId: "hr" });
		expect(resolved.ref).toEqual({ agentId: "hr", source: "session" });
	});

	test("a Project default still outranks the two new declarations", async () => {
		const agentDir = await makeRegisteredAgent("hr", "HR", { defaultAgentId: "hr" });
		const cwd = path.join(home, "work");
		await fs.mkdir(cwd, { recursive: true });
		await setUserGlobalDefaultAgent("hr");
		await upsertProject({ projectId: "hr-project", root: cwd, name: "HR", defaultAgentId: "hr" });

		const resolved = await resolveSessionAgent({ cwd, processAgentDir: agentDir });
		expect(resolved.ref).toEqual({ agentId: "hr", source: "project" });
	});

	test("a workspace default naming an unregistered Agent does not fall through", async () => {
		const agentDir = await makeRegisteredAgent("hr", "HR", { defaultAgentId: "unregistered" });
		const cwd = path.join(home, "work");
		await fs.mkdir(cwd, { recursive: true });
		// A working weaker answer must not rescue a broken declaration (§10 rule 1).
		await setUserGlobalDefaultAgent("hr");

		const failure = await failureOf(resolveSessionAgent({ cwd, processAgentDir: agentDir }));
		expect(failure).toEqual({ kind: "agent-unknown", source: "workspace", agentId: "unregistered" });
	});

	test("a user-global default naming a disabled Agent does not fall through", async () => {
		const agentDir = await makeRegisteredAgent("hr");
		const goneDir = await makeRegisteredAgent("sw");
		const cwd = path.join(home, "work");
		await fs.mkdir(cwd, { recursive: true });
		await setUserGlobalDefaultAgent("sw");
		await fs.rm(goneDir, { recursive: true, force: true });

		const failure = await failureOf(resolveSessionAgent({ cwd, processAgentDir: agentDir }));
		expect(failure).toEqual({ kind: "agent-disabled", source: "user", agentId: "sw" });
	});

	test("an unreadable workspace declaration is an error, not 'nothing declared'", async () => {
		const agentDir = await makeRegisteredAgent("hr");
		const cwd = path.join(home, "work");
		await fs.mkdir(cwd, { recursive: true });
		await setUserGlobalDefaultAgent("hr");
		await Bun.write(path.join(agentDir, ".cornfield", "workspace.json"), "{ not json");

		const failure = await failureOf(resolveSessionAgent({ cwd, processAgentDir: agentDir }));
		expect(failure).toMatchObject({ kind: "agent-declaration-unreadable", source: "workspace" });
		expect(failure).toMatchObject({ path: path.join(agentDir, ".cornfield", "workspace.json") });
		expect((failure as { reason: string }).reason).toContain("not valid JSON");
	});

	test("an unreadable user config is an error, not 'nothing declared'", async () => {
		const agentDir = await makeRegisteredAgent("hr");
		const cwd = path.join(home, "work");
		await fs.mkdir(cwd, { recursive: true });
		await writeUserConfig("user: {globalDefaultAgentId: 'hr'\n");

		const failure = await failureOf(resolveSessionAgent({ cwd, processAgentDir: agentDir }));
		expect(failure).toMatchObject({
			kind: "agent-declaration-unreadable",
			source: "user",
			path: userConfigFilePath(),
		});
		expect((failure as { reason: string }).reason).toContain("not valid YAML");
	});

	test("a declared non-string user default is rejected instead of ignored", async () => {
		const agentDir = await makeRegisteredAgent("hr");
		const cwd = path.join(home, "work");
		await fs.mkdir(cwd, { recursive: true });
		await writeUserConfig("user:\n  globalDefaultAgentId: 42\n");

		const failure = await failureOf(resolveSessionAgent({ cwd, processAgentDir: agentDir }));
		expect(failure).toMatchObject({ kind: "agent-declaration-unreadable", source: "user" });
		expect((failure as { reason: string }).reason).toContain("must be an Agent id");
	});

	test("a user config without the key declares nothing", async () => {
		const agentDir = await makeRegisteredAgent("hr");
		const cwd = path.join(home, "work");
		await fs.mkdir(cwd, { recursive: true });
		await writeUserConfig("theme:\n  dark: titanium\nuser: {}\n");

		const resolved = await resolveSessionAgent({ cwd, processAgentDir: agentDir });
		expect(resolved.ref).toEqual({ agentId: "hr", source: "bootstrap" });
	});
});

describe("the user-global rung resolves the client's config root", () => {
	test("an absolute CORNFIELD_CONFIG_DIR is the root, not a name under HOME", async () => {
		const clientRoot = path.join(home, "client");
		const agentDir = await makeRegisteredAgent("hr");
		const cwd = path.join(home, "work");
		await fs.mkdir(cwd, { recursive: true });
		// The directory authority's reading: an absolute override *is* the config root, so the
		// file `Settings` writes there is the file this rung reads.
		process.env.CORNFIELD_CONFIG_DIR = clientRoot;
		await setUserGlobalDefaultAgent("hr");

		expect(userConfigFilePath()).toBe(path.join(clientRoot, "agent", "config.yml"));
		const resolved = await resolveSessionAgent({ cwd, processAgentDir: agentDir });
		expect(resolved.ref).toEqual({ agentId: "hr", source: "user" });
	});

	test("an explicit null is a declaration that cannot be honoured, not an absent key", async () => {
		const agentDir = await makeRegisteredAgent("hr");
		const cwd = path.join(home, "work");
		await fs.mkdir(cwd, { recursive: true });
		await writeUserConfig("user:\n  globalDefaultAgentId: null\n");

		const failure = await failureOf(resolveSessionAgent({ cwd, processAgentDir: agentDir }));
		expect(failure).toMatchObject({
			kind: "agent-declaration-unreadable",
			source: "user",
			path: userConfigFilePath(),
		});
		expect((failure as { reason: string }).reason).toContain("must be an Agent id");
		expect((failure as { reason: string }).reason).toContain("null");
	});
});

describe("a rung behind a file is read only when the policy consults it", () => {
	test("a broken user rung does not veto a pinned session", async () => {
		const agentDir = await makeRegisteredAgent("hr");
		const cwd = path.join(home, "work");
		await fs.mkdir(cwd, { recursive: true });
		// An unrelated client-level value that cannot be read as an Agent id.
		await writeUserConfig("user:\n  globalDefaultAgentId: 42\n");

		const resolved = await resolveSessionAgent({ cwd, processAgentDir: agentDir, pinnedAgentId: "hr" });
		expect(resolved.ref).toEqual({ agentId: "hr", source: "session" });
	});

	test("a broken user rung does not veto a workspace default", async () => {
		const agentDir = await makeRegisteredAgent("hr", "HR", { defaultAgentId: "hr" });
		const cwd = path.join(home, "work");
		await fs.mkdir(cwd, { recursive: true });
		await writeUserConfig("user: {globalDefaultAgentId: 42}\n");

		const resolved = await resolveSessionAgent({ cwd, processAgentDir: agentDir });
		expect(resolved.ref).toEqual({ agentId: "hr", source: "workspace" });
	});

	test("an unreadable workspace declaration does not veto a pinned session", async () => {
		const agentDir = await makeRegisteredAgent("hr");
		const cwd = path.join(home, "work");
		await fs.mkdir(cwd, { recursive: true });
		await Bun.write(path.join(agentDir, ".cornfield", "workspace.json"), "{ not json");

		const resolved = await resolveSessionAgent({ cwd, processAgentDir: agentDir, pinnedAgentId: "hr" });
		expect(resolved.ref).toEqual({ agentId: "hr", source: "session" });
		// Nothing was declared that could be mirrored: an unreadable file is not a declaration.
		expect(resolved.workspaceContext.defaultAgentId).toBeUndefined();
	});
});

describe("an unregistered process directory keeps its declaration", () => {
	/** The built-in `default` Agent's agentDir: a directory no registry knows about. */
	function bareProcessAgentDir(): string {
		return path.join(home, ".cornfield", "agent");
	}

	test("the derived context mirrors the declaration, not only the Agent id", async () => {
		const processAgentDir = bareProcessAgentDir();
		await writeWorkspaceDeclaration(processAgentDir, { id: "default", name: "Default", defaultAgentId: "default" });
		const cwd = path.join(home, "work");
		await fs.mkdir(cwd, { recursive: true });

		const resolved = await resolveSessionAgent({ cwd, processAgentDir });

		expect(resolved.ref).toEqual({ agentId: "default", source: "workspace" });
		expect(resolved.workspaceContext.defaultAgentId).toBe("default");
	});

	test("a broken declared default reaches the relations rules through the context", async () => {
		const processAgentDir = bareProcessAgentDir();
		// The workspace declares a default Agent that does not exist.
		await writeWorkspaceDeclaration(processAgentDir, { id: "default", name: "Default", defaultAgentId: "ghost" });
		const cwd = path.join(home, "work");
		await fs.mkdir(cwd, { recursive: true });
		// A Project default wins, so rung 3 never decides anything here — the declaration is
		// still the one in force in this workspace, and the context is what a reader judges it by.
		await upsertProject({ projectId: "work", root: cwd, name: "Work", defaultAgentId: "default" });

		const resolved = await resolveSessionAgent({ cwd, processAgentDir });
		expect(resolved.ref).toEqual({ agentId: "default", source: "project" });
		expect(resolved.workspaceContext.defaultAgentId).toBe("ghost");

		const violations = validateWorkspaceContexts({
			agents: [{ agentId: "default", agentDir: processAgentDir, displayName: "default", enabled: true }],
			projects: [{ projectId: "work", root: cwd, name: "Work", defaultAgentId: "default" }],
			sessions: [],
			workspaceContexts: [resolved.workspaceContext],
		});
		expect(violations.map(violation => violation.rule)).toEqual(["workspace.default-agent-missing"]);
	});

	test("a registered directory reports the same broken declared default", async () => {
		const agentDir = await makeRegisteredAgent("hr", "HR", { defaultAgentId: "ghost" });
		const cwd = path.join(home, "work");
		await fs.mkdir(cwd, { recursive: true });
		await upsertProject({ projectId: "work", root: cwd, name: "Work", defaultAgentId: "hr" });

		const resolved = await resolveSessionAgent({ cwd, processAgentDir: agentDir });
		expect(resolved.ref).toEqual({ agentId: "hr", source: "project" });
		expect(resolved.workspaceContext.defaultAgentId).toBe("ghost");
	});
});

describe("resolveSessionAgent restore", () => {
	test("a persisted header wins over ambient declarations and keeps its provenance", async () => {
		const agentDir = await makeRegisteredAgent("hr");
		await makeRegisteredAgent("sw");
		const cwd = path.join(home, "work");
		await fs.mkdir(cwd, { recursive: true });
		// Ambient state says "sw"; the session itself was already resolved to "hr".
		await upsertProject({ projectId: "work", root: cwd, name: "Work", defaultAgentId: "sw" });

		const resolved = await resolveSessionAgent({
			cwd,
			processAgentDir: agentDir,
			sessionHeader: { agentId: "hr", agentSource: "user" } as SessionHeader,
		});
		expect(resolved.ref).toEqual({ agentId: "hr", source: "user" });
		expect(resolved.origin).toBe("persisted");
	});

	test("a persisted Agent that disappeared is reported as drift", async () => {
		const agentDir = await makeRegisteredAgent("hr");
		const cwd = path.join(home, "work");
		await fs.mkdir(cwd, { recursive: true });
		await fs.rm(agentDir, { recursive: true, force: true });

		const failure = await failureOf(
			resolveSessionAgent({
				cwd,
				processAgentDir: agentDir,
				sessionHeader: { agentId: "hr", agentSource: "project" } as SessionHeader,
			}),
		);
		expect(failure).toEqual({ kind: "agent-disabled", source: "session", agentId: "hr" });
	});

	test("a legacy session without an Agent resolves explicitly", async () => {
		const agentDir = await makeRegisteredAgent("hr");
		const cwd = path.join(home, "work");
		await fs.mkdir(cwd, { recursive: true });

		const resolved = await resolveSessionAgent({
			cwd,
			processAgentDir: agentDir,
			sessionHeader: { cwd } as SessionHeader,
		});
		expect(readPersistedRef({ cwd } as SessionHeader)).toBeNull();
		expect(resolved.origin).toBe("resolved");
		expect(resolved.ref.agentId).toBe("hr");
	});
});

describe("Project store failure policy", () => {
	test("a missing store is an empty store", async () => {
		expect(await loadProjects()).toEqual([]);
	});

	test("a corrupt store is an explicit error, never an empty store", async () => {
		const file = projectsFilePath();
		await fs.mkdir(path.dirname(file), { recursive: true });
		await Bun.write(file, "{ not json");
		await expect(loadProjects()).rejects.toThrow(/not valid JSON/);
	});

	test("a store with an unexpected version is rejected", async () => {
		const file = projectsFilePath();
		await fs.mkdir(path.dirname(file), { recursive: true });
		await Bun.write(file, `${JSON.stringify({ version: 99, projects: {} })}\n`);
		await expect(loadProjects()).rejects.toThrow(/version 99/);
	});

	test("two Projects cannot share a root", async () => {
		const root = path.join(home, "repo");
		await upsertProject({ projectId: "a", root, name: "A" });
		await expect(upsertProject({ projectId: "b", root, name: "B" })).rejects.toThrow(/already declared/);
	});
});

describe("session header persistence", () => {
	const ref = { agentId: "hr", source: "project" } as const;

	test("a created session records the resolved Agent on disk", async () => {
		const cwd = path.join(home, "work");
		const sessionDir = path.join(home, "sessions");
		await fs.mkdir(cwd, { recursive: true });

		const manager = SessionManager.create(cwd, sessionDir, undefined, ref);
		expect(manager.getHeader()?.agentId).toBe("hr");
		expect(manager.getHeader()?.agentSource).toBe("project");

		manager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		// A user-only session stays lazy on purpose; `ensureOnDisk()` is the documented
		// "put this session on disk now" call (also what ACP mode uses).
		await manager.ensureOnDisk();

		const file = manager.getSessionFile();
		if (!file) throw new Error("expected a session file");
		const firstLine = (await Bun.file(file).text()).split("\n")[0];
		const header = JSON.parse(firstLine) as SessionHeader;
		expect(header.agentId).toBe("hr");
		expect(header.agentSource).toBe("project");
	});

	test("reopening a session reads the recorded Agent back", async () => {
		const cwd = path.join(home, "work");
		const sessionDir = path.join(home, "sessions");
		await fs.mkdir(cwd, { recursive: true });

		const created = SessionManager.create(cwd, sessionDir, undefined, ref);
		created.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		await created.ensureOnDisk();
		const file = created.getSessionFile();
		if (!file) throw new Error("expected a session file");

		const reopened = await SessionManager.open(file, sessionDir);
		expect(readPersistedRef(reopened.getHeader())).toEqual({ agentId: "hr", source: "project" });
	});

	test("forking a session carries the Agent over", async () => {
		const cwd = path.join(home, "work");
		const sessionDir = path.join(home, "sessions");
		await fs.mkdir(cwd, { recursive: true });

		const created = SessionManager.create(cwd, sessionDir, undefined, ref);
		created.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		await created.ensureOnDisk();
		const file = created.getSessionFile();
		if (!file) throw new Error("expected a session file");

		const forked = await SessionManager.forkFrom(file, cwd, sessionDir);
		expect(forked.getHeader()?.agentId).toBe("hr");
		expect(forked.getHeader()?.agentSource).toBe("project");
	});

	test("a session created without a resolution records none (not a guess)", async () => {
		const cwd = path.join(home, "work");
		const sessionDir = path.join(home, "sessions");
		await fs.mkdir(cwd, { recursive: true });

		const manager = SessionManager.create(cwd, sessionDir);
		expect(manager.getHeader()?.agentId).toBeUndefined();
		expect(manager.getHeader()?.agentSource).toBeUndefined();
	});

	test("readPersistedRef tolerates an unknown source value", () => {
		expect(readPersistedRef({ agentId: "hr", agentSource: "ui" } as unknown as SessionHeader)).toEqual({
			agentId: "hr",
			source: "session",
		});
	});
});

describe("setResolvedAgent write-back", () => {
	const ref = { agentId: "hr", source: "project" } as const;

	async function workDir(): Promise<{ cwd: string; sessionDir: string }> {
		const cwd = path.join(home, "work");
		const sessionDir = path.join(home, "sessions");
		await fs.mkdir(cwd, { recursive: true });
		return { cwd, sessionDir };
	}

	async function headerOnDisk(file: string): Promise<Record<string, unknown>> {
		const firstLine = (await Bun.file(file).text()).split("\n")[0];
		return JSON.parse(firstLine) as Record<string, unknown>;
	}

	test("records the Agent on a session that has not been written yet", async () => {
		const { cwd, sessionDir } = await workDir();
		const manager = SessionManager.create(cwd, sessionDir);
		expect(manager.getHeader()?.agentId).toBeUndefined();

		expect(await manager.setResolvedAgent(ref)).toBe(true);
		expect(manager.getHeader()?.agentId).toBe("hr");

		await manager.ensureOnDisk();
		const file = manager.getSessionFile();
		if (!file) throw new Error("expected a session file");
		expect(await headerOnDisk(file)).toMatchObject({ agentId: "hr", agentSource: "project" });
	});

	test("updates a session already on disk and keeps its entries", async () => {
		const { cwd, sessionDir } = await workDir();
		const manager = SessionManager.create(cwd, sessionDir);
		manager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		await manager.ensureOnDisk();
		const file = manager.getSessionFile();
		if (!file) throw new Error("expected a session file");
		const before = (await Bun.file(file).text()).trim().split("\n");

		expect(await manager.setResolvedAgent(ref)).toBe(true);

		const after = (await Bun.file(file).text()).trim().split("\n");
		expect(after).toHaveLength(before.length);
		const entries = after.map(line => JSON.parse(line) as { type?: string; agentId?: string });
		expect(entries[0]).toMatchObject({ agentId: "hr", agentSource: "project" });
		expect(entries.filter(entry => entry.type === "message")).toHaveLength(1);
	});

	test("never overwrites an Agent that is already recorded", async () => {
		const { cwd, sessionDir } = await workDir();
		const manager = SessionManager.create(cwd, sessionDir, undefined, { agentId: "sw", source: "user" });

		expect(await manager.setResolvedAgent(ref)).toBe(false);
		expect(manager.getHeader()?.agentId).toBe("sw");
		expect(manager.getHeader()?.agentSource).toBe("user");
	});

	test("records on an in-memory session without touching disk", async () => {
		const manager = SessionManager.inMemory();

		expect(await manager.setResolvedAgent(ref)).toBe(true);
		expect(manager.getHeader()?.agentId).toBe("hr");
		expect(manager.getSessionFile()).toBeUndefined();
	});
});
