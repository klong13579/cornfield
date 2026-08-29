/**
 * Wire protocol handshake — the `cornfield --mode wire-stdio` hello_ack contract.
 *
 * The gateway only accepts agent subprocesses that complete the wire hello
 * handshake: after the transport sends `hello`, the first stdout frame must
 * be `hello_ack` carrying a numeric protocolVersion >= 1 (current wire
 * protocol: MULTIDEVICE_PROTOCOL_VERSION in packages/pi-wire/src/frames.ts).
 * Peers that answer `hello_error` (legacy binaries, no wire protocol support)
 * and peers that ack with an incompatible protocolVersion are REJECTED with a
 * diagnostic error naming the fix (upgrade cornfield) — hard cutover, no silent
 * compatibility mode (see docs/gateway-binary-split-plan.md §5.4).
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MULTIDEVICE_PROTOCOL_VERSION } from "@cornfield/wire";
import { resolveDefaultOmpPath, WireTransport } from "../src/agent-transport-wire";

async function createFakeWire(
	script: string,
	prefix = "proto-handshake-",
): Promise<{ path: string; cleanup: () => void }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	const scriptPath = path.join(dir, "fake-wire");
	await fs.writeFile(scriptPath, script, { mode: 0o755 });
	return { path: scriptPath, cleanup: () => void fs.rm(dir, { recursive: true, force: true }) };
}

/** hello_ack + stay alive so `transport.start()` can observe the handshake. */
function holdOpen(helloAck: string): string {
	return `#!/usr/bin/env bun
process.stdout.write(${JSON.stringify(helloAck)} + "\\n");
await new Promise(() => {});
`;
}

/** Emit the frame, then exit shortly after — a deterministic pre-ready rejection. */
function respondThenExit(frame: string): string {
	return `#!/usr/bin/env bun
process.stdout.write(${JSON.stringify(frame)} + "\\n");
setTimeout(() => process.exit(0), 100);
`;
}

const HELLO_ACK_V1 = JSON.stringify({
	type: "hello_ack",
	connectionId: "proto",
	protocolVersion: MULTIDEVICE_PROTOCOL_VERSION,
});
const HELLO_ACK_BAD_VERSION = JSON.stringify({ type: "hello_ack", connectionId: "proto", protocolVersion: 0 });
const HELLO_ERROR_LEGACY = JSON.stringify({
	type: "hello_error",
	error: "legacy binary: no wire protocol support, upgrade cornfield",
});

describe("WireTransport protocol handshake", () => {
	test("accepts a protocolVersion 1 hello_ack (current wire protocol)", async () => {
		const fake = await createFakeWire(holdOpen(HELLO_ACK_V1));
		const transport = new WireTransport({ ompPath: fake.path, readyTimeoutMs: 5_000 });
		try {
			await transport.start();
			expect(transport.isReady).toBe(true);
		} finally {
			transport.stop();
			await fake.cleanup();
		}
	});

	test("rejects a legacy peer answering with hello_error (no wire protocol support)", async () => {
		const fake = await createFakeWire(respondThenExit(HELLO_ERROR_LEGACY));
		const transport = new WireTransport({ ompPath: fake.path, readyTimeoutMs: 5_000 });
		try {
			await expect(transport.start()).rejects.toThrow(/hello rejected: legacy binary.*upgrade cornfield/s);
		} finally {
			transport.stop();
			await fake.cleanup();
		}
	});

	test("rejects a hello_ack with an incompatible protocolVersion", async () => {
		const fake = await createFakeWire(respondThenExit(HELLO_ACK_BAD_VERSION));
		const transport = new WireTransport({ ompPath: fake.path, readyTimeoutMs: 5_000 });
		try {
			await expect(transport.start()).rejects.toThrow(/Incompatible wire protocol version: 0/);
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
			expect(resolveDefaultOmpPath(dir)).toBe("cornfield");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test("prefers ~/.local/bin/omp when present and executable", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-omp-path-"));
		try {
			const bin = path.join(dir, ".local", "bin");
			await fs.mkdir(bin, { recursive: true });
			await fs.writeFile(path.join(bin, "cornfield"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
			expect(resolveDefaultOmpPath(dir)).toBe(path.join(bin, "cornfield"));
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
