import type { PiClientEventKind, PiWebSocketCtor } from "@cornfield/client";
import { PiServerError, PiClient as WirePiClient } from "@cornfield/client";
import type {
	AgentCreateDto,
	AgentCreateInput,
	AgentInfoDto,
	AgentPromptSourceDto,
	AvailableModelsDto,
	BroughtBackChildResultDto,
	ConfigInheritanceRestoreDto,
	ConfigScopeDto,
	ConnectionInfoDto,
	CronLogEntryDto,
	DashboardStatsDto,
	DelegateChildInput,
	DelegatedChildDto,
	DingtalkAgentConfigDto,
	EnvironmentSummaryDto,
	EvolvedSkillsDto,
	GitChangesDto,
	HostToolDefinitionDto,
	ImageContentDto,
	MemoryProjectionDto,
	ModelCatalogDto,
	ModelSelectionDto,
	ModelTestResultDto,
	ProgressEventDto,
	ProjectDeleteDto,
	ProjectListDto,
	ProjectRecordDto,
	ProjectUpsertDto,
	ProviderDisconnectResultDto,
	ProviderListDto,
	ProviderOAuthStartDto,
	ProviderStatusDto,
	SessionSnapshotDto,
	SessionTreeDto,
	SkillsResultDto,
	StatsPeriodDto,
	TaskRowDto,
	TodoPhaseDto,
	ToolSwitchesDto,
	WireCommand,
	WireServerEventDto,
} from "@cornfield/wire";
import type {
	AgentMessageDto,
	AgentTodoDeleteDto,
	AgentTodoDto,
	AgentTodoListDto,
	AgentTodoUpsertDto,
	ArtifactDto,
	CronCreateInput,
	CronRemoveResultDto,
	CronTaskWriteResultDto,
	CronTestRunResultDto,
	CronUpdateInput,
	DiagnosisAggregationDto,
	DiagnosisReportListItemDto,
	DiagnosisSummaryDto,
	FsDiffResult,
	FsEntryDto,
	FsImageResult,
	FsReadResult,
	FsWriteResult,
	GatewayAccountPatchDto,
	GatewayStatusDto,
	ListenRecordingDto,
	McpServerDto,
	NewSessionOptions,
	NewSessionResult,
	PiClient,
	RemoteSkillItemDto,
} from "../lib/pi-client-api";
import { FsConflictError } from "../lib/pi-client-api";
import type { BranchPoint, PlaybackEntry, PlaybackToolStep, RecordStatus, SessionRecordSummary } from "../lib/records";

/** serve get_state env 条目（pi-wire WireEnvironmentSummary；pendingCronCount 为可选缺省）。 */
interface WireEnvironmentSummaryDto {
	repos: string;
	branch: string | null;
	activeAgentCount: number;
	pendingCronCount?: number | null;
}

/** serve list_sessions 响应条目（WireSessionIndexEntry，字段名以 pi-wire 为准）。 */
interface WireSessionIndexEntryDto {
	sessionId: string;
	agentId?: string;
	agentName?: string;
	title?: string;
	cwd?: string;
	/** 会话自己记下的归属（header.projectId）；旧会话没有就是没有，serve 不拿 cwd 猜。 */
	projectId?: string;
	startTime: string;
	endTime?: string;
	messageCount: number;
	status?: "completed" | "aborted" | "error" | "incomplete" | "unknown";
	source?: "cli" | "agent";
	sessionFile?: string;
}

/**
 * 真实 `@cornfield/client` 适配器 —— 实现 web-app 内部契约（lib/pi-client-api.ts）。
 *
 * 差异映射（pi-client 真实 API vs 本前端契约，完整差异清单见 P3 汇报）：
 * - pi-client 只提供 `request(WireCommand)` 通用命令面，无业务方法 → 本层按命令拼装
 * - pi-client 无 getSnapshot/getServerAgents/getEnvironment → 快照走 getCachedSnapshot，
 *   agents 从 server_snapshot 推送映射（P3 多 Agent 升级后变真），env 暂缺（返回 null）
 * - pi-client subscribe 推的是包装事件（status/hello_ack/push/error）→ 本层拆包为 wire 帧
 * - serve progress 只转发 message_update / tool_execution_update 两类事件，
 *   tool_execution_update 未归一（真机工具卡三态以快照为准，流式转场待协议扩展）
 * - get_available_models 已接真（serve 返回 Model[]）；失败返回空数组，UI 空态
 */

/** `cornfield serve` 连接配置（设置页可改，localStorage 持久化）。 */
export interface ServeConnectionConfig {
	wsUrl: string;
	token: string;
}

const CONN_STORAGE_KEY = "cornfield.serve.connection";

export const DEFAULT_SERVE_CONFIG: ServeConnectionConfig = {
	wsUrl: "ws://127.0.0.1:7891/ws",
	token: "",
};

export function loadServeConfig(): ServeConnectionConfig {
	try {
		const raw = localStorage.getItem(CONN_STORAGE_KEY);
		if (raw) {
			const parsed = JSON.parse(raw) as Partial<ServeConnectionConfig>;
			if (typeof parsed.wsUrl === "string") {
				return { wsUrl: parsed.wsUrl, token: typeof parsed.token === "string" ? parsed.token : "" };
			}
		}
	} catch {
		// 配置损坏回默认
	}
	return DEFAULT_SERVE_CONFIG;
}

export function saveServeConfig(config: ServeConnectionConfig): void {
	try {
		localStorage.setItem(CONN_STORAGE_KEY, JSON.stringify(config));
	} catch {
		// localStorage 不可用时仅内存态
	}
}

function toWsUrl(config: ServeConnectionConfig): string {
	if (!config.token) return config.wsUrl;
	const sep = config.wsUrl.includes("?") ? "&" : "?";
	return `${config.wsUrl}${sep}token=${encodeURIComponent(config.token)}`;
}

/** serve HTTP 基址 + token（静态路由如 /listen-audio 用）：wsUrl → http(s) 基址。 */
export function serveHttpBase(): { base: string; token: string } {
	const config = loadServeConfig();
	return {
		base: config.wsUrl.replace(/^ws(s?):/, "http$1:").replace(/\/ws\/?$/, ""),
		token: config.token,
	};
}

export class PiClientAdapter implements PiClient {
	#client: WirePiClient;
	#sessionId: string | null = null;
	#connection: ConnectionInfoDto;
	#token: string;
	#agents: AgentInfoDto[] = [];
	#env: EnvironmentSummaryDto | null = null;
	#listeners = new Set<(frame: WireServerEventDto) => void>();
	#connListeners = new Set<(conn: ConnectionInfoDto) => void>();
	/** 测试注入的 WebSocket 构造器（recordTranscribe 独立短连接共用）。 */
	#wsCtor?: PiWebSocketCtor;
	/**
	 * serve 在 hello_ack 里上报的 gateway wire 端口（serve 自己解析的那个）。
	 *
	 * 浏览器猜不了端口（没有 process.env），猜错就是打到**本机真实运营中的 gateway**（隔离
	 * 环境里看到的会是别的进程的数据）。所以：要么拿到 serve 报的那个，要么明说拿不到 ——
	 * `null` 就是「还没上报」，绝不当成 7892。
	 */
	#gatewayWirePort: number | null = null;

