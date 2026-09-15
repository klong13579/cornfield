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
import {
	readPersistedRef,
	resolveSessionAgent,
	SessionAgentError,
	type SessionAgentFailure,
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

/** Create an agentDir on disk and register it, so it is a live Agent. */
async function makeRegisteredAgent(agentId: string, displayName = agentId): Promise<string> {
	const agentDir = path.join(home, "agents", agentId);
	await fs.mkdir(agentDir, { recursive: true });
	await registerAgent(agentId, agentDir);
	await Bun.write(
		path.join(agentDir, ".cornfield", "workspace.json"),
		`${JSON.stringify({
			schemaVersion: 2,
			id: agentId,
			name: displayName,
			type: "agent",
			root: ".",
			projectRoot: ".",
			skillsDir: ".cornfield/skills/",
		})}\n`,
	);
	return agentDir;
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
