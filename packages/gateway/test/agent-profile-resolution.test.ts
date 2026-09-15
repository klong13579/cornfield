/**
 * Gateway agent binding resolution (WP2).
 *
 *   1. `resolveAccountAgentBinding` — account → Agent profile / agentDir. Covers the
 *      legacy shapes (declared `agentDir`, no `agentId`), the new shape (`agentId`
 *      only, resolved through the registry), the accountId fallback and the default
 *      home, plus the reverse lookup that turns a legacy `agentDir` back into the
 *      Agent's registry id.
 *   2. A real Gateway boot (fake RPC binary + fake DingTalk channel) — the account →
 *      agentDir map every other gateway path consumes is the binding's result, and a
 *      second account pointing at an Agent's existing home does not mint a duplicate
 *      `registry.json` entry.
 *
 * HOME is isolated in every test: the gateway registers accounts into the real
 * `~/.cornfield/agent/registry.json` unless HOME points elsewhere.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@cornfield/utils";
import { resolveAccountAgentBinding } from "../src/agent-profile";
import { DingTalkChannel } from "../src/channels/dingtalk";
import { validateAndNormalizeConfig } from "../src/config";
import { Gateway } from "../src/gateway";

// ═══════════════════════════════════════════════════════════════════════
// Fixtures: isolated HOME + a registry.json + agentDirs with declarations
// ═══════════════════════════════════════════════════════════════════════

interface Fixture {
	root: string;
	home: string;
	/** `<root>/<name>` agentDirs that exist on disk. */
	dir: (name: string) => string;
	cleanup: () => Promise<void>;
}

async function createFixture(): Promise<Fixture> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gw-agent-binding-"));
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

/** Write `~/.cornfield/agent/registry.json` for the isolated HOME. */
async function writeRegistry(home: string, agents: Record<string, string>): Promise<void> {
	const entries: Record<string, unknown> = {};
	for (const [name, dir] of Object.entries(agents)) {
		entries[name] = { path: dir, registeredAt: new Date().toISOString(), template: "default", displayName: name };
	}
	await Bun.write(
		path.join(home, ".cornfield", "agent", "registry.json"),
		JSON.stringify({ version: 2, agents: entries }, null, 2),
	);
}

async function readRegistry(home: string): Promise<Record<string, { path: string }>> {
	const text = await Bun.file(path.join(home, ".cornfield", "agent", "registry.json")).text();
	return (JSON.parse(text) as { agents: Record<string, { path: string }> }).agents;
}

/** Create an agentDir carrying a schema-v2 declaration named `name`. */
async function makeAgentDir(dir: string, name: string): Promise<void> {
	await fs.mkdir(path.join(dir, ".cornfield"), { recursive: true });
	await Bun.write(
		path.join(dir, ".cornfield", "workspace.json"),
		JSON.stringify(
			{
				schemaVersion: 2,
				id: name,
				name,
				type: "agent",
				root: ".",
				projectRoot: ".",
				updatedAt: new Date().toISOString(),
			},
			null,
			2,
		),
	);
}

// ═══════════════════════════════════════════════════════════════════════
// 1. Account → Agent binding
// ═══════════════════════════════════════════════════════════════════════