	constructor(config: ServeConnectionConfig = loadServeConfig(), webSocketCtor?: PiWebSocketCtor) {
		this.#connection = { connected: false, wsUrl: config.wsUrl, protocolVersion: 1 };
		this.#token = config.token;
		this.#wsCtor = webSocketCtor;
		this.#client = new WirePiClient({
			url: toWsUrl(config),
			token: config.token,
			autoReconnect: true,
			...(webSocketCtor ? { webSocketCtor } : {}),
		});
		this.#client.subscribe(event => this.#handleEvent(event));
	}

	async connect(): Promise<ConnectionInfoDto> {
		await this.#client.connect();
		return { ...this.#connection };
	}

	disconnect(): void {
		// 端口是**当前这条连接**的事实，断开就不知道了（重连后 serve 会再报一次）。
		this.#gatewayWirePort = null;
		this.#client.close("client disconnect");
	}

	getConnection(): ConnectionInfoDto {
		return { ...this.#connection };
	}

	getSnapshot(): SessionSnapshotDto | null {
		if (!this.#sessionId) return null;
		const snapshot = this.#client.getCachedSnapshot<unknown>(this.#sessionId);
		return (snapshot as SessionSnapshotDto) ?? null;
	}

	getServerAgents(): AgentInfoDto[] {
		return this.#agents;
	}

	getEnvironment(): EnvironmentSummaryDto | null {
		return this.#env;
	}

	subscribe(listener: (frame: WireServerEventDto) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** 连接状态订阅（wire 推送帧之外的状态变化，如断线重连）。 */
	subscribeConnection(listener: (conn: ConnectionInfoDto) => void): () => void {
		this.#connListeners.add(listener);
		return () => this.#connListeners.delete(listener);
	}

	// ── 命令面（拼装 WireCommand）──

	prompt(text: string, sessionId?: string, images?: ImageContentDto[]): Promise<void> {
		const command = {
			type: "prompt",
			message: text,
			...(sessionId ? { sessionId } : {}),
			...(images && images.length > 0 ? { images } : {}),
		} as never;
		return this.#req(command).then(() => undefined);
	}

	abort(): Promise<void> {
		return this.#req({ type: "abort" }).then(() => undefined);
	}

	compact(): Promise<void> {
		return this.#req({ type: "compact" }).then(() => undefined);
	}

	/**
	 * 新建会话（new_session）。三个入参都落在这一条命令（+ 一次改名）上：
	 * - `agentId` → `new_session.sessionId`（命令面所有状态命令的 `sessionId` 都是「哪个 agent」，
	 *   serve 按它解析目标；目标 Agent 必须已 attach，否则 ok:false，错误原文上抛）
	 * - `projectId` → `new_session.projectId`：会话的**权威归属**，serve 按它定工作根与边界根，
	 *   并把结果作为事实记进会话（`SessionHeader.projectId`）。未知 id 直接 ok:false
	 * - `title`   → 创建成功后紧跟一次 `set_session_name`（wire 没有「创建时命名」这条命令）
	 *
	 * 空串与缺省同义（不指定）——本地不替调用方把 `""` 变成一个具体的 Project。
	 *
	 * `cancelled:true`（serve 接了命令但没建，如上一回合还没收尾）不当成功：**标题那一跳必须跳过**
	 * —— 否则改的是**上一个**会话的名字。这不是修饰：`created:false` 时调用方手上没有新会话。
	 */
	async newSession(opts?: NewSessionOptions): Promise<NewSessionResult> {
		const target = opts?.agentId;
		const project = opts?.projectId;
		const result = await this.#req<{ cancelled?: boolean }>({
			type: "new_session",
			...(target ? { sessionId: target } : {}),
			...(project ? { projectId: project } : {}),
		});
		const created = result?.cancelled !== true;
		if (created && opts?.title) {
			await this.#req({
				type: "set_session_name",
				name: opts.title,
				...(target ? { sessionId: target } : {}),
			});
		}
		// 三个入参都有去处，所以这里是空的 —— **但出口得在**：将来有一个 wire 上表达不出来的字段，
		// 就在这个数组里点名（并同步更新 `NewSessionResult` 的文档），别让它静默消失。
		// 它说的是**能力**（wire 有没有对应的字段），不是结果：所以只看入参，不看 created。
		return { created, notApplied: [] };
	}
	forkFrom(entryId: string): Promise<void> {
		return this.#req({ type: "fork_from", entryId }).then(() => undefined);
	}

	undoExchange(entryId: string): Promise<void> {
		return this.#req({ type: "undo_exchange", entryId }).then(() => undefined);
	}

	retryFrom(entryId: string, message?: string): Promise<void> {
		return this.#req({ type: "retry_from", entryId, message }).then(() => undefined);
	}

	setModel(modelId: string, provider = "custom", sessionId?: string): Promise<void> {
		return this.#req({ type: "set_model", provider, modelId, ...(sessionId ? { sessionId } : {}) }).then(
			() => undefined,
		);
	}

	setThinkingLevel(level: string, sessionId?: string): Promise<void> {
		const command = { type: "set_thinking_level", level, ...(sessionId ? { sessionId } : {}) } as WireCommand;
		return this.#req(command).then(() => undefined);
	}

	setTodos(phases: TodoPhaseDto[]): Promise<void> {
		const command = { type: "set_todos", phases } as WireCommand;
		return this.#req(command).then(() => undefined);
	}

	setAutoCompaction(enabled: boolean): Promise<void> {
		return this.#req({ type: "set_auto_compaction", enabled }).then(() => undefined);
	}

	setAutoRetry(enabled: boolean): Promise<void> {
		return this.#req({ type: "set_auto_retry", enabled }).then(() => undefined);
	}

	abortRetry(): Promise<void> {
		return this.#req({ type: "abort_retry" }).then(() => undefined);
	}

	/** 用户裁决回传（permission_respond）。 */
	permissionRespond(requestId: string, choice: string): Promise<void> {
		return this.#req({ type: "permission_respond", requestId, choice }).then(() => undefined);
	}

	/** 读目标 agent 的配置合并视图（get_config；per-agent，sessionId 必传）。 */
	getConfig(sessionId: string, key?: string): Promise<{ config: unknown }> {
		const command = { type: "get_config", sessionId, ...(key ? { key } : {}) } as never;
		return this.#req<{ config: unknown }>(command);
	}

	/** 写目标 agent 生效层的配置并持久化（set_config；per-agent）。 */
	setConfig(sessionId: string, key: string, value: unknown): Promise<{ ok: boolean; key: string; value: unknown }> {
		const command = { type: "set_config", sessionId, key, value } as never;
		return this.#req<{ ok: boolean; key: string; value: unknown }>(command);
	}

	/** 工具开关语义视图（get_tool_switches；per-agent）。 */
	getToolSwitches(sessionId: string): Promise<ToolSwitchesDto> {
		const command = { type: "get_tool_switches", sessionId } as never;
		return this.#req<ToolSwitchesDto>(command);
	}

	/** 前端已注册的 host tools 声明（set_host_tools 后的本地权威态；UI 工具注册 tab 用）。 */
	#hostTools: HostToolDefinitionDto[] = [];

	getHostTools(): HostToolDefinitionDto[] {
		return this.#hostTools;
	}

	setHostTools(tools: HostToolDefinitionDto[]): Promise<void> {
		this.#hostTools = tools;
		const command = { type: "set_host_tools", tools } as never;
		return this.#req(command).then(() => undefined);
	}

	/**
	 * 真实模型列表（get_available_models → serve 真 Model[]，已按 disabledProviders /
	 * disabledModels 过滤）。绝不回退内置假数据（HF-1）。
	 * 失败契约：未连接/命令失败时抛错（不吞错、不返回空数组），由调用方
	 * （模型目录 CatalogView 等）渲染错误态 + 重试入口。
	 * 映射补齐真实字段：name/reasoning/cost/contextWindow（数字→“200K”格式化，原始值保留供排序）。
	 * 响应附带停用名单（disabledProviders/disabledModels）供「已停用」分区恢复入口。
	 */
	async getAvailableModels(): Promise<AvailableModelsDto> {
		const result = await this.#req<{
			models?: ServeModelLike[] | null;
			disabledProviders?: string[] | null;
			disabledModels?: string[] | null;
		}>({ type: "get_available_models" });
		return {
			models: (result.models ?? []).map(m => ({
				id: m.id,
				provider: m.provider,
				name: m.name ?? m.id,
				description: m.name ?? m.id,
				contextWindow: fmtTokens(m.contextWindow),
				contextWindowTokens: m.contextWindow,
				price: m.cost ? `$${m.cost.input}/M tokens` : undefined,
				supportsThinking: m.reasoning === true,
			})),
			disabledProviders: result.disabledProviders ?? [],
			disabledModels: result.disabledModels ?? [],
		};
	}

	/**
	 * 停用/恢复 provider（modelId 缺省）或单个模型（provider/modelId 精确 pattern）。
	 * 写 settings（config.yml）后 get_available_models 立即反映；返回最新停用名单供 UI 同步。
	 */
	async setModelDisabled(
		provider: string,
		modelId: string | undefined,
		disabled: boolean,
	): Promise<{ ok: boolean; disabledProviders: string[]; disabledModels: string[] }> {
		const result = await this.#req<{
			ok?: boolean;
			disabledProviders?: string[] | null;
			disabledModels?: string[] | null;
		}>({
			type: "set_model_disabled",
			provider,
			...(modelId ? { modelId } : {}),
			disabled,
		} as never);
		return {
			ok: result.ok === true,
			disabledProviders: result.disabledProviders ?? [],
			disabledModels: result.disabledModels ?? [],
		};
	}

	// ── 模型控制中心（#02 全量目录 / #03 Provider 接入 / #05 配置作用域）──
	// 敏感约束：apiKey/code 只进写命令请求载荷（serve 写入 AuthCredentialStore）；
	// 任何响应只含 DTO 的 maskedKey 掩码片段，本层不做任何明文落盘/日志。

	/** #02 全量模型目录（get_model_catalog：全部已知模型 + 六态 status + 目录元数据）。 */
	fetchModelCatalog(): Promise<ModelCatalogDto> {
		return this.#req<ModelCatalogDto>({ type: "get_model_catalog" });
	}

	/** #05 模型选择两层视图（get_model_selection）。 */
	fetchModelSelection(): Promise<ModelSelectionDto> {
		return this.#req<ModelSelectionDto>({ type: "get_model_selection" });
	}

	/** 会话级临时切换模型（set_model_temporary：仅本会话，不写 settings）。 */
	setModelTemporary(providerId: string, modelId: string): Promise<void> {
		return this.#req({ type: "set_model_temporary", provider: providerId, modelId }).then(() => undefined);
	}

	/** 持久化默认模型（set_model：serve 侧写 settings.modelRoutes.default.primary 并持久化）。 */
	setPersistentDefaultModel(providerId: string, modelId: string): Promise<void> {
		return this.#req({ type: "set_model", provider: providerId, modelId }).then(() => undefined);
	}

	/** #05 按作用域写配置（set_config；scope 缺省 serve 侧 = global）。 */
	setConfigValue(key: string, value: unknown, scope: "global" | "project"): Promise<void> {
		return this.#req({ type: "set_config", key, value, scope }).then(() => undefined);
	}

	/** #03 Provider 状态列表（get_providers）。 */
	fetchProviders(): Promise<ProviderListDto> {
		return this.#req<ProviderListDto>({ type: "get_providers" });
	}

	/** #03 单个 Provider 状态（get_provider；未知 providerId 抛错由调用方渲染）。 */
	fetchProvider(providerId: string): Promise<ProviderStatusDto> {
		return this.#req<ProviderStatusDto>({ type: "get_provider", providerId });
	}

	/** #03 发起 OAuth 登录（start_provider_oauth）。 */
	startProviderOauth(providerId: string): Promise<ProviderOAuthStartDto> {
		return this.#req<ProviderOAuthStartDto>({ type: "start_provider_oauth", providerId });
	}

	/** #03 提交 OAuth 手输 code / 粘贴 key（complete_provider_oauth）。 */
	completeProviderOauth(providerId: string, code: string): Promise<ProviderStatusDto> {
		return this.#req<ProviderStatusDto>({ type: "complete_provider_oauth", providerId, code });
	}

	/** #03 保存/替换 API Key（save_provider_api_key；明文只进请求载荷）。 */
	saveProviderApiKey(providerId: string, apiKey: string): Promise<ProviderStatusDto> {
		return this.#req<ProviderStatusDto>({ type: "save_provider_api_key", providerId, apiKey });
	}

	/** #03 删除已存 API Key（delete_provider_api_key；幂等）。 */
	deleteProviderApiKey(providerId: string): Promise<ProviderStatusDto> {
		return this.#req<ProviderStatusDto>({ type: "delete_provider_api_key", providerId });
	}

	/** #03 设置自定义 Base URL（set_provider_base_url；null 清除覆盖）。 */
	setProviderBaseUrl(providerId: string, baseUrl: string | null): Promise<ProviderStatusDto> {
		return this.#req<ProviderStatusDto>({ type: "set_provider_base_url", providerId, baseUrl });
	}

	/** #03 断开 provider（disconnect_provider；force 缺省 false——有依赖时 ok:true +
	 * disconnected:false + dependencies 清单，不走错误通道）。 */
	disconnectProvider(providerId: string, force: boolean): Promise<ProviderDisconnectResultDto> {
		return this.#req<ProviderDisconnectResultDto>({
			type: "disconnect_provider",
			providerId,
			...(force ? { force: true } : {}),
		});
	}

	/** #03 单 provider 目录刷新（refresh_provider；online 强制）。 */
	refreshProvider(providerId: string): Promise<ProviderStatusDto> {
		return this.#req<ProviderStatusDto>({ type: "refresh_provider", providerId });
	}

	/** #04 全量目录刷新（refresh_catalog；registry 级并行，返回刷新后的完整目录）。 */
	refreshCatalog(): Promise<ModelCatalogDto> {
		return this.#req<ModelCatalogDto>({ type: "refresh_catalog" });
	}

	/** #04 单模型连通性测试（test_model；真实调用会产生费用，UI 必须先确认）。 */
	testModel(providerId: string, modelId: string): Promise<ModelTestResultDto> {
		return this.#req<ModelTestResultDto>({ type: "test_model", providerId, modelId });
	}

	/** #05 配置作用域读取（get_config_scope）。 */
	fetchConfigScope(): Promise<ConfigScopeDto> {
		return this.#req<ConfigScopeDto>({ type: "get_config_scope" });
	}

	/** #05 恢复继承（restore_config_inheritance；删除项目覆盖键而非复制值）。 */
	restoreConfigInheritance(key: string): Promise<ConfigInheritanceRestoreDto> {
		return this.#req<ConfigInheritanceRestoreDto>({ type: "restore_config_inheritance", key });
	}

	// ── P3 多 Agent ──

	/** 拉取注册表 agent 元数据（list_agents），不触发 attach。 */
	async listAgents(): Promise<AgentInfoDto[]> {
		try {
			// serve 回的是 { agents: [...] }（和 server_snapshot 的 sessions 同形）。当成裸数组读
			// 会让每次调用都静默回落到上一次的缓存值 —— 拉取结果永远不生效。
			const result = await this.#req<{ agents?: SessionEntryLike[] | null }>({ type: "list_agents" });
			const list = result.agents;
			if (Array.isArray(list)) {
				this.#agents = list.map(mapAgentEntry);
				return this.#agents;
			}
		} catch (err) {
			console.warn("[web-app] list_agents unavailable", err);
		}
		return this.#agents;
	}

	/**
	 * 建一个新 agentDir（create_agent）。serve 侧就是 `cornfield agent init` 那条实现，所以这里
	 * 只把入参搬过去、把答复原样交回 —— 不在这里拼路径、不在这里推断「建到哪去了」（`agentDir`
	 * 是服务端归一后的读数，`--dir` 给父目录时客户端算不出它）。
	 *
	 * 列表缓存的刷新**不在这里**：`#agents` 是 `listAgents()` 的产物，由调用方（store）建完
	 * 再拉一次就是现状。两边都刷就是两次网络往返 + 两处真相。
	 */
	createAgent(input: AgentCreateInput): Promise<AgentCreateDto> {
		return this.#req<AgentCreateDto>({ type: "create_agent", ...input });
	}

	attach(sessionId: string): Promise<void> {
		return this.#req({ type: "attach", sessionId }).then(() => undefined);
	}

	switchSession(sessionId: string): Promise<void> {
		return this.#req({ type: "switch_session", sessionId }).then(() => undefined);
	}

	/** 拉取当前 attached session 全部消息（get_messages，serve P4 已真实现）。 */
	async getMessages(): Promise<PlaybackEntry[]> {
		const result = await this.#req<{ messages?: unknown[] }>({ type: "get_messages" });
		return toPlaybackEntries(result.messages ?? []);
	}

	/** 按 sessionFile 拉取历史会话消息（get_session_messages；serve 端契约命令，WireCommand union 暂缺故最小局部 cast）。 */
	async getSessionMessages(sessionFile: string): Promise<AgentMessageDto[]> {
		const result = await this.#req<{ messages?: AgentMessageDto[] | null }>({
			type: "get_session_messages",
			sessionFile,
		} as never);
		return result.messages ?? [];
	}

	/** 原始消息 JSON 序列（导出 JSONL 用；与落盘 SessionEntry 格式不一致，导出时标注）。 */
	async getRawMessages(): Promise<unknown[]> {
		const result = await this.#req<{ messages?: unknown[] }>({ type: "get_messages" });
		return result.messages ?? [];
	}

	/** 分支候选（get_branch_messages：用户消息分支点）。 */
	async getBranchMessages(): Promise<BranchPoint[]> {
		try {
			const result = await this.#req<{ messages?: BranchPoint[] | null }>({ type: "get_branch_messages" });
			return result.messages ?? [];
		} catch (err) {
			console.warn("[web-app] get_branch_messages unavailable", err);
			return [];
		}
	}

	/**
	 * 历史会话索引（serve list_sessions）。
	 * 后端返回 WireSessionIndexEntry（sessionId/title/startTime/endTime/agentName/status/source/
	 * sessionFile/projectId），映射到前端 SessionRecordSummary（id/name/agent/startedAt/source…）。
	 * 失败返回空数组，UI 空态。
	 */
	async listSessions(): Promise<SessionRecordSummary[]> {
		try {
			const result = await this.#req<{ sessions?: WireSessionIndexEntryDto[] }>({ type: "list_sessions" });
			return (result.sessions ?? []).map(s => ({
				id: s.sessionId,
				name: s.title ?? s.sessionId.slice(0, 8),
				agent: s.agentName ?? s.agentId ?? "default",
				startedAt: s.startTime,
				messageCount: s.messageCount,
				status: (s.status ?? "unknown") as RecordStatus,
				source: s.source ?? (s.agentId === "default" ? "cli" : "agent"),
				sessionFile: s.sessionFile,
				cwd: s.cwd,
				// 原样带上会话记下的归属：它缺省就是缺省（旧会话没记过），不拿 cwd 反推一个。
				...(s.projectId === undefined ? {} : { projectId: s.projectId }),
			}));
		} catch (err) {
			console.warn("[web-app] list_sessions unavailable", err);
			return [];
		}
	}

	/** 读当前会话的委派账本（get_session_tree）。 */
	getSessionTree(sessionId?: string): Promise<SessionTreeDto> {
		return this.#req<SessionTreeDto>({ type: "get_session_tree", ...(sessionId ? { sessionId } : {}) });
	}

	/** 把子会话结果带回父会话（bring_back_child_result）；幂等门阀是结果里的 firstTime。 */
	bringBackChildResult(childSessionId: string, sessionId?: string): Promise<BroughtBackChildResultDto> {
		return this.#req<BroughtBackChildResultDto>({
			type: "bring_back_child_result",
			childSessionId,
			...(sessionId ? { sessionId } : {}),
		});
	}

	/**
	 * 委派一个子会话（delegate_child）。
	 *
	 * 不捕获错误：serve 只有在子进程真的起来、且真的挂上父边之后才会 OK，其余情况都是
	 * 真错误 —— 吞掉它并把回执造出来，就是让用户对着一棵不存在子会话的树。
	 */
	delegateChild(input: DelegateChildInput, sessionId?: string): Promise<DelegatedChildDto> {
		return this.#req<DelegatedChildDto>({
			type: "delegate_child",
			...(sessionId ? { sessionId } : {}),
			objective: input.objective,
			...(input.label ? { label: input.label } : {}),
			...(input.agentId ? { agentId: input.agentId } : {}),
			...(input.cwd ? { cwd: input.cwd } : {}),
		});
	}

	/**
	 * 已声明的 Project（list_projects）。
	 *
	 * 不捕获错误：读不到（存储损坏）必须原样到 store 显示成错误态 —— 捕获后返回空数组
	 * 就是把「声明过但读坏了」显示成「没声明过」。
	 */
	listProjects(sessionId?: string): Promise<ProjectListDto> {
		return this.#req<ProjectListDto>({ type: "list_projects", ...(sessionId ? { sessionId } : {}) });
	}

	/**
	 * 声明或更新一个 Project（set_project），返回存储真正落盘的那一份（`root` 已由存储归一）。
	 *
	 * 不捕获错误：root 被别的 Project 占用 / 输入不成立 / 存储写不进去都必须原样到 UI 显示成错误 ——
	 * 吞掉它就是在告诉用户「已经声明好了」，而盘上什么也没多。
	 * `defaultAgentId` 只在真的给了值时才发字段：缺省与空串不是同一件事，不在这里替它二选一。
	 */
	setProject(project: ProjectRecordDto): Promise<ProjectUpsertDto> {
		return this.#req<ProjectUpsertDto>({
			type: "set_project",
			projectId: project.projectId,
			name: project.name,
			root: project.root,
			...(project.defaultAgentId === undefined ? {} : { defaultAgentId: project.defaultAgentId }),
		});
	}

	/** 删掉一个已声明的 Project（delete_project）。没声明过会招错，不静默成功。 */
	deleteProject(projectId: string): Promise<ProjectDeleteDto> {
		return this.#req<ProjectDeleteDto>({ type: "delete_project", projectId });
	}

	/**
	 * Agent Todo（T10A）。三条命令已在 pi-wire 的 `WireCommand` union 里登记，所以这里按
	 * 普通命令写，不需要 cast。
	 *
	 * 三个都不捕获错误：读不到（存储损坏 / 声明读不出来）与写不进去（owner / Project 绑定）
	 * 必须原样到 store 显示 —— 捕获后返回空板或假装成功，就是把「坏了」显示成「没有」。
	 */
	listAgentTodos(sessionId?: string): Promise<AgentTodoListDto> {
		return this.#req<AgentTodoListDto>({ type: "list_agent_todos", ...(sessionId ? { sessionId } : {}) });
	}

	setAgentTodo(todo: AgentTodoDto, sessionId?: string): Promise<AgentTodoUpsertDto> {
		return this.#req<AgentTodoUpsertDto>({ type: "set_agent_todo", todo, ...(sessionId ? { sessionId } : {}) });
	}

	deleteAgentTodo(todoId: string, sessionId?: string): Promise<AgentTodoDeleteDto> {
		return this.#req<AgentTodoDeleteDto>({ type: "delete_agent_todo", todoId, ...(sessionId ? { sessionId } : {}) });
	}

	async diagnoseSession(
		sessionFile: string,
	): Promise<{ reportId: string; sessionId: string; state: "running" | "done" }> {
		return this.#req<{ reportId: string; sessionId: string; state: "running" | "done" }>({
			type: "diagnose_session",
			sessionFile,
		} as never);
	}

	async listDiagnosisReports(
		sessionFile?: string,
	): Promise<{ reports: DiagnosisReportListItemDto[]; tasks: unknown[] }> {
		return this.#req<{ reports: DiagnosisReportListItemDto[]; tasks: unknown[] }>({
			type: "list_diagnosis_reports",
			sessionFile,
		} as never);
	}

	async getDiagnosisReport(reportId: string): Promise<{ markdown: string; summary: DiagnosisSummaryDto } | null> {
		return this.#req<{ markdown: string; summary: DiagnosisSummaryDto } | null>({
			type: "get_diagnosis_report",
			reportId,
		} as never);
	}

	async aggregateDiagnosis(opts?: {
		since?: number;
		until?: number;
		agentId?: string;
	}): Promise<DiagnosisAggregationDto> {
		return this.#req<DiagnosisAggregationDto>({
			type: "aggregate_diagnosis",
			...(opts ?? {}),
		} as never);
	}

	/**
	 * agentDir 的 prompt 源清单（get_agent_prompt_sources；逐项报 exists，缺的那项也在清单里）。
	 *
	 * 清单是 serve 侧的事实（skeleton/agent-dir-files.ts 的 prompt 面），本层不重排、不过滤：
	 * 「该建哪个 / 哪个没了」正是这份视图要看的东西。答复里没有 sources 数组 = 协议违约，
	 * 就抛错 —— 返回空清单会被渲染成「这个 agent 没有任何 prompt 源」，那是一句假话。
	 */
	async getAgentPromptSources(agentId: string): Promise<AgentPromptSourceDto[]> {
		const result = await this.#req<{ sources?: AgentPromptSourceDto[] | null }>({
			type: "get_agent_prompt_sources",
			sessionId: agentId,
		});
		if (!Array.isArray(result.sources)) {
			throw new Error("get_agent_prompt_sources 响应里没有 sources 清单");
		}
		return result.sources;
	}

	/** 列出 agent workspace 目录（fs_list；name/type/size，目录在前）。 */
	async fsList(sessionId: string, path?: string): Promise<{ entries: FsEntryDto[] }> {
		const result = await this.#req<{ entries?: FsEntryDto[] | null }>({
			type: "fs_list",
			sessionId,
			...(path ? { path } : {}),
		} as never);
		return { entries: result.entries ?? [] };
	}

	/** 读 agent workspace 文件（fs_read；>128KB 截断标记；version = 磁盘内容身份，保存时回传做 CAS）。 */
	async fsRead(sessionId: string, path: string): Promise<FsReadResult> {
		const result = await this.#req<{
			text?: string | null;
			truncated?: boolean | null;
			version?: string | null;
		}>({
			type: "fs_read",
			sessionId,
			path,
		} as never);
		return {
			text: result.text ?? "",
			truncated: result.truncated === true,
			version: result.version ?? "",
		};
	}

	/**
	 * 整段写文件（fs_write）+ 服务端 compare-and-swap。
	 *
	 * `expectedVersion` 原样回传打开时读到的 version；服务端对不上就拒绝并且不落盘，
	 * 这里把那个判决归一成 {@link FsConflictError}（可恢复：调用方重读磁盘后让用户选）。
	 * 其余错误（越界/超限/未连接）原样上抛 —— 只有冲突是「选择哪一份」的问题。
	 */
	async fsWrite(sessionId: string, path: string, content: string, expectedVersion: string): Promise<FsWriteResult> {
		const command = { type: "fs_write", sessionId, path, content, expectedVersion } as never;
		try {
			const result = await this.#req<{
				bytesWritten?: number | null;
				version?: string | null;
				normalized?: boolean | null;
			}>(command);
			return {
				path,
				bytesWritten: result.bytesWritten ?? 0,
				version: result.version ?? "",
				normalized: result.normalized === true,
			};
		} catch (err) {
			const detail = conflictDetailOf(err);
			if (detail !== null) throw new FsConflictError(detail);
			throw err;
		}
	}

	/** 两段纯文本的统一 diff（fs_diff 的 before/after 分支；不落地）。 */
	async fsDiff(before: string, after: string): Promise<FsDiffResult> {
		const result = await this.#req<{ diff?: string | null; firstChangedLine?: number | null }>({
			type: "fs_diff",
			before,
			after,
		} as never);
		return { diff: result.diff ?? "", firstChangedLine: result.firstChangedLine ?? undefined };
	}

	/**
	 * 一个 agent 工作区的改动清单（git_changes）。
	 *
	 * 不把读失败注水成空清单：`{changes: []}` 是「读到了，工作区确实干净」，它是命令的正常
	 * 答案；读不到（不是 git 仓库 / git 失败 / 未知 agent）整条 ok:false 并招错 —— 两者在
	 * 右栏要显示成两种不同的东西。
	 *
	 * 答复里可选的 `error` 是**降级**通道（serve 读到了一份不完整的清单，见 GitChangesDto）：
	 * 原样透传，不吞也不当成失败 —— 吞了它就是把一份残清单冒充成完整的。
	 */
	async getGitChanges(sessionId?: string): Promise<GitChangesDto> {
		const result = await this.#req<{
			repoRoot?: string | null;
			changes?: GitChangesDto["changes"] | null;
			error?: string | null;
		}>({
			type: "git_changes",
			...(sessionId ? { sessionId } : {}),
		});
		return {
			repoRoot: result.repoRoot ?? "",
			changes: result.changes ?? [],
			...(result.error ? { error: result.error } : {}),
		};
	}

	/** 读 agent workspace 图片（fs_read_image；dataUrl，2MB 上限；FileExplorer 预览用）。 */
	async fsReadImage(sessionId: string, path: string): Promise<FsImageResult> {
		return this.#req<FsImageResult>({
			type: "fs_read_image",
			sessionId,
			path,
		} as never);
	}

	/** 产物列表（list_artifacts；会话 toolCall 提取，mtime 倒序；`sessionId` = 会话身份（附件地址），
	 * sessionFile 定向单会话；失败抛错由调用方空态）。 */
	async listArtifacts(sessionId: string, sessionFile?: string): Promise<{ artifacts: ArtifactDto[] }> {
		const result = await this.#req<{ artifacts?: ArtifactDto[] | null }>({
			type: "list_artifacts",
			sessionId,
			...(sessionFile ? { sessionFile } : {}),
		} as never);
		return { artifacts: result.artifacts ?? [] };
	}

	/** 产物静态预览 URL（/preview/<附件地址>/<relpath>，serve 同源端口，逐段编码；token 非空时带上）。 */
	artifactPreviewUrl(attachmentAddress: string, path: string): string {
		const wsUrl = this.#connection.wsUrl;
		const base = wsUrl.replace(/^ws:/, "http:").replace(/\/ws$/, "");
		const segs = path
			.split("/")
			.map(s => encodeURIComponent(s))
			.join("/");
		const tokenQuery = this.#token ? `?token=${encodeURIComponent(this.#token)}` : "";
		return `${base}/preview/${encodeURIComponent(attachmentAddress)}/${segs}${tokenQuery}`;
	}

	/** 本机 gateway 运行状态（gateway_status；gateway 生产端点直连）。 */
	async gatewayStatus(): Promise<GatewayStatusDto> {
		return this.#gatewayWire<GatewayStatusDto>({ type: "gateway_status" });
	}

	/** 动态账号热生效（set_gateway_account；gateway 写 gateway.json + 进程内 reload）。
	 * HTTP 层已验 data.ok === true（#gatewayWire），这里把 result 收束为契约要求的 { ok: true }。 */
	async setGatewayAccount(accountId: string, patch: GatewayAccountPatchDto): Promise<{ ok: boolean }> {
		await this.#gatewayWire<{ accountId: string; account: unknown }>({
			type: "set_gateway_account",
			accountId,
			patch,
		});
		return { ok: true };
	}

	/** 进程内 reload（reload_gateway；兜底手动触发配置热生效）。 */
	async reloadGateway(): Promise<{ ok: boolean }> {
		await this.#gatewayWire<unknown>({ type: "reload_gateway" });
		return { ok: true };
	}

	/** 本地用量统计（get_stats；period 可选时间窗口，无数据/失败抛错由调用方空态）。 */
	async getStats(period?: StatsPeriodDto): Promise<DashboardStatsDto> {
		const command = period === undefined || period === "all" ? { type: "get_stats" } : { type: "get_stats", period };
		return this.#req<DashboardStatsDto>(command as never);
	}

	/**
	 * 记忆投影（get_memory；按 Agent/Project/Session/User scope 分区，只读）。
	 * sessionId 定向 agent（命令已带该字段，不需要 cast）。
	 */
	async getMemory(sessionId?: string): Promise<MemoryProjectionDto> {
		return this.#req<MemoryProjectionDto>({ type: "get_memory", ...(sessionId ? { sessionId } : {}) });
	}

	/** 技能工作台数据（get_skills；已加载 + 停用 + 被挡住 + 发现错误，失败抛错由调用方空态）。 */
	async getSkills(sessionId?: string): Promise<SkillsResultDto> {
		const result = await this.#req<Partial<SkillsResultDto>>({
			type: "get_skills",
			...(sessionId ? { sessionId } : {}),
		});
		return {
			skills: result.skills ?? [],
			disabled: result.disabled ?? [],
			blocked: result.blocked ?? [],
			errors: result.errors ?? [],
			scope: result.scope ?? {
				agentId: sessionId ?? "default",
				agentDir: "",
				sessionCwd: "",
				projectRoot: null,
				projectError: null,
			},
		};
	}

	/**
	 * 演化系统沉淀的技能（get_evolved_skills；与 get_skills 是两件事，不合并）。
	 *
	 * 空清单 = 库读到了、里面确实没技能；库在但打不开 → ok:false 招错（读失败不是空集）。
	 * 行里的字段原样透传（包括可选的 error 降级通道），不在这里补默认值 —— 补一个假值
	 * 就让「没记过」和「记了个空」长得一模一样。
	 */
	async getEvolvedSkills(sessionId?: string): Promise<EvolvedSkillsDto> {
		const result = await this.#req<{ skills?: EvolvedSkillsDto["skills"] | null; error?: string | null }>({
			type: "get_evolved_skills",
			...(sessionId ? { sessionId } : {}),
		});
		return {
			skills: result.skills ?? [],
			...(result.error ? { error: result.error } : {}),
		};
	}

	/** 启停技能（set_skill_enabled；写该 agent 自己的配置 + 重发现热重载）。 */
	async setSkillEnabled(
		name: string,
		enabled: boolean,
		sessionId?: string,
	): Promise<{ ok: boolean; name: string; enabled: boolean }> {
		return this.#req<{ ok: boolean; name: string; enabled: boolean }>({
			type: "set_skill_enabled",
			name,
			enabled,
			...(sessionId ? { sessionId } : {}),
		});
	}

	/** 远程技能市场（list_remote_skills；契约命令名，WireCommand union 暂缺故最小局部 cast）。 */
	async listRemoteSkills(source?: string): Promise<RemoteSkillItemDto[]> {
		const result = await this.#req<{ items?: RemoteSkillItemDto[] | null }>({
			type: "list_remote_skills",
			...(source ? { source } : {}),
		} as never);
		return result.items ?? [];
	}

	/** 安装远程技能（install_remote_skill；契约命令名，WireCommand union 暂缺故最小局部 cast）。 */
	async installRemoteSkill(source: string, name: string): Promise<{ path: string; alreadyInstalled: boolean }> {
		return this.#req<{ path: string; alreadyInstalled: boolean }>({
			type: "install_remote_skill",
			source,
			name,
		} as never);
	}

	// ── MCP 服务器管理（设置页；契约命令由 serve 端 m1 并行实现，WireCommand union 暂缺故最小局部 cast）──

	/** 列出 MCP 服务器（get_mcp_servers；读 ~/.cornfield/agent/mcp.json 的 mcpServers）。 */
	async getMcpServers(): Promise<{ servers: McpServerDto[] }> {
		const result = await this.#req<{ servers?: McpServerDto[] | null }>({
			type: "get_mcp_servers",
		} as never);
		return { servers: result.servers ?? [] };
	}

	/** 新增/更新 MCP 服务器（set_mcp_server upsert；name 必填，command/args/enabled 可选缺省，未提供字段由 serve 保留原值）。 */
	async setMcpServer(input: {
		name: string;
		command?: string;
		args?: string[];
		enabled?: boolean;
	}): Promise<{ ok: boolean }> {
		const result = await this.#req<{ ok?: boolean }>({
			type: "set_mcp_server",
			name: input.name,
			...(input.command !== undefined ? { command: input.command } : {}),
			...(input.args !== undefined ? { args: input.args } : {}),
			...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
		} as never);
		return { ok: result.ok === true };
	}

	/** 删除 MCP 服务器（remove_mcp_server；幂等，不存在也 ok）。 */
	async removeMcpServer(name: string): Promise<{ ok: boolean }> {
		const result = await this.#req<{ ok?: boolean }>({
			type: "remove_mcp_server",
			name,
		} as never);
		return { ok: result.ok === true };
	}

	/** 测试 MCP 服务器（test_mcp_server；spawn + JSON-RPC initialize 握手 8s 超时，失败不崩 serve）。 */
	async testMcpServer(name: string): Promise<{ ok: boolean; message: string }> {
		const result = await this.#req<{ ok?: boolean; message?: string | null }>({
			type: "test_mcp_server",
			name,
		} as never);
		return { ok: result.ok === true, message: result.message ?? "" };
	}

	/** 排队文本（get_state 的 queued；协议批 B-2，QueueCard 数据源）。 */
	async fetchQueue(): Promise<{ steering: string[]; followUp: string[] }> {
		const result = await this.#req<{ queued?: { steering?: string[]; followUp?: string[] } }>({
			type: "get_state",
		} as never);
		return {
			steering: result.queued?.steering ?? [],
			followUp: result.queued?.followUp ?? [],
		};
	}

	/** 取消最近一条排队消息（cancel_queued；空队列 cancelled:false）。 */
	async cancelQueued(): Promise<{ cancelled: boolean; text?: string }> {
		return this.#req<{ cancelled: boolean; text?: string }>({ type: "cancel_queued" } as never);
	}

	/** TUI slash 命令表（list_commands；W1 SlashPalette 真源替换 DEFAULT_COMMANDS）。 */
	async listCommands(): Promise<{ name: string; description: string }[]> {
		const result = await this.#req<{ commands?: { name: string; description: string }[] }>({
			type: "list_commands",
		} as never);
		return result.commands ?? [];
	}

	/** gateway cron 任务表（get_cron_tasks；gateway 生产端点直连）。 */
	async getCronTasks(): Promise<{ tasks: TaskRowDto[] }> {
		return this.#gatewayWire<{ tasks: TaskRowDto[] }>({ type: "get_cron_tasks" });
	}

	/**
	 * 调度定义写面（T10C）：四个命令都直连 gateway POST /wire（scheduler 的主人是 gateway）。
	 * 失败原因（未注册的 agentId / 已不存在的 agentDir / 重名 / 未知 taskId）原样抛给调用方渲染，
	 * 不在这里吞成 false。
	 */
	async cronCreate(input: CronCreateInput): Promise<CronTaskWriteResultDto> {
		return this.#gatewayWire<CronTaskWriteResultDto>({ type: "cron_create", ...input });
	}

	async cronUpdate(taskId: string, input: CronUpdateInput): Promise<CronTaskWriteResultDto> {
		return this.#gatewayWire<CronTaskWriteResultDto>({ type: "cron_update", taskId, ...input });
	}

	async cronRemove(taskId: string): Promise<CronRemoveResultDto> {
		return this.#gatewayWire<CronRemoveResultDto>({ type: "cron_remove", taskId });
	}

	async cronTestRun(name: string, inMs?: number): Promise<CronTestRunResultDto> {
		return this.#gatewayWire<CronTestRunResultDto>({
			type: "cron_test_run",
			name,
			...(inMs !== undefined ? { inMs } : {}),
		});
	}

	/**
	 * 听记：上传浏览器录音（16kHz mono PCM WAV base64）→ serve 转写（TUI /record 同管线）→ 落盘。
	 * 长请求（本地 whisper 分钟级）——独立短连接 + 10 分钟超时，不拖累主连接 30s 超时策略。
	 */
	async recordTranscribe(
		audioBase64: string,
		desc?: string,
	): Promise<{ ok: boolean; text: string; path: string; model: string; error?: string }> {
		const config = loadServeConfig();
		const client = new WirePiClient({
			url: toWsUrl(config),
			token: config.token,
			autoReconnect: false,
			requestTimeoutMs: 600_000,
			...(this.#wsCtor ? { webSocketCtor: this.#wsCtor } : {}),
		});
		try {
			await client.connect();
			const result = await client.request<{
				ok?: boolean;
				text?: string;
				path?: string;
				model?: string;
				error?: string;
			}>({
				type: "record_transcribe",
				audio: audioBase64,
				...(desc ? { desc } : {}),
			} as never);
			return {
				ok: result.ok === true,
				text: result.text ?? "",
				path: result.path ?? "",
				model: result.model ?? "",
				...(result.error ? { error: result.error } : {}),
			};
		} finally {
			client.close("record_transcribe done");
		}
	}

	/**
	 * 听记分帧转写（长录音）：单帧 base64 超 Bun WS 16MB 上限会断连（code 1006 实测），
	 * 改走 begin→chunk→end，服务端流式落盘后走同一转写管线。独立短连接 + 30 分钟超时。
	 */
	async recordTranscribeChunked(
		audioBase64: string,
		desc?: string,
		onProgress?: (sent: number, total: number) => void,
	): Promise<{ ok: boolean; text: string; path: string; model: string; error?: string }> {
		const config = loadServeConfig();
		const client = new WirePiClient({
			url: toWsUrl(config),
			token: config.token,
			autoReconnect: false,
			requestTimeoutMs: 1_800_000,
			...(this.#wsCtor ? { webSocketCtor: this.#wsCtor } : {}),
		});
		try {
			await client.connect();
			const begin = await client.request<{ ok?: boolean; uploadId?: string; error?: string }>({
				type: "record_transcribe_begin",
				totalBytes: Math.floor(audioBase64.length * 0.75),
				...(desc ? { desc } : {}),
			} as never);
			if (!begin.ok || !begin.uploadId) {
				return { ok: false, text: "", path: "", model: "", error: begin.error ?? "begin upload failed" };
			}
			// 每帧 b64 字符数取 4 的倍数（不切坏 base64 组），解码后 ≈1.5MB，远低于 16MB 单帧上限
			const B64_CHUNK_CHARS = 2_000_000;
			const totalChunks = Math.ceil(audioBase64.length / B64_CHUNK_CHARS);
			for (let seq = 1, off = 0; off < audioBase64.length; seq++, off += B64_CHUNK_CHARS) {
				const part = audioBase64.slice(off, off + B64_CHUNK_CHARS);
				const chunk = await client.request<{ ok?: boolean; error?: string }>({
					type: "record_transcribe_chunk",
					uploadId: begin.uploadId,
					seq,
					data: part,
				} as never);
				if (!chunk.ok) {
					return { ok: false, text: "", path: "", model: "", error: chunk.error ?? "chunk upload failed" };
				}
				onProgress?.(seq, totalChunks);
			}
			const end = await client.request<{
				ok?: boolean;
				text?: string;
				path?: string;
				model?: string;
				error?: string;
			}>({
				type: "record_transcribe_end",
				uploadId: begin.uploadId,
			} as never);
			return {
				ok: end.ok === true,
				text: end.text ?? "",
				path: end.path ?? "",
				model: end.model ?? "",
				...(end.error ? { error: end.error } : {}),
			};
		} finally {
			client.close("record_transcribe_chunked done");
		}
	}

	/** 听记历史（listen_list；~/.cornfield/listen/ 全部录音，名称倒序 + 转写全文）。 */
	async listenList(): Promise<{ ok: boolean; recordings: ListenRecordingDto[] }> {
		const result = await this.#req<{ ok?: boolean; recordings?: ListenRecordingDto[] | null }>({
			type: "listen_list",
		} as never);
		return { ok: result.ok === true, recordings: result.recordings ?? [] };
	}

	/** cron 执行日志（get_cron_logs；gateway 生产端点直连，taskId/days/limit 可选）。 */
	async getCronLogs(opts?: { taskId?: string; days?: number; limit?: number }): Promise<{ logs: CronLogEntryDto[] }> {
		return this.#gatewayWire<{ logs: CronLogEntryDto[] }>({
			type: "get_cron_logs",
			...(opts?.taskId ? { taskId: opts.taskId } : {}),
			...(opts?.days ? { days: opts.days } : {}),
			...(opts?.limit ? { limit: opts.limit } : {}),
		});
	}

	// hostToolResult：pi-client 无裸帧发送 API（host_tool_result 是独立 client frame），
	// 待 pi-client 补 sendRaw/hostToolResult 后实现（差异清单已反馈 be-dev）。

	// ── 内部 ──

	#req<TResult = unknown>(command: WireCommand): Promise<TResult> {
		return this.#client.request<TResult>(command).catch((err: unknown) => {
			console.warn("[web-app] serve command failed", command.type, err);
			throw err;
		});
	}

	/**
	 * gateway 命令直连 gateway 生产端点（POST /wire，host:port = serve 在 hello_ack 里报的
	 * `gatewayWirePort`）。
	 *
	 * **端口由 serve 给**：浏览器侧没有 process.env，以前写死 7892，于是隔离 HOME 跑 e2e 时，
	 * 前端仍然连着本机真实运营中的 gateway（页面上出现的是别的进程的数据）。未上报（未连接 /
	 * 握手前）时就地下抛错 —— 快、且说得出原因；不许静默回退到 7892。
	 * gateway 未运行（端点不可达）→ fetch 抛错（调用方错误态）。
	 */
	async #gatewayWire<T>(command: Record<string, unknown>): Promise<T> {
		const port = this.#gatewayWirePort;
		if (port === null) {
			throw new Error("gateway 端口未知：待 serve 上报 gateway 端口（hello_ack.gatewayWirePort）");
		}
		const res = await fetch(`http://127.0.0.1:${port}/wire`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(command),
		});
		const data = (await res.json()) as { ok?: boolean; result?: unknown; error?: unknown };
		if (!res.ok || data.ok !== true) {
			throw new Error(typeof data.error === "string" ? data.error : `gateway wire ${res.status}`);
		}
		return data.result as T;
	}

	/** 拉取环境摘要（get_state → env，serve B1 已实现）。失败保留旧值/置 null，不阻塞连接。 */
	async #refreshEnvironment(): Promise<void> {
		try {
			const result = await this.#req<{ env?: WireEnvironmentSummaryDto | null }>({ type: "get_state" });
			const env = result.env;
			if (env) {
				this.#env = {
					repos: env.repos,
					branch: env.branch ?? "",
					activeAgentCount: env.activeAgentCount,
					pendingCronCount: env.pendingCronCount ?? 0,
				};
				// 经由 store subscriptionConnection 重建视图使 Home/Workspace 拿到新 env
				this.#notifyConnection();
			}
		} catch {
			// 保留旧值/置 null，不阻塞连接
		}
	}

	/**
	 * serve 重启 / WS 重连后旧快照可能残留（如上传送中相位）导致发送按钮锁死在「停止」。
	 *
	 * 走 `switch_session` 而不是 `attach`：重连是一条**新连接**，serve 侧焦点回到 default，
	 * 只 attach 不会把焦点拉回来，于是本连接会开始收 default 的快照 —— 另一个 Agent 的
	 * 会话就出现在当前转录里。switch_session 同时含 attach，并把焦点与权威快照一起恢复。
	 */
	async #resyncAttached(): Promise<void> {
		if (!this.#sessionId) return;
		try {
			await this.#req({ type: "switch_session", sessionId: this.#sessionId });
		} catch {
			// 会话已不存在（serve 数据重置）等场景：忽略，等下一个 server_snapshot
		}
	}

	#handleEvent(event: PiClientEventKind): void {
		switch (event.type) {
			case "status":
				this.#applyStatus(event.status, event.attempt);
				break;
			case "hello_ack":
				// serve 上报 gateway wire 端口 → gateway 类命令打那个端口（见 #gatewayWire）。
				this.#gatewayWirePort = gatewayWirePortOf(event);
				this.#connection = {
					...this.#connection,
					connectionId: event.connectionId,
					protocolVersion: event.protocolVersion,
					connected: true,
					reconnecting: false,
				};
				this.#notifyConnection();
				// env 环境摘要（serve get_state 已含 env 字段，B1）——异步拉取，到达后经 store 重建视图
				void this.#refreshEnvironment();
				// serve 重启 / WS 重连后旧快照可能残留（上传送中相位）锁死发送按钮：
				// 重新 attach 已附着的会话，强制 serve 推送权威快照覆盖缓存
				void this.#resyncAttached();
				break;
			case "push":
				this.#handlePush(event.event);
				break;
			case "error":
				// 传输层错误（重连中属常态），仅记录
				break;
		}
	}

	#applyStatus(status: string, attempt: number | undefined): void {
		const connected = status === "open";
		const reconnecting = status === "connecting" && (attempt ?? 0) > 0;
		// 断开就不再知道 serve 报的是哪个端口：清掉，重连后由新的 hello_ack 重新报。
		if (!connected) this.#gatewayWirePort = null;
		if (connected === this.#connection.connected && reconnecting === (this.#connection.reconnecting ?? false)) return;
		this.#connection = { ...this.#connection, connected, reconnecting };
		this.#notifyConnection();
	}

	#handlePush(event: unknown): void {
		if (!event || typeof event !== "object") return;
		const raw = event as {
			type?: string;
			sessions?: { id: string; name?: string; active: boolean }[];
			sessionId?: string;
			snapshot?: unknown;
			progressEvent?: unknown;
			event?: unknown;
		};

		if (raw.type === "server_snapshot") {
			const sessions = Array.isArray(raw.sessions) ? (raw.sessions as SessionEntryLike[]) : [];
			this.#agents = sessions.map(mapAgentEntry);
			this.#emit(raw as unknown as WireServerEventDto);
			return;
		}

		if (raw.type === "session_snapshot") {
			this.#sessionId = raw.sessionId ?? this.#sessionId;
			this.#emit(raw as unknown as WireServerEventDto);
			return;
		}

		if (raw.type === "progress") {
			const progress = normalizeProgress(raw.event);
			if (progress) this.#emit({ type: "progress", sessionId: this.#sessionId ?? "", event: progress });
			return;
		}

		if (raw.type === "permission_request") {
			this.#emit(raw as unknown as WireServerEventDto);
			return;
		}

		// host_tool_call：serve 需要前端执行已注册工具 → 归一为工具卡 run 态（回传待 pi-client 裸帧能力）
		if (raw.type === "host_tool_call") {
			const call = raw as unknown as {
				id: string;
				sessionId: string;
				toolCallId: string;
				toolName: string;
				arguments: Record<string, unknown>;
			};
			this.#emit({
				type: "progress",
				sessionId: call.sessionId,
				event: {
					type: "tool_execution_start",
					toolCallId: call.toolCallId,
					name: call.toolName,
					arguments: call.arguments,
					startedAt: Date.now(),
				},
			});
		}
	}

	#emit(frame: WireServerEventDto): void {
		for (const listener of this.#listeners) {
			listener(frame);
		}
	}

	#notifyConnection(): void {
		for (const listener of this.#connListeners) {
			listener({ ...this.#connection });
		}
	}
}

