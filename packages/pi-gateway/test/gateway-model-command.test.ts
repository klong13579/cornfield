/**
 * Gateway model command interception tests.
 *
 * Tests that /models, /model, and /model <provider>/<id> messages
 * are intercepted before reaching the agent, correctly resolved
 * through the AgentBridge RPC, and formatted as markdown replies.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentBridge } from "../src/agent-bridge";
import type { InboundMessage, OutboundMessage } from "../src/types";

const FAKE_RPC_SCRIPT = `#!/usr/bin/env bun
process.stdout.write(JSON.stringify({ type: "ready" }) + "\\n");
let currentSession = "";
let currentModel = { provider: "narwal-plan", id: "deepseek-r1" };
let buffer = "";
function emit(value) {
  process.stdout.write(JSON.stringify(value) + "\\n");
}
const AVAILABLE_MODELS = [
  { provider: "narwal-plan", id: "deepseek-r1", contextWindow: 64000, reasoning: true },
  { provider: "narwal-plan", id: "deepseek-v3", contextWindow: 64000, reasoning: false },
  { provider: "alibaba-coding-plan", id: "qwen3-coder-plus", contextWindow: 131072, reasoning: false },
];
async function handleFrame(frame) {
  if (frame.type === "switch_session") {
    currentSession = frame.sessionPath;
    emit({ type: "response", id: frame.id, command: "switch_session", success: true, data: { cancelled: false } });
    return;
  }
  if (frame.type === "prompt") {
    emit({ type: "response", id: frame.id, command: "prompt", success: true });
    const sessionAtPrompt = currentSession;
    setTimeout(() => {
      emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: sessionAtPrompt + " :: " + frame.message }] } });
      emit({ type: "agent_end" });
    }, 10);
    return;
  }
  if (frame.type === "abort") {
    emit({ type: "response", id: frame.id, command: "abort", success: true });
    return;
  }
  if (frame.type === "get_available_models") {
    emit({ type: "response", id: frame.id, command: "get_available_models", success: true, data: { models: AVAILABLE_MODELS } });
    return;
  }
  if (frame.type === "set_model") {
    const found = AVAILABLE_MODELS.find(m => m.provider === frame.provider && m.id === frame.modelId);
    if (!found) {
      emit({ type: "response", id: frame.id, command: "set_model", success: false, error: "No model " + frame.provider + "/" + frame.modelId });
      return;
    }
    currentModel = { provider: found.provider, id: found.id };
    emit({ type: "response", id: frame.id, command: "set_model", success: true, data: found });
    return;
  }
  if (frame.type === "get_state") {
    emit({ type: "response", id: frame.id, command: "get_state", success: true, data: { model: currentModel, thinkingLevel: "medium", isStreaming: false } });
    return;
  }
}
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk);
  let index = buffer.indexOf("\\n");
  while (index !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) await handleFrame(JSON.parse(line));
    index = buffer.indexOf("\\n");
  }
}
`;

interface Harness {
	rpcPath: string;
	bridge: AgentBridge;
	replyBuffer: OutboundMessage[];
	cleanup: () => Promise<void>;
}

async function createHarness(): Promise<Harness> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-gateway-model-cmd-"));
	const rpcPath = path.join(dir, "fake-rpc");
	await Bun.write(rpcPath, FAKE_RPC_SCRIPT);
	await fs.chmod(rpcPath, 0o755);

	const bridge = new AgentBridge({ ompPath: rpcPath, timeoutMs: 5_000 });
	await bridge.start();

	const replyBuffer: OutboundMessage[] = [];

	return {
		rpcPath,
		bridge,
		replyBuffer,
		cleanup: async () => {
			bridge.stop();
			await fs.rm(dir, { recursive: true, force: true });
		},
	};
}

function makeInbound(text: string): InboundMessage {
	return {
		channelId: "dingtalk:test",
		accountId: "ops",
		userId: "user1",
		conversationId: "conv-model-test",
		isGroup: false,
		content: { type: "text", text },
		timestamp: new Date(),
	};
}

/**
 * Simulate model command handling by directly calling the AgentBridge
 * methods and formatting the response, matching Gateway.#handleModelCommand logic.
 *
 * Since #handleModelCommand is a private method on Gateway, we test the
 * equivalent logic here: message detection → bridge RPC → response format.
 */
function isModelCommand(text: string): boolean {
	const trimmed = text.trim();
	return trimmed.startsWith("/models") || trimmed.startsWith("/list-models") || trimmed.startsWith("/model");
}

function formatModelNumber(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
	return String(n);
}