describe("resolveAccountAgentBinding", () => {
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

	test("legacy account: declared agentDir wins and reverse-resolves the Agent id", async () => {
		const agentDir = fixture.dir("hr3");
		await makeAgentDir(agentDir, "HR 助手");
		await writeRegistry(fixture.home, { hr: agentDir });

		const binding = await resolveAccountAgentBinding("hr", { agentDir });

		expect(binding.agentDir).toBe(agentDir);
		expect(binding.agentDirSource).toBe("declared");
		expect(binding.agentId).toBe("hr");
		expect(binding.profile?.displayName).toBe("HR 助手");
		expect(binding.conflict).toBeUndefined();
	});

	test("legacy account whose dir is NOT registered still resolves verbatim (no migration)", async () => {
		const agentDir = fixture.dir("omp-legacy");
		await writeRegistry(fixture.home, {});

		const binding = await resolveAccountAgentBinding("legacy", { agentDir });

		expect(binding.agentDir).toBe(agentDir);
		expect(binding.agentDirSource).toBe("declared");
		expect(binding.agentId).toBe("legacy");
		expect(binding.profile).toBeNull();
		expect(binding.conflict).toBeUndefined();
	});

	test("agentId-only account resolves agentDir through the registry", async () => {
		const agentDir = fixture.dir("omp-atomix");
		await makeAgentDir(agentDir, "算法");
		await writeRegistry(fixture.home, { algorithm: agentDir });

		// Account key and registry key differ: the gateway account is `omp-atomix`,
		// the Agent it speaks for is `algorithm`.
		const binding = await resolveAccountAgentBinding("omp-atomix", { agentId: "algorithm" });

		expect(binding.agentId).toBe("algorithm");
		expect(binding.agentDir).toBe(agentDir);
		expect(binding.agentDirSource).toBe("registry");
		expect(binding.profile?.displayName).toBe("算法");
	});

	test("account with no declaration resolves through its own registry key", async () => {
		const agentDir = fixture.dir("me");
		await makeAgentDir(agentDir, "me");
		await writeRegistry(fixture.home, { me: agentDir });

		const binding = await resolveAccountAgentBinding("me", {});

		expect(binding.agentId).toBe("me");
		expect(binding.agentDir).toBe(agentDir);
		expect(binding.agentDirSource).toBe("registry");
	});

	test("account with nothing declared and nothing registered falls back to the default home", async () => {
		await writeRegistry(fixture.home, {});

		const binding = await resolveAccountAgentBinding("nobody", {});

		expect(binding.agentId).toBe("nobody");
		expect(binding.agentDirSource).toBe("default");
		expect(binding.agentDir).toBe(path.join(os.homedir(), ".cornfield", "agents", "nobody"));
		expect(binding.profile).toBeNull();
	});

	test("declared agentDir and registered agentId that disagree: declared wins, conflict reported", async () => {
		const registeredDir = fixture.dir("registered");
		const declaredDir = fixture.dir("stale");
		await writeRegistry(fixture.home, { hr: registeredDir });
		const warn = spyOn(logger, "warn").mockImplementation(() => undefined as never);

		const binding = await resolveAccountAgentBinding("hr", { agentId: "hr", agentDir: declaredDir });

		expect(binding.agentDir).toBe(declaredDir);
		expect(binding.agentDirSource).toBe("declared");
		expect(binding.profile).toBeNull();
		expect(binding.conflict).toEqual({
			requestedAgentId: "hr",
			declaredAgentDir: declaredDir,
			registeredAgentDir: registeredDir,
		});
		expect(warn.mock.calls.some(call => String(call[0]).includes("disagrees"))).toBe(true);
	});

	test("trailing separator on the declared dir still finds the registered Agent", async () => {
		const agentDir = fixture.dir("hr3");
		await makeAgentDir(agentDir, "HR");
		await writeRegistry(fixture.home, { hr: agentDir });

		const binding = await resolveAccountAgentBinding("hr", { agentDir: `${agentDir}/` });

		expect(binding.agentId).toBe("hr");
		// The registry's canonical spelling, not the caller's duplicate separator.
		expect(binding.agentDir).toBe(agentDir);
	});

	test("empty-string agentDir is treated as absent, not as a path", async () => {
		const agentDir = fixture.dir("hr3");
		await writeRegistry(fixture.home, { hr: agentDir });

		const binding = await resolveAccountAgentBinding("hr", { agentDir: "" });

		expect(binding.agentDirSource).toBe("registry");
		expect(binding.agentDir).toBe(agentDir);
	});

	test("profile always owns the binding's home (binding never carries a contradictory profile)", async () => {
		const registeredDir = fixture.dir("registered");
		await writeRegistry(fixture.home, { hr: registeredDir });

		for (const account of [{}, { agentId: "hr" }, { agentDir: registeredDir }, { agentDir: fixture.dir("x") }]) {
			const binding = await resolveAccountAgentBinding("hr", account);
			if (binding.profile) expect(binding.profile.agentDir).toBe(binding.agentDir);
		}
	});

	test("config schema accepts agentId and keeps old accounts valid", () => {
		const base = { appKey: "k", appSecret: "s" };
		const oldAccount = validateAndNormalizeConfig({
			channels: { dingtalk: { enabled: true, accounts: { hr: { ...base, agentDir: "/tmp/hr3" } } } },
		});
		expect(oldAccount.channels.dingtalk.accounts.hr.agentDir).toBe("/tmp/hr3");
		expect(oldAccount.channels.dingtalk.accounts.hr.agentId).toBeUndefined();

		const newAccount = validateAndNormalizeConfig({
			channels: { dingtalk: { enabled: true, accounts: { algorithm: { ...base, agentId: "algorithm" } } } },
		});
		expect(newAccount.channels.dingtalk.accounts.algorithm.agentId).toBe("algorithm");

		expect(() =>
			validateAndNormalizeConfig({
				channels: { dingtalk: { enabled: true, accounts: { hr: { ...base, agentId: "" } } } },
			}),
		).toThrow();
	});
});

// ═══════════════════════════════════════════════════════════════════════
// 2. Boot a real Gateway over the binding
// ═══════════════════════════════════════════════════════════════════════