/** AgentMessage（真实快照/get_messages 返回形状）→ 播放时间线条目。 */
function toPlaybackEntries(messages: unknown[]): PlaybackEntry[] {
	// 独立 toolResult 顶层消息（role:"toolResult"，serve 快照/JSONL 形状）→ 按 toolCallId 归并，
	// 供下面渲染时挂回对应 toolCall（结果在消息自己的 content 内联形状时直接在循环内读取）。
	const standaloneResults = new Map<string, { isError?: boolean; text: string }>();
	for (const raw of messages) {
		if (!raw || typeof raw !== "object") continue;
		const m = raw as { role?: string; toolCallId?: string; isError?: boolean; content?: unknown };
		if (m.role !== "toolResult" || !m.toolCallId) continue;
		const parts = Array.isArray(m.content) ? (m.content as { type?: string; text?: string }[]) : [];
		standaloneResults.set(m.toolCallId, {
			isError: m.isError,
			text: parts
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map(c => c.text)
				.join("\n"),
		});
	}

	const result = new Map<string, { isError?: boolean; text: string }>(standaloneResults);
	const entries: PlaybackEntry[] = [];

	for (const raw of messages) {
		if (!raw || typeof raw !== "object") continue;
		const msg = raw as {
			id?: string;
			role?: string;
			model?: string;
			content?: unknown;
			errorMessage?: string;
		};
		const parts = Array.isArray(msg.content)
			? (msg.content as {
					type?: string;
					text?: string;
					thinking?: string;
					id?: string;
					name?: string;
					content?: unknown;
					isError?: boolean;
					arguments?: Record<string, unknown>;
				}[])
			: [];
		if (msg.role !== "user" && msg.role !== "assistant") continue;

		const contentByType = (type: string) => parts.filter(p => p.type === type);
		const text = [
			...contentByType("text").map(p => p.text ?? ""),
			...(msg.errorMessage ? [`✗ Error: ${msg.errorMessage}`] : []),
		].join("\n\n");
		const calls = contentByType("toolCall");
		const toolResults = contentByType("toolResult") as {
			toolCallId?: string;
			isError?: boolean;
			content?: { type: string; text?: string }[];
		}[];
		for (const tr of toolResults) {
			result.set(tr.toolCallId ?? "", {
				isError: tr.isError,
				text: (tr.content ?? [])
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map(c => c.text)
					.join("\n"),
			});
		}
		const tools: PlaybackToolStep[] = calls.map(call => {
			const r = result.get(call.id ?? "");
			return {
				name: call.name ?? "tool",
				argsText: call.arguments ? prettyArgs(call.arguments) : "",
				state: r?.isError ? "fail" : "done",
				result: r?.text,
			};
		});
		if (!text && tools.length === 0 && !msg.errorMessage) continue;
		entries.push({
			id: msg.id ?? `e${entries.length}`,
			role: msg.role === "user" ? "user" : "assistant",
			model: msg.model,
			text,
			tools,
		});
	}
	return entries;
}

