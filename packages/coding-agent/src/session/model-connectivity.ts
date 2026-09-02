/**
 * 单模型连通性测试（模型控制中心 #04：test_model）。
 *
 * 复用既有验证机制而非另起探测体系：真实调用走 `completeSimple`（与 title-generator 的
 * 单发补全、真实会话流量同一条 API 适配链路——anthropic-messages / openai-completions /
 * google / ollama 等全部 API 类型，包括内部重试与超时看门狗），因此探测结果与该模型
 * 真实可用性一致。错误分类复用 @cornfield/ai 的 extractHttpStatusFromError（与重试层
 * 同一套状态码提取启发式），保证对"HTTP 401 / API error (429)"等既有错误文案的识别一致。
 *
 * 结果六类（ModelTestOutcome）：success / auth / permission / rate-limit / network / timeout。
 * 失败不伪装成功：非 success 一律带 outcome + 可诊断 message；deadline 触发归类 timeout，
 * 但若错误本身带明确归因（如 429），按真实归因分类。
 */

import type { Api, AssistantMessage, Model } from "@cornfield/ai";
import { completeSimple, extractHttpStatusFromError } from "@cornfield/ai";
import type { ModelTestOutcome } from "@cornfield/wire";

/** 测试时限。客户端 wire 请求超时默认 30s，留余量给结果回传。 */
export const MODEL_TEST_TIMEOUT_MS = 20_000;

/**
 * 探测请求的输出 token 上限。16 是 openai-responses max_output_tokens 的下限——
 * 用 1 会在该 API 类型上必然 400（探测形状自身制造假失败）。
 */
const PROBE_MAX_TOKENS = 16;

/** 探测用户消息（最小输入；与 @cornfield/ai probeAccessibleModels 同款）。 */
const PROBE_USER_TEXT = "ok";

/** 探测成功文案（DTO message；耗时由 latencyMs 单独承载）。 */
const PROBE_SUCCESS_MESSAGE = "模型响应正常";

/** 429 携带超长 Retry-After 时立即失败（走限流分类），不让内部重试把限流拖成超时。 */
const PROBE_MAX_RETRY_DELAY_MS = 2_000;

/** 原始错误摘要截断长度（provider 错误体可能携带超长 dump）。 */
const MAX_MESSAGE_LENGTH = 300;

/** 非对话模型分类（探测走 chat 补全端点，对其余端点发起 chat 调用只会产出误导性结果）。 */
export const MODEL_TEST_UNSUPPORTED_CATEGORIES = new Set(["asr", "tts", "embedding", "image", "video"]);

/** 失败分类输入：deadline 命中标记 + 原始错误文本（AssistantMessage.errorMessage 或抛错 message）。 */
export interface ModelTestFailureInput {
	/** 我方测试时限触发（请求已 abort）。 */
	deadlineHit?: boolean;
	/** 原始错误文本；空/undefined = 无归因信息。 */
	rawMessage?: string;
	/** 抛出的错误对象（可携带 .status 等结构化字段；与 rawMessage 二选一或同给）。 */
	error?: unknown;
}

/** 失败分类结果（ModelTestResultDto 去掉身份与耗时字段的公共部分）。 */
export interface ModelTestFailureClassification {
	outcome: Exclude<ModelTestOutcome, "success">;
	httpStatus?: number;
	message: string;
}

/**
 * 失败分类。优先级：HTTP 状态码 > 错误文本模式 > deadline（timeout）> network 兜底。
 * - 401 → auth；403 / 404 → permission（404 在模型探测语境 = 模型不存在或无访问权）；
 *   429 → rate-limit；408 → timeout；5xx → network。
 * - 文本模式覆盖无状态码的错误文案（如 "quota exceeded"、"fetch failed"）。
 * - deadline 命中但错误带明确归因（如重试耗尽后才浮出的 429）按真实归因分类。
 */
