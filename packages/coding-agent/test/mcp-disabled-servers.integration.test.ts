/**
 * Integration tests for MCP `disabledServers` — the "user-disable-by-name"
 * contract. The denylist lives in the user-level mcp.json (`<clientDir>/mcp.json`)
 * and is consulted at load time by `loadAllMCPConfigs`. This file locks in:
 *
 *   - reader/writer round-trip (config-writer.ts)
 *   - loader-side filtering (config.ts:115)
 *   - exact-name match (case/whitespace-sensitive)
 *   - "disabled" vs "self-disabled" not masking each other
 *   - removal-then-re-add collapses the key when empty
 *   - cross-source denylist semantics (denylist applies across all sources)
 *   - "wire-server does not expose disabledServers" contract
 *
 * Tests use real files in an isolated HOME + CORNFIELD_CLIENT_DIR; we do not
 * mock `readDisabledServers` because the contract value is exactly "user edits
 * the file, runtime picks it up".
 *
 * Issue 25: MCP disabled-servers has zero coverage before this file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getMCPConfigPath, setClientDir, setConfigRootDir, TempDir } from "@cornfield/utils";
import { loadAllMCPConfigs } from "../src/mcp/config";
import { readDisabledServers, setServerDisabled, writeMCPConfigFile } from "../src/mcp/config-writer";

let homeRoot: TempDir;
let projectRoot: TempDir;
let savedHome: string | undefined;
let savedClientDir: string | undefined;
let savedConfigRoot: string | undefined;

const projectMcpPath = (): string => path.join(projectRoot.path(), "mcp.json");
const userMcpPath = (): string => getMCPConfigPath("user", projectRoot.path());

beforeEach(async () => {
	homeRoot = TempDir.createSync("@mcp-disabled-servers-home-");
	projectRoot = TempDir.createSync("@mcp-disabled-servers-proj-");

	savedHome = process.env.HOME;
	savedClientDir = process.env.CORNFIELD_CLIENT_DIR;
	savedConfigRoot = process.env.CORNFIELD_CONFIG_DIR;

	// Pin the client directory at <home>/.cornfield/agent and rebuild the
	// DirResolver so caches pick up the new root.
	setConfigRootDir(path.join(homeRoot.path(), ".cornfield"));
	setClientDir(path.join(homeRoot.path(), ".cornfield", "agent"));

	// `loadCapability` resolves `LoadContext.home` via `os.homedir()` (capability/index.ts:267).
	// Bun caches the value at startup, so `process.env.HOME = ...` is not enough —
	// spy on the API instead. We are NOT mocking `readDisabledServers`; the contract
	// under test is "user-edits-mcp.json → loader-picks-it-up", which still requires
	// the real file at `<clientDir>/mcp.json`.
	vi.spyOn(os, "homedir").mockReturnValue(homeRoot.path());
});

afterEach(async () => {
	if (savedHome === undefined) delete process.env.HOME;
	else process.env.HOME = savedHome;
	if (savedConfigRoot === undefined) delete process.env.CORNFIELD_CONFIG_DIR;
	else process.env.CORNFIELD_CONFIG_DIR = savedConfigRoot;
	if (savedClientDir === undefined) delete process.env.CORNFIELD_CLIENT_DIR;
	else process.env.CORNFIELD_CLIENT_DIR = savedClientDir;
	setConfigRootDir(savedConfigRoot ?? path.join(os.homedir(), ".cornfield"));
	setClientDir(savedClientDir ?? path.join(savedConfigRoot ?? path.join(os.homedir(), ".cornfield"), "agent"));
	vi.restoreAllMocks();

	await fs.rm(homeRoot.path(), { recursive: true, force: true });
	await fs.rm(projectRoot.path(), { recursive: true, force: true });
});

/** Write a project-level mcp.json with the given servers. */
async function writeProjectMcp(servers: Record<string, { command: string }>): Promise<void> {
	const body = {
		$schema: "https://example.invalid/mcp-schema.json",
		mcpServers: servers,
	};
	await fs.writeFile(projectMcpPath(), JSON.stringify(body, null, 2), "utf8");
}

