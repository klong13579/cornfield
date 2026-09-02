import { beforeEach, describe, expect, it } from "bun:test";
import type { PiWebSocketCtor, PiWebSocketLike } from "@cornfield/client";
import type {
	ConfigInheritanceRestoreDto,
	ConfigScopeDto,
	ModelCatalogDto,
	ModelSelectionDto,
	ModelTestResultDto,
	ProviderDisconnectResultDto,
	ProviderListDto,
	ProviderOAuthStartDto,
	ProviderStatusDto,
} from "@cornfield/wire";
import { PiClientAdapter, type ServeConnectionConfig } from "../src/state/pi-client-adapter";
import { SessionStore } from "../src/state/session-store";

/**
 * 模型控制中心 Phase 2 后端接线（#02 全量目录 / #03 Provider 接入 / #05 配置作用域）：
 * adapter 层 wire 命令拼装 + 响应映射 + 失败路径；store 层契约方法透传。
 * 敏感约束断言：apiKey/code 只出现在写命令请求载荷；响应只允许 maskedKey 掩码片段。
 */

let lastCreated: FakeWebSocket | undefined;

class FakeWebSocket implements PiWebSocketLike {
	readyState = 1;
	sent: string[] = [];
	onopen: PiWebSocketLike["onopen"] = null;
	onmessage: PiWebSocketLike["onmessage"] = null;
	onclose: PiWebSocketLike["onclose"] = null;
	onerror: PiWebSocketLike["onerror"] = null;

	constructor(_url: string) {
		lastCreated = this;
	}

	send(data: string): void {
		this.sent.push(data);
	}

	close(): void {}

	receive(data: string): void {
		this.onmessage?.({ data });
	}
}

const fakeCtor: PiWebSocketCtor = FakeWebSocket;
const config: ServeConnectionConfig = { wsUrl: "ws://127.0.0.1:1/ws", token: "" };

async function connectAdapter(adapter: PiClientAdapter): Promise<void> {
	const connectPromise = adapter.connect();
	lastCreated?.onopen?.({});
	lastCreated?.receive(JSON.stringify({ type: "hello_ack", connectionId: "c1", protocolVersion: 1 }));
	await connectPromise;
}

/** 解析已发出的 request 帧（不含 hello/ping）。 */
function sentRequests(): Array<{ id: string; command: Record<string, unknown> }> {
	return (lastCreated?.sent ?? [])
		.map(s => JSON.parse(s) as { type?: string; id?: string; command?: Record<string, unknown> })
		.filter(
			(f): f is { id: string; command: Record<string, unknown> } => f.type === "request" && !!f.id && !!f.command,
		);
}

/** 用当前最新 request 帧的 id 回一个响应；ok=false 时走失败路径。 */
function respond(result: unknown, ok = true, error?: string): void {
	const reqs = sentRequests();
	lastCreated?.receive(
		JSON.stringify({ type: "response", id: reqs[reqs.length - 1]!.id, ok, ...(ok ? { result } : { error }) }),
	);
}

async function connectedAdapter(): Promise<PiClientAdapter> {
	const adapter = new PiClientAdapter(config, fakeCtor);
	await connectAdapter(adapter);
	return adapter;
}

const PLAINTEXT_KEY = "sk-live-abcdef123456";

function maskProviderStatus(overrides: Partial<ProviderStatusDto> = {}): ProviderStatusDto {
	return {
		providerId: "narwal-plan",
		status: "connected",
		credentialSource: "api-key",
		maskedKey: "sk-l…3456",
		envVarPresent: false,
		modelCount: 3,
		catalogStale: false,
		...overrides,
	};
}

