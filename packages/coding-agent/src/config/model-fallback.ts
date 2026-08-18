/**
 * 模型级故障回退（path A：agent 配置层）。
 *
 * 动机：单一 provider 的 API key 失效 / 限流 / 5xx 会让整个 agent 会话瘫痪
 * （实测：alibaba-coding-plan key 失效 → 401 连挂）。主模型失败时应自动
 * 切到配置的备用模型重试一轮，而不是把会话打垮。
 *
 * 用法（agentDir `config.yml`）：
 * ```yaml
 * modelRoles:
 *   default: alibaba-coding-plan/deepseek-v4-flash
 * modelFallbacks:
 *   - narwal-plan/deepseek-v4-flash-0731
 *   - narwal-plan/qwen3.7-plus
 * ```
 * `modelFallbacks` 是本 agent 的备用模型列表（字符串，与 modelRoles 同格式）。
 *
 * 触发条件：401（鉴权）/ 429（限流）/ 5xx / 网络错误（TypeError /
 * ECONNRESET / timeout）。主动取消（AbortError）**不**触发回退。
 *
 * 重试边界：只对"尚未产出任何事件"前的失败重试——流已经输出过半再失败是
 * 上下文不完整的信号，切模型重放会丢语义，直接抛原错。
 */

import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import type { Api, AssistantMessageEventStream, Model } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "./model-registry";
import { resolveModelRoleValue } from "./model-resolver";
import type { SettingPath, Settings } from "./settings";

/** settings.modelFallbacks 键名。 */
export const MODEL_FALLBACKS_KEY = "modelFallbacks";

/** 判定一次 LLM 失败是否值得切备用模型重试。 */
export function isRetryableError(err: unknown): boolean {
	if (!err) return false;
	if (err instanceof Error && err.name === "AbortError") return false;
	const anyErr = err as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } };
	const status = anyErr?.status ?? anyErr?.statusCode ?? anyErr?.response?.status;
	if (typeof status === "number") {
		return status === 401 || status === 429 || status >= 500;
	}
	if (err instanceof TypeError) return true; // fetch 网络层失败
	if (err instanceof Error) {
		return /(ECONNRESET|ETIMEDOUT|ENOTFOUND|timeout|socket hang up|network error)/i.test(err.message);
	}
	return false;
}

/**
 * 从 settings 解析当前 agent 的 fallback 模型列表（与主模型同一套解析逻辑，
 * 含 thinking level；去重；解析失败的条目跳过并告警）。
 */
export function resolveFallbackModels(
	settings: Settings,
	registry: ModelRegistry,
	availableModels: Model<Api>[],
): Model<Api>[] {
	const raw = settings.get("modelFallbacks" as SettingPath) as unknown;
	if (raw === undefined || raw === null) return [];
	const specs = (Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : []) as string[];
	const out: Model<Api>[] = [];
	for (const spec of specs) {
		try {
			const resolved = resolveModelRoleValue(spec, availableModels, { settings, modelRegistry: registry });
			const m = resolved?.model;
			if (m && !out.some(x => x.provider === m.provider && x.id === m.id)) {
				out.push(m);
			}
		} catch (err) {
			logger.warn(`modelFallbacks: 解析失败，跳过 "${spec}"`, { err: String(err) });
		}
	}
	return out;
}

/**
 * 包一层 lazy 流：主模型失败（可重试类）且尚未产出事件时，依次用备用模型
 * 重建流重试；全部失败抛最后错误。`raw` 或 `fallbacks` 为空时原样返回。
 */
export function withModelFallback(raw: StreamFn, fallbacks: readonly Model<Api>[]): StreamFn {
	if (fallbacks.length === 0) return raw;
	return (model, context, options) => {
		const candidates = [model, ...fallbacks];
		async function* run(): AsyncGenerator<AssistantMessageEventStream extends AsyncIterable<infer T> ? T : never> {
			let emitted = false;
			let lastErr: unknown;
			for (const candidate of candidates) {
				try {
					const stream = await raw(candidate, context, options);
					for await (const event of stream) {
						emitted = true;
						yield event;
					}
					return;
				} catch (err) {
					lastErr = err;
					if (emitted || candidates.length === 1 || !isRetryableError(err)) throw err;
					logger.warn(`模型 ${candidate.provider}/${candidate.id} 失败（${describe(err)}），回退备用模型`);
				}
			}
			throw lastErr;
		}
		return { [Symbol.asyncIterator]: () => run() } as unknown as AssistantMessageEventStream;
	};
}

function describe(err: unknown): string {
	return err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120);
}
