import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { postmortem } from "@oh-my-pi/pi-utils";
import type { SourceMeta } from "../src/capability/types";
import * as mcpClient from "../src/mcp/client";
import { MCPManager } from "../src/mcp/manager";
import { StdioTransport } from "../src/mcp/transports/stdio";
import type { MCPServerCapabilities, MCPServerConnection } from "../src/mcp/types";

const testSource: SourceMeta = {
	provider: "mcp",
	providerName: "MCP",
	path: "/tmp/.mcp.json",
	level: "project",
};

const stubCapabilities: MCPServerCapabilities = { tools: {} };
const stubServerInfo = { name: "test", version: "1.0" };

/**
 * These tests verify the postmortem `mcp-disconnect` wiring added in sdk.ts.
 * The wiring is responsible for killing MCP child stdio processes on OMP
 * exit (SIGINT/SIGTERM/SIGHUP/uncaughtException). Without it, clean OMP
 * exits rely on the child noticing its stdin pipe closed, which leaves a
 * window where the child is still alive and holding the lbug file open.
 */
describe("MCP postmortem disconnect", () => {
	let cancel: (() => void) | null = null;
	const pidFilesToCleanup = new Set<string>();

	afterEach(async () => {
		cancel?.();
		cancel = null;
		for (const f of pidFilesToCleanup) {
			await fs.unlink(f).catch(() => {});
		}
		pidFilesToCleanup.clear();
		vi.restoreAllMocks();
	});

	/**
	 * End-to-end: a real stdio child is spawned, the postmortem callback
	 * replicates the exact `mcp-disconnect` registration from sdk.ts, and
	 * triggering postmortem cleanup must kill the child.
	 */
	it("kills the mcp child subprocess when the postmortem callback fires", async () => {
		const pidFile = path.join(os.tmpdir(), `mcp-exit-cleanup-${process.pid}-${Date.now()}.pid`);
		pidFilesToCleanup.add(pidFile);

		// The child writes its own pid to pidFile then blocks on stdin so we
		// can observe its death from the test.
		const childScript = `
			(async () => {
				const fs = require("node:fs/promises");
				await fs.writeFile(${JSON.stringify(pidFile)}, String(process.pid));
				process.stdin.resume();
			})();
		`;

		const transport = new StdioTransport({
			command: "node",
			args: ["-e", childScript],
			cwd: os.tmpdir(),
		});
		await transport.connect();

		const childPid = await waitForPid(pidFile);
		expect(isAlive(childPid)).toBe(true);

		const connection: MCPServerConnection = {
			name: "fake",
			config: { type: "stdio", command: "node", args: ["-e", childScript], cwd: os.tmpdir() },
			transport,
			serverInfo: stubServerInfo,
			capabilities: stubCapabilities,
		};

		vi.spyOn(mcpClient, "connectToServer").mockResolvedValue(connection);

		const manager = new MCPManager(os.tmpdir());
		await manager.connectServers(
			{
				fake: {
					type: "stdio",
					command: "node",
					args: ["-e", childScript],
					cwd: os.tmpdir(),
				},
			},
			{ fake: testSource },
		);
		expect(manager.getConnectionStatus("fake")).toBe("connected");

		// Replicate the SDK's postmortem registration verbatim. The exact
		// shape matters: the production code wraps disconnectAll in
		// try/catch + logs on failure.
		cancel = postmortem.register("test-mcp-disconnect", async () => {
			try {
				await manager.disconnectAll();
			} catch (err) {
				// Mirror the SDK warning behavior
				console.warn("MCP postmortem disconnect failed", err);
			}
		});

		// Run all registered postmortem callbacks. postmortem.cleanup()
		// invokes every registered handler with Reason.MANUAL — this is
		// the same code path postmortem uses for SIGINT/SIGTERM/SIGHUP,
		// just with a different Reason enum value. Other module-level
		// callbacks (terminal-restore, ssh-cleanup, etc.) are safe in a
		// non-TUI test env: terminal-restore is a no-op without an
		// activeTerminal, and the rest are guarded by empty state.
		await postmortem.cleanup();

		// The child must be gone.
		await waitForExit(childPid, 2_000);
		expect(isAlive(childPid)).toBe(false);
	});

	/**
	 * Source-level guard: the wiring must be present in sdk.ts. This catches
	 * accidental removal during refactors. It complements the behavioral
	 * test above (which uses a mock to keep the test independent of the
	 * heavier createAgentSession path).
	 */
	it("sdk.ts registers the mcp-disconnect postmortem callback", async () => {
		const sdkPath = path.join(import.meta.dir, "..", "src", "sdk.ts");
		const source = await Bun.file(sdkPath).text();
		expect(source).toMatch(/postmortem\.register\(\s*["']mcp-disconnect["']/);
		// And it must call disconnectAll on the mcpManager, not a stale ref
		expect(source).toMatch(/mcpManager\.disconnectAll\(\)/);
	});
});

/**
 * Returns true if pid is alive (signal 0 succeeds).
 */
function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Polls pidFile until the child has written its pid, or throws.
 */
async function waitForPid(pidFile: string, timeoutMs = 2_000): Promise<number> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			const pid = parseInt(await Bun.file(pidFile).text(), 10);
			if (pid > 0) return pid;
		} catch {
			// file not written yet
		}
		await Bun.sleep(20);
	}
	throw new Error(`child did not write pid to ${pidFile} within ${timeoutMs}ms`);
}

/**
 * Polls until the pid is no longer alive, or throws.
 */
async function waitForExit(pid: number, timeoutMs = 2_000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (!isAlive(pid)) return;
		await Bun.sleep(20);
	}
	throw new Error(`pid ${pid} still alive after ${timeoutMs}ms`);
}