describe("模型控制中心 adapter（#02/#03/#05）", () => {
	beforeEach(() => {
		lastCreated = undefined;
	});

	it("fetchModelCatalog 发 get_model_catalog 并原样返回 DTO", async () => {
		const adapter = await connectedAdapter();
		try {
			const catalog: ModelCatalogDto = {
				models: [
					{
						provider: "narwal-plan",
						id: "minimax-m3",
						name: "MiniMax M3",
						status: "available",
						pricing: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
						capabilities: { thinking: true, vision: false, tools: true, inputModalities: ["text"] },
						contextWindowTokens: 200000,
						roles: [],
					},
					{
						provider: "openai",
						id: "gpt-5.4",
						name: "GPT-5.4",
						status: "provider-not-configured",
						pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						capabilities: { thinking: false, vision: false, tools: true, inputModalities: ["text"] },
						contextWindowTokens: 400000,
						roles: [],
					},
				],
				providers: [
					{
						providerId: "narwal-plan",
						source: "dynamic",
						stale: false,
						discoveredCount: 1,
					},
				],
				disabledProviders: ["xai"],
				disabledModels: ["openai/gpt-5.4"],
				generatedAt: "2026-09-02T00:00:00.000Z",
			};
			const pending = adapter.fetchModelCatalog();
			expect(sentRequests().at(-1)?.command).toMatchObject({ type: "get_model_catalog" });
			respond(catalog);
			expect(await pending).toEqual(catalog);
		} finally {
			adapter.disconnect();
		}
	});

	it("fetchProviders / fetchProvider 发对应命令并透传 DTO", async () => {
		const adapter = await connectedAdapter();
		try {
			const list: ProviderListDto = { providers: [maskProviderStatus()] };
			const pendingList = adapter.fetchProviders();
			expect(sentRequests().at(-1)?.command).toMatchObject({ type: "get_providers" });
			respond(list);
			expect(await pendingList).toEqual(list);

			const pendingOne = adapter.fetchProvider("narwal-plan");
			expect(sentRequests().at(-1)?.command).toMatchObject({ type: "get_provider", providerId: "narwal-plan" });
			respond(maskProviderStatus());
			expect(await pendingOne).toMatchObject({ providerId: "narwal-plan", credentialSource: "api-key" });
		} finally {
			adapter.disconnect();
		}
	});

	it("saveProviderApiKey 明文只进请求载荷；响应只含 maskedKey，无明文回显", async () => {
		const adapter = await connectedAdapter();
		try {
			const pending = adapter.saveProviderApiKey("narwal-plan", PLAINTEXT_KEY);
			const command = sentRequests().at(-1)?.command;
			// 请求载荷带明文（serve 写入 AuthCredentialStore 的唯一通道）
			expect(command).toMatchObject({ type: "save_provider_api_key", providerId: "narwal-plan" });
			expect(command?.apiKey).toBe(PLAINTEXT_KEY);

			respond(maskProviderStatus());
			const status = await pending;
			expect(status.maskedKey).toBe("sk-l…3456");
			// 响应不得回显明文
			expect(JSON.stringify(status)).not.toContain(PLAINTEXT_KEY);
		} finally {
			adapter.disconnect();
		}
	});

	it("deleteProviderApiKey / setProviderBaseUrl（含 null 清除）发对应命令", async () => {
		const adapter = await connectedAdapter();
		try {
			const del = adapter.deleteProviderApiKey("narwal-plan");
			expect(sentRequests().at(-1)?.command).toMatchObject({
				type: "delete_provider_api_key",
				providerId: "narwal-plan",
			});
			respond(maskProviderStatus({ credentialSource: "none", maskedKey: undefined }));
			expect((await del).credentialSource).toBe("none");

			const setUrl = adapter.setProviderBaseUrl("narwal-plan", "https://gateway.example.com/v1");
			expect(sentRequests().at(-1)?.command).toMatchObject({
				type: "set_provider_base_url",
				providerId: "narwal-plan",
				baseUrl: "https://gateway.example.com/v1",
			});
			respond(maskProviderStatus({ baseUrl: "https://gateway.example.com/v1" }));
			expect((await setUrl).baseUrl).toBe("https://gateway.example.com/v1");

			const clearUrl = adapter.setProviderBaseUrl("narwal-plan", null);
			expect(sentRequests().at(-1)?.command).toMatchObject({
				type: "set_provider_base_url",
				baseUrl: null,
			});
			respond(maskProviderStatus());
			expect(await clearUrl).toMatchObject({ providerId: "narwal-plan" });
		} finally {
			adapter.disconnect();
		}
	});

	it("startProviderOauth / completeProviderOauth 拼装命令并透传 DTO", async () => {
		const adapter = await connectedAdapter();
		try {
			const start: ProviderOAuthStartDto = {
				authUrl: "https://claude.ai/oauth/authorize?client_id=x",
				instructions: "在浏览器完成授权后粘贴 code",
				requiresManualCode: true,
			};
			const pendingStart = adapter.startProviderOauth("anthropic");
			expect(sentRequests().at(-1)?.command).toMatchObject({
				type: "start_provider_oauth",
				providerId: "anthropic",
			});
			respond(start);
			expect(await pendingStart).toEqual(start);

			const pendingComplete = adapter.completeProviderOauth("anthropic", "oauth-code-123");
			const completeCommand = sentRequests().at(-1)?.command;
			expect(completeCommand).toMatchObject({ type: "complete_provider_oauth", providerId: "anthropic" });
			expect(completeCommand?.code).toBe("oauth-code-123");
			respond(maskProviderStatus({ credentialSource: "oauth" }));
			expect(await pendingComplete).toMatchObject({ credentialSource: "oauth" });
		} finally {
			adapter.disconnect();
		}
	});

	it("disconnectProvider 未 force：不带 force 字段；依赖检查结果原样返回（不走错误通道）", async () => {
		const adapter = await connectedAdapter();
		try {
			const dependencyResult: ProviderDisconnectResultDto = {
				disconnected: false,
				dependencies: [
					{ kind: "session-model", ref: "sess-1", model: "narwal-plan/minimax-m3" },
					{ kind: "role-binding", ref: "default", model: "narwal-plan/minimax-m3" },
					{ kind: "model-fallback", ref: "0", model: "narwal-plan/minimax-m3" },
				],
				provider: maskProviderStatus(),
			};
			const pending = adapter.disconnectProvider("narwal-plan", false);
			const command = sentRequests().at(-1)?.command;
			expect(command).toMatchObject({ type: "disconnect_provider", providerId: "narwal-plan" });
			expect(command).not.toHaveProperty("force");
			// ok:true + disconnected:false —— 依赖检查结果是命令的正常结果
			respond(dependencyResult, true);
			const result = await pending;
			expect(result.disconnected).toBe(false);
			expect(result.dependencies).toHaveLength(3);
			expect(result.dependencies[0]).toMatchObject({ kind: "session-model", model: "narwal-plan/minimax-m3" });
		} finally {
			adapter.disconnect();
		}
	});

	it("disconnectProvider force=true 携带 force 字段", async () => {
		const adapter = await connectedAdapter();
		try {
			const pending = adapter.disconnectProvider("narwal-plan", true);
			const command = sentRequests().at(-1)?.command;
			expect(command).toMatchObject({ type: "disconnect_provider", providerId: "narwal-plan", force: true });
			respond({ disconnected: true, dependencies: [], provider: maskProviderStatus({ credentialSource: "none" }) });
			const result = await pending;
			expect(result.disconnected).toBe(true);
			expect(result.dependencies).toEqual([]);
		} finally {
			adapter.disconnect();
		}
	});

	it("refreshProvider / fetchConfigScope / restoreConfigInheritance / refreshCatalog / testModel 拼装命令并透传", async () => {
		const adapter = await connectedAdapter();
		try {
			const pendingRefresh = adapter.refreshProvider("narwal-plan");
			expect(sentRequests().at(-1)?.command).toMatchObject({ type: "refresh_provider", providerId: "narwal-plan" });
			respond(maskProviderStatus({ catalogStale: false }));
			expect(await pendingRefresh).toMatchObject({ providerId: "narwal-plan" });

			const pendingCatalogRefresh = adapter.refreshCatalog();
			expect(sentRequests().at(-1)?.command).toMatchObject({ type: "refresh_catalog" });
			const refreshedCatalog: ModelCatalogDto = {
				models: [],
				providers: [{ providerId: "narwal-plan", source: "dynamic", stale: false, discoveredCount: 3 }],
				disabledProviders: [],
				disabledModels: [],
				generatedAt: "2026-09-02T08:00:00.000Z",
			};
			respond(refreshedCatalog);
			expect(await pendingCatalogRefresh).toEqual(refreshedCatalog);

			const pendingTest = adapter.testModel("narwal-plan", "minimax-m3");
			expect(sentRequests().at(-1)?.command).toMatchObject({
				type: "test_model",
				providerId: "narwal-plan",
				modelId: "minimax-m3",
			});
			const testResult: ModelTestResultDto = {
				provider: "narwal-plan",
				modelId: "minimax-m3",
				outcome: "rate-limit",
				latencyMs: 843,
				message: "429 Rate limit reached for requests.",
				httpStatus: 429,
			};
			respond(testResult);
			expect(await pendingTest).toEqual(testResult);

			const pendingTestFailure = adapter.testModel("narwal-plan", "nope");
			respond(undefined, false, "test_model failed: unknown model: narwal-plan/nope");
			expect(await pendingTestFailure.catch((err: Error) => err.message)).toContain("unknown model");

			const scope: ConfigScopeDto = {
				hasProjectConfig: true,
				projectConfigPath: "/repo/.cornfield/config.yml",
				globalConfigPath: "/home/.cornfield/agent/config.yml",
				keys: [
					{
						key: "defaultThinkingLevel",
						overridden: true,
						projectValue: "high",
						effectiveValue: "high",
					},
				],
			};
			const pendingScope = adapter.fetchConfigScope();
			expect(sentRequests().at(-1)?.command).toMatchObject({ type: "get_config_scope" });
			respond(scope);
			expect(await pendingScope).toEqual(scope);

			const restore: ConfigInheritanceRestoreDto = {
				key: "defaultThinkingLevel",
				removed: true,
				effectiveValue: "medium",
			};
			const pendingRestore = adapter.restoreConfigInheritance("defaultThinkingLevel");
			expect(sentRequests().at(-1)?.command).toMatchObject({
				type: "restore_config_inheritance",
				key: "defaultThinkingLevel",
			});
			respond(restore);
			expect(await pendingRestore).toEqual(restore);
		} finally {
			adapter.disconnect();
		}
	});

	it("setConfigValue 带 scope；setModelTemporary / setPersistentDefaultModel 拼 set_config/set_model", async () => {
		const adapter = await connectedAdapter();
		try {
			const pendingProject = adapter.setConfigValue("defaultThinkingLevel", "low", "project");
			expect(sentRequests().at(-1)?.command).toMatchObject({
				type: "set_config",
				key: "defaultThinkingLevel",
				value: "low",
				scope: "project",
			});
			respond({ ok: true, key: "defaultThinkingLevel", value: "low", scope: "project" });
			expect(await pendingProject).toBeUndefined();

			const pendingGlobal = adapter.setConfigValue("defaultThinkingLevel", "high", "global");
			expect(sentRequests().at(-1)?.command).toMatchObject({ type: "set_config", scope: "global" });
			respond({ ok: true });
			expect(await pendingGlobal).toBeUndefined();

			const pendingTemporary = adapter.setModelTemporary("narwal-plan", "minimax-m3");
			expect(sentRequests().at(-1)?.command).toMatchObject({
				type: "set_model_temporary",
				provider: "narwal-plan",
				modelId: "minimax-m3",
			});
			respond({ model: { provider: "narwal-plan", id: "minimax-m3" } });
			expect(await pendingTemporary).toBeUndefined();

			const pendingPersist = adapter.setPersistentDefaultModel("narwal-plan", "minimax-m3");
			expect(sentRequests().at(-1)?.command).toMatchObject({
				type: "set_model",
				provider: "narwal-plan",
				modelId: "minimax-m3",
			});
			respond({ provider: "narwal-plan", id: "minimax-m3" });
			expect(await pendingPersist).toBeUndefined();
		} finally {
			adapter.disconnect();
		}
	});

	it("fetchModelSelection 发 get_model_selection 并透传 DTO", async () => {
		const adapter = await connectedAdapter();
		try {
			const selection: ModelSelectionDto = {
				session: { provider: "narwal-plan", modelId: "minimax-m3", source: "temporary" },
				persistedDefault: { provider: "anthropic", modelId: "claude-sonnet-4-6" },
			};
			const pending = adapter.fetchModelSelection();
			expect(sentRequests().at(-1)?.command).toMatchObject({ type: "get_model_selection" });
			respond(selection);
			expect(await pending).toEqual(selection);
		} finally {
			adapter.disconnect();
		}
	});

	it("失败路径：ok:false 抛错（可诊断信息），拒绝静默吞掉", async () => {
		const adapter = await connectedAdapter();
		try {
			const pending = adapter.fetchProvider("does-not-exist");
			respond(undefined, false, "get_provider failed: unknown provider: does-not-exist");
			expect(await pending.catch((err: Error) => err.message)).toContain("unknown provider: does-not-exist");

			const pendingFail = adapter.disconnectProvider("narwal-plan", false);
			respond(undefined, false, "disconnect_provider failed: boom");
			expect(await pendingFail.catch((err: Error) => err.message)).toContain("boom");
		} finally {
			adapter.disconnect();
		}
	});

	it("敏感约束：save_provider_api_key 之外的命令载荷不携带明文密钥", async () => {
		const adapter = await connectedAdapter();
		try {
			const pending = adapter.fetchProviders();
			respond({ providers: [maskProviderStatus()] });
			await pending;
			const frames = (lastCreated?.sent ?? []).join("\n");
			// 全部已发送帧中，明文密钥只允许出现在 save_provider_api_key 载荷里
			const leaky = sentRequests().filter(
				req => JSON.stringify(req.command).includes(PLAINTEXT_KEY) && req.command.type !== "save_provider_api_key",
			);
			expect(leaky).toEqual([]);
			expect(frames).toBeDefined();
		} finally {
			adapter.disconnect();
		}
	});
});

