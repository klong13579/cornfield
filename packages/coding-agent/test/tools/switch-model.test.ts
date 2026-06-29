import { describe, expect, it, mock } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { resolveModel, SwitchModelTool } from "@oh-my-pi/pi-coding-agent/tools/switch-model";

function makeModel(overrides: Partial<Model> & Pick<Model, "provider" | "id">): Model {
	return {
		name: overrides.id,
		api: "anthropic-messages",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8192,
		...overrides,
	};
}

const MODELS: Model[] = [
	makeModel({ provider: "narwal-plan", id: "minimax-m3", name: "MiniMax M3" }),
	makeModel({ provider: "narwal-plan", id: "kimi-k2.6", name: "Kimi K2.6" }),
	makeModel({ provider: "alibaba-coding-plan", id: "qwen3.6-plus", name: "Qwen 3.6 Plus" }),
	makeModel({ provider: "anthropic", id: "claude-opus-4-5", name: "Claude Opus 4.5" }),
	makeModel({ provider: "openai", id: "gpt-5", name: "GPT-5" }),
];

describe("resolveModel", () => {
	it("matches exact 'provider/id'", () => {
		expect(resolveModel(MODELS, "narwal-plan/minimax-m3")?.id).toBe("minimax-m3");
		expect(resolveModel(MODELS, "anthropic/claude-opus-4-5")?.id).toBe("claude-opus-4-5");
	});

	it("matches exact 'provider:id' (colon form)", () => {
		expect(resolveModel(MODELS, "openai:gpt-5")?.id).toBe("gpt-5");
	});

	it("matches exact bare model id", () => {
		expect(resolveModel(MODELS, "minimax-m3")?.id).toBe("minimax-m3");
		expect(resolveModel(MODELS, "gpt-5")?.id).toBe("gpt-5");
	});

	it("matches exact bare provider (returns first model under that provider)", () => {
		expect(resolveModel(MODELS, "narwal-plan")?.provider).toBe("narwal-plan");
		expect(resolveModel(MODELS, "openai")?.id).toBe("gpt-5");
	});

	it("matches case-insensitively", () => {
		expect(resolveModel(MODELS, "ANTHROPIC/CLAUDE-OPUS-4-5")?.id).toBe("claude-opus-4-5");
		expect(resolveModel(MODELS, "MiniMax-M3")?.id).toBe("minimax-m3");
	});

	it("normalizes dashes, underscores, dots for fuzzy match", () => {
		// "kimi2.6" → strip dot → "kimi26" — won't match "kimi-k2.6" norm "kimik26"
		// but "kimi k 2.6" → strip dashes/dots/spaces → "kimik26" same
		// Simpler: "kimi" should substring-match "kimi-k2.6"
		expect(resolveModel(MODELS, "kimi")?.id).toBe("kimi-k2.6");
		// "minimax" → strip nothing → "minimax" is substring of "minimax-m3" norm "minimaxm3"
		expect(resolveModel(MODELS, "minimax")?.id).toBe("minimax-m3");
		// "claude-opus" → strip dash → "claudeopus" is substring of "claude-opus-4-5" norm "claudeopus45"
		expect(resolveModel(MODELS, "claude-opus")?.id).toBe("claude-opus-4-5");
	});

	it("matches display name substring", () => {
		expect(resolveModel(MODELS, "Qwen")?.id).toBe("qwen3.6-plus");
		expect(resolveModel(MODELS, "GPT")?.id).toBe("gpt-5");
	});

	it("returns null for empty query", () => {
		expect(resolveModel(MODELS, "")).toBeNull();
		expect(resolveModel(MODELS, "   ")).toBeNull();
	});

	it("returns null for no match", () => {
		expect(resolveModel(MODELS, "gpt-99-xyz")).toBeNull();
		expect(resolveModel(MODELS, "totally-unrelated-model")).toBeNull();
	});

	it("trims whitespace from query", () => {
		expect(resolveModel(MODELS, "  minimax-m3  ")?.id).toBe("minimax-m3");
	});

	it("prefers exact provider/id over substring match", () => {
		// If someone passes "narwal-plan/minimax-m3" with a typo in the id, exact match still wins
		// only if both provider AND id match. Otherwise falls through to fuzzy.
		const models = [
			makeModel({ provider: "narwal-plan", id: "minimax-m3" }),
			makeModel({ provider: "other", id: "minimax-m3" }),
		];
		expect(resolveModel(models, "narwal-plan/minimax-m3")?.provider).toBe("narwal-plan");
	});
});

function makeSession(overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getActiveModelString: () => "anthropic/claude-opus-4-5",
		getAvailableModels: () => MODELS,
		setModel: mock(async () => {}),
		settings: {
			get: () => true,
		} as unknown as ToolSession["settings"],
		...overrides,
	};
}

