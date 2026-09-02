import { describe, expect, it } from "bun:test";
import type {
	ConfigScopeDto,
	ModelCatalogDto,
	ModelCatalogEntryDto,
	ProviderCatalogMetaDto,
	ProviderStatusDto,
} from "@cornfield/wire";
import { catalogHealth, deriveExceptions, parseModelSpec } from "../src/pages/models/exceptions";

/**
 * 控制中心异常推导回归（#08）：只测 exceptions.ts 纯逻辑——
 * 异常推导规则、严重级别、跳转目标、角色/回退位标注、容错与派生恢复。
 * 不触 store / DOM；ProviderCard 交互行为由 ticket 验收覆盖。
 */

function entry(
	overrides: Partial<ModelCatalogEntryDto> & Pick<ModelCatalogEntryDto, "provider" | "id" | "status">,
): ModelCatalogEntryDto {
	return {
		name: overrides.id,
		pricing: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		capabilities: { thinking: false, vision: false, tools: true, inputModalities: ["text"] },
		contextWindowTokens: 128_000,
		roles: [],
		...overrides,
	} as ModelCatalogEntryDto;
}

function catalog(models: ModelCatalogEntryDto[], metas: ProviderCatalogMetaDto[] = []): ModelCatalogDto {
	return {
		models,
		providers: metas,
		disabledProviders: [],
		disabledModels: [],
		generatedAt: "2026-09-02T00:00:00.000Z",
	};
}

function provider(
	overrides: Partial<ProviderStatusDto> & Pick<ProviderStatusDto, "providerId" | "status">,
): ProviderStatusDto {
	return { credentialSource: "none", modelCount: 3, catalogStale: false, ...overrides };
}

function meta(
	overrides: Partial<ProviderCatalogMetaDto> & Pick<ProviderCatalogMetaDto, "providerId">,
): ProviderCatalogMetaDto {
	return { source: "static", stale: false, discoveredCount: 3, ...overrides };
}

function scope(modelRoutesEffective: unknown): ConfigScopeDto {
	return {
		hasProjectConfig: false,
		globalConfigPath: "/g/config.yml",
		keys: [{ key: "modelRoutes", overridden: false, effectiveValue: modelRoutesEffective }],
	};
}

describe("provider 状态异常（三不可用态 critical / 即将过期 warning）", () => {
	it("credential-invalid / unreachable / local-offline → critical，跳 Provider 工作区，带 providerId", () => {
		const input: ExceptionsArgs = {
			providers: {
				providers: [
					provider({ providerId: "a", status: "credential-invalid" }),
					provider({ providerId: "b", status: "unreachable" }),
					provider({ providerId: "c", status: "local-offline" }),
				],
			},
		};
		const items = deriveExceptions(input);
		expect(items.map(i => i.kind)).toEqual([
			"provider-credential-invalid",
			"provider-unreachable",
			"provider-local-offline",
		]);
		expect(items.every(i => i.severity === "critical")).toBe(true);
		expect(items.every(i => i.target === "/models/providers")).toBe(true);
		expect(items.map(i => i.providerId)).toEqual(["a", "b", "c"]);
		// 标题在 detail 中指名 provider（displayName 优先，缺省回落 providerId）
		expect(items[0]?.detail).toContain("a");
	});

	it("oauth-expiring → warning；connected / not-configured 不产生异常", () => {
		const items = deriveExceptions({
			providers: {
				providers: [
					provider({ providerId: "a", status: "oauth-expiring", credentialSource: "oauth" }),
					provider({ providerId: "b", status: "connected" }),
					provider({ providerId: "c", status: "not-configured" }),
				],
			},
		});
		expect(items.length).toBe(1);
		expect(items[0]?.kind).toBe("provider-oauth-expiring");
		expect(items[0]?.severity).toBe("warning");
	});

	it("displayName 优先于 providerId 展示", () => {
		const items = deriveExceptions({
			providers: { providers: [provider({ providerId: "a", displayName: "Alpha", status: "unreachable" })] },
		});
		expect(items[0]?.detail).toContain("Alpha");
	});
});

type ExceptionsArgs = Parameters<typeof deriveExceptions>[0];

describe("目录非权威（catalog-stale）", () => {
	it("stale meta → warning 异常；非 stale 不产生", () => {
		const items = deriveExceptions({
			catalog: catalog([], [meta({ providerId: "x", stale: true }), meta({ providerId: "y", stale: false })]),
		});
		expect(items.length).toBe(1);
		expect(items[0]?.kind).toBe("provider-catalog-stale");
		expect(items[0]?.severity).toBe("warning");
		expect(items[0]?.providerId).toBe("x");
		expect(items[0]?.target).toBe("/models/providers");
	});
});