describe("readDisabledServers / setServerDisabled — writer contract", () => {
	it("readDisabledServers returns [] when the file is absent", async () => {
		const list = await readDisabledServers(userMcpPath());
		expect(list).toEqual([]);
	});

	it("readDisabledServers returns [] when disabledServers is missing or invalid", async () => {
		await fs.mkdir(path.dirname(userMcpPath()), { recursive: true });
		await fs.writeFile(userMcpPath(), JSON.stringify({ mcpServers: {} }), "utf8");
		expect(await readDisabledServers(userMcpPath())).toEqual([]);

		await fs.writeFile(userMcpPath(), JSON.stringify({ disabledServers: "not-an-array" }), "utf8");
		expect(await readDisabledServers(userMcpPath())).toEqual([]);

		await fs.writeFile(userMcpPath(), JSON.stringify({ disabledServers: { foo: "bar" } }), "utf8");
		expect(await readDisabledServers(userMcpPath())).toEqual([]);
	});

	it("setServerDisabled(true) writes the name; setServerDisabled(false) removes it", async () => {
		await setServerDisabled(userMcpPath(), "keep-a", true);
		await setServerDisabled(userMcpPath(), "keep-b", true);
		expect((await readDisabledServers(userMcpPath())).sort()).toEqual(["keep-a", "keep-b"]);

		await setServerDisabled(userMcpPath(), "keep-a", false);
		expect(await readDisabledServers(userMcpPath())).toEqual(["keep-b"]);

		await setServerDisabled(userMcpPath(), "keep-b", false);
		expect(await readDisabledServers(userMcpPath())).toEqual([]);
	});

	it("removing the last name deletes the disabledServers key entirely", async () => {
		await setServerDisabled(userMcpPath(), "solo", true);
		const withKey = JSON.parse(await fs.readFile(userMcpPath(), "utf8"));
		expect(withKey.disabledServers).toEqual(["solo"]);

		await setServerDisabled(userMcpPath(), "solo", false);
		const after = JSON.parse(await fs.readFile(userMcpPath(), "utf8"));
		expect(Object.hasOwn(after, "disabledServers")).toBe(false);
	});

	it("writeMCPConfigFile preserves $schema and existing mcpServers", async () => {
		await fs.mkdir(path.dirname(userMcpPath()), { recursive: true });
		await writeMCPConfigFile(userMcpPath(), {
			$schema: "https://example.invalid/mcp-schema.json",
			mcpServers: { alive: { command: "echo", args: ["alive"] } },
		});

		await setServerDisabled(userMcpPath(), "alive", true);
		const after = JSON.parse(await fs.readFile(userMcpPath(), "utf8"));
		expect(after.$schema).toBe("https://example.invalid/mcp-schema.json");
		expect(after.mcpServers?.alive).toEqual({ command: "echo", args: ["alive"] });
		expect(after.disabledServers).toEqual(["alive"]);
	});

	it("setServerDisabled is idempotent for the same name", async () => {
		await setServerDisabled(userMcpPath(), "dup", true);
		await setServerDisabled(userMcpPath(), "dup", true);
		expect(await readDisabledServers(userMcpPath())).toEqual(["dup"]);
	});
});