describe("SwitchModelTool", () => {
	it("has the expected name and schema", () => {
		const tool = new SwitchModelTool(makeSession());
		expect(tool.name).toBe("switch_model");
		expect(tool.parameters).toBeDefined();
	});

	it("switches model on exact provider/id match", async () => {
		const setModel = mock(async () => {});
		const tool = new SwitchModelTool(makeSession({ setModel }));
		const result = await tool.execute("call-1", { query: "narwal-plan/minimax-m3" });
		expect(setModel).toHaveBeenCalledTimes(1);
		const calledWith = (setModel.mock.calls[0] as unknown[])[0] as Model;
		expect(calledWith.provider).toBe("narwal-plan");
		expect(calledWith.id).toBe("minimax-m3");
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("narwal-plan/minimax-m3");
		expect(text).toContain("已切换模型");
	});

	it("switches model on fuzzy match", async () => {
		const setModel = mock(async () => {});
		const tool = new SwitchModelTool(makeSession({ setModel }));
		const result = await tool.execute("call-2", { query: "minimax" });
		expect(setModel).toHaveBeenCalledTimes(1);
		const calledWith = (setModel.mock.calls[0] as unknown[])[0] as Model;
		expect(calledWith.id).toBe("minimax-m3");
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("narwal-plan/minimax-m3");
	});

	it("passes role='temporary' to setModel when requested", async () => {
		const setModel = mock(async () => {});
		const tool = new SwitchModelTool(makeSession({ setModel }));
		await tool.execute("call-3", { query: "anthropic/claude-opus-4-5", role: "temporary" });
		expect(setModel).toHaveBeenCalledTimes(1);
		const role = (setModel.mock.calls[0] as unknown[])[1] as string;
		expect(role).toBe("temporary");
	});

	it("defaults role to 'default' when not specified", async () => {
		const setModel = mock(async () => {});
		const tool = new SwitchModelTool(makeSession({ setModel }));
		await tool.execute("call-4", { query: "openai/gpt-5" });
		const role = (setModel.mock.calls[0] as unknown[])[1] as string;
		expect(role).toBe("default");
	});

	it("returns a user-friendly error when no match is found", async () => {
		const setModel = mock(async () => {});
		const tool = new SwitchModelTool(makeSession({ setModel }));
		await expect(tool.execute("call-5", { query: "gpt-99-xyz" })).rejects.toThrow(/未找到匹配 "gpt-99-xyz" 的模型/);
		expect(setModel).not.toHaveBeenCalled();
	});

	it("lists up to 10 candidates in the error message", async () => {
		const tool = new SwitchModelTool(makeSession());
		try {
			await tool.execute("call-6", { query: "totally-unknown" });
		} catch (err) {
			const msg = (err as Error).message;
			expect(msg).toContain("narwal-plan/minimax-m3");
			expect(msg).toContain("anthropic/claude-opus-4-5");
		}
	});

	it("errors when the session exposes no setModel binding", async () => {
		const session = makeSession();
		// Remove setModel binding
		const { setModel: _omit, ...rest } = session;
		const tool = new SwitchModelTool(rest);
		await expect(tool.execute("call-7", { query: "minimax-m3" })).rejects.toThrow(/Model switching is not available/);
	});

	it("errors when no models are available", async () => {
		const tool = new SwitchModelTool(makeSession({ getAvailableModels: () => [] }));
		await expect(tool.execute("call-8", { query: "minimax-m3" })).rejects.toThrow(/No models available/);
	});

	it("falls back to modelRegistry.getAvailable when getAvailableModels is absent", async () => {
		const getAvailable = mock(() => MODELS);
		const session = makeSession();
		const { getAvailableModels: _omit, ...rest } = session;
		rest.modelRegistry = { getAvailable } as unknown as NonNullable<ToolSession["modelRegistry"]>;
		const setModel = mock(async () => {});
		rest.setModel = setModel;
		const tool = new SwitchModelTool(rest);
		await tool.execute("call-9", { query: "minimax-m3" });
		expect(getAvailable).toHaveBeenCalledTimes(1);
		expect(setModel).toHaveBeenCalledTimes(1);
	});

	it("includes display name in the confirmation when it differs from id", async () => {
		const setModel = mock(async () => {});
		const tool = new SwitchModelTool(makeSession({ setModel }));
		const result = await tool.execute("call-10", { query: "Qwen" });
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("alibaba-coding-plan/qwen3.6-plus");
		expect(text).toContain("Qwen 3.6 Plus");
	});

	it("annotates temporary switches in the confirmation", async () => {
		const setModel = mock(async () => {});
		const tool = new SwitchModelTool(makeSession({ setModel }));
		const result = await tool.execute("call-11", { query: "minimax-m3", role: "temporary" });
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("临时");
	});

	it("returns details for callers that want structured confirmation", async () => {
		const setModel = mock(async () => {});
		const tool = new SwitchModelTool(
			makeSession({
				setModel,
				getActiveModelString: () => "anthropic/claude-opus-4-5",
			}),
		);
		const result = await tool.execute("call-12", { query: "minimax-m3" });
		expect(result.details).toEqual({
			previousModel: "anthropic/claude-opus-4-5",
			newModel: "narwal-plan/minimax-m3",
			role: "default",
		});
	});
});