/**
 * fs_write 的 CAS 拒绝标记。服务端把判决放在 error 字符串的固定前缀上（wire 错误码枚举
 * `WireErrorCode` 在 pi-wire 里，本票不改那个包），这里只认这个前缀 —— 其余服务端错误
 * （越界/超限/未知文件）必须原样上抛，不能被归成「冲突」。
 */
const FS_CONFLICT_PREFIX = "fs_conflict:";

/** 从服务端错误里取出冲突判决文本；不是冲突则返回 null。 */
function conflictDetailOf(err: unknown): string | null {
	if (!(err instanceof PiServerError)) return null;
	const detail = typeof err.serverError === "string" ? err.serverError : err.serverError.message;
	return detail.startsWith(FS_CONFLICT_PREFIX) ? detail : null;
}

/**
 * 从 hello_ack 上读 serve 上报的 gateway wire 端口。
 *
 * 读的是**帧上的字段**（不是常量）：serve 侧把它解析自 CORNFIELD_GATEWAY_WIRE_PORT，所以
 * 隔离 HOME 跑出来的那套 serve 报的就是它自己的端口。没报 / 报的不是一个正经端口号 → null，
 * 调用方据此报「还没上报」，而不是回落 7892。
 */
function gatewayWirePortOf(event: PiClientEventKind): number | null {
	if (event.type !== "hello_ack") return null;
	const raw: unknown = event.gatewayWirePort;
	return typeof raw === "number" && Number.isInteger(raw) && raw > 0 && raw <= 65535 ? raw : null;
}

