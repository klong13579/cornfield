/**
 * RpcTransport disconnected-event emission.
 *
 * Plan v2 Fix B: after the subprocess reaches `ready` and then exits, the
 * transport must emit `{type: "disconnected"}` so the bridge can record
 * the crash and back off. Without this emit, the disconnect was
 * silent — the bridge only learned on its next `transport.start()`
 * retry, which could take 30+ seconds to surface as a `before ready`
 * error. Before the fix, the `disconnected` event type existed in the
 * union but was never produced by any code path (dead code).
 *
 * Pre-ready exits must continue to reject `#spawnAndWaitReady()` with
 * `exited with code N before ready` — that's the original contract.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RpcTransport, type RpcTransportEvent } from "../src/agent-transport";

let tmpDir: string;

const SCRIPT_CRASH_AFTER_READY = `#!/usr/bin/env bun
process.stdout.write(JSON.stringify({ type: "ready" }) + "\\n");
setTimeout(() => process.exit(7), 50);
`;

const SCRIPT_CRASH_BEFORE_READY = `#!/usr/bin/env bun
// Exit immediately, never emit ready.
process.exit(9);
`;

const SCRIPT_NEVER_READY = `#!/usr/bin/env bun
// Stay alive but never emit ready.
setInterval(() => {}, 1000);
`;

async function writeScript(content: string): Promise<string> {
	const p = path.join(tmpDir, `fake-${Math.random().toString(36).slice(2, 8)}`);
	await Bun.write(p, content);
	await fs.chmod(p, 0o755);
	return p;
}

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-gateway-disconnect-"));
});

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("RpcTransport disconnected event", () => {
	test("emits disconnected after subprocess exits post-ready", async () => {
		const scriptPath = await writeScript(SCRIPT_CRASH_AFTER_READY);
		const transport = new RpcTransport({ ompPath: scriptPath, readyTimeoutMs: 5_000 });
		const events: RpcTransportEvent[] = [];
		transport.onEvent(e => events.push(e));
		await transport.start();
		expect(events.some(e => e.type === "ready")).toBe(true);
		// Wait long enough for the subprocess to exit (50ms + slack).
		await Bun.sleep(200);
		const disc = events.find(e => e.type === "disconnected");
		expect(disc).toBeDefined();
		expect(disc?.error?.message).toMatch(/exited with code 7/);
		expect(disc?.error?.message).toMatch(/wasReady=true/);
		await transport.stop();
	});

	test("pre-ready exit rejects start() with before-ready error (no disconnected emit during start)", async () => {
		const scriptPath = await writeScript(SCRIPT_CRASH_BEFORE_READY);
		const transport = new RpcTransport({ ompPath: scriptPath, readyTimeoutMs: 5_000 });
		const events: RpcTransportEvent[] = [];
		transport.onEvent(e => events.push(e));
		await expect(transport.start()).rejects.toThrow(/exited with code 9 before ready/);
		// No disconnected event is expected from the start() promise — the
		// pre-ready path is handled via rejection. The exit handler in
		// `#spawnAndWaitReady` does skip the emit when not yet ready.
		expect(events.filter(e => e.type === "disconnected")).toHaveLength(0);
	});

	test("subprocess that never reaches ready hits readyTimeoutMs", async () => {
		const scriptPath = await writeScript(SCRIPT_NEVER_READY);
		const transport = new RpcTransport({ ompPath: scriptPath, readyTimeoutMs: 200 });
		await expect(transport.start()).rejects.toThrow(/timed out waiting for ready/);
		await transport.stop();
	});

	test("transport cleanup wipes proc and stdinWriter after post-ready crash", async () => {
		const scriptPath = await writeScript(SCRIPT_CRASH_AFTER_READY);
		const transport = new RpcTransport({ ompPath: scriptPath, readyTimeoutMs: 5_000 });
		await transport.start();
		await Bun.sleep(200);
		// After disconnect, the writer is cleared — sendFrame throws a
		// clear "Agent process not running" error instead of crashing
		// on a stale writer. This is the contract: callers see the
		// truth that the subprocess is gone.
		expect(() => transport.sendFrame("prompt", { id: "x", message: "y" })).toThrow(/not running/);
	});
});