const FAKE_RPC_SCRIPT = `#!/usr/bin/env bun
let buffer = "";
function emit(v) { process.stdout.write(JSON.stringify(v) + "\\n"); }
async function handleFrame(frame) {
  if (frame.type === "hello") {
    emit({ type: "hello_ack", connectionId: "binding", protocolVersion: 1 });
    return;
  }
  if (frame.type !== "request") return;
  emit({ type: "response", id: frame.id, ok: true });
}
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk);
  let i = buffer.indexOf("\\n");
  while (i !== -1) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (line) await handleFrame(JSON.parse(line));
    i = buffer.indexOf("\\n");
  }
}
`;

class FakeDWClient extends EventEmitter {
	socketCallBackResponse(_messageId: string, _result: { success: boolean }): void {}
	async connect(): Promise<void> {
		(this as any).socket = new EventEmitter();
		(this as any).socket.readyState = 1;
		this.emit("connect");
	}
	disconnect(): void {
		(this as any).socket = null;
		this.emit("disconnect");
	}
	registerCallbackListener(_topic: string, _handler: (msg: unknown) => void): void {}
}

class FakeDingTalkChannel extends DingTalkChannel {
	protected override createDWClient(_opts: {
		clientId: string;
		clientSecret: string;
		ua?: string;
		debug?: boolean;
		autoReconnect?: boolean;
	}): FakeDWClient {
		return new FakeDWClient();
	}
}

describe("Gateway boots over resolved Agent bindings", () => {
	let fixture: Fixture;
	let savedHome: string | undefined;
	let savedTestMode: string | undefined;
	let rpcPath: string;
	let gateway: Gateway | undefined;

	beforeEach(async () => {
		fixture = await createFixture();
		savedHome = process.env.HOME;
		process.env.HOME = fixture.home;
		// The test-mode guard skips registry writes for temp agentDirs; this suite
		// asserts on those writes, so it must run outside test mode.
		savedTestMode = process.env.CORNFIELD_GATEWAY_TEST_MODE;
		delete process.env.CORNFIELD_GATEWAY_TEST_MODE;
		rpcPath = path.join(fixture.root, "fake-rpc");
		await Bun.write(rpcPath, FAKE_RPC_SCRIPT);
		await fs.chmod(rpcPath, 0o755);
	});

	afterEach(async () => {
		await gateway?.stop();
		gateway = undefined;
		if (savedHome === undefined) delete process.env.HOME;
		else process.env.HOME = savedHome;
		if (savedTestMode === undefined) delete process.env.CORNFIELD_GATEWAY_TEST_MODE;
		else process.env.CORNFIELD_GATEWAY_TEST_MODE = savedTestMode;
		await fixture.cleanup();
	});

	test("legacy and agentId accounts both land on the Agent's home; no duplicate registry entry", async () => {
		// The live OMP-workspace-test shape: the account key is the registry key and
		// gateway.json declares the (non-default) directory explicitly.
		const hrDir = fixture.dir("hr3");
		await makeAgentDir(hrDir, "HR");
		// A second shape: the account names its Agent instead of its directory.
		const algorithmDir = fixture.dir("omp-atomix");
		await makeAgentDir(algorithmDir, "算法");
		await writeRegistry(fixture.home, { hr: hrDir, algorithm: algorithmDir });

		const config = {
			channels: {
				dingtalk: {
					enabled: true,
					accounts: {
						hr: { appKey: "k1", appSecret: "s1", agentDir: hrDir },
						algorithm: { appKey: "k2", appSecret: "s2", agentId: "algorithm" },
						// A second robot for the same Agent: same home, different IM account.
						"omp-atomix": { appKey: "k3", appSecret: "s3", agentId: "algorithm", agentDir: algorithmDir },
					},
				},
			},
			agent: { cornfieldPath: rpcPath },
			session: { resetPolicy: "none" as const },
			dataDir: fixture.root,
			intercomDir: path.join(fixture.root, "intercom"),
		};

		gateway = new Gateway(config, { channelFactory: () => new FakeDingTalkChannel() });
		await gateway.start();

		const status = await gateway.getStatus();
		const byAccount = new Map(status.accounts.map(a => [a.accountId, a.agentDir]));
		expect(byAccount.get("hr")).toBe(hrDir);
		expect(byAccount.get("algorithm")).toBe(algorithmDir);
		expect(byAccount.get("omp-atomix")).toBe(algorithmDir);

		const registered = await readRegistry(fixture.home);
		// Both Agent homes stay registered under their own Agent id...
		expect(registered.hr.path).toBe(hrDir);
		expect(registered.algorithm.path).toBe(algorithmDir);
		// ...and the second robot does not mint a duplicate Agent for `algorithm`'s home.
		expect(registered["omp-atomix"]).toBeUndefined();
	});
});
