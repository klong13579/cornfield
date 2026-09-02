import type { ConfigScopeDto, ModelCatalogDto, ProviderConnectionStatus, ProviderListDto } from "@cornfield/wire";

/**
 * 控制中心异常推导（模型控制中心 #08，纯逻辑）——从三份只读数据
 * （ProviderListDto + ModelCatalogDto + ConfigScopeDto）推导当前异常清单。
 *
 * 设计红线：
 * - 「失效待修复」是**派生态**：配置（modelRoutes）引用了当前不可用的模型。
 *   它不是写进配置的标记，也不是 serve 端的持久状态——provider 恢复 connected
 *   且模型回到目录（status=available）后，重新推导即自动消失，无需清理动作。
 * - 只消费传入数据，不触 store / DOM；数据缺失（null）时跳过对应规则族，
 *   绝不报假阳性（例如目录拉不到时不判定「模型不在目录中」）。
 * - 会话当前模型不在此推导：快照只有 model id（无 provider 前缀，跨 provider
 *   可能歧义），会话级依赖由 serve 的 disconnect_provider 依赖检查负责，
 *   ProviderCard 断开面板直接展示该结果。
 */

/** 异常严重级别：critical = 需要处理才能恢复正常工作；warning = 即将劣化 / 建议处置。 */
export type ExceptionSeverity = "critical" | "warning";

/**
 * 异常种类（判定规则一一对应）：
 * - provider-credential-invalid / unreachable / local-offline：provider 三种不可用态；
 * - provider-oauth-expiring：OAuth 临近过期（可继续用，但即将劣化）；
 * - provider-catalog-stale：目录非权威（缓存 / 回落数据）；
 * - route-primary-unavailable / route-fallback-unavailable：失效待修复——
 *   modelRoutes 角色 primary / 回退位引用了不可用模型（含目录中不存在）。
 */
export type ExceptionKind =
	| "provider-credential-invalid"
	| "provider-unreachable"
	| "provider-local-offline"
	| "provider-oauth-expiring"
	| "provider-catalog-stale"
	| "route-primary-unavailable"
	| "route-fallback-unavailable";

/** 异常跳转目标（模型控制中心内的子工作区路由）。 */
export type ExceptionTarget = "/models/providers" | "/models/config" | "/models/catalog";

/** 单条控制中心异常（推导结果，展示与跳转由壳层渲染）。 */
export interface ControlCenterException {
	kind: ExceptionKind;
	severity: ExceptionSeverity;
	/** 单行标题（异常清单行首）。 */
	title: string;
	/** 处置说明（去哪、做什么）。 */
	detail: string;
	/** 跳转入口（对应子工作区路由）。 */
	target: ExceptionTarget;
	/** provider 状态类异常的 providerId；route 类异常不设置。 */
	providerId?: string;
	/** 失效待修复附加信息：角色名。 */
	role?: string;
	/** 失效待修复附加信息：引用位置（primary / 回退位下标）。 */
	position?: "primary" | `fallbacks[${number}]`;
	/** 失效待修复附加信息：引用的模型（`provider/modelId` 规范形，无 thinking level 后缀）。 */
	model?: string;
}

/** deriveExceptions 输入：三份数据均可缺失（null / undefined = 该数据当前不可用）。 */
export interface ExceptionsInput {
	providers?: ProviderListDto | null;
	catalog?: ModelCatalogDto | null;
	scope?: ConfigScopeDto | null;
}

/** provider 异常的严重级别与文案（不可用三态 critical；即将过期 warning）。 */
const PROVIDER_EXCEPTIONS: Partial<
	Record<ProviderConnectionStatus, Pick<ControlCenterException, "severity" | "title" | "detail">>
> = {
	"credential-invalid": {
		severity: "critical",
		title: "凭据失效",
		detail: "已配置凭据但已知失效（401 / token 刷新失败），重新认证或替换 API Key 后恢复。",
	},
	unreachable: {
		severity: "critical",
		title: "Provider 不可达",
		detail: "远端 Provider 不可达（网络 / 网关错误），检查网络与 Base URL 后恢复。",
	},
	"local-offline": {
		severity: "critical",
		title: "本地端点离线",
		detail: "本地 Provider 进程不可达，确认本地服务已启动且端点地址正确。",
	},
	"oauth-expiring": {
		severity: "warning",
		title: "OAuth 即将过期",
		detail: "OAuth 凭据临近过期，请在过期前重新认证，避免凭据失效引发失效待修复。",
	},
};

const SEVERITY_RANK: Record<ExceptionSeverity, number> = { critical: 0, warning: 1 };

/**
 * 解析 modelRoutes 中的模型 spec（`provider/modelId[:level]`），与 coding-agent
 * parseModelString + parseThinkingLevel 的语义对齐：仅剥掉已知 thinking level
 * 后缀（inherit/off/minimal/low/medium/high/xhigh）；其余冒号后缀是模型 id 的一部分
 * （如 openrouter 路由）。provider 不含 `/`，取首个 `/` 切分。
 */
const THINKING_LEVEL_SUFFIXES = new Set(["inherit", "off", "minimal", "low", "medium", "high", "xhigh"]);

export function parseModelSpec(spec: string): { provider: string; id: string } | null {
	const slashIdx = spec.indexOf("/");
	if (slashIdx <= 0) return null;
	const provider = spec.slice(0, slashIdx);
	const rawId = spec.slice(slashIdx + 1);
	const colonIdx = rawId.lastIndexOf(":");
	if (colonIdx !== -1 && THINKING_LEVEL_SUFFIXES.has(rawId.slice(colonIdx + 1))) {
		return { provider, id: rawId.slice(0, colonIdx) };
	}
	return { provider, id: rawId };
}