function prettyArgs(args: Record<string, unknown>): string {
	return Object.entries(args)
		.map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
		.join(" · ");
}

/** 注册表 session 项（pi-wire SessionListEntry P3 富化形状）。 */
interface SessionEntryLike {
	id: string;
	name?: string;
	sessionFile?: string;
	active: boolean;
	role?: string;
	model?: { provider: string; id: string; name?: string };
	skillCount?: number;
	phase?: "idle" | "streaming" | "compacting" | "retrying" | "executing_tool";
	attached?: boolean;
	agentDir?: string;
	dingtalk?: DingtalkAgentConfigDto;
}

function mapAgentEntry(s: SessionEntryLike, index: number): AgentInfoDto {
	const busyPhase =
		s.phase === "streaming" || s.phase === "executing_tool" || s.phase === "compacting" || s.phase === "retrying";
	return {
		id: s.id,
		name: s.name ?? `Agent ${index + 1}`,
		face: (s.name ?? s.id[0] ?? "A").slice(0, 1),
		workspace: s.role ?? "默认工作区",
		kind: "worker",
		status: busyPhase ? "busy" : s.active ? "online" : s.attached ? "idle" : "stopped",
		model: s.model?.id,
		skillsCount: s.skillCount,
		attached: s.attached,
		active: s.active,
		phase: s.phase,
		agentDir: s.agentDir,
		dingtalk: s.dingtalk,
	};
}

