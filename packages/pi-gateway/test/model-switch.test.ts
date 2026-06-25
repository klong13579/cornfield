/**
 * Natural-language model switch interception tests.
 *
 * Tests two layers:
 * 1. Pure functions (extractModelSwitchArg, fuzzyMatchModel) — pattern
 *    matching and model name resolution.
 * 2. Integration with AgentBridge — verifies the full NL switch path:
 *    message → extract → getAvailableModels → fuzzyMatch → setModel.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentBridge } from "../src/agent-bridge";
import { extractModelSwitchArg, fuzzyMatchModel, type MatchableModel } from "../src/model-switch";
import type { OutboundMessage } from "../src/types";

const FAKE_RPC_SCRIPT = `#!/usr/bin/env bun
process.stdout.write(JSON.stringify({ type: "ready" }) + "\\n");
let currentModel = { provider: "narwal-plan", id: "minimax-m3" };
let buffer = "";
function emit(value) {
  process.stdout.write(JSON.stringify(value) + "\\n");
}
const AVAILABLE_MODELS = [
  { provider: "narwal-plan", id: "kimi-k2.6", name: "Kimi K2.6", contextWindow: 200000, reasoning: true },
  { provider: "narwal-plan", id: "minimax-m3", name: "MiniMax M3", contextWindow: 205000, reasoning: false },
  { provider: "narwal-plan", id: "glm-5.2", name: "GLM 5.2", contextWindow: 205000, reasoning: false },
  { provider: "alibaba-coding-plan", id: "qwen3.6-plus", name: "Qwen 3.6 Plus", contextWindow: 1000000, reasoning: true },
];
async function handleFrame(frame) {
  if (frame.type === "switch_session") {
    emit({ type: "response", id: frame.id, command: "switch_session", success: true, data: { cancelled: false } });
    return;
  }
  if (frame.type === "prompt") {
    emit({ type: "response", id: frame.id, command: "prompt", success: true });
    setTimeout(() => {
      emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } });
      emit({ type: "agent_end" });
    }, 10);
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

const TEST_MODELS: MatchableModel[] = [
	{ provider: "narwal-plan", id: "kimi-k2.6", name: "Kimi K2.6" },
	{ provider: "narwal-plan", id: "minimax-m3", name: "MiniMax M3" },
	{ provider: "narwal-plan", id: "glm-5.2", name: "GLM 5.2" },
	{ provider: "alibaba-coding-plan", id: "qwen3.6-plus", name: "Qwen 3.6 Plus" },
];

// ─────────────────────────────────────────────────────────────────────────
// extractModelSwitchArg — pattern matching
// ─────────────────────────────────────────────────────────────────────────

describe("extractModelSwitchArg", () => {
	test("matches 切换模型到 X", () => {
		expect(extractModelSwitchArg("切换模型到 kimi-k2.6")).toBe("kimi-k2.6");
		expect(extractModelSwitchArg("切换模型到kimi-k2.6")).toBe("kimi-k2.6");
	});

	test("matches 切模型到 X (short form)", () => {
		expect(extractModelSwitchArg("切模型到 glm-5.2")).toBe("glm-5.2");
	});

	test("matches 换成 X", () => {
		expect(extractModelSwitchArg("换成 minimax-m3")).toBe("minimax-m3");
	});

	test("matches 切到 X", () => {
		expect(extractModelSwitchArg("切到 kimi-k2.6")).toBe("kimi-k2.6");
	});

	test("matches switch model to X (English)", () => {
		expect(extractModelSwitchArg("switch model to kimi-k2.6")).toBe("kimi-k2.6");
		expect(extractModelSwitchArg("Switch Model To kimi-k2.6")).toBe("kimi-k2.6");
	});

	test("matches change model to X (English)", () => {
		expect(extractModelSwitchArg("change model to glm-5.2")).toBe("glm-5.2");
	});

	test("does not match unrelated messages", () => {
		expect(extractModelSwitchArg("你好")).toBeNull();
		expect(extractModelSwitchArg("帮我查一下天气")).toBeNull();
		expect(extractModelSwitchArg("/model kimi-k2.6")).toBeNull();
		expect(extractModelSwitchArg("当前模型是什么")).toBeNull();
		expect(extractModelSwitchArg("model list")).toBeNull();
	});
});

// ─────────────────────────────────────────────────────────────────────────
// fuzzyMatchModel — model name resolution
// ─────────────────────────────────────────────────────────────────────────

describe("fuzzyMatchModel", () => {
	test("exact provider/id match", () => {
		const m = fuzzyMatchModel(TEST_MODELS, "narwal-plan/kimi-k2.6");
		expect(m).toEqual({ provider: "narwal-plan", id: "kimi-k2.6" });
	});

	test("exact id match", () => {
		const m = fuzzyMatchModel(TEST_MODELS, "kimi-k2.6");
		expect(m).toEqual({ provider: "narwal-plan", id: "kimi-k2.6" });
	});

	test("normalized substring: kimi matches kimi-k2.6", () => {
		const m = fuzzyMatchModel(TEST_MODELS, "kimi");
		expect(m).toEqual({ provider: "narwal-plan", id: "kimi-k2.6" });
	});

	test("normalized substring: kimi2.6 matches kimi-k2.6 (dash/underscore stripped)", () => {
		const m = fuzzyMatchModel(TEST_MODELS, "kimi2.6");
		expect(m).toEqual({ provider: "narwal-plan", id: "kimi-k2.6" });
	});

	test("normalized substring: kimi-2.6 matches kimi-k2.6", () => {
		// "kimi-2.6" → normalized "kimi26"; "kimi-k2.6" → normalized "kimik26"
		// "kimi26" is contained in "kimik26"? No. But "kimik26".includes("kimi26")? No.
		// This is the exact bug case from the user's session — verify it resolves.
		const m = fuzzyMatchModel(TEST_MODELS, "kimi-2.6");
		// kimi-2.6 normalized = kimi26, kimi-k2.6 normalized = kimik26
		// "kimi26" is NOT a substring of "kimik26". But "kimi" prefix matches.
		// The test documents current behavior: kimi-2.6 → no direct normalized match,
		// but display name "Kimi K2.6" contains "kimi" → matches via name path.
		expect(m).toEqual({ provider: "narwal-plan", id: "kimi-k2.6" });
	});

	test("display name match: GLM matches glm-5.2", () => {
		const m = fuzzyMatchModel(TEST_MODELS, "GLM");
		expect(m).toEqual({ provider: "narwal-plan", id: "glm-5.2" });
	});

	test("returns null for no match", () => {
		expect(fuzzyMatchModel(TEST_MODELS, "nonexistent")).toBeNull();
	});

	test("case insensitive matching", () => {
		const m = fuzzyMatchModel(TEST_MODELS, "KIMI-K2.6");
		expect(m).toEqual({ provider: "narwal-plan", id: "kimi-k2.6" });
	});
});

// ─────────────────────────────────────────────────────────────────────────
// Integration: NL switch → bridge.setModel
// ─────────────────────────────────────────────────────────────────────────

interface Harness {
	bridge: AgentBridge;
	cleanup: () => Promise<void>;
}

async function createHarness(): Promise<Harness> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-gateway-nl-switch-"));
	const rpcPath = path.join(dir, "fake-rpc");
	await Bun.write(rpcPath, FAKE_RPC_SCRIPT);
	await fs.chmod(rpcPath, 0o755);

	const bridge = new AgentBridge({ ompPath: rpcPath, timeoutMs: 5_000 });
	await bridge.start();

	return {
		bridge,
		cleanup: async () => {
			bridge.stop();
			await fs.rm(dir, { recursive: true, force: true });
		},
	};
}

describe("NL model switch integration", () => {
	let harness: Harness | undefined;

	beforeEach(async () => {
		harness = await createHarness();
	});

	afterEach(async () => {
		if (harness) await harness.cleanup();
		harness = undefined;
	});

	test("full path: 切换模型到 kimi → bridge.setModel succeeds", async () => {
		if (!harness) throw new Error("missing harness");

		// Simulate gateway NL switch logic
		const modelArg = extractModelSwitchArg("切换模型到 kimi");
		expect(modelArg).toBe("kimi");

		const response = await harness.bridge.getAvailableModels();
		const { models } = response.data as { models: MatchableModel[] };

		const match = fuzzyMatchModel(models, modelArg!);
		expect(match).toEqual({ provider: "narwal-plan", id: "kimi-k2.6" });

		const switchResponse = await harness.bridge.setModel(match!.provider, match!.id);
		expect(switchResponse.success).toBe(true);

		// Verify model actually changed
		const state = await harness.bridge.getState();
		const stateData = state.data as { model: { provider: string; id: string } };
		expect(stateData.model.id).toBe("kimi-k2.6");
	});

	test("unmatched model name returns null, gateway would reply with available list", async () => {
		if (!harness) throw new Error("missing harness");

		const modelArg = extractModelSwitchArg("切换模型到 gpt-99");
		expect(modelArg).toBe("gpt-99");

		const response = await harness.bridge.getAvailableModels();
		const { models } = response.data as { models: MatchableModel[] };

		const match = fuzzyMatchModel(models, modelArg!);
		expect(match).toBeNull();
	});
});