/**
 * 规范化 ConfigScopeDto 中 modelRoutes 的 effectiveValue（与 coding-agent
 * normalizeModelRoutes 同等容错：用户手改 YAML 不应让推导崩溃）。垃圾项跳过：
 * 非对象路由、非字符串 primary、非数组/非字符串回退项一律忽略。
 */
function normalizeRoutes(effectiveValue: unknown): Record<string, { primary?: string; fallbacks: string[] }> {
	const out: Record<string, { primary?: string; fallbacks: string[] }> = {};
	if (!effectiveValue || typeof effectiveValue !== "object" || Array.isArray(effectiveValue)) return out;
	for (const [role, value] of Object.entries(effectiveValue as Record<string, unknown>)) {
		if (!value || typeof value !== "object" || Array.isArray(value)) continue;
		const raw = value as { primary?: unknown; fallbacks?: unknown };
		const primary = typeof raw.primary === "string" && raw.primary.trim() ? raw.primary.trim() : undefined;
		const fallbacks = Array.isArray(raw.fallbacks)
			? raw.fallbacks.filter((item): item is string => typeof item === "string" && item.trim() !== "")
			: [];
		if (!primary && fallbacks.length === 0) continue;
		out[role] = { primary, fallbacks };
	}
	return out;
}

/** 目录状态标签（与 catalog/catalog-logic 的 STATUS_META 同源文案；此处独立维护避免跨目录 import 循环）。 */
const CATALOG_STATUS_LABELS: Record<string, string> = {
	"provider-not-configured": "Provider 未接入",
	"credential-invalid": "凭据失效",
	disabled: "已停用",
	"local-offline": "本地离线",
	"catalog-stale": "目录过期",
};

/**
 * 异常推导主入口。规则（按规则族，输出再按严重级别稳定排序——critical 在前，
 * 同级保持规则内顺序）：
 * 1. provider 状态异常（providers 列表顺序，每 provider 至多一条）；
 * 2. 目录非权威（catalog.providers meta 顺序）；
 * 3. 失效待修复：modelRoutes 各角色 primary 与每个回退位（role 插入序，primary 先于
 *    回退位；回退位按数组下标）引用不可用模型——目录中不存在，或目录 status ≠ available。
 */
export function deriveExceptions(input: ExceptionsInput): ControlCenterException[] {
	const items: ControlCenterException[] = [];

	for (const provider of input.providers?.providers ?? []) {
		const rule = PROVIDER_EXCEPTIONS[provider.status];
		if (!rule) continue;
		items.push({
			kind: `provider-${provider.status}` as ExceptionKind,
			severity: rule.severity,
			title: rule.title,
			detail: `${provider.displayName ?? provider.providerId}：${rule.detail}`,
			target: "/models/providers",
			providerId: provider.providerId,
		});
	}

	const catalog = input.catalog;
	for (const meta of catalog?.providers ?? []) {
		if (!meta.stale) continue;
		items.push({
			kind: "provider-catalog-stale",
			severity: "warning",
			title: "目录非权威",
			detail: `${meta.displayName ?? meta.providerId} 的目录为缓存 / 回落数据，去 Provider 工作区刷新后更新。`,
			target: "/models/providers",
			providerId: meta.providerId,
		});
	}

	const scope = input.scope;
	if (scope && catalog) {
		const routeKey = scope.keys.find(k => k.key === "modelRoutes");
		const routes = normalizeRoutes(routeKey?.effectiveValue);
		for (const [role, route] of Object.entries(routes)) {
			const positions: Array<{ position: ControlCenterException["position"]; spec?: string }> = [
				{ position: "primary", spec: route.primary },
				...route.fallbacks.map((spec, index) => ({ position: `fallbacks[${index}]` as const, spec })),
			];
			for (const { position, spec } of positions) {
				if (!spec) continue;
				const parsed = parseModelSpec(spec);
				if (!parsed) continue;
				const entry = catalog.models.find(m => m.provider === parsed.provider && m.id === parsed.id);
				if (entry && entry.status === "available") continue;
				const fallbackPosition = position !== "primary";
				items.push({
					kind: fallbackPosition ? "route-fallback-unavailable" : "route-primary-unavailable",
					severity: fallbackPosition ? "warning" : "critical",
					title: fallbackPosition ? "回退链引用不可用模型" : "角色主模型引用不可用模型",
					detail: entry
						? `模型当前不可用（${CATALOG_STATUS_LABELS[entry.status] ?? entry.status}）。${fallbackPosition ? "主模型失败时该回退位不可用。" : "该角色的主模型不可调用。"}修复入口：运行时配置调整角色路由，或恢复对应 Provider。`
						: `模型不在目录中（拼写错误或 Provider 未知）。修复入口：运行时配置调整角色路由。`,
					target: "/models/config",
					role,
					position,
					model: `${parsed.provider}/${parsed.id}`,
				});
			}
		}
	}

	return items.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

/** 目录健康状态（壳层状态条「目录状态」）：null = 不可用；stale 计数 > 0 = 过期；否则权威。 */
export function catalogHealth(catalog: ModelCatalogDto | null): { label: string; staleCount: number } {
	if (!catalog) return { label: "—", staleCount: 0 };
	const staleCount = catalog.providers.filter(p => p.stale).length;
	return staleCount > 0 ? { label: `过期 ${staleCount} 个`, staleCount } : { label: "权威", staleCount: 0 };
}
