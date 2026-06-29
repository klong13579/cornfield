import { describe, expect, it } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ListModelsTool } from "@oh-my-pi/pi-coding-agent/tools/list-models";

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
	makeModel({ provider: "narwal-plan", id: "minimax-m3", name: "MiniMax M3", contextWindow: 200_000 }),
	makeModel({ provider: "narwal-plan", id: "kimi-k2.6", name: "Kimi K2.6", contextWindow: 128_000 }),
	makeModel({
		provider: "alibaba-coding-plan",
		id: "qwen3.6-plus",
		name: "Qwen 3.6 Plus",
		contextWindow: 1_000_000,
		reasoning: true,
	}),
	makeModel({
		provider: "anthropic",
		id: "claude-opus-4-5",
		name: "Claude Opus 4.5",
		contextWindow: 200_000,
		reasoning: true,
	}),
	makeModel({ provider: "openai", id: "gpt-5", name: "GPT-5", contextWindow: 400_000 }),
];

function makeSession(overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getActiveModelString: () => "narwal-plan/minimax-m3",
		getAvailableModels: () => MODELS,
		...overrides,
	};
}

function readText(result: { content: Array<{ type: string; text?: string }> }): string {
	const c = result.content[0];
	return c.type === "text" ? (c.text ?? "") : "";
}

describe("ListModelsTool", () => {
	it("has the expected name and schema", () => {
		const tool = new ListModelsTool(makeSession());
		expect(tool.name).toBe("list_models");
		expect(tool.parameters).toBeDefined();
	});

	it("lists all models with a header row and the current model footer", async () => {
		const tool = new ListModelsTool(makeSession());
		const result = await tool.execute("call-1", {});
		const text = readText(result);
		expect(text).toContain("可用模型 (5):");
		expect(text).toContain("| provider | model | context | reasoning |");
		expect(text).toContain("| narwal-plan | minimax-m3 | 200k | - |");
		expect(text).toContain("| alibaba-coding-plan | qwen3.6-plus | 1.0M | yes |");
		expect(text).toContain("| openai | gpt-5 | 400k | - |");
		expect(text).toContain("current: narwal-plan/minimax-m3");
		expect(text).toContain("/model <provider>/<modelId>");
		expect(text).toContain("`/model openai/o3`");
		expect(text).not.toContain("switch_model({query:");
	});

	it("sorts by provider then model id (deterministic order)", async () => {
		const tool = new ListModelsTool(makeSession());
		const result = await tool.execute("call-2", {});
		const text = readText(result);
		const alibabaIdx = text.indexOf("alibaba-coding-plan");
		const anthropicIdx = text.indexOf("anthropic");
		const narwalIdx = text.indexOf("narwal-plan");
		const openaiIdx = text.indexOf("openai");
		expect(alibabaIdx).toBeLessThan(anthropicIdx);
		expect(anthropicIdx).toBeLessThan(narwalIdx);
		expect(narwalIdx).toBeLessThan(openaiIdx);
	});

	it("filters by query substring (matches provider OR id, case-insensitive)", async () => {
		const tool = new ListModelsTool(makeSession());
		const result = await tool.execute("call-3", { query: "kimi" });
		const text = readText(result);
		expect(text).toContain("可用模型 (1/5");
		expect(text).toContain("| narwal-plan | kimi-k2.6 |");
		expect(text).not.toContain("gpt-5");
		expect(text).not.toContain("claude-opus-4-5");
	});

	it("returns no-match text when the query filters everything out", async () => {
		const tool = new ListModelsTool(makeSession());
		const result = await tool.execute("call-4", { query: "totally-unknown" });
		const text = readText(result);
		expect(text).toContain(`没有匹配 "totally-unknown" 的模型。`);
		expect(result.details.filtered).toBe(0);
	});

	it("shows context window in human-readable form (k / M)", async () => {
		const tool = new ListModelsTool(makeSession());
		const result = await tool.execute("call-5", {});
		const text = readText(result);
		expect(text).toContain("200k");
		expect(text).toContain("1.0M");
	});

	it("marks reasoning models with 'yes' in the table", async () => {
		const tool = new ListModelsTool(makeSession());
		const result = await tool.execute("call-6", {});
		const text = readText(result);
		expect(text).toMatch(/\| anthropic \| claude-opus-4-5 \| 200k \| yes \|/);
		expect(text).toMatch(/\| alibaba-coding-plan \| qwen3.6-plus \| 1\.0M \| yes \|/);
	});

	it("truncates to 50 rows with a notice when there are more", async () => {
		const many = Array.from({ length: 75 }, (_, i) =>
			makeModel({ provider: `p${String(i).padStart(2, "0")}`, id: `m${i}` }),
		);
		const tool = new ListModelsTool(makeSession({ getAvailableModels: () => many }));
		const result = await tool.execute("call-7", {});
		const text = readText(result);
		const rowCount = (text.match(/^\| p\d{2} /gm) ?? []).length;
		expect(rowCount).toBe(50);
		expect(text).toContain("仅显示前 50 条");
		expect(text).toContain("list_models");
	});

	it("does not truncate when total <= 50", async () => {
		const tool = new ListModelsTool(makeSession());
		const result = await tool.execute("call-8", {});
		const text = readText(result);
		expect(text).not.toContain("仅显示前 50 条");
	});

	it("errors when no models are available", async () => {
		const tool = new ListModelsTool(makeSession({ getAvailableModels: () => [] }));
		await expect(tool.execute("call-9", {})).rejects.toThrow(/当前没有可用的模型/);
	});

	it("falls back to modelRegistry.getVerifiedAvailable when getAvailableModels is absent", async () => {
		const getVerifiedAvailable = () => MODELS;
		const session = makeSession();
		const { getAvailableModels: _omit, ...rest } = session;
		rest.modelRegistry = { getVerifiedAvailable } as unknown as NonNullable<ToolSession["modelRegistry"]>;
		const tool = new ListModelsTool(rest);
		const result = await tool.execute("call-10", {});
		const text = readText(result);
		expect(text).toContain("可用模型 (5):");
	});

	it("omits the 'current:' footer when no active model is bound", async () => {
		const tool = new ListModelsTool(makeSession({ getActiveModelString: () => undefined }));
		const result = await tool.execute("call-11", {});
		const text = readText(result);
		expect(text).not.toContain("current:");
		expect(text).toContain("/model <provider>/<modelId>");
	});

	it("includes query in details when filter was applied", async () => {
		const tool = new ListModelsTool(makeSession());
		const result = await tool.execute("call-12", { query: "claude" });
		expect(result.details.query).toBe("claude");
		expect(result.details.filtered).toBe(1);
		expect(result.details.total).toBe(5);
		expect(result.details.current).toBe("narwal-plan/minimax-m3");
	});

	it("reports total + filtered in details even when no query is passed", async () => {
		const tool = new ListModelsTool(makeSession());
		const result = await tool.execute("call-13", {});
		expect(result.details.total).toBe(5);
		expect(result.details.filtered).toBe(5);
		expect(result.details.query).toBeUndefined();
	});

	it("intent field is set for both empty and filtered queries", () => {
		const tool = new ListModelsTool(makeSession());
		expect(tool.intent({})).toContain("Listing");
		expect(tool.intent({ query: "kimi" })).toContain("kimi");
	});
});
