/**
 * Agent Profile Registry (WP2 kernel).
 *
 * The registry reads the two authorities that already exist and writes neither:
 * `~/.cornfield/agent/registry.json` (index) and `<agentDir>/.cornfield/workspace.json`
 * (declaration). These tests pin the projection and the binding precedence, including
 * the legacy path a gateway account takes when it only declares an `agentDir`.
 *
 * HOME is isolated: the registry path and the default agent home both live under it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	findAgentProfile,
	findAgentProfileByDir,
	listAgentProfiles,
	resolveAgentBinding,
	toAgentProfile,
} from "../src/agent-domain";
import { loadRegistry } from "../src/skeleton/registry";

interface Fixture {
	root: string;
	home: string;
	dir: (name: string) => string;
	cleanup: () => Promise<void>;
}

async function createFixture(): Promise<Fixture> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-profile-registry-"));
	const home = path.join(root, "home");
	await fs.mkdir(path.join(home, ".cornfield", "agent"), { recursive: true });
	return {
		root,
		home,
		dir: (name: string) => path.join(root, "agents", name),
		cleanup: async () => {
			await fs.rm(root, { recursive: true, force: true });
		},
	};
}

async function writeRegistry(
	home: string,
	agents: Record<string, { path: string; displayName?: string }>,
): Promise<void> {
	const entries: Record<string, unknown> = {};
	for (const [name, entry] of Object.entries(agents)) {
		entries[name] = {
			path: entry.path,
			registeredAt: new Date().toISOString(),
			template: "default",
			...(entry.displayName !== undefined ? { displayName: entry.displayName } : {}),
		};
	}
	await Bun.write(
		path.join(home, ".cornfield", "agent", "registry.json"),
		JSON.stringify({ version: 2, agents: entries }, null, 2),
	);
}

async function writeDeclaration(dir: string, name: string): Promise<void> {
	await fs.mkdir(path.join(dir, ".cornfield"), { recursive: true });
	await Bun.write(
		path.join(dir, ".cornfield", "workspace.json"),
		JSON.stringify({ schemaVersion: 2, id: name, name, type: "agent", root: ".", projectRoot: "." }, null, 2),
	);
}

describe("agent profile registry", () => {
	let fixture: Fixture;
	let savedHome: string | undefined;

	beforeEach(async () => {
		fixture = await createFixture();
		savedHome = process.env.HOME;
		process.env.HOME = fixture.home;
	});

	afterEach(async () => {
		if (savedHome === undefined) delete process.env.HOME;
		else process.env.HOME = savedHome;
		await fixture.cleanup();
	});

	test("empty registry projects to an empty list", async () => {
		await writeRegistry(fixture.home, {});
		expect(await listAgentProfiles()).toEqual([]);
	});

	test("projects registry entries with the declaration's name, sorted by agentId", async () => {
		const hrDir = fixture.dir("hr3");
		const algorithmDir = fixture.dir("omp-atomix");
		await writeDeclaration(hrDir, "HR 助手");
		await writeDeclaration(algorithmDir, "算法");
		await writeRegistry(fixture.home, {
			hr: { path: hrDir, displayName: "stale-cache-name" },
			algorithm: { path: algorithmDir },
		});

		const profiles = await listAgentProfiles();

		expect(profiles.map(p => p.agentId)).toEqual(["algorithm", "hr"]);
		// The declaration travels with the directory and outranks the registry cache.
		expect(profiles[1]).toEqual({
			agentId: "hr",
			agentDir: hrDir,
			displayName: "HR 助手",
			enabled: true,
		});
	});

	test("falls back to the registry's cached displayName when the declaration is missing or corrupt", async () => {
		const noDeclaration = fixture.dir("plain");
		const corrupt = fixture.dir("corrupt");
		await fs.mkdir(corrupt, { recursive: true });
		await Bun.write(path.join(corrupt, ".cornfield", "workspace.json"), "{ not json");
		await writeRegistry(fixture.home, {
			plain: { path: noDeclaration, displayName: "Plain" },
			corrupt: { path: corrupt, displayName: "Corrupt" },
		});

		expect((await findAgentProfile("plain"))?.displayName).toBe("Plain");
		expect((await findAgentProfile("corrupt"))?.displayName).toBe("Corrupt");
	});

	test("unknown agentId projects to null, never a guessed default", async () => {
		await writeRegistry(fixture.home, {});
		expect(await findAgentProfile("nobody")).toBeNull();
	});

	test("reverse lookup by dir normalizes separators and trailing slashes", async () => {
		const hrDir = fixture.dir("hr3");
		await writeDeclaration(hrDir, "HR");
		await writeRegistry(fixture.home, { hr: { path: hrDir } });

		expect((await findAgentProfileByDir(hrDir))?.agentId).toBe("hr");
		expect((await findAgentProfileByDir(`${hrDir}/`))?.agentId).toBe("hr");
		expect((await findAgentProfileByDir(`${hrDir}//`))?.agentId).toBe("hr");
		expect(await findAgentProfileByDir(fixture.dir("elsewhere"))).toBeNull();
	});

	test("listAgentProfiles does not scan for unregistered agentDirs", async () => {
		const registered = fixture.dir("registered");
		const orphan = fixture.dir("orphan");
		await writeDeclaration(orphan, "orphan");
		await writeRegistry(fixture.home, { registered: { path: registered } });

		expect((await listAgentProfiles()).map(p => p.agentId)).toEqual(["registered"]);
	});

	test("reads never write the registry", async () => {
		const hrDir = fixture.dir("hr3");
		await writeRegistry(fixture.home, { hr: { path: hrDir } });
		const before = await Bun.file(path.join(fixture.home, ".cornfield", "agent", "registry.json")).text();

		await listAgentProfiles();
		await findAgentProfile("hr");
		await findAgentProfileByDir(hrDir);
		await resolveAgentBinding({ agentId: "hr", agentDir: hrDir });

		const after = await Bun.file(path.join(fixture.home, ".cornfield", "agent", "registry.json")).text();
		expect(after).toBe(before);
		const reg = await loadRegistry();
		expect(Object.keys(reg.agents)).toEqual(["hr"]);
	});

	test("toAgentProfile keeps the registry entry's home and the id it was asked for", () => {
		const entry = { path: "/tmp/agent", registeredAt: "2026-01-01T00:00:00.000Z", template: "default" };
		expect(toAgentProfile("hr", entry, null)).toEqual({
			agentId: "hr",
			agentDir: "/tmp/agent",
			displayName: "hr",
			enabled: true,
		});
		expect(toAgentProfile("hr", entry, null).projectIds).toBeUndefined();
	});
});

describe("resolveAgentBinding", () => {
	let fixture: Fixture;
	let savedHome: string | undefined;

	beforeEach(async () => {
		fixture = await createFixture();
		savedHome = process.env.HOME;
		process.env.HOME = fixture.home;
	});

	afterEach(async () => {
		if (savedHome === undefined) delete process.env.HOME;
		else process.env.HOME = savedHome;
		await fixture.cleanup();
	});

	test("declared dir that is a registered Agent's home wins the identity", async () => {
		const dir = fixture.dir("hr3");
		await writeDeclaration(dir, "HR");
		await writeRegistry(fixture.home, { hr: { path: dir } });

		// The caller (a legacy gateway account) only knows the directory.
		const binding = await resolveAgentBinding({ agentId: "hr-account", agentDir: dir });

		expect(binding.agentId).toBe("hr");
		expect(binding.agentDir).toBe(dir);
		expect(binding.agentDirSource).toBe("declared");
		expect(binding.profile?.agentId).toBe("hr");
	});

	test("declared dir that no Agent owns is kept verbatim", async () => {
		await writeRegistry(fixture.home, {});
		const dir = fixture.dir("legacy-workspace");

		const binding = await resolveAgentBinding({ agentId: "hr", agentDir: dir });

		expect(binding.agentDir).toBe(dir);
		expect(binding.agentDirSource).toBe("declared");
		expect(binding.profile).toBeNull();
		expect(binding.conflict).toBeUndefined();
	});

	test("registered agentId resolves its home from the registry", async () => {
		const dir = fixture.dir("omp-atomix");
		await writeRegistry(fixture.home, { algorithm: { path: dir } });

		const binding = await resolveAgentBinding({ agentId: "algorithm" });

		expect(binding.agentDir).toBe(dir);
		expect(binding.agentDirSource).toBe("registry");
		expect(binding.profile?.agentDir).toBe(dir);
	});

	test("unregistered agentId falls back to the conventional default home", async () => {
		await writeRegistry(fixture.home, {});

		const binding = await resolveAgentBinding({ agentId: "nobody" });

		expect(binding.agentDirSource).toBe("default");
		expect(binding.agentDir).toBe(path.join(os.homedir(), ".cornfield", "agents", "nobody"));
		expect(binding.profile).toBeNull();
	});

	test("conflicting declared dir and registered agentId report the conflict instead of hiding it", async () => {
		const registeredDir = fixture.dir("registered");
		const declaredDir = fixture.dir("stale");
		await writeRegistry(fixture.home, { hr: { path: registeredDir } });

		const binding = await resolveAgentBinding({ agentId: "hr", agentDir: declaredDir });

		expect(binding.agentDir).toBe(declaredDir);
		expect(binding.profile).toBeNull();
		expect(binding.conflict).toEqual({
			requestedAgentId: "hr",
			declaredAgentDir: declaredDir,
			registeredAgentDir: registeredDir,
		});
	});

	test("whitespace-only and empty agentDir are not declarations", async () => {
		const dir = fixture.dir("hr3");
		await writeRegistry(fixture.home, { hr: { path: dir } });

		for (const agentDir of ["", "   "]) {
			const binding = await resolveAgentBinding({ agentId: "hr", agentDir });
			expect(binding.agentDir).toBe(dir);
			expect(binding.agentDirSource).toBe("registry");
		}
	});

	test("a declared dir with stray spaces is used verbatim, not trimmed into another path", async () => {
		await writeRegistry(fixture.home, {});

		const binding = await resolveAgentBinding({ agentId: "hr", agentDir: `${fixture.dir("x")} ` });

		expect(binding.agentDir).toBe(`${fixture.dir("x")} `);
		expect(binding.agentDirSource).toBe("declared");
	});
});
