import type { PiClientEventKind, PiWebSocketCtor } from "@oh-my-pi/pi-client";
import { PiClient as WirePiClient } from "@oh-my-pi/pi-client";
import type { WireCommand } from "@oh-my-pi/pi-wire";
import type { AgentMessageDto, FsEntryDto, FsImageResult, GatewayStatusDto, PiClient } from "../lib/pi-client-api";
import type { BranchPoint, PlaybackEntry, PlaybackToolStep, RecordStatus, SessionRecordSummary } from "../lib/records";
import type {
	AgentInfoDto,
	AvailableModelsDto,
	ConnectionInfoDto,
	CronLogEntryDto,
	DashboardStatsDto,
	DisabledSkillDto,
	EnvironmentSummaryDto,
	HostToolDefinitionDto,
	ImageContentDto,
	MemoryProjectionDto,
	ProgressEventDto,
	SessionSnapshotDto,
	SkillDto,
	StatsPeriodDto,
	TaskRowDto,
	TodoPhaseDto,
	WireServerEventDto,
} from "../lib/wire-dto";

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
	startTime: string;
	endTime?: string;
	messageCount: number;
	status?: "completed" | "aborted" | "error" | "incomplete" | "unknown";
	source?: "cli" | "agent";
	sessionFile?: string;
}

/**
 * 真实 `@oh-my-pi/pi-client` 适配器 —— 实现 web-app 内部契约（lib/pi-client-api.ts）。
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

/** `omp serve` 连接配置（设置页可改，localStorage 持久化）。 */
export interface ServeConnectionConfig {
	wsUrl: string;
	token: string;
}

const CONN_STORAGE_KEY = "omp.serve.connection";

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

export class PiClientAdapter implements PiClient {
	#client: WirePiClient;
	#sessionId: string | null = null;
	#connection: ConnectionInfoDto;
	#agents: AgentInfoDto[] = [];
	#env: EnvironmentSummaryDto | null = null;
	#listeners = new Set<(frame: WireServerEventDto) => void>();
	#connListeners = new Set<(conn: ConnectionInfoDto) => void>();

	constructor(config: ServeConnectionConfig = loadServeConfig(), webSocketCtor?: PiWebSocketCtor) {
		this.#connection = { connected: false, wsUrl: config.wsUrl, protocolVersion: 1 };
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

	newSession(): Promise<void> {
		return this.#req({ type: "new_session" }).then(() => undefined);
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

	setModel(modelId: string, provider = "custom"): Promise<void> {
		return this.#req({ type: "set_model", provider, modelId }).then(() => undefined);
	}

	setThinkingLevel(level: string): Promise<void> {
		const command = { type: "set_thinking_level", level } as WireCommand;
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
	 * disabledModels 过滤）。未连接/命令失败返回空数组，UI 显示「未连接/不可用」空态；
	 * 绝不回退内置假数据（HF-1）。
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

	// ── P3 多 Agent ──

	/** 拉取注册表 agent 元数据（list_agents），不触发 attach。 */
	async listAgents(): Promise<AgentInfoDto[]> {
		try {
			const result = await this.#req<unknown>({ type: "list_agents" });
			const list = result as SessionEntryLike[] | null;
			if (Array.isArray(list)) {
				this.#agents = list.map(mapAgentEntry);
				return this.#agents;
			}
		} catch (err) {
			console.warn("[web-app] list_agents unavailable", err);
		}
		return this.#agents;
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
	 * 后端返回 WireSessionIndexEntry（sessionId/title/startTime/endTime/agentName/status/source/sessionFile），
	 * 映射到前端 SessionRecordSummary（id/name/agent/startedAt/source）。失败返回空数组，UI 空态。
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
			}));
		} catch (err) {
			console.warn("[web-app] list_sessions unavailable", err);
			return [];
		}
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

	/** 读 agent workspace 文件（fs_read；>128KB 截断标记）。 */
	async fsRead(sessionId: string, path: string): Promise<{ text: string; truncated: boolean }> {
		const result = await this.#req<{ text?: string | null; truncated?: boolean | null }>({
			type: "fs_read",
			sessionId,
			path,
		} as never);
		return { text: result.text ?? "", truncated: result.truncated === true };
	}

	/** 读 agent workspace 图片（fs_read_image；dataUrl，2MB 上限；FileExplorer 预览用）。 */
	async fsReadImage(sessionId: string, path: string): Promise<FsImageResult> {
		return this.#req<FsImageResult>({
			type: "fs_read_image",
			sessionId,
			path,
		} as never);
	}

	/** 本机 gateway 运行状态（gateway_status；serve 转发 gateway.status.json）。 */
	async gatewayStatus(): Promise<GatewayStatusDto> {
		return this.#req<GatewayStatusDto>({ type: "gateway_status" } as never);
	}

	/** 本地用量统计（get_stats；period 可选时间窗口，无数据/失败抛错由调用方空态）。 */
	async getStats(period?: StatsPeriodDto): Promise<DashboardStatsDto> {
		const command = period === undefined || period === "all" ? { type: "get_stats" } : { type: "get_stats", period };
		return this.#req<DashboardStatsDto>(command as never);
	}

	/** 记忆投影（get_memory；三分区只读，取不到为 null，失败抛错由调用方空态）。 */
	async getMemory(): Promise<MemoryProjectionDto> {
		return this.#req<MemoryProjectionDto>({ type: "get_memory" } as never);
	}

	/** 已加载技能 + 已停用名单（get_skills；只读；失败抛错由调用方空态）。 */
	async getSkills(): Promise<{ skills: SkillDto[]; disabled: DisabledSkillDto[] }> {
		const result = await this.#req<{ skills?: SkillDto[]; disabled?: DisabledSkillDto[] }>({
			type: "get_skills",
		} as never);
		return { skills: result.skills ?? [], disabled: result.disabled ?? [] };
	}

	/** 启停技能（set_skill_enabled；写配置 + 重发现热重载，失败抛错由调用方提示）。 */
	async setSkillEnabled(name: string, enabled: boolean): Promise<{ ok: boolean; name: string; enabled: boolean }> {
		return this.#req<{ ok: boolean; name: string; enabled: boolean }>({
			type: "set_skill_enabled",
			name,
			enabled,
		} as never);
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

	/** gateway cron 任务表（get_cron_tasks；jobs.json 直读，只读）。 */
	async getCronTasks(): Promise<{ tasks: TaskRowDto[] }> {
		return this.#req<{ tasks: TaskRowDto[] }>({ type: "get_cron_tasks" } as never);
	}

	/** cron 执行日志（get_cron_logs；logs/by-task 直读，只读）。 */
	async getCronLogs(opts?: { taskId?: string; days?: number; limit?: number }): Promise<{ logs: CronLogEntryDto[] }> {
		const command = {
			type: "get_cron_logs",
			...(opts?.taskId ? { taskId: opts.taskId } : {}),
			...(opts?.days ? { days: opts.days } : {}),
			...(opts?.limit ? { limit: opts.limit } : {}),
		} as never;
		return this.#req<{ logs: CronLogEntryDto[] }>(command);
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
	 * 重新 attach 已知会话，强制 serve 广播权威 session_snapshot 覆盖缓存。幂等：已附着则无副作用。
	 */
	async #resyncAttached(): Promise<void> {
		if (!this.#sessionId) return;
		try {
			await this.#req({ type: "attach", sessionId: this.#sessionId } as never);
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
		phase: s.phase,
		agentDir: s.agentDir,
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