/** 真实 AgentSessionEvent → 前端 ProgressEventDto（serve 白名单内的增量与工具生命周期事件）。 */
function normalizeProgress(event: unknown): ProgressEventDto | null {
	if (!event || typeof event !== "object") return null;
	const raw = event as Record<string, unknown>;

	// 生命周期事件（turn/agent 起止）：serve 白名单已含，前端需透传让 store 归零 isStreaming/相位
	switch (raw.type) {
		case "turn_start":
			return { type: "turn_start" };
		case "turn_end":
			return { type: "turn_end" };
		case "agent_start":
			return { type: "agent_start" };
		case "agent_end":
			return { type: "agent_end" };
		case "steer":
			// 协议批 B-1：steer 回显（serve 转发 steer 后推的 progress 帧，SteerIndicator 数据源）
			return typeof raw.text === "string" ? { type: "steer", text: raw.text } : null;
	}

	// 消息增量（thinking/text/toolcall delta）
	if (raw.type === "message_update") {
		const a = raw.assistantMessageEvent as { type?: string; contentIndex?: number; delta?: string } | undefined;
		if (!a) return null;
		const base = { contentIndex: a.contentIndex ?? 0, delta: a.delta ?? "" };
		switch (a.type) {
			case "thinking_delta":
				return { type: "message_update", assistantEvent: { type: "thinking_delta", ...base } };
			case "text_delta":
				return { type: "message_update", assistantEvent: { type: "text_delta", ...base } };
			case "toolcall_delta":
				return { type: "message_update", assistantEvent: { type: "toolcall_delta", ...base } };
			default:
				return null;
		}
	}

	// 工具生命周期（be-dev hotfix 后 serve 白名单含 start/end → 工具卡三态真 progress）
	if (raw.type === "tool_execution_start" && typeof raw.toolCallId === "string") {
		return {
			type: "tool_execution_start",
			toolCallId: raw.toolCallId,
			name: typeof raw.name === "string" ? raw.name : "tool",
			arguments:
				typeof raw.arguments === "object" && raw.arguments !== null
					? (raw.arguments as Record<string, unknown>)
					: undefined,
			intent: typeof raw.intent === "string" ? raw.intent : undefined,
			startedAt: typeof raw.startedAt === "number" ? raw.startedAt : Date.now(),
		};
	}
	if (raw.type === "tool_execution_end" && typeof raw.toolCallId === "string") {
		return {
			type: "tool_execution_end",
			toolCallId: raw.toolCallId,
			isError: raw.isError === true,
			resultText: typeof raw.resultText === "string" ? raw.resultText : undefined,
			durationMs: typeof raw.durationMs === "number" ? raw.durationMs : undefined,
		};
	}

	// message_end / tool_execution_update：流式结算/部分结果，前端无对应渲染，静默忽略
	return null;
}

/** serve get_available_models 返回的 Model 形状（pi-ai Model 的子集映射）。 */
interface ServeModelLike {
	id: string;
	name?: string;
	provider: string;
	reasoning?: boolean;
	contextWindow?: number;
	cost?: { input: number };
}

function fmtTokens(n: number | undefined): string | undefined {
	if (n === undefined) return undefined;
	if (n >= 1_000_000) return `${n / 1_000_000}M`;
	if (n >= 1_000) return `${n / 1_000}K`;
	return String(n);
}