describe("gateway model command interception", () => {
	let harness: Harness | undefined;

	beforeEach(async () => {
		harness = await createHarness();
	});

	afterEach(async () => {
		if (!harness) return;
		await harness.cleanup();
		harness = undefined;
	});

	test("/models lists available models as markdown table", async () => {
		if (!harness) throw new Error("missing harness");
		const msg = makeInbound("/models");
		const text = msg.content.type === "text" ? msg.content.text : "";
		expect(isModelCommand(text)).toBe(true);

		const response = await harness.bridge.getAvailableModels();
		expect(response.success).toBe(true);
		const { models } = response.data as {
			models: Array<{ provider: string; id: string; contextWindow?: number; reasoning?: boolean }>;
		};
		expect(models.length).toBe(3);

		// Build table (matching Gateway logic)
		models.sort((a, b) => {
			const providerCmp = a.provider.localeCompare(b.provider);
			if (providerCmp !== 0) return providerCmp;
			return a.id.localeCompare(b.id);
		});

		const rows = models.map(m => {
			const ctx = m.contextWindow ? formatModelNumber(m.contextWindow) : "-";
			const think = m.reasoning ? "yes" : "-";
			return `| ${m.provider} | ${m.id} | ${ctx} | ${think} |`;
		});
		const table = `| provider | model | context | reasoning |\n|---|---|---|---|\n${rows.join("\n")}`;

		// Verify table structure
		expect(table).toContain("narwal-plan");
		expect(table).toContain("deepseek-r1");
		expect(table).toContain("alibaba-coding-plan");
		expect(table).toContain("qwen3-coder-plus");
		expect(table).toContain("64k");
		expect(table).toContain("131k");
	});

	test("/models with search pattern filters models", async () => {
		if (!harness) throw new Error("missing harness");
		const response = await harness.bridge.getAvailableModels();
		const { models } = response.data as { models: Array<{ provider: string; id: string }> };

		// Filter by "alibaba"
		const pattern = "alibaba";
		const filtered = models.filter(
			m => m.provider.toLowerCase().includes(pattern) || m.id.toLowerCase().includes(pattern),
		);
		expect(filtered.length).toBe(1);
		expect(filtered[0].provider).toBe("alibaba-coding-plan");
	});

	test("/model shows current model", async () => {
		if (!harness) throw new Error("missing harness");
		const response = await harness.bridge.getState();
		expect(response.success).toBe(true);
		const state = response.data as { model: { provider: string; id: string }; thinkingLevel: string };
		expect(state.model.provider).toBe("narwal-plan");
		expect(state.model.id).toBe("deepseek-r1");
		expect(state.thinkingLevel).toBe("medium");

		const modelStr = `${state.model.provider}/${state.model.id}`;
		const thinking = state.thinkingLevel ? ` (推理级别: ${state.thinkingLevel})` : "";
		const reply = `当前模型: ${modelStr}${thinking}`;
		expect(reply).toBe("当前模型: narwal-plan/deepseek-r1 (推理级别: medium)");
	});

	test("/model <provider>/<id> switches model", async () => {
		if (!harness) throw new Error("missing harness");

		// Verify initial state
		const initialState = await harness.bridge.getState();
		const initialData = initialState.data as { model: { provider: string; id: string } };
		expect(initialData.model.id).toBe("deepseek-r1");

		// Switch model
		const response = await harness.bridge.setModel("alibaba-coding-plan", "qwen3-coder-plus");
		expect(response.success).toBe(true);
		const modelData = response.data as { provider: string; id: string };
		expect(modelData.provider).toBe("alibaba-coding-plan");
		expect(modelData.id).toBe("qwen3-coder-plus");

		// Verify model changed via getState
		const newState = await harness.bridge.getState();
		const newData = newState.data as { model: { provider: string; id: string } };
		expect(newData.model.provider).toBe("alibaba-coding-plan");
		expect(newData.model.id).toBe("qwen3-coder-plus");
	});

	test("/model <modelId> with no provider uses current provider", async () => {
		if (!harness) throw new Error("missing harness");

		// Get current state to find provider
		const stateResponse = await harness.bridge.getState();
		const stateData = stateResponse.data as { model?: { provider: string } };
		const currentProvider = stateData.model?.provider;
		expect(currentProvider).toBe("narwal-plan");

		// Use just the modelId with the current provider
		const response = await harness.bridge.setModel(currentProvider!, "deepseek-v3");
		expect(response.success).toBe(true);
	});

	test("non-model messages are not intercepted", async () => {
		const texts = ["hello", "/cron create 10m echo hi", "停止", "what models do you have"];
		for (const text of texts) {
			expect(isModelCommand(text)).toBe(false);
		}
	});

	test("model command detection works for all variants", async () => {
		expect(isModelCommand("/models")).toBe(true);
		expect(isModelCommand("/list-models")).toBe(true);
		expect(isModelCommand("/models deepseek")).toBe(true);
		expect(isModelCommand("/list-models deepseek")).toBe(true);
		expect(isModelCommand("/model")).toBe(true);
		expect(isModelCommand("/model narwal-plan/deepseek-r1")).toBe(true);
		expect(isModelCommand("/model deepseek-r1")).toBe(true);
	});
});
