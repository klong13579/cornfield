/**
 * Gateway Communication Test
 *
 * 测试 Gateway 通信的几种方式:
 * 1. 直接使用 omp --mode rpc
 * 2. 通过 AgentBridge.forward() 模拟
 * 3. 模拟 InboundMessage
 */
import { describe, expect, test } from "bun:test";
import { AgentBridge } from "../src/agent-bridge";
import type { InboundMessage } from "../src/types";

describe("Method 1: omp --mode rpc direct", () => {
	// This test requires a real LLM model which may not be available in CI
	test("spawns and sends ready signal", async () => {
		const proc = Bun.spawn(["omp", "--mode", "rpc"], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});

		try {
			// Just check for the ready signal
			const reader = proc.stdout.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			let gotReady = false;

			const timeout = setTimeout(() => proc.kill(), 10000);

			while (!gotReady) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				if (buffer.includes('"type":"ready"')) {
					gotReady = true;
				}
			}

			clearTimeout(timeout);
			expect(gotReady).toBe(true);
		} finally {
			proc.kill();
		}
	}, 15000);
});

/**
 * 方法2: 通过 AgentBridge 模拟消息
 */
describe.skip("Method 2: AgentBridge forward", () => {
	// Skipped: requires real LLM call. Run with --timeout=120000 to re-enable
	test("forward message to agent", async () => {
		const bridge = new AgentBridge({ ompPath: "omp" });

		await bridge.start();
		expect(bridge.isRunning).toBe(true);

		const mockMessage: InboundMessage = {
			channelId: "test",
			userId: "test-user",
			userName: "Test User",
			conversationId: "test-conv",
			isGroup: false,
			content: { type: "text", text: "你好" },
			timestamp: new Date(),
		};

		const mockSession = {
			id: "test-session",
			channelId: "test",
			userId: "test-user",
			conversationId: "test-conv",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			status: "active" as const,
		};

		const response = await bridge.forward(mockMessage, mockSession);
		expect(response).toBeTruthy();
		expect(response!.length).toBeGreaterThan(0);

		bridge.stop();
	}, 120000);
});

/**
 * 方法3: 创建测试配置文件启用测试通道
 */
describe("Method 3: Config-based channel test", () => {
	test("load config with test channel", async () => {
		const { loadConfig } = await import("../src/config");

		// 创建测试配置
		const testConfigPath = "/tmp/gateway-test.json";
		const testConfig = {
			channels: {
				test: {
					enabled: true,
				},
			},
		};

		await Bun.write(testConfigPath, JSON.stringify(testConfig));

		// 加载配置
		const config = await loadConfig(testConfigPath);
		console.log("Loaded config:", config);

		expect(config.channels.test).toBeDefined();
	});
});