/** store 层契约透传验证：签名逐字 + 委托到 client。 */
describe("SessionStore 模型控制中心契约方法", () => {
	/** 最小 PiClient 桩（init 所需连接面 + 本组命令），其余以 cast 满足接口。 */
	function stubClient(record: {
		requests: Array<{ type: string; payload: unknown }>;
		results: Map<string, unknown>;
	}): PiClientLike {
		return {
			connect: async () => ({
				connected: true,
				wsUrl: "ws://test",
				protocolVersion: 1,
			}),
			disconnect: () => undefined,
			getConnection: () => ({ connected: true, wsUrl: "ws://test", protocolVersion: 1 }),
			getSnapshot: () => null,
			getServerAgents: () => [],
			getEnvironment: () => null,
			subscribe: () => () => undefined,
			subscribeConnection: () => () => undefined,
			// 契约方法：记录调用并回放预设结果
			fetchModelCatalog: async () => record.results.get("get_model_catalog"),
			fetchModelSelection: async () => record.results.get("get_model_selection"),
			fetchProviders: async () => record.results.get("get_providers"),
			fetchProvider: async (providerId: string) => {
				record.requests.push({ type: "fetchProvider", payload: providerId });
				return record.results.get("get_provider");
			},
			startProviderOauth: async (providerId: string) => {
				record.requests.push({ type: "startProviderOauth", payload: providerId });
				return record.results.get("start_provider_oauth");
			},
			completeProviderOauth: async (providerId: string, code: string) => {
				record.requests.push({ type: "completeProviderOauth", payload: { providerId, code } });
				return record.results.get("complete_provider_oauth");
			},
			saveProviderApiKey: async (providerId: string, apiKey: string) => {
				record.requests.push({ type: "saveProviderApiKey", payload: { providerId, apiKey } });
				return record.results.get("save_provider_api_key");
			},
			deleteProviderApiKey: async (providerId: string) => {
				record.requests.push({ type: "deleteProviderApiKey", payload: providerId });
				return record.results.get("delete_provider_api_key");
			},
			setProviderBaseUrl: async (providerId: string, baseUrl: string | null) => {
				record.requests.push({ type: "setProviderBaseUrl", payload: { providerId, baseUrl } });
				return record.results.get("set_provider_base_url");
			},
			disconnectProvider: async (providerId: string, force: boolean) => {
				record.requests.push({ type: "disconnectProvider", payload: { providerId, force } });
				return record.results.get("disconnect_provider");
			},
			refreshProvider: async (providerId: string) => {
				record.requests.push({ type: "refreshProvider", payload: providerId });
				return record.results.get("refresh_provider");
			},
			refreshCatalog: async () => record.results.get("refresh_catalog"),
			testModel: async (providerId: string, modelId: string) => {
				record.requests.push({ type: "testModel", payload: { providerId, modelId } });
				return record.results.get("test_model");
			},
			fetchConfigScope: async () => record.results.get("get_config_scope"),
			restoreConfigInheritance: async (key: string) => {
				record.requests.push({ type: "restoreConfigInheritance", payload: key });
				return record.results.get("restore_config_inheritance");
			},
			setConfigValue: async (key: string, value: unknown, scope: string) => {
				record.requests.push({ type: "setConfigValue", payload: { key, value, scope } });
			},
			setModelTemporary: async (providerId: string, modelId: string) => {
				record.requests.push({ type: "setModelTemporary", payload: { providerId, modelId } });
			},
			setPersistentDefaultModel: async (providerId: string, modelId: string) => {
				record.requests.push({ type: "setPersistentDefaultModel", payload: { providerId, modelId } });
			},
		} as unknown as PiClientLike;
	}

	interface PiClientLike {
		connect(): Promise<unknown>;
		disconnect(): void;
		getConnection(): unknown;
		getSnapshot(): null;
		getServerAgents(): never[];
		getEnvironment(): null;
		subscribe(): () => void;
		subscribeConnection(): () => void;
	}

	it("16 条契约方法逐字签名透传（含 disconnect force 与掩码不回显）", async () => {
		const status = maskProviderStatus();
		const testResult: ModelTestResultDto = {
			provider: "narwal-plan",
			modelId: "minimax-m3",
			outcome: "success",
			latencyMs: 512,
			message: "模型响应正常",
		};
		const requests: Array<{ type: string; payload: unknown }> = [];
		const results = new Map<string, unknown>([
			[
				"get_model_catalog",
				{ models: [], providers: [], disabledProviders: [], disabledModels: [], generatedAt: "t" },
			],
			[
				"get_model_selection",
				{ session: { provider: "a", modelId: "b", source: "persistent" }, persistedDefault: null },
			],
			["get_providers", { providers: [status] }],
			["get_provider", status],
			["start_provider_oauth", { requiresManualCode: true }],
			["complete_provider_oauth", status],
			["save_provider_api_key", status],
			["delete_provider_api_key", status],
			["set_provider_base_url", status],
			[
				"disconnect_provider",
				{
					disconnected: false,
					dependencies: [{ kind: "role-binding", ref: "default", model: "a/b" }],
					provider: status,
				},
			],
			["refresh_provider", status],
			[
				"refresh_catalog",
				{ models: [], providers: [], disabledProviders: [], disabledModels: [], generatedAt: "t2" },
			],
			["test_model", testResult],
			["get_config_scope", { hasProjectConfig: false, globalConfigPath: "/g", keys: [] }],
			["restore_config_inheritance", { key: "k", removed: false, effectiveValue: null }],
		]);
		const store = new SessionStore();
		store.init(stubClient({ requests, results }) as never);

		expect(await store.fetchModelCatalog()).toMatchObject({ generatedAt: "t" });
		expect(await store.fetchModelSelection()).toMatchObject({ session: { source: "persistent" } });
		expect(await store.fetchProviders()).toMatchObject({ providers: [{}] });
		expect(await store.fetchProvider("anthropic")).toBe(status);
		expect(await store.startProviderOauth("anthropic")).toMatchObject({ requiresManualCode: true });
		expect(await store.completeProviderOauth("anthropic", "code-1")).toBe(status);
		expect(await store.saveProviderApiKey("narwal-plan", PLAINTEXT_KEY)).toBe(status);
		expect(await store.deleteProviderApiKey("narwal-plan")).toBe(status);
		expect(await store.setProviderBaseUrl("narwal-plan", null)).toBe(status);
		const disconnectResult = await store.disconnectProvider("narwal-plan", false);
		expect(disconnectResult.disconnected).toBe(false);
		expect(disconnectResult.dependencies).toEqual([{ kind: "role-binding", ref: "default", model: "a/b" }]);
		expect(await store.refreshProvider("narwal-plan")).toBe(status);
		expect(await store.refreshCatalog()).toMatchObject({ generatedAt: "t2" });
		expect(await store.testModel("narwal-plan", "minimax-m3")).toBe(testResult);
		expect(await store.fetchConfigScope()).toMatchObject({ hasProjectConfig: false });
		expect(await store.restoreConfigInheritance("k")).toMatchObject({ removed: false });
		await store.setConfigValue("k", 1, "project");
		await store.setModelTemporary("narwal-plan", "minimax-m3");
		await store.setPersistentDefaultModel("narwal-plan", "minimax-m3");

		// 关键转发参数落点
		expect(requests.find(r => r.type === "saveProviderApiKey")?.payload).toEqual({
			providerId: "narwal-plan",
			apiKey: PLAINTEXT_KEY,
		});
		expect(requests.find(r => r.type === "disconnectProvider")?.payload).toEqual({
			providerId: "narwal-plan",
			force: false,
		});
		expect(requests.find(r => r.type === "setConfigValue")?.payload).toEqual({
			key: "k",
			value: 1,
			scope: "project",
		});
		expect(requests.find(r => r.type === "setPersistentDefaultModel")?.payload).toEqual({
			providerId: "narwal-plan",
			modelId: "minimax-m3",
		});
		expect(requests.find(r => r.type === "testModel")?.payload).toEqual({
			providerId: "narwal-plan",
			modelId: "minimax-m3",
		});
	});

	it("失败路径：client 抛错时 store 契约方法原样抛出（不吞错）", async () => {
		const failing = {
			connect: async () => ({ connected: true, wsUrl: "ws://test", protocolVersion: 1 }),
			disconnect: () => undefined,
			getConnection: () => ({ connected: true, wsUrl: "ws://test", protocolVersion: 1 }),
			getSnapshot: () => null,
			getServerAgents: () => [],
			getEnvironment: () => null,
			subscribe: () => () => undefined,
			fetchProvider: async () => {
				throw new Error("get_provider failed: unknown provider: x");
			},
		};
		const store = new SessionStore();
		store.init(failing as never);
		expect(store.fetchProvider("x").catch((err: Error) => err.message)).resolves.toContain("unknown provider: x");
	});
});
