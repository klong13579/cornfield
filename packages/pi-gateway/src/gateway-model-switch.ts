/**
 * Model switch / model command handling.
 *
 * Handles /model, /models, /list-models slash commands and natural-language
 * model switch interception (e.g. "切换模型到 kimi-k2.6").
 */
import { logger } from "@oh-my-pi/pi-utils";
import { AgentBridge } from "./agent-bridge";
import { extractModelSwitchArg, fuzzyMatchModel, type MatchableModel } from "./model-switch";
import type { InboundMessage } from "./types";

function formatModelNumber(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
	return String(n);
}

/** Interface for the subset of Gateway that ModelSwitch needs. */
export interface ModelSwitchGatewayDeps {
	resolveDirectBridge(accountId?: string): AgentBridge | null;
	sendAgentResponse(msg: InboundMessage, text: string): Promise<void>;
	extractMessageText(msg: InboundMessage): string;
}

export class ModelSwitch {
	#deps: ModelSwitchGatewayDeps;

	constructor(deps: ModelSwitchGatewayDeps) {
		this.#deps = deps;
	}

	async handleModelCommand(msg: InboundMessage, accountId: string): Promise<boolean> {
		const text = this.#deps.extractMessageText(msg).trim();
		if (!text.startsWith("/models") && !text.startsWith("/list-models") && !text.startsWith("/model")) return false;

		const bridge = this.#deps.resolveDirectBridge(accountId === "__default__" ? undefined : accountId);
		if (!bridge?.isRunning) {
			await this.#deps.sendAgentResponse(msg, "Agent 未启动，无法执行模型命令。请稍后再试。");
			return true;
		}

		// /models or /list-models — list all available models
		if (
			text === "/models" ||
			text === "/list-models" ||
			text.startsWith("/models ") ||
			text.startsWith("/list-models ")
		) {
			try {
				const response = await bridge.getAvailableModels();
				if (!response.data || typeof response.data !== "object") {
					await this.#deps.sendAgentResponse(msg, "无法获取模型列表。");
					return true;
				}
				const { models } = response.data as {
					models: Array<{
						provider: string;
						id: string;
						contextWindow?: number;
						reasoning?: boolean;
						thinking?: unknown;
					}>;
				};
				if (!Array.isArray(models) || models.length === 0) {
					await this.#deps.sendAgentResponse(msg, "当前没有可用的模型。请检查 API key 配置。");
					return true;
				}

				const searchPattern = text.startsWith("/models ")
					? text.slice(8).trim()
					: text.startsWith("/list-models ")
						? text.slice(13).trim()
						: undefined;
				let filtered = models;
				if (searchPattern) {
					const pattern = searchPattern.toLowerCase();
					filtered = models.filter(
						m => m.provider.toLowerCase().includes(pattern) || m.id.toLowerCase().includes(pattern),
					);
					if (filtered.length === 0) {
						await this.#deps.sendAgentResponse(msg, `没有匹配 "${searchPattern}" 的模型。`);
						return true;
					}
				}

				filtered.sort((a, b) => {
					const providerCmp = a.provider.localeCompare(b.provider);
					if (providerCmp !== 0) return providerCmp;
					return a.id.localeCompare(b.id);
				});

				const rows = filtered.map(m => {
					const ctx = m.contextWindow ? formatModelNumber(m.contextWindow) : "-";
					const think = m.reasoning ? "yes" : "-";
					return `| ${m.provider} | ${m.id} | ${ctx} | ${think} |`;
				});
				const table = `| provider | model | context | reasoning |
|---|---|---|---|
${rows.join("\n")}`;
				const count =
					filtered.length === models.length ? `${models.length}` : `${filtered.length}/${models.length}`;
				await this.#deps.sendAgentResponse(
					msg,
					`可用模型 (${count}):\n\n${table}\n\n切换模型: /model <provider>/<modelId>`,
				);
				return true;
			} catch (err) {
				logger.error("Failed to list models", { error: err instanceof Error ? err.message : String(err) });
				await this.#deps.sendAgentResponse(msg, `获取模型列表失败: ${err instanceof Error ? err.message : String(err)}`);
				return true;
			}
		}

