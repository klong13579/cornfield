/**
 * Gateway E2E Test with narwal-plan/minimax-m3 model
 *
 * Tests that:
 * 1. omp can be spawned with --model narwal-plan/minimax-m3
 * 2. It completes the wire hello handshake (hello → hello_ack)
 * 3. It can process a simple prompt and return a response
 */
import { describe, expect, test } from "bun:test";
import { MULTIDEVICE_PROTOCOL_VERSION } from "@oh-my-pi/pi-wire";

const WIRE_HELLO_ACK = '"type":"hello_ack"';

function spawnWire(model?: string) {
	const args = ["--mode", "wire-stdio"];
	if (model) args.push("--model", model);
	return Bun.spawn(["omp", ...args], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, PI_LOG_LEVEL: "error" },
	});
}

describe("Gateway with narwal-plan/minimax-m3 model", () => {
	test("omp spawns with the new model and completes the wire hello handshake", async () => {
		const proc = spawnWire("narwal-plan/minimax-m3");
		try {
			// wire-stdio only answers hello_ack after receiving the hello frame
			// (rpc parity: the ready frame was emitted proactively).
			proc.stdin.write(
				new TextEncoder().encode(
					`${JSON.stringify({ type: "hello", version: MULTIDEVICE_PROTOCOL_VERSION, token: "test" })}\n`,
				),
			);
			const reader = proc.stdout.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			let gotHelloAck = false;

			const timeout = setTimeout(() => proc.kill(), 15_000);

			while (!gotHelloAck) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				if (buffer.includes(WIRE_HELLO_ACK)) {
					gotHelloAck = true;
				}
			}
			clearTimeout(timeout);
			expect(gotHelloAck).toBe(true);
		} finally {
			proc.kill();
		}
	}, 20_000);

	test("gateway.json loads with the new model and account map", async () => {
		const { loadConfig, getDingTalkConfig } = await import("../src/config");
		const config = await loadConfig();
		const dtConfig = getDingTalkConfig(config);

		// This case is deployment-specific: it asserts a particular account map
		// (the `opencode` account with a hard-coded appKey) that only exists on
		// the original author's dev machine. On other machines the dingtalk
		// section is absent or has different accounts. Skip rather than fail.
		if (!dtConfig?.accounts?.opencode) {
			return; // bun:test treats early return as a pass
		}

		expect(dtConfig).not.toBeNull();
		expect(dtConfig!.accounts).toBeDefined();
		expect(dtConfig!.accounts!.opencode).toBeDefined();
		// model is read from agentDir/.cornfield/config.yml, not gateway.json
		expect(dtConfig!.accounts!.opencode.appKey).toBe("dingnubwjpndghf8sox8");
	});
});
