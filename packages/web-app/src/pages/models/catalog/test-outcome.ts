import type { ModelCatalogEntryDto, ModelTestOutcome } from "@cornfield/wire";

/**
 * 连通性测试展示映射（模型控制中心 #04，纯逻辑）：六类 outcome → 徽章文案/语义色/释义、
 * 耗时格式化、测试可用性与确认文案。不依赖 store 与 DOM：ModelDetailDrawer 消费，
 * 单测直接覆盖（test/model-catalog-logic.test.ts）。
 */

/** outcome 展示映射（badge 色板与 STATUS_META 同一套：done/fail/warn/info/run/neutral）。 */
export const TEST_OUTCOME_META: Record<ModelTestOutcome, { label: string; badge: string; hint: string }> = {
	success: { label: "连通正常", badge: "done", hint: "模型接受请求并正常响应" },
	auth: { label: "认证失败", badge: "fail", hint: "凭据无效或过期（HTTP 401）——检查 API Key / OAuth 登录状态" },
	permission: {
		label: "无访问权限",
		badge: "fail",
		hint: "凭据有效但无该模型权限（403/404）——账号未开通或模型 ID 已下线",
	},
	"rate-limit": { label: "触发限流", badge: "run", hint: "请求频率/配额受限（HTTP 429）——凭据本身有效" },
	network: { label: "网络错误", badge: "fail", hint: "无法到达 Provider 或服务端错误——检查网络、Base URL 与服务状态" },
	timeout: { label: "请求超时", badge: "run", hint: "超过测试时限未收到响应——网络慢或 Provider 无响应" },
};

/** 测试确认文案（说明会产生一次真实调用与费用——必须展示在执行入口之前）。 */
export function testConfirmNotice(modelKey: string): string {
	return `将对 ${modelKey} 发起一次最小真实调用（约 20 tokens），可能产生少量费用。`;
}

/** 测试可用性：未接入 provider 无可测凭据，直接禁用（避免白弹一次费用确认）。 */
export function canRunConnectivityTest(entry: Pick<ModelCatalogEntryDto, "status">): boolean {
	return entry.status !== "provider-not-configured";
}

/** 耗时展示：< 1000ms 用 ms 整数，否则用一位小数的秒；非法值 "—"。 */
export function formatLatency(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "—";
	if (ms < 1000) return `${Math.round(ms)} ms`;
	return `${Math.round((ms / 1000) * 10) / 10} s`;
}
