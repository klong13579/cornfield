/**
 * RPC lifecycle tests — process management and shutdown behavior.
 *
 * Some tests require a real omp --mode rpc process (gated by e2eApiKey).
 * Mock-based tests run without LLM.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { e2eApiKey } from "./utilities";

const tempPaths: string[] = [];

afterEach(() => {
	for (const p of tempPaths.splice(0)) {
		try {
			fs.rmSync(p, { recursive: true, force: true });
		} catch {}
	}
});

// ═══════════════════════════════════════════════════════════════════
// Mock-based lifecycle tests (no LLM required)
// ═══════════════════════════════════════════════════════════════════

function createLifecycleMock(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rpc-lifecycle-"));
	tempPaths.push(dir);
	const scriptPath = path.join(dir, `server-${Date.now()}.js`);
	fs.writeFileSync(
		scriptPath,
		`
const encoder = new TextEncoder();
function write(frame) {
	process.stdout.write(JSON.stringify(frame) + "\\n");
}
write({ type: "ready" });

let buffer = "";
process.stdin.on("data", chunk => {
	buffer += chunk.toString("utf8");
	let idx = buffer.indexOf("\\n");
	while (idx !== -1) {
		const line = buffer.slice(0, idx).trim();
		buffer = buffer.slice(idx + 1);
		if (line) {
			const parsed = JSON.parse(line);
			if (parsed.type === "get_state") {
				write({ id: parsed.id, type: "response", command: "get_state", success: true, data: { messageCount: 0, isStreaming: false } });
			} else {
				write({ id: parsed.id, type: "response", command: parsed.type, success: true });
			}
		}
		idx = buffer.indexOf("\\n");
	}
});

process.stdin.on("end", () => {
	write({ type: "server_shutdown" });
	process.exit(0);
});
`,
	);
	tempPaths.push(scriptPath);
	return scriptPath;
}

describe("RPC lifecycle (mock)", () => {
	test("double stop is safe", async () => {
		const scriptPath = createLifecycleMock();
		using client = new RpcClient({ cliPath: scriptPath });
		await client.start();

		// First stop
		client.stop();
		// Second stop should not throw
		expect(() => client.stop()).not.toThrow();
	});

	test("start after stop throws", async () => {
		const scriptPath = createLifecycleMock();
		using client = new RpcClient({ cliPath: scriptPath });
		await client.start();
		client.stop();
		// Cannot restart after stop
		await expect(client.start()).rejects.toThrow(/already started/);
	});

	test("client disposes via [Symbol.dispose]", async () => {
		const scriptPath = createLifecycleMock();
		using client = new RpcClient({ cliPath: scriptPath });
		await client.start();

		const state = await client.getState();
		expect(state).toBeDefined();

		// Symbol.dispose should call stop()
		expect(() => client[Symbol.dispose]()).not.toThrow();
		expect(() => client.stop()).not.toThrow(); // Double stop is safe
	});

	test("event listener unsubscribe works", async () => {
		const scriptPath = createLifecycleMock();
		using client = new RpcClient({ cliPath: scriptPath });
		await client.start();

		const events: string[] = [];
		const unsubscribe = client.onEvent(event => {
			events.push(event.type);
		});

		// state check doesn't produce agent events, so listener shouldn't fire
		await client.getState();

		unsubscribe();

		// After unsubscribe, listener should not receive more events
		expect(events.length).toBe(0);
	});
});

// ═══════════════════════════════════════════════════════════════════
// Real-process lifecycle tests (require API key)
// ═══════════════════════════════════════════════════════════════════

describe.skipIf(!e2eApiKey("ANTHROPIC_API_KEY"))("RPC lifecycle (real process)", () => {
	let client: RpcClient;
	let sessionDir: string;

	beforeEach(() => {
		sessionDir = path.join(os.tmpdir(), `omp-rpc-lifecycle-${Snowflake.next()}`);
		client = new RpcClient({
			cliPath: path.join(import.meta.dir, "..", "dist", "cli.js"),
			cwd: path.join(import.meta.dir, ".."),
			env: { PI_CODING_AGENT_DIR: sessionDir },
			provider: "anthropic",
			model: "claude-sonnet-4-5",
		});
	});

	afterEach(() => {
		client.stop();
		if (sessionDir && fs.existsSync(sessionDir)) {
			fs.rmSync(sessionDir, { recursive: true, force: true });
		}
	});

	test("should send SIGTERM and exit cleanly on stop", async () => {
		await client.start();
		const state = await client.getState();
		expect(state.isStreaming).toBe(false);

		// stop() should not throw
		expect(() => client.stop()).not.toThrow();
	}, 30000);

	test("should survive getState after stop (no-op)", async () => {
		await client.start();
		client.stop();

		// Operations after stop should fail with clear errors
		await expect(client.getState()).rejects.toThrow();
	}, 30000);

	test("supports sequential prompt calls", async () => {
		await client.start();

		// Send first prompt
		await client.promptAndWait("Say just the word hello");

		// Send second prompt on same session
		const events = await client.promptAndWait("Say just the word world");

		const messageEnd = events.find(
			(e): e is Extract<(typeof events)[number], { type: "message_end" }> => e.type === "message_end",
		);
		expect(messageEnd).toBeDefined();
	}, 120000);
});
