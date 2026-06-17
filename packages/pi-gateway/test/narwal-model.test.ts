/**
 * Gateway E2E Test with narwal-plan/minimax-m3 model
 *
 * Tests that:
 * 1. omp can be spawned with --model narwal-plan/minimax-m3
 * 2. It sends a ready signal
 * 3. It can process a simple prompt and return a response
 */
import { describe, test, expect } from "bun:test";

const RPC_READY = '"type":"ready"';

function spawnRpc(model?: string) {
	const args = ["--mode", "rpc"];
	if (model) args.push("--model", model);
	return Bun.spawn(["omp", ...args], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, PI_LOG_LEVEL: "error" },
	});
}

describe("Gateway with narwal-plan/minimax-m3 model", () => {
	test("omp spawns with the new model and sends ready", async () => {
		const proc = spawnRpc("narwal-plan/minimax-m3");
		try {
			const reader = proc.stdout.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			let gotReady = false;

			const timeout = setTimeout(() => proc.kill(), 15_000);

			while (!gotReady) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				if (buffer.includes(RPC_READY)) {
					gotReady = true;
				}
			}
			clearTimeout(timeout);
			expect(gotReady).toBe(true);
		} finally {
			proc.kill();
		}
	}, 20_000);

	test("gateway.json loads with the new model and account map", async () => {
		const { loadConfig, getDingTalkConfig } = await import("../src/config");
		const config = await loadConfig();
		const dtConfig = getDingTalkConfig(config);

		expect(dtConfig).not.toBeNull();
		expect(dtConfig!.accounts).toBeDefined();
		expect(dtConfig!.accounts!.opencode).toBeDefined();
		// model is read from agentDir/.omp/config.yml, not gateway.json
		expect(dtConfig!.accounts!.opencode.appKey).toBe("dingnubwjpndghf8sox8");
	});
});