export function classifyModelTestFailure(input: ModelTestFailureInput): ModelTestFailureClassification {
	const rawMessage = input.rawMessage ?? "";
	const statusSource = input.error ?? (rawMessage ? new Error(rawMessage) : undefined);
	// OpenAI SDK 约定：APIError.message 以 `${status} ${msg}` 开头（含 "401 status code (no body)"
	// 形态）。extractHttpStatusFromError 只认 status/error/http 关键字邻接形态，这里补首部前缀提取。
	const prefixStatus = /^\s*(\d{3})\s/.exec(rawMessage);
	const status =
		(statusSource !== undefined ? extractHttpStatusFromError(statusSource) : undefined) ??
		(prefixStatus ? Number(prefixStatus[1]) : undefined);

	const message = rawMessage.length > MAX_MESSAGE_LENGTH ? `${rawMessage.slice(0, MAX_MESSAGE_LENGTH)}…` : rawMessage;

	let outcome: ModelTestFailureClassification["outcome"] | undefined;
	if (status === 401) outcome = "auth";
	else if (status === 403 || status === 404) outcome = "permission";
	else if (status === 429) outcome = "rate-limit";
	else if (status === 408) outcome = "timeout";
	else if (status !== undefined && status >= 500) outcome = "network";

	if (outcome === undefined && rawMessage) {
		const lowered = rawMessage.toLowerCase();
		if (/\btimed?\s*out\b|\btimeout\b|deadline exceeded|etimedout/.test(lowered)) outcome = "timeout";
		else if (/rate.?limit|too many requests|quota|resource.?exhausted|usage limit/.test(lowered)) {
			outcome = "rate-limit";
		} else if (
			/unauthorized|invalid_api_key|incorrect api key|invalid (api ?key|token|credential)|authentication|unauthenticated|expired token|api key (not|is) (valid|provided)/.test(
				lowered,
			)
		) {
			outcome = "auth";
		} else if (
			/forbidden|permission|access denied|not allowed|does not have access|not entitled|no access|model_not_found|does not exist|not found/.test(
				lowered,
			)
		) {
			outcome = "permission";
		} else if (
			/fetch failed|network|socket|connection|econnrefused|econnreset|enotfound|dns|certificate|\bssl\b|\btls\b|server error|internal server|bad gateway|service unavailable|overloaded|cloudflare/.test(
				lowered,
			)
		) {
			outcome = "network";
		}
	}

	if (outcome === undefined && input.deadlineHit) outcome = "timeout";
	return { outcome: outcome ?? "network", ...(status !== undefined ? { httpStatus: status } : {}), message };
}

/** 连通性探测结果（AgentSession.testModel 组装 DTO 的中间形态；outcome 含 success）。 */
export interface ModelProbeResult {
	outcome: ModelTestOutcome;
	latencyMs: number;
	message: string;
	httpStatus?: number;
}

/** 探测选项。 */
export interface ModelProbeOptions {
	/** 测试时限（ms）；缺省 MODEL_TEST_TIMEOUT_MS。超时 abort 请求并归类 timeout。 */
	timeoutMs?: number;
}

/**
 * 对单模型发起一次最小真实调用（1 条用户消息 + PROBE_MAX_TOKENS 输出上限）。
 * 走 completeSimple 与真实会话同一条适配链路；调用是真实 API 调用、可能产生费用——
 * 调用方（UI）必须先经用户确认。
 *
 * 失败的两种形态都归一为 outcome：
 * - provider 错误经错误事件回传 → AssistantMessage.stopReason = "error"/"aborted"；
 * - completeSimple 同步抛错（无 API key、未支持的 API 类型等）。
 */
export async function runModelConnectivityProbe(
	model: Model<Api>,
	apiKey: string,
	options?: ModelProbeOptions,
): Promise<ModelProbeResult> {
	const timeoutMs = options?.timeoutMs ?? MODEL_TEST_TIMEOUT_MS;
	const controller = new AbortController();
	let deadlineHit = false;
	const timer = setTimeout(() => {
		deadlineHit = true;
		controller.abort();
	}, timeoutMs);
	const startedAt = Date.now();
	try {
		const result: AssistantMessage = await completeSimple(
			model,
			{ messages: [{ role: "user", content: PROBE_USER_TEXT, timestamp: Date.now() }] },
			{
				apiKey,
				maxTokens: PROBE_MAX_TOKENS,
				signal: controller.signal,
				maxRetryDelayMs: PROBE_MAX_RETRY_DELAY_MS,
			},
		);
		const latencyMs = Date.now() - startedAt;
		if (result.stopReason === "error" || result.stopReason === "aborted") {
			const failure = classifyModelTestFailure({ deadlineHit, rawMessage: result.errorMessage });
			return { ...failure, latencyMs };
		}
		return { outcome: "success", latencyMs, message: PROBE_SUCCESS_MESSAGE };
	} catch (error) {
		const latencyMs = Date.now() - startedAt;
		const rawMessage = error instanceof Error ? error.message : String(error);
		const failure = classifyModelTestFailure({ deadlineHit, rawMessage, error });
		return { ...failure, latencyMs };
	} finally {
		clearTimeout(timer);
	}
}