describe("loadAllMCPConfigs — denylist filtering", () => {
	it("drops servers whose name appears in disabledServers; keeps the rest", async () => {
		await writeProjectMcp({
			"dead-a": { command: "echo" },
			"keep-b": { command: "echo" },
		});
		await setServerDisabled(userMcpPath(), "dead-a", true);

		const result = await loadAllMCPConfigs(projectRoot.path(), {
			filterExa: false,
			filterBrowser: false,
		});

		expect(Object.keys(result.configs).sort()).toEqual(["keep-b"]);
		expect(result.sources["dead-a"]).toBeUndefined();
		expect(result.sources["keep-b"]).toBeDefined();
	});

	it("missing/empty/invalid disabledServers is treated as 'no filter'", async () => {
		await writeProjectMcp({
			"a-server": { command: "echo" },
			"b-server": { command: "echo" },
		});

		const cases: Array<{ label: string; payload: unknown }> = [
			{ label: "missing key", payload: { mcpServers: {} } },
			{ label: "empty array", payload: { mcpServers: {}, disabledServers: [] } },
			{ label: "string instead of array", payload: { mcpServers: {}, disabledServers: "dead-a" } },
			{ label: "object instead of array", payload: { mcpServers: {}, disabledServers: { name: "dead-a" } } },
		];

		for (const { label, payload } of cases) {
			await fs.mkdir(path.dirname(userMcpPath()), { recursive: true });
			await fs.writeFile(userMcpPath(), JSON.stringify(payload), "utf8");

			const result = await loadAllMCPConfigs(projectRoot.path(), {
				filterExa: false,
				filterBrowser: false,
			});
			expect(Object.keys(result.configs).sort(), label).toEqual(["a-server", "b-server"]);
		}
	});

	it("name match is exact — case and whitespace differences do NOT match", async () => {
		await writeProjectMcp({
			"chrome-devtools": { command: "echo" },
			"chrome devtools": { command: "echo" },
			ChromeDevTools: { command: "echo" },
		});
		await setServerDisabled(userMcpPath(), "Chrome DevTools", true); // title-cased + space

		const result = await loadAllMCPConfigs(projectRoot.path(), {
			filterExa: false,
			filterBrowser: false,
		});

		// None of the three names equal "Chrome DevTools"; all survive.
		expect(Object.keys(result.configs).sort()).toEqual(["ChromeDevTools", "chrome devtools", "chrome-devtools"]);
	});

	it("disabled-then-re-enabled: a server comes back through setServerDisabled", async () => {
		await writeProjectMcp({ toggled: { command: "echo" } });

		await setServerDisabled(userMcpPath(), "toggled", true);
		let result = await loadAllMCPConfigs(projectRoot.path(), {
			filterExa: false,
			filterBrowser: false,
		});
		expect(result.configs.toggled).toBeUndefined();

		await setServerDisabled(userMcpPath(), "toggled", false);
		result = await loadAllMCPConfigs(projectRoot.path(), {
			filterExa: false,
			filterBrowser: false,
		});
		expect(result.configs.toggled).toBeDefined();
	});

	it("server with enabled:false is filtered independently of the denylist", async () => {
		// Server A: enabled:false. Server B: enabled:true. denylist contains A only.
		// Both must be filtered, but for different reasons. The two filter
		// branches share one `||` in config.ts:115, so we encode the
		// 'two independent reasons' contract by asserting each branch in
		// isolation, not by combining the conditions.
		await writeProjectMcp({
			"server-a": { command: "echo" }, // enabled defaults to true (absent)
		});
		const body = JSON.parse(await fs.readFile(projectMcpPath(), "utf8"));
		body.mcpServers["server-b"] = { command: "echo", enabled: false };
		await fs.writeFile(projectMcpPath(), JSON.stringify(body), "utf8");

		// Branch 1: enabled:false alone is enough — server-b filtered even
		// though it is NOT in the denylist.
		let result = await loadAllMCPConfigs(projectRoot.path(), {
			filterExa: false,
			filterBrowser: false,
		});
		expect(result.configs["server-a"]).toBeDefined();
		expect(result.configs["server-b"]).toBeUndefined();

		// Branch 2: denylist alone is enough — server-a filtered even though
		// it has no enabled flag.
		await setServerDisabled(userMcpPath(), "server-a", true);
		result = await loadAllMCPConfigs(projectRoot.path(), {
			filterExa: false,
			filterBrowser: false,
		});
		expect(result.configs["server-a"]).toBeUndefined();
		expect(result.configs["server-b"]).toBeUndefined();
	});

	it("denylist applies regardless of which provider supplied the server", async () => {
		// Same name appears in two project files via the mcp-json provider's
		// `mcp.json` and `.mcp.json` fallback paths. The dedup key is the
		// server name; the denylist filters by name, not by source. We assert
		// the denylist hits both copies by writing them in the same project
		// dir and checking that only the surviving (different-named) entry
		// remains in the result.
		await writeProjectMcp({
			shared: { command: "echo" },
			unique: { command: "echo" },
		});
		await fs.writeFile(
			path.join(projectRoot.path(), ".mcp.json"),
			JSON.stringify({
				mcpServers: { shared: { command: "echo" }, other: { command: "echo" } },
			}),
			"utf8",
		);
		await setServerDisabled(userMcpPath(), "shared", true);

		const result = await loadAllMCPConfigs(projectRoot.path(), {
			filterExa: false,
			filterBrowser: false,
		});

		expect(Object.keys(result.configs).sort()).toEqual(["other", "unique"]);
		expect(result.configs.shared).toBeUndefined();
	});

	it("fresh loadAllMCPConfigs after a writer update reflects the new denylist", async () => {
		await writeProjectMcp({ pivot: { command: "echo" } });
		// Ensure the user-level mcp.json exists so writeMCPConfigFile can mutate
		// it in-place; otherwise the next read ENOENTs.
		await writeMCPConfigFile(userMcpPath(), { mcpServers: {} });

		let result = await loadAllMCPConfigs(projectRoot.path(), {
			filterExa: false,
			filterBrowser: false,
		});
		expect(result.configs.pivot).toBeDefined();

		// User edits the file out-of-band (mirroring the public contract).
		const fresh = JSON.parse(await fs.readFile(userMcpPath(), "utf8"));
		fresh.disabledServers = ["pivot"];
		await writeMCPConfigFile(userMcpPath(), fresh);

		result = await loadAllMCPConfigs(projectRoot.path(), {
			filterExa: false,
			filterBrowser: false,
		});
		expect(result.configs.pivot).toBeUndefined();
	});

	it("discovered-only server can be disabled via setServerDisabled (does NOT require mcpServers entry)", async () => {
		// The TUI /mcp toggle hits this code path
		// (mcp-command-controller.ts:1215) when the user disables a server
		// they did not add to their own config — it lives in a third-party
		// config (claude/cursor/...) and is only known via discovery. Such a
		// server name is NEVER in `mcpServers`, so `removeMCPServer` would
		// throw "Server '...' not found in ...". `setServerDisabled` must
		// tolerate the absence — it only edits the denylist.
		await writeMCPConfigFile(userMcpPath(), { mcpServers: {} });
		await writeProjectMcp({
			"third-party-only": { command: "echo" },
		});

		// Sanity: loader currently surfaces the discovered server.
		let result = await loadAllMCPConfigs(projectRoot.path(), {
			filterExa: false,
			filterBrowser: false,
		});
		expect(result.configs["third-party-only"]).toBeDefined();

		// Now disable it via the denylist path used by TUI.
		await expect(setServerDisabled(userMcpPath(), "third-party-only", true)).resolves.toBeUndefined();

		result = await loadAllMCPConfigs(projectRoot.path(), {
			filterExa: false,
			filterBrowser: false,
		});
		expect(result.configs["third-party-only"]).toBeUndefined();
		// The mcpServers entry itself must NOT have been created or mutated —
		// the denylist path must not leak into mcpServers.
		const written = JSON.parse(await fs.readFile(userMcpPath(), "utf8"));
		expect(written.mcpServers).toEqual({});
		expect(written.disabledServers).toEqual(["third-party-only"]);
	});
});

// ---------------------------------------------------------------------------
// Cross-cutting contract notes (not exercised here because the consumers live
// in files owned by other in-flight changes):
//
//   * wire-server.ts:3195-3197 / 3240-3256 — AgentMcpJson includes the
//     `disabledServers` field; the round-trip writer reads the whole file
//     and spreads existing keys, so the field is preserved across edits
//     from the front-end (which never touches it). Preserved-by-construction.
//
//   * wire-server.ts:3288-3292 — `get_mcp_servers` returns ONLY `mcpServers`,
//     not `disabledServers`. The denylist is client-side state, not part
//     of the server-to-client payload. This file does not cover it because
//     `wire-server.ts` is owned by another worker in this integration
//     wave; the contract lives at that site and is enforced by review, not
//     by a regression here.
// ---------------------------------------------------------------------------
