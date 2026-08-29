/**
 * Registry v2 / workspace declaration tests.
 *
 * Covers the workspace-v2 design (`agentDir/.cornfield/workspace.json` as source of
 * truth, registry as thin index with cached fields):
 *   - loadWorkspace: missing/corrupt → null, valid → declaration
 *   - ensureWorkspace: creates with defaults, additive (never overwrites)
 *   - registerAgent: fills v2 cache fields from the declaration
 *   - registry v1 → v2: legacy entries survive, new writes are v2
 *   - gateway-style registration (no declaration) stays side-effect free
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { loadRegistry, registerAgent, saveRegistry } from "../src/skeleton/registry";
import { ensureWorkspace, loadWorkspace, WORKSPACE_SCHEMA_VERSION, workspaceFilePath } from "../src/skeleton/workspace";

const savedHome = process.env.HOME;
let isolatedHome: string;
let agentDir: string;

beforeEach(async () => {
	agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ws-test-"));
	isolatedHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ws-registry-"));
	process.env.HOME = isolatedHome;
});

afterEach(async () => {
	process.env.HOME = savedHome;
	if (agentDir) await fs.rm(agentDir, { recursive: true, force: true });
	if (isolatedHome) await fs.rm(isolatedHome, { recursive: true, force: true });
});

describe("loadWorkspace", () => {
	test("returns null when the declaration is missing", async () => {
		expect(await loadWorkspace(agentDir)).toBeNull();
	});

	test("returns null for a corrupt / non-v2 file", async () => {
		await fs.mkdir(path.join(agentDir, ".cornfield"), { recursive: true });
		await Bun.write(workspaceFilePath(agentDir), "not json");
		expect(await loadWorkspace(agentDir)).toBeNull();

		await Bun.write(
			workspaceFilePath(agentDir),
			JSON.stringify({ schemaVersion: 1, id: "x", name: "X", type: "agent", root: ".", projectRoot: "." }),
		);
		expect(await loadWorkspace(agentDir)).toBeNull();
	});

	test("returns the declaration for a valid v2 file", async () => {
		const decl = await ensureWorkspace(agentDir, { name: "hr" });
		expect(decl.schemaVersion).toBe(WORKSPACE_SCHEMA_VERSION);
		expect(decl.id).toBe("hr");
		expect(decl.name).toBe("hr");
		expect(decl.type).toBe("agent");
		expect(decl.root).toBe(".");
		expect(decl.projectRoot).toBe(".");
		expect(decl.knowledge?.identity).toBe("mission.md");
	});
});

describe("ensureWorkspace", () => {
	test("creates .cornfield/workspace.json with defaults; idempotent on second call", async () => {
		const first = await ensureWorkspace(agentDir, { name: "hr" });
		await fs.writeFile(path.join(agentDir, "mission.md"), "# custom\n");
		const second = await ensureWorkspace(agentDir, { name: "hr" });
		expect(second).toEqual(first); // additive: existing declaration untouched
		const onDisk = await loadWorkspace(agentDir);
		expect(onDisk).toEqual(first);
		// The agent's root-level identity file is not part of the declaration write.
		expect(await Bun.file(path.join(agentDir, "mission.md")).text()).toBe("# custom\n");
	});

	test("never overwrites an existing valid declaration", async () => {
		const first = await ensureWorkspace(agentDir, { name: "hr" });
		first.name = "HR 数字员工";
		first.projectRoot = "/external/project";
		await Bun.write(workspaceFilePath(agentDir), `${JSON.stringify(first, null, 2)}\n`);
		await ensureWorkspace(agentDir, { name: "ignored" });
		const reloaded = await loadWorkspace(agentDir);
		expect(reloaded?.name).toBe("HR 数字员工");
		expect(reloaded?.projectRoot).toBe("/external/project");
	});
});

describe("registry v2", () => {
	test("registerAgent fills cache fields from the declaration", async () => {
		const decl = await ensureWorkspace(agentDir, { name: "hr" });
		const entry = await registerAgent("hr", agentDir, "default");

		expect(entry.path).toBe(agentDir);
		expect(entry.displayName).toBe(decl.name);
		expect(entry.workspaceVersion).toBe(WORKSPACE_SCHEMA_VERSION);
		expect(entry.workspaceUpdatedAt).toBe(decl.updatedAt);

		const reg = await loadRegistry();
		expect(reg.version).toBe(2);
		expect(reg.agents.hr?.path).toBe(agentDir);
	});

	test("v1 registries load and legacy entries survive", async () => {
		const legacyEntry = {
			path: agentDir,
			registeredAt: "2026-01-01T00:00:00.000Z",
			template: "default",
		};
		await saveRegistry({ version: 1, agents: { legacy: legacyEntry } });

		const reg = await loadRegistry();
		expect(reg.agents.legacy).toEqual(legacyEntry); // no fields lost

		// A new registration bumps the file to v2 without touching legacy entries.
		await registerAgent("hr", agentDir);
		const after = await loadRegistry();
		expect(after.version).toBe(2);
		expect(after.agents.legacy).toEqual(legacyEntry);
		expect(after.agents.hr?.path).toBe(agentDir);
	});

	test("gateway-style registration without a declaration stays side-effect free", async () => {
		// Gateway account dirs call registerAgent directly, no ensureWorkspace.
		const entry = await registerAgent("ops/hr", agentDir, "default");
		expect(entry.workspaceVersion).toBeUndefined();
		expect(entry.displayName).toBeUndefined();
		// No .cornfield/workspace.json created by registration itself.
		await expect(fs.stat(workspaceFilePath(agentDir))).rejects.toThrow();
	});
});