describe("失效待修复（modelRoutes 引用不可用模型——纯派生态）", () => {
	const routes = { default: { primary: "anthropic/claude-x", fallbacks: [] } };

	it("primary 引用凭据失效模型 → critical，标注角色与位置，跳运行时配置", () => {
		const items = deriveExceptions({
			scope: scope(routes),
			catalog: catalog([entry({ provider: "anthropic", id: "claude-x", status: "credential-invalid" })]),
		});
		expect(items.length).toBe(1);
		expect(items[0]?.kind).toBe("route-primary-unavailable");
		expect(items[0]?.severity).toBe("critical");
		expect(items[0]?.role).toBe("default");
		expect(items[0]?.position).toBe("primary");
		expect(items[0]?.model).toBe("anthropic/claude-x");
		expect(items[0]?.target).toBe("/models/config");
		expect(items[0]?.detail).toContain("凭据失效");
	});

	it("目录中不存在的模型（拼写错误 / 未知 provider）→ 异常且注明不在目录", () => {
		const items = deriveExceptions({ scope: scope(routes), catalog: catalog([]) });
		expect(items.length).toBe(1);
		expect(items[0]?.kind).toBe("route-primary-unavailable");
		expect(items[0]?.detail).toContain("不在目录中");
	});

	it("回退位按位置标注（fallbacks[下标]）；可用回退位不报；回退位 severity 为 warning", () => {
		const items = deriveExceptions({
			scope: scope({ default: { primary: "anthropic/ok", fallbacks: ["anthropic/good", "anthropic/bad"] } }),
			catalog: catalog([
				entry({ provider: "anthropic", id: "ok", status: "available" }),
				entry({ provider: "anthropic", id: "good", status: "available" }),
				entry({ provider: "anthropic", id: "bad", status: "local-offline" }),
			]),
		});
		expect(items.length).toBe(1);
		expect(items[0]?.kind).toBe("route-fallback-unavailable");
		expect(items[0]?.severity).toBe("warning");
		expect(items[0]?.position).toBe("fallbacks[1]");
		expect(items[0]?.model).toBe("anthropic/bad");
	});

	it("多角色 / 主+回退同时失效：primary 与每个回退位各一条", () => {
		const items = deriveExceptions({
			scope: scope({
				coder: { primary: "anthropic/a1", fallbacks: ["anthropic/a2"] },
				reviewer: { primary: "anthropic/a1", fallbacks: ["openai/b1"] },
			}),
			catalog: catalog([
				entry({ provider: "anthropic", id: "a1", status: "credential-invalid" }),
				entry({ provider: "anthropic", id: "a2", status: "disabled" }),
				entry({ provider: "openai", id: "b1", status: "available" }),
			]),
		});
		expect(items.map(i => `${i.role}:${i.position}`)).toEqual([
			"coder:primary", // critical ×2 先于 warning；同级内保持插入序（coder 在 reviewer 前）
			"reviewer:primary",
			"coder:fallbacks[0]", // warning 排后
		]);
		expect(items.map(i => i.severity)).toEqual(["critical", "critical", "warning"]);
	});

	it("thinking level 后缀剥除后匹配目录（与 parseModelString 语义对齐）", () => {
		const items = deriveExceptions({
			scope: scope({ default: { primary: "anthropic/claude-x:high", fallbacks: [] } }),
			catalog: catalog([entry({ provider: "anthropic", id: "claude-x", status: "credential-invalid" })]),
		});
		expect(items.length).toBe(1);
		expect(items[0]?.model).toBe("anthropic/claude-x"); // 规范形无后缀
	});

	it("非 thinking level 的冒号后缀属模型 id 一部分（openrouter 路由），不误剥", () => {
		expect(parseModelSpec("openrouter/a:free")).toEqual({ provider: "openrouter", id: "a:free" });
		expect(parseModelSpec("openrouter/a:bogus")).toEqual({ provider: "openrouter", id: "a:bogus" });
		expect(parseModelSpec("openrouter/a:xhigh")).toEqual({ provider: "openrouter", id: "a" });
	});

	it("重新接入后异常自动消失（provider 恢复 + 模型回目录 → 推导结果为空）", () => {
		const broken = deriveExceptions({
			providers: { providers: [provider({ providerId: "anthropic", status: "credential-invalid" })] },
			scope: scope(routes),
			catalog: catalog([entry({ provider: "anthropic", id: "claude-x", status: "credential-invalid" })]),
		});
		expect(broken.length).toBe(2); // provider 异常 + 失效待修复

		const recovered = deriveExceptions({
			providers: { providers: [provider({ providerId: "anthropic", status: "connected" })] },
			scope: scope(routes),
			catalog: catalog([entry({ provider: "anthropic", id: "claude-x", status: "available" })]),
		});
		expect(recovered).toEqual([]);
	});
});

