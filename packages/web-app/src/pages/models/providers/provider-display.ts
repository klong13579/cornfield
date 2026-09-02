import type {
	ProviderConnectionStatus,
	ProviderCredentialSource,
	ProviderDependencyDto,
	ProviderStatusDto,
} from "@cornfield/wire";

/**
 * Provider 管理页的纯展示映射（#03）——状态→徽章/文案、凭据掩码行、断开依赖分组。
 * 只做数据→展示字符串的映射，不触 store、不持有状态；单测锁定这些文案契约
 * （test/provider-management-display.test.ts）。
 */

/** 连接六态徽章：className 复用 index.css 的 badge 语义色变体。 */
export interface StatusBadge {
	label: string;
	className: string;
}

const STATUS_BADGES: Record<ProviderConnectionStatus, StatusBadge> = {
	connected: { label: "已连接", className: "badge done" },
	"not-configured": { label: "未接入", className: "badge neutral" },
	"oauth-expiring": { label: "OAuth 即将过期", className: "badge run" },
	"credential-invalid": { label: "凭据失效", className: "badge fail" },
	unreachable: { label: "不可达", className: "badge fail" },
	"local-offline": { label: "本地端点离线", className: "badge fail" },
};

export function statusBadge(status: ProviderConnectionStatus): StatusBadge {
	return STATUS_BADGES[status];
}

/** 凭据来源显示名（api-key/oauth/env/none）。 */
const SOURCE_LABELS: Record<ProviderCredentialSource, string> = {
	"api-key": "API Key",
	oauth: "OAuth",
	env: "环境变量",
	none: "未配置",
};

export function credentialSourceLabel(source: ProviderCredentialSource): string {
	return SOURCE_LABELS[source];
}

/**
 * 凭据行文案。安全红线：唯一允许出现的密钥内容是后端已掩码的 maskedKey 片段——
 * 明文密钥根本不进前端（DTO 契约），这里也不会从任何其他字段拼出密钥。
 * credentialSource=none 时返回 null（调用方显示「未配置凭据」）。
 */
export function credentialSummary(provider: ProviderStatusDto): string | null {
	const { credentialSource } = provider;
	if (credentialSource === "api-key") {
		return provider.maskedKey ? `已存 API Key · ${provider.maskedKey}` : "已存 API Key（掩码片段未提供）";
	}
	if (credentialSource === "oauth") {
		return provider.oauthExpiresAt ? `OAuth 登录 · ${isoToMinuteText(provider.oauthExpiresAt)} 过期` : "OAuth 登录";
	}
	if (credentialSource === "env") {
		return provider.envVarNames?.length
			? `环境变量凭据 · ${provider.envVarNames.join(" / ")}`
			: "环境变量凭据（变量名未由目录声明）";
	}
	return null;
}

/** ISO 时间戳 → "YYYY-MM-DD HH:mm"（取 ISO 前段，规避本地时区/locale 差异；UTC 标注）。 */
export function isoToMinuteText(iso: string): string {
	const compact = iso.slice(0, 16).replace("T", " ");
	return iso.endsWith("Z") ? `${compact} UTC` : compact;
}

/** 目录上次刷新时间（ProviderStatusDto.lastRefreshAt，从未刷新 → 固定文案）。 */
export function lastRefreshText(iso: string | undefined): string {
	return iso ? isoToMinuteText(iso) : "从未刷新";
}

/** 非正常态的处置提示（connected / not-configured 无需提示 → null）。 */
export function statusHint(status: ProviderConnectionStatus): string | null {
	switch (status) {
		case "oauth-expiring":
			return "OAuth 凭据临近过期，建议重新认证。";
		case "credential-invalid":
			return "凭据已失效（401 / token 刷新失败），重新认证或替换 API Key。";
		case "unreachable":
			return "远端 Provider 不可达（网络/网关错误），检查网络与 Base URL。";
		case "local-offline":
			return "本地服务不可达，确认本地进程已启动且端点地址正确。";
		case "connected":
		case "not-configured":
			return null;
	}
}

// ── 断开依赖（#03 交付列表 + force 二次确认；#08 在此基础上做替换引导强化）──

export type DependencyKind = ProviderDependencyDto["kind"];

/** 分组展示顺序：会话 → 角色绑定 → 回退链（影响面从即时到持久）。 */
const DEPENDENCY_KIND_ORDER: readonly DependencyKind[] = ["session-model", "role-binding", "model-fallback"];

const DEPENDENCY_KIND_LABELS: Record<DependencyKind, string> = {
	"session-model": "会话当前模型",
	"role-binding": "角色绑定",
	"model-fallback": "回退链",
};

export function dependencyKindLabel(kind: DependencyKind): string {
	return DEPENDENCY_KIND_LABELS[kind];
}

export interface DependencyGroup {
	kind: DependencyKind;
	label: string;
	items: ProviderDependencyDto[];
}

/** 按 kind 分组（空组不出现，组序固定）；条目保持 serve 返回的原顺序。 */
export function groupDependencies(dependencies: readonly ProviderDependencyDto[]): DependencyGroup[] {
	return DEPENDENCY_KIND_ORDER.flatMap(kind => {
		const items = dependencies.filter(dep => dep.kind === kind);
		return items.length > 0 ? [{ kind, label: DEPENDENCY_KIND_LABELS[kind], items: [...items] }] : [];
	});
}

// ── 断开流强化（#08）：竞态提示 / 会话占用警告 / force 确认文案 ──

/** force 前必勾选的明示文案（语义契约：不改配置 + 失效待修复 + 重新接入可恢复）。 */
export const FORCE_ACK_LABEL =
	"我明白：强制断开不会修改任何配置——引用该 Provider 的角色主模型与回退链将处于失效待修复状态，重新接入前不可用。";

/**
 * 会话占用警告（醒目级）：依赖清单含 session-model 时返回警告文案，否则 null。
 * 断开进行中会话调用会立即失败，必须先切换会话模型。
 */
export function sessionModelWarning(dependencies: readonly ProviderDependencyDto[]): string | null {
	const sessionDeps = dependencies.filter(dep => dep.kind === "session-model");
	if (sessionDeps.length === 0) return null;
	const models = [...new Set(sessionDeps.map(dep => dep.model))].join("、");
	return `当前会话正在使用该 Provider 的模型（${models}）。断开后该会话的模型调用会立即失败，请先在模型目录切换会话模型。`;
}

/**
 * 断开进行中的跨卡竞态提示：其他 provider 的写操作被禁用时，卡片内展示。
 */
export function raceLockNotice(holderId: string): string {
	return `${holderId} 正在执行断开——为避免配置竞态，其他 Provider 的写操作已暂停，待断开完成后恢复。`;
}

/**
 * force 二次确认文案（window.confirm）：按 kind 汇总依赖数量，明示失效待修复
 * 后果与不可自动改写红线。依赖为空时不应被调用（无依赖直接断开）。
 */
export function forceConfirmText(providerId: string, dependencies: readonly ProviderDependencyDto[]): string {
	const parts: string[] = [];
	for (const group of groupDependencies(dependencies)) {
		parts.push(`${group.label} ${group.items.length} 处`);
	}
	return `确认强制断开「${providerId}」？${parts.join("、")}将进入失效待修复状态（配置不会被自动改写，重新接入后原配置自动恢复有效）。`;
}

/** 未知错误的可诊断文本（错误 banner 用；不区分错误类型，原样透出 message）。 */
export function errorText(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}
