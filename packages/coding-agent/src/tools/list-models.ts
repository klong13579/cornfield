import type { Model } from "@oh-my-pi/pi-ai";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import listModelsDescription from "../prompts/tools/list-models.md" with { type: "text" };
import type { ToolSession } from "./index";
import { ToolError } from "./tool-errors";

/**
 * `list_models` — read-only enumeration of models the current omp session
 * can call.
 *
 * Mirrors the gateway-side `/models` / `/list-models` slash command (see
 * `packages/pi-gateway/src/gateway-model-switch.ts`) but is callable by
 * the LLM, not just the user. Used when the LLM needs to proactively
 * surface options to the user (e.g. "what models are available?" /
 * "show me the Claude family") without bouncing the request off a
 * slash command and waiting for the user to type it.
 */

const listModelsSchema = Type.Object({
	query: Type.Optional(
		Type.String({
			description:
				"Optional case-insensitive substring filter applied to provider and model id. " +
				"Use to narrow before listing (e.g. 'kimi', 'claude', 'narwal-plan').",
			examples: ["kimi", "claude", "narwal-plan", "Qwen"],
		}),
	),
});

type ListModelsParams = Static<typeof listModelsSchema>;

export interface ListModelsToolDetails {
	total: number;
	filtered: number;
	current?: string;
	query?: string;
}

const MAX_ROWS = 50;

function formatContext(n: number | undefined): string {
	if (!n || n <= 0) return "-";
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
	return String(n);
}

function formatReasoning(m: Model): string {
	return m.reasoning ? "yes" : "-";
}

export class ListModelsTool implements AgentTool<typeof listModelsSchema, ListModelsToolDetails> {
	readonly name = "list_models";
	readonly label = "ListModels";
	readonly description: string;
	readonly parameters = listModelsSchema;
	readonly strict = false;
	readonly intent = (args: Partial<ListModelsParams>): string => {
		const q = typeof args.query === "string" ? args.query.trim() : "";
		return q ? `Listing models matching ${q}` : "Listing available models";
	};

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(listModelsDescription);
	}

	async execute(
		_toolCallId: string,
		params: ListModelsParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<ListModelsToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<ListModelsToolDetails>> {
		const models = this.#collectAvailableModels();
		const current = this.session.getActiveModelString?.();
		const query = typeof params.query === "string" ? params.query.trim() : "";

		if (models.length === 0) {
			throw new ToolError("当前没有可用的模型。请检查 API key 配置。");
		}

		const filtered = query ? this.#filter(models, query) : models;

		if (filtered.length === 0) {
			logger.info("list_models: no matches", { query, total: models.length });
			return {
				content: [{ type: "text", text: `没有匹配 "${query}" 的模型。` }],
				details: { total: models.length, filtered: 0, current, query },
			};
		}

		const sorted = [...filtered].sort((a, b) => {
			const providerCmp = a.provider.localeCompare(b.provider);
			return providerCmp !== 0 ? providerCmp : a.id.localeCompare(b.id);
		});

		const truncated = sorted.length > MAX_ROWS;
		const rows = sorted.slice(0, MAX_ROWS).map(m => {
			const ctx = formatContext(m.contextWindow);
			const think = formatReasoning(m);
			return `| ${m.provider} | ${m.id} | ${ctx} | ${think} |`;
		});

		const table = `| provider | model | context | reasoning |
|---|---|---|---|
${rows.join("\n")}`;

		const countLabel = query
			? `${filtered.length}/${models.length}（匹配 "${query}"）`
			: `${models.length}`;
		const truncationNotice = truncated
			? `\n\n…仅显示前 ${MAX_ROWS} 条；用 \`list_models({query: "<filter>"})\` 缩小范围。`
			: "";
		const currentLine = current ? `\n\ncurrent: ${current}` : "";
		const hint = "\n\n切换模型: `switch_model({query: \"<provider>/<modelId>\"})`";

		const text = `可用模型 (${countLabel}):\n\n${table}${truncationNotice}${currentLine}${hint}`;

		logger.info("list_models: returned", {
			total: models.length,
			filtered: filtered.length,
			query: query || undefined,
			truncated,
		});

		return {
			content: [{ type: "text", text }],
			details: {
				total: models.length,
				filtered: filtered.length,
				current,
				query: query || undefined,
			},
		};
	}

	#collectAvailableModels(): Model[] {
		const fromSession = this.session.getAvailableModels?.();
		if (fromSession && fromSession.length > 0) return fromSession;
		const registry = this.session.modelRegistry;
		return registry ? registry.getAvailable() : [];
	}

	#filter(models: Model[], query: string): Model[] {
		const q = query.toLowerCase();
		return models.filter(m => m.provider.toLowerCase().includes(q) || m.id.toLowerCase().includes(q));
	}
}
