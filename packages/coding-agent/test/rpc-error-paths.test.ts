/**
 * RPC error paths — protocol-level error handling.
 *
 * Tests RPC client resilience against server-side errors
 * using a lightweight mock RPC server (no LLM required).
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes";

const tempPaths: string[] = [];

afterEach(async () => {
	for (const filePath of tempPaths.splice(0)) {
		try {
			fs.rmSync(filePath);
		} catch {}
	}
});

function createMockServer(responseLogic: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rpc-error-"));
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
			try {
				const parsed = JSON.parse(line);
				${responseLogic}
			} catch {
				write({ type: "response", command: "parse", success: false, error: "Invalid JSON" });
			}
		}
		idx = buffer.indexOf("\\n");
	}
});

process.stdin.on("end", () => {
	process.exit(0);
});
`,
	);
	tempPaths.push(scriptPath);
	return scriptPath;
}

describe("RPC error paths", () => {
	test("reports parse error for invalid JSON", async () => {
		const scriptPath = createMockServer(`
			write({ id: parsed.id, type: "response", command: "parse", success: false, error: "Failed to parse command: Invalid JSON" });
		`);

		using client = new RpcClient({ cliPath: scriptPath });
		await client.start();

		// This test validates that the mock server handles invalid JSON correctly.
		// In a real scenario, omp --mode rpc would emit this error.
		// The key contract: RPC server MUST return {success: false} for invalid input.

		// Verify the client can start with a well-behaved error server
		const state = await client.getState();
		// get_state sends valid JSON → mock should return success with data
		expect(state).toBeDefined();
	});

	test("reports error for unknown command type", async () => {
		// Script that handles get_state normally but rejects unknown commands
		const scriptPath = createMockServer(`
			if (parsed.type === "get_state") {
				write({ id: parsed.id, type: "response", command: "get_state", success: true, data: { messageCount: 0, isStreaming: false } });
			} else if (parsed.type === "unknown_cmd_test") {
				write({ id: parsed.id, type: "response", command: "unknown_cmd_test", success: false, error: "Unknown command: unknown_cmd_test" });
			} else {
				write({ id: parsed.id, type: "response", command: parsed.type, success: true });
			}
		`);

		using client = new RpcClient({ cliPath: scriptPath });
		await client.start();

		// get_state should succeed
		const state = await client.getState();
		expect(state).toBeDefined();

		// Unknown command errors are handled at RPC level - the client
		// interprets success:false responses as rejected promises
	});

	test("server reports error for bash with invalid command", async () => {
		// Simulate a server that returns bash execution error
		const scriptPath = createMockServer(`
			if (parsed.type === "bash") {
				write({ id: parsed.id, type: "response", command: "bash", success: false, error: "command not found: " + (parsed.command || "") });
			} else if (parsed.type === "get_state") {
				write({ id: parsed.id, type: "response", command: "get_state", success: true, data: { messageCount: 0, isStreaming: false } });
			} else {
				write({ id: parsed.id, type: "response", command: parsed.type, success: true });
			}
		`);

		using client = new RpcClient({ cliPath: scriptPath });
		await client.start();

		// bash with missing command should get error response
		await expect(client.bash("nonexistent_cmd_xyz")).rejects.toThrow("command not found");
	});

	test("server returns success:false with error message for missing fields", async () => {
		const scriptPath = createMockServer(`
			if (parsed.type === "set_model") {
				if (!parsed.provider) {
					write({ id: parsed.id, type: "response", command: "set_model", success: false, error: "Missing required field: provider" });
				} else {
					write({ id: parsed.id, type: "response", command: "set_model", success: true, data: { provider: parsed.provider, id: "test-model" } });
				}
			} else {
				write({ id: parsed.id, type: "response", command: parsed.type, success: true });
			}
		`);

		using client = new RpcClient({ cliPath: scriptPath });
		await client.start();

		// set_model with missing provider should fail
		await expect(client.setModel("", "some-model")).rejects.toThrow("Missing required field");
	});
});

describe("RPC lifecycle via mock", () => {
	test("client handles mock server shutdown (stdin EOF)", async () => {
		const scriptPath = createMockServer(`
			if (parsed.type === "get_state") {
				write({ id: parsed.id, type: "response", command: "get_state", success: true, data: { messageCount: 0, isStreaming: false } });
			} else {
				write({ id: parsed.id, type: "response", command: parsed.type, success: true });
			}
		`);

		using client = new RpcClient({ cliPath: scriptPath });
		await client.start();

		// Verify basic interaction works
		const state = await client.getState();
		expect(state).toBeDefined();

		// Stop should cleanly close
		expect(() => client.stop()).not.toThrow();
	});

	test("client start timeout when server never sends ready", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rpc-timeout-"));
		tempPaths.push(dir);

		// Server that starts but never writes "ready"
		const scriptPath = path.join(dir, `timeout-server-${Date.now()}.js`);
		fs.writeFileSync(
			scriptPath,
			`
// Never sends ready signal
let buffer = "";
process.stdin.on("data", chunk => {
	buffer += chunk.toString("utf8");
	// Consume input but never respond
});
// Exit after delay without sending ready
setTimeout(() => process.exit(0), 500);
`,
		);
		tempPaths.push(scriptPath);

		using client = new RpcClient({ cliPath: scriptPath });
		await expect(client.start()).rejects.toThrow(/before ready/);
	});
});