		// /model with no args — show current model
		if (text === "/model") {
			try {
				const response = await bridge.getState();
				if (!response.data || typeof response.data !== "object") {
					await this.#deps.sendAgentResponse(msg, "无法获取当前模型信息。");
					return true;
				}
				const state = response.data as { model?: { provider: string; id: string }; thinkingLevel?: string };
				if (!state.model) {
					await this.#deps.sendAgentResponse(msg, "当前没有选中模型。");
					return true;
				}
				const modelStr = `${state.model.provider}/${state.model.id}`;
				const thinking = state.thinkingLevel ? ` (推理级别: ${state.thinkingLevel})` : "";
				await this.#deps.sendAgentResponse(msg, `当前模型: ${modelStr}${thinking}`);
				return true;
			} catch (err) {
				logger.error("Failed to get current model", { error: err instanceof Error ? err.message : String(err) });
				await this.#deps.sendAgentResponse(msg, `获取当前模型失败: ${err instanceof Error ? err.message : String(err)}`);
				return true;
			}
		}

		// /model <provider>/<modelId> — switch model
		const modelArg = text.startsWith("/model ") ? text.slice(7).trim() : undefined;
		if (!modelArg) return false;

		let provider: string | undefined;
		let modelId: string;
		if (modelArg.includes("/")) {
			const [p, m] = modelArg.split("/", 2);
			provider = p;
			modelId = m;
		} else if (modelArg.includes(":")) {
			const [p, m] = modelArg.split(":", 2);
			provider = p;
			modelId = m;
		} else {
			try {
				const stateResponse = await bridge.getState();
				const stateData = stateResponse.data as { model?: { provider: string } } | undefined;
				provider = stateData?.model?.provider;
				modelId = modelArg;
			} catch {
				await this.#deps.sendAgentResponse(msg, `无法确定当前 provider。请使用完整格式: /model <provider>/<modelId>`);
				return true;
			}
		}

		if (!provider) {
			await this.#deps.sendAgentResponse(msg, `无法确定 provider。请使用完整格式: /model <provider>/<modelId>`);
			return true;
		}

		return this.#switchModelAndReply(bridge, msg, provider, modelId);
	}

	async tryNaturalLanguageModelSwitch(msg: InboundMessage, accountId: string): Promise<boolean> {
		const text = this.#deps.extractMessageText(msg);
		const modelArg = extractModelSwitchArg(text);
		if (!modelArg) return false;

		const bridge = this.#deps.resolveDirectBridge(accountId === "__default__" ? undefined : accountId);
		if (!bridge?.isRunning) {
			await this.#deps.sendAgentResponse(msg, "Agent 未启动，无法切换模型。请稍后再试。");
			return true;
		}

		try {
			const response = await bridge.getAvailableModels();
			if (!response.data || typeof response.data !== "object") {
				await this.#deps.sendAgentResponse(msg, "无法获取模型列表。");
				return true;
			}
			const { models } = response.data as { models?: MatchableModel[] };
			if (!Array.isArray(models) || models.length === 0) {
				await this.#deps.sendAgentResponse(msg, "当前没有可用模型。");
				return true;
			}

			const match = fuzzyMatchModel(models, modelArg);
			if (!match) {
				const available = models.map(m => `\`${m.provider}/${m.id}\``).join("、");
				await this.#deps.sendAgentResponse(msg, `未找到匹配 "${modelArg}" 的模型。可用模型：${available}`);
				return true;
			}

			return this.#switchModelAndReply(bridge, msg, match.provider, match.id);
		} catch (err) {
			logger.error("NL model switch failed", { error: err instanceof Error ? err.message : String(err) });
			await this.#deps.sendAgentResponse(msg, `切换模型失败: ${err instanceof Error ? err.message : String(err)}`);
			return true;
		}
	}

	async #switchModelAndReply(
		bridge: AgentBridge,
		msg: InboundMessage,
		provider: string,
		modelId: string,
	): Promise<boolean> {
		try {
			const response = await bridge.setModel(provider, modelId);
			logger.info("NL model switch response", {
				requestedProvider: provider,
				requestedModelId: modelId,
				success: response.success,
				responseData: response.data,
				error: (response as Record<string, unknown>).error,
			});
			if (!response.success) {
				await this.#deps.sendAgentResponse(msg, `切换模型失败: ${response.error ?? "未知错误"}`);
				return true;
			}
			const model = response.data as { provider: string; id: string } | undefined;
			const modelStr = model ? `${model.provider}/${model.id}` : `${provider}/${modelId}`;
			await this.#deps.sendAgentResponse(msg, `已切换到模型: ${modelStr}`);
			return true;
		} catch (err) {
			logger.error("Failed to switch model", {
				provider,
				modelId,
				error: err instanceof Error ? err.message : String(err),
			});
			await this.#deps.sendAgentResponse(msg, `切换模型失败: ${err instanceof Error ? err.message : String(err)}`);
			return true;
		}
	}
}