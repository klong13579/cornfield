/**
 * Gateway account as an intercom child (#2 leftover): `intercomParent`
 * account config → transport spawn env.
 *
 * Covers the two ends of the plumbing:
 *   - WireTransport injects PI_SUBAGENT_ORCHESTRATOR_TARGET/_RUN_ID/_CHILD_AGENT/
 *     _CHILD_INDEX into the spawned omp child when `intercomParent` is set;
 *     without it, no child env leaks into the process.
 *   - createAccountBridgeOptions forwards `account.intercomParent` into the
 *     bridge options.
 *
 * The bridge-level hop (AgentBridgeOptions → WireTransport) is type-checked
 * only; the runtime contract is the transport env + options factory below.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { WireTransport } from "../src/agent-transport-wire";
import { createAccountBridgeOptions } from "../src/gateway";

let tmpDir: string;

const SCRIPT_DUMP_CHILD_ENV = `#!/usr/bin/env bun
const fs = require("node:fs");
fs.writeFileSync(
  process.env.__INTERCOM_CHILD_DUMP!,
  JSON.stringify({
    target: process.env.PI_SUBAGENT_ORCHESTRATOR_TARGET ?? null,
    runId: process.env.PI_SUBAGENT_RUN_ID ?? null,
    agent: process.env.PI_SUBAGENT_CHILD_AGENT ?? null,
    index: process.env.PI_SUBAGENT_CHILD_INDEX ?? null,
  }),
);
// Wire handshake: reply hello_ack so WireTransport.start() resolves.
process.stdout.write(JSON.stringify({ type: "hello_ack", connectionId: "intercom-child", protocolVersion: 1 }) + "\\n");
setInterval(() => {}, 1000);
`;

async function writeScript(): Promise<string> {
	const p = path.join(tmpDir, `fake-${Math.random().toString(36).slice(2, 8)}`);
	await Bun.write(p, SCRIPT_DUMP_CHILD_ENV);
	await fs.chmod(p, 0o755);
	return p;
}

async function waitForFile(p: string, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			await fs.access(p);
			return;
		} catch {
			await Bun.sleep(50);
		}
	}
	throw new Error(`timed out waiting for ${p}`);
}

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cornfield-gateway-intercom-child-"));
});

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("WireTransport intercom child env", () => {
	test("injects PI_SUBAGENT_* env when intercomParent is set", async () => {
		const scriptPath = await writeScript();
		const outPath = path.join(tmpDir, "env-dump-with.json");
		const transport = new WireTransport({
			cornfieldPath: scriptPath,
			readyTimeoutMs: 5_000,
			intercomParent: "main-omp",
			cwd: tmpDir,
		});
		// The script reads the dump path from the env var the test sets below.
		(process.env as Record<string, unknown>).__INTERCOM_CHILD_DUMP = outPath;
		try {
			await transport.start();
			await waitForFile(outPath);
			const env = JSON.parse(await Bun.file(outPath).text()) as Record<string, string | null>;
			expect(env.target).toBe("main-omp");
			expect(env.runId).toBeTruthy();
			expect(env.agent).toBe("gateway-account");
			expect(env.index).toBe("0");
		} finally {
			await transport.stop();
			delete (process.env as Record<string, unknown>).__INTERCOM_CHILD_DUMP;
		}
	});

	test("does not inject child env without intercomParent", async () => {
		const scriptPath = await writeScript();
		const outPath = path.join(tmpDir, "env-dump-without.json");
		const transport = new WireTransport({
			cornfieldPath: scriptPath,
			readyTimeoutMs: 5_000,
			cwd: tmpDir,
		});
		(process.env as Record<string, unknown>).__INTERCOM_CHILD_DUMP = outPath;
		try {
			await transport.start();
			await waitForFile(outPath);
			const env = JSON.parse(await Bun.file(outPath).text()) as Record<string, string | null>;
			expect(env.target).toBeNull();
			expect(env.runId).toBeNull();
			expect(env.agent).toBeNull();
			expect(env.index).toBeNull();
		} finally {
			await transport.stop();
			delete (process.env as Record<string, unknown>).__INTERCOM_CHILD_DUMP;
		}
	});
});

describe("createAccountBridgeOptions intercomParent passthrough", () => {
	test("forwards account.intercomParent into bridge options", async () => {
		const options = await createAccountBridgeOptions(
			{},
			"hr-account",
			{ appKey: "a", appSecret: "s", intercomParent: "main-omp" },
			path.join(tmpDir, "agent"),
		);
		expect(options.intercomParent).toBe("main-omp");
	});

	test("leaves intercomParent undefined when the account has none", async () => {
		const options = await createAccountBridgeOptions(
			{},
			"hr-account",
			{ appKey: "a", appSecret: "s" },
			path.join(tmpDir, "agent"),
		);
		expect(options.intercomParent).toBeUndefined();
	});
});