describe("容错（用户手改 YAML 不应让推导崩溃）", () => {
	it("垃圾 effectiveValue（数组 / 字符串 / null / 空对象）不抛、不产出", () => {
		for (const junk of [[], "x", 42, null, {}, { default: null }, { default: "str" }, { default: { primary: 1 } }]) {
			expect(() => deriveExceptions({ scope: scope(junk), catalog: catalog([]) })).not.toThrow();
			expect(deriveExceptions({ scope: scope(junk), catalog: catalog([]) })).toEqual([]);
		}
	});

	it("回退链非数组 / 含非字符串项：只对合法字符串项判定", () => {
		const items = deriveExceptions({
			scope: scope({ default: { primary: "anthropic/a1", fallbacks: ["anthropic/a2", 42, null, ""] } }),
			catalog: catalog([
				entry({ provider: "anthropic", id: "a1", status: "available" }),
				entry({ provider: "anthropic", id: "a2", status: "unreachable" }),
			]),
		});
		expect(items.map(i => i.position)).toEqual(["fallbacks[0]"]);
	});

	it("无 modelRoutes 键或 effectiveValue 缺失 → 不产出 route 异常", () => {
		expect(
			deriveExceptions({
				scope: { hasProjectConfig: false, globalConfigPath: "/g", keys: [] },
				catalog: catalog([]),
			}),
		).toEqual([]);
		expect(
			deriveExceptions({
				scope: {
					hasProjectConfig: false,
					globalConfigPath: "/g",
					keys: [{ key: "other", overridden: false, effectiveValue: 1 }],
				},
				catalog: catalog([]),
			}),
		).toEqual([]);
	});
});

describe("数据缺失不报假阳性", () => {
	const routes = { default: { primary: "anthropic/claude-x", fallbacks: [] } };

	it("scope 缺失：provider 异常照常，route 不判定", () => {
		const items = deriveExceptions({
			providers: { providers: [provider({ providerId: "a", status: "unreachable" })] },
			catalog: catalog([]),
		});
		expect(items.map(i => i.kind)).toEqual(["provider-unreachable"]);
	});

	it("catalog 缺失：route 不判定（无目录不可判定可用性）", () => {
		const items = deriveExceptions({ scope: scope(routes) });
		expect(items).toEqual([]);
	});

	it("providers 缺失：route 异常照常（失效待修复只依赖 scope + catalog）", () => {
		const items = deriveExceptions({
			scope: scope(routes),
			catalog: catalog([entry({ provider: "anthropic", id: "claude-x", status: "disabled" })]),
		});
		expect(items.map(i => i.kind)).toEqual(["route-primary-unavailable"]);
	});
});

describe("排序与确定性", () => {
	it("critical 恒在 warning 前；同级保持规则内顺序（provider 序 → 角色序）", () => {
		const items = deriveExceptions({
			providers: {
				providers: [
					provider({ providerId: "w1", status: "oauth-expiring" }),
					provider({ providerId: "c1", status: "unreachable" }),
				],
			},
			scope: scope({ default: { primary: "anthropic/x", fallbacks: ["anthropic/y"] } }),
			catalog: catalog([
				entry({ provider: "anthropic", id: "x", status: "credential-invalid" }),
				entry({ provider: "anthropic", id: "y", status: "disabled" }),
			]),
		});
		expect(items.map(i => i.kind)).toEqual([
			"provider-unreachable", // critical（providers 序在前）
			"route-primary-unavailable", // critical
			"provider-oauth-expiring", // warning（providers 序在前）
			"route-fallback-unavailable", // warning
		]);
	});

	it("重复推导结果一致（纯函数，无隐状态）", () => {
		const input: ExceptionsArgs = {
			providers: { providers: [provider({ providerId: "a", status: "local-offline" })] },
			scope: scope({ default: { primary: "p/m", fallbacks: [] } }),
			catalog: catalog([entry({ provider: "p", id: "m", status: "available" })]),
		};
		expect(deriveExceptions(input)).toEqual(deriveExceptions(input));
	});
});

describe("目录健康状态（壳层状态条）", () => {
	it("null → —；有 stale → 过期 N 个；否则权威", () => {
		expect(catalogHealth(null)).toEqual({ label: "—", staleCount: 0 });
		expect(catalogHealth(catalog([], [meta({ providerId: "a" }), meta({ providerId: "b", stale: true })]))).toEqual({
			label: "过期 1 个",
			staleCount: 1,
		});
		expect(catalogHealth(catalog())).toEqual({ label: "权威", staleCount: 0 });
	});
});
