/**
 * Gateway Communication Test
 * 
 * 测试 Gateway 通信的几种方式:
 * 1. 直接使用 omp --mode rpc
 * 2. 通过 AgentBridge.forward() 模拟
 * 3. 模拟 InboundMessage
 */
import { describe, test, expect } from "bun:test";
import { AgentBridge } from "../src/agent-bridge";
import type { InboundMessage } from "../src/types";

/**
 * 方法1: 直接通过 stdin 发送 JSON 消息
 * 
 * RPC 协议格式:
 * {"type":"prompt","id":"xxx","prompt":"消息内容"}
 * 
 * 返回格式:
 * {"type":"ready"} - 就绪
 * {"type":"agent_message","id":"xxx","content":[{"type":"text","text":"..."}]}
 * {"type":"agent_end","id":"xxx"}
 */
describe("Method 1: omp --mode rpc direct", () => {
	test("send prompt via stdin", async () => {
		const proc = Bun.spawn(["omp", "--mode", "rpc"], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});

		// 发送 prompt
		const prompt = JSON.stringify({
			type: "prompt",
			id: "test-1",
			prompt: "用一句话介绍你自己",
		}) + "\n";

		proc.stdin.write(prompt);
		proc.stdin.end();

		// 读取响应
		const output = await new Response(proc.stdout).text();
		console.log("RPC Output:", output);

		expect(output).toContain("ready");
		proc.kill();
	});
});

/**
 * 方法2: 通过 AgentBridge 模拟消息
 */
describe("Method 2: AgentBridge forward", () => {
	test("forward message to agent", async () => {
		const bridge = new AgentBridge({ ompPath: "omp" });

		// 启动 bridge
		await bridge.start();
		expect(bridge.isRunning).toBe(true);

		// 模拟收到消息
		const mockMessage: InboundMessage = {
			channelId: "test",
			userId: "test-user",
			userName: "Test User",
			conversationId: "test-conv",
			isGroup: false,
			content: { type: "text", text: "你好，请介绍一下自己" },
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

		// 发送消息并等待响应
		const response = await bridge.forward(mockMessage, mockSession);
		console.log("Agent Response:", response);

		expect(response).toBeTruthy();
		expect(response!.length).toBeGreaterThan(0);

		// 清理
		bridge.stop();
	}, 60000); // 60s timeout for LLM call
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
