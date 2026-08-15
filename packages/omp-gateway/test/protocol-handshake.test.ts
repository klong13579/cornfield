/**
 * RPC protocol handshake — the `omp --mode rpc` ready frame contract.
 *
 * The gateway only accepts agent subprocesses whose first stdout frame is
 * `{"type": "ready", "protocol_version": 1, "agent": "omp"}`. Legacy binaries
 * (no protocol_version) and future version mismatches are REJECTED with a
 * diagnostic error naming the fix (upgrade omp) — hard cutover, no silent
 * compatibility mode (see docs/gateway-binary-split-plan.md §5.4).
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RPC_PROTOCOL_VERSION, RpcTransport, resolveDefaultOmpPath } from "../src/agent-transport";

async function createFakeRpc(
	script: string,
	prefix = "proto-handshake-",
): Promise<{ path: string; cleanup: () => void }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	const scriptPath = path.join(dir, "fake-rpc");
	await fs.writeFile(scriptPath, script, { mode: 0o755 });
	return { path: scriptPath, cleanup: () => void fs.rm(dir, { recursive: true, force: true }) };
}

/** Ready + stay alive so `transport.start()` can observe the handshake. */
function holdOpen(readyFrame: string): string {
	return `#!/usr/bin/env bun
process.stdout.write(${JSON.stringify(readyFrame)} + "\\n");
await new Promise(() => {});
`;
}

const READY_V1 = holdOpen(JSON.stringify({ type: "ready", protocol_version: RPC_PROTOCOL_VERSION, agent: "omp" }));
const READY_LEGACY = holdOpen(JSON.stringify({ type: "ready" }));
const READY_V2 = holdOpen(JSON.stringify({ type: "ready", protocol_version: 2, agent: "omp" }));

describe("RpcTransport protocol handshake", () => {
	test("accepts a protocol_version 1 ready frame (current omp)", async () => {
		const fake = await createFakeRpc(READY_V1);
		const transport = new RpcTransport({ ompPath: fake.path, readyTimeoutMs: 5_000 });
		try {
			await transport.start();
			expect(transport.isReady).toBe(true);
		} finally {
			transport.stop();
			await fake.cleanup();
		}
	});

	test("rejects a legacy ready frame without protocol_version", async () => {
		const fake = await createFakeRpc(READY_LEGACY);
		const transport = new RpcTransport({ ompPath: fake.path, readyTimeoutMs: 5_000 });
		try {
			await expect(transport.start()).rejects.toThrow(/protocol_version.*Upgrade omp/s);
		} finally {
			transport.stop();
			await fake.cleanup();
		}
	});

	test("rejects a future protocol_version 2 ready frame", async () => {
		const fake = await createFakeRpc(READY_V2);
		const transport = new RpcTransport({ ompPath: fake.path, readyTimeoutMs: 5_000 });
		try {
			await expect(transport.start()).rejects.toThrow(/protocol_version 2/);
		} finally {
			transport.stop();
			await fake.cleanup();
		}
	});
});

describe("resolveDefaultOmpPath", () => {
	test("falls back to the PATH name when ~/.local/bin/omp is absent", async () => {
		// Use an empty temp dir as HOME — no ~/.local/bin/omp exists there.
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-omp-path-"));
		try {
			expect(resolveDefaultOmpPath(dir)).toBe("omp");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test("prefers ~/.local/bin/omp when present and executable", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-omp-path-"));
		try {
			const bin = path.join(dir, ".local", "bin");
			await fs.mkdir(bin, { recursive: true });
			await fs.writeFile(path.join(bin, "omp"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
			expect(resolveDefaultOmpPath(dir)).toBe(path.join(bin, "omp"));
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
