import { describe, expect, it } from "bun:test";
import { agentLoop } from "@cornfield/agent/agent-loop";
import type { AgentContext, AgentLoopConfig, AgentMessage, AgentTool, CanUseToolContext } from "@cornfield/agent/types";
import type { AssistantMessage, Message, Model, Usage, UserMessage } from "@cornfield/ai";
import { AssistantMessageEventStream } from "@cornfield/ai/utils/event-stream";
import { createApprovalCanUseTool, PermissionGate } from "@cornfield/coding-agent/server/permission-gate";
import type { PermissionRequestPush } from "@cornfield/wire";
import { Type } from "@sinclair/typebox";

/**
 * serve 侧 canUseTool 钩子 + PermissionGate 与 agent-core 循环的真集成：
 * 真实 fake-streamFn 吐 bash 工具调用（不碰真 LLM），断言
 *   bash → canUseTool → gate.requestApproval → 广播 permission_request → respond → 继续/拒绝。
 * 覆盖 once 放行、deny 拒绝、非 bash 零变化、session 精确命令放行。
 */

class MockAssistantStream extends AssistantMessageEventStream {}

function createModel(): Model<"openai-responses"> {
	return {
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function createUserMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function createUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createAssistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: createUsage(),
		stopReason,
		timestamp: Date.now(),
	};
}

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

const commandSchema = Type.Object({ command: Type.String() });

function makeTool(name: string, executed: string[]): AgentTool<typeof commandSchema, { command: string }> {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: commandSchema,
		async execute(_id, params) {
			executed.push(params.command);
			return { content: [{ type: "text", text: `ok:${params.command}` }], details: { command: params.command } };
		},
	};
}

function makeStreamFn(toolName: string, command: string): () => AssistantMessageEventStream {
	let callIndex = 0;
	return (): AssistantMessageEventStream => {
		const stream = new MockAssistantStream();
		queueMicrotask(() => {
			if (callIndex === 0) {
				const message = createAssistantMessage(
					[{ type: "toolCall", id: "tool-1", name: toolName, arguments: { command } }],
					"toolUse",
				);
				stream.push({ type: "done", reason: "toolUse", message });
			} else {
				const message = createAssistantMessage([{ type: "text", text: "done" }]);
				stream.push({ type: "done", reason: "stop", message });
			}
			callIndex += 1;
		});
		return stream;
	};
}

function newGateAndHook(): {
	gate: PermissionGate;
	broadcasts: PermissionRequestPush[];
	canUseTool: (ctx: CanUseToolContext) => Promise<boolean>;
	broadcasted: Promise<void>;
} {
	const gate = new PermissionGate();
	const broadcasts: PermissionRequestPush[] = [];
	const { promise: broadcasted, resolve: resolveBroadcasted } = Promise.withResolvers<void>();
	const canUseTool = createApprovalCanUseTool(gate, push => {
		broadcasts.push(push);
		resolveBroadcasted();
	});
	return { gate, broadcasts, canUseTool, broadcasted };
}

async function drain(stream: ReturnType<typeof agentLoop>): Promise<void> {
	for await (const _ of stream) {
		// consume
	}
}

describe("serve canUseTool → PermissionGate（真 agent-core 循环）", () => {
	it("bash 触发 permission_request，once 放行后执行", async () => {
		const { gate, broadcasts, canUseTool, broadcasted } = newGateAndHook();
		const executed: string[] = [];
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [makeTool("bash", executed)] };
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			canUseTool,
		};

		const stream = agentLoop([createUserMessage("run")], context, config, undefined, makeStreamFn("bash", "echo hi"));
		const task = drain(stream);

		await broadcasted;
		expect(executed).toEqual([]);
		expect(broadcasts).toHaveLength(1);
		if (broadcasts[0]?.kind !== "approval") throw new Error("expected approval push");
		expect(broadcasts[0].command).toBe("echo hi");

		expect(gate.respond(broadcasts[0].requestId, "once")).toEqual({ ok: true });
		await task;

		expect(executed).toEqual(["echo hi"]);
	});

	it("deny 拒绝，bash 不执行", async () => {
		const { gate, broadcasts, canUseTool, broadcasted } = newGateAndHook();
		const executed: string[] = [];
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [makeTool("bash", executed)] };
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			canUseTool,
		};

		const stream = agentLoop(
			[createUserMessage("run")],
			context,
			config,
			undefined,
			makeStreamFn("bash", "rm -rf /tmp/x"),
		);
		const task = drain(stream);

		await broadcasted;
		expect(gate.respond(broadcasts[0].requestId, "deny")).toEqual({ ok: true });
		await task;

		expect(executed).toEqual([]);
	});

	it("非 bash 工具零变化：不广播、直接执行", async () => {
		const { broadcasts, canUseTool } = newGateAndHook();
		const executed: string[] = [];
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [makeTool("read", executed)] };
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			canUseTool,
		};

		const stream = agentLoop(
			[createUserMessage("run")],
			context,
			config,
			undefined,
			makeStreamFn("read", "README.md"),
		);
		await drain(stream);

		expect(executed).toEqual(["README.md"]);
		expect(broadcasts).toEqual([]);
	});

	it("session 放行写 gate 内存 allowlist，同命令二次直接放行", async () => {
		const { gate, broadcasts, canUseTool, broadcasted } = newGateAndHook();

		const firstExecuted: string[] = [];
		const firstContext: AgentContext = { systemPrompt: "", messages: [], tools: [makeTool("bash", firstExecuted)] };
		const firstConfig: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			canUseTool,
		};
		const firstStream = agentLoop(
			[createUserMessage("run")],
			firstContext,
			firstConfig,
			undefined,
			makeStreamFn("bash", "echo   hi"),
		);
		const firstTask = drain(firstStream);
		await broadcasted;
		expect(gate.respond(broadcasts[0].requestId, "session")).toEqual({ ok: true });
		await firstTask;
		expect(firstExecuted).toEqual(["echo   hi"]);
		expect(broadcasts).toHaveLength(1);

		// 同一归一化命令第二次跑：命中 session allowlist，不再广播，直接执行。
		const secondExecuted: string[] = [];
		const secondContext: AgentContext = { systemPrompt: "", messages: [], tools: [makeTool("bash", secondExecuted)] };
		const secondConfig: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			canUseTool,
		};
		const secondStream = agentLoop(
			[createUserMessage("run")],
			secondContext,
			secondConfig,
			undefined,
			makeStreamFn("bash", "echo hi"),
		);
		await drain(secondStream);

		expect(secondExecuted).toEqual(["echo hi"]);
		expect(broadcasts).toHaveLength(1);
	});
});
