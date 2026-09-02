import { describe, expect, it } from "bun:test";
import type { ProviderDependencyDto, ProviderStatusDto } from "@cornfield/wire";
import {
	credentialSourceLabel,
	credentialSummary,
	dependencyKindLabel,
	groupDependencies,
	isoToMinuteText,
	lastRefreshText,
	statusBadge,
	statusHint,
} from "../src/pages/models/providers/provider-display";

/**
 * Provider 管理（模型控制中心 #03）纯展示映射回归：
 * 只测 provider-display.ts 的状态→展示映射、掩码渲染与依赖列表文案——
 * 不触 store/DOM（store 契约方法由后端切片并行落地，交互行为由 ticket 验收覆盖）。
 */

function provider(overrides: Partial<ProviderStatusDto>): ProviderStatusDto {
	return {
		providerId: "anthropic",
		status: "connected",
		credentialSource: "none",
		modelCount: 12,
		catalogStale: false,
		...overrides,
	};
}

describe("连接六态徽章（状态→展示映射）", () => {
	it("六态各有确定徽章与语义色 class", () => {
		expect(statusBadge("connected")).toEqual({ label: "已连接", className: "badge done" });
		expect(statusBadge("not-configured")).toEqual({ label: "未接入", className: "badge neutral" });
		expect(statusBadge("oauth-expiring")).toEqual({ label: "OAuth 即将过期", className: "badge run" });
		expect(statusBadge("credential-invalid")).toEqual({ label: "凭据失效", className: "badge fail" });
		expect(statusBadge("unreachable")).toEqual({ label: "不可达", className: "badge fail" });
		expect(statusBadge("local-offline")).toEqual({ label: "本地端点离线", className: "badge fail" });
	});
});

describe("凭据来源与掩码渲染（安全红线：仅 maskedKey 片段可回显）", () => {
	it("四种来源有确定显示名", () => {
		expect(credentialSourceLabel("api-key")).toBe("API Key");
		expect(credentialSourceLabel("oauth")).toBe("OAuth");
		expect(credentialSourceLabel("env")).toBe("环境变量");
		expect(credentialSourceLabel("none")).toBe("未配置");
	});

	it("api-key 来源：只拼接后端掩码片段，不出现任何明文形态的密钥", () => {
		const masked = credentialSummary(provider({ credentialSource: "api-key", maskedKey: "sk-…f3a2" }));
		expect(masked).toBe("已存 API Key · sk-…f3a2");
		// 精确相等锁定：除掩码片段外不拼接任何其他密钥内容
		expect(masked).not.toContain("sk-ant-");
	});

	it("api-key 来源缺 maskedKey：显示占位文案而非空掩码", () => {
		expect(credentialSummary(provider({ credentialSource: "api-key" }))).toBe("已存 API Key（掩码片段未提供）");
	});

	it("oauth 来源：只展示过期时间，无密钥内容", () => {
		expect(
			credentialSummary(provider({ credentialSource: "oauth", oauthExpiresAt: "2026-09-30T08:00:00.000Z" })),
		).toBe("OAuth 登录 · 2026-09-30 08:00 UTC 过期");
		expect(credentialSummary(provider({ credentialSource: "oauth" }))).toBe("OAuth 登录");
	});

	it("env 来源：展示变量名候选；未声明时给出兜底文案", () => {
		expect(
			credentialSummary(provider({ credentialSource: "env", envVarNames: ["NARWAL_API_KEY", "ANTHROPIC_API_KEY"] })),
		).toBe("环境变量凭据 · NARWAL_API_KEY / ANTHROPIC_API_KEY");
		expect(credentialSummary(provider({ credentialSource: "env" }))).toBe("环境变量凭据（变量名未由目录声明）");
	});

	it("未配置（none）：无凭据行", () => {
		expect(credentialSummary(provider({ credentialSource: "none" }))).toBeNull();
	});
});

describe("时间与目录元数据文案", () => {
	it("ISO 时间戳取分钟精度，UTC 时间带标注；带时区偏移的原样取段", () => {
		expect(isoToMinuteText("2026-09-02T14:30:00.000Z")).toBe("2026-09-02 14:30 UTC");
		expect(isoToMinuteText("2026-09-02T14:30:00+08:00")).toBe("2026-09-02 14:30");
	});

	it("目录上次刷新：从未刷新有固定文案", () => {
		expect(lastRefreshText(undefined)).toBe("从未刷新");
		expect(lastRefreshText("2026-09-01T03:05:00.000Z")).toBe("2026-09-01 03:05 UTC");
	});
});

describe("非正常态处置提示", () => {
	it("四种异常态各给处置提示；正常/未接入无提示", () => {
		expect(statusHint("oauth-expiring")).toBe("OAuth 凭据临近过期，建议重新认证。");
		expect(statusHint("credential-invalid")).toBe("凭据已失效（401 / token 刷新失败），重新认证或替换 API Key。");
		expect(statusHint("unreachable")).toBe("远端 Provider 不可达（网络/网关错误），检查网络与 Base URL。");
		expect(statusHint("local-offline")).toBe("本地服务不可达，确认本地进程已启动且端点地址正确。");
		expect(statusHint("connected")).toBeNull();
		expect(statusHint("not-configured")).toBeNull();
	});
});

describe("断开依赖列表（分组与文案）", () => {
	const deps: ProviderDependencyDto[] = [
		{ kind: "model-fallback", ref: "1", model: "anthropic/claude-x" },
		{ kind: "session-model", ref: "sess-1", model: "openai/gpt-x" },
		{ kind: "role-binding", ref: "coder", model: "anthropic/claude-x" },
		{ kind: "model-fallback", ref: "0", model: "openai/gpt-mini" },
	];

	it("按 kind 分组：组序固定（会话→角色→回退链），空组不出现，组内条目保持原顺序", () => {
		const groups = groupDependencies(deps);
		expect(groups.map(g => g.kind)).toEqual(["session-model", "role-binding", "model-fallback"]);
		expect(groups.map(g => g.label)).toEqual(["会话当前模型", "角色绑定", "回退链"]);
		expect(groups.map(g => g.items.length)).toEqual([1, 1, 2]);
		expect(groups[2]?.items.map(i => i.ref)).toEqual(["1", "0"]);
	});

	it("无依赖：空数组，不产出分组", () => {
		expect(groupDependencies([])).toEqual([]);
	});

	it("三种 kind 各有确定文案", () => {
		expect(dependencyKindLabel("session-model")).toBe("会话当前模型");
		expect(dependencyKindLabel("role-binding")).toBe("角色绑定");
		expect(dependencyKindLabel("model-fallback")).toBe("回退链");
	});
});
