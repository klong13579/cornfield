import type { BranchPoint, PlaybackEntry, SessionRecordSummary } from "./records";
import type {
	AgentInfoDto,
	ConnectionInfoDto,
	EnvironmentSummaryDto,
	HostToolDefinitionDto,
	ImageContentDto,
	ModelInfoDto,
	SessionSnapshotDto,
	TodoPhaseDto,
	WireServerEventDto,
} from "./wire-dto";

/**
 * pi-client 接口契约（Web 壳消费的唯一数据面）。
 *
 * 形态对齐 requirements.md FR-1 与 wire-types.ts 的 snapshot/progress 语义：
 * - `session_snapshot` 为权威缓存（getSnapshot/subscribe 重建 UI）
 * - `progress` 只做事件通知（subscribe 回调中的 progress 事件，UI 层不得归约为权威状态）
 * - 命令面覆盖 workspace 需要的 12+ 条（prompt/abort/set_model/set_todos/…）
 *
 * 实现：`state/client.ts` 的 `createClient()` 返回 PiClientAdapter（真 pi-client 适配）。
 */
export interface PiClient {
	/** hello 握手建立连接（指数退避重连由实现管理）。 */
	connect(): Promise<ConnectionInfoDto>;
	disconnect(): void;
	getConnection(): ConnectionInfoDto;
	/** 权威快照缓存（连接成功前为 null）。 */
	getSnapshot(): SessionSnapshotDto | null;
	getServerAgents(): AgentInfoDto[];
	getEnvironment(): EnvironmentSummaryDto | null;
	/** 订阅推送帧（session_snapshot / progress / server_snapshot），返回退订函数。 */
	subscribe(listener: (frame: WireServerEventDto) => void): () => void;
	/** 连接状态订阅（可选：适配层提供，mock 可忽略）。 */
	subscribeConnection?(listener: (conn: ConnectionInfoDto) => void): () => void;

	// ── 命令面（12 条 workspace 命令子集）──
	prompt(text: string, sessionId?: string, images?: ImageContentDto[]): Promise<void>;
	abort(): Promise<void>;
	/** abort_retry：中止当前重试流。 */
	abortRetry(): Promise<void>;
	/** 前端已注册的 host tools（set_host_tools 本地态）。 */
	getHostTools(): HostToolDefinitionDto[];
	compact(): Promise<void>;
	newSession(): Promise<void>;
	setModel(modelId: string, provider?: string): Promise<void>;
	setThinkingLevel(level: string): Promise<void>;
	setTodos(phases: TodoPhaseDto[]): Promise<void>;
	setAutoCompaction(enabled: boolean): Promise<void>;
	setAutoRetry(enabled: boolean): Promise<void>;
	getAvailableModels(): Promise<ModelInfoDto[]>;

	// ── P3 多 Agent ──
	/** 拉取注册表 agent 元数据列表（list_agents，不触发 attach）。 */
	listAgents(): Promise<AgentInfoDto[]>;
	/** lazy attach 一个注册表 agent 到本进程（attach）。 */
	attach(sessionId: string): Promise<void>;
	/** 切换本连接的活动会话（switch_session；server 随后推新 session_snapshot）。 */
	switchSession(sessionId: string): Promise<void>;
	/** 注册 host tool 声明（set_host_tools；双向帧协议见 wire frames）。 */
	setHostTools(tools: HostToolDefinitionDto[]): Promise<void>;
	/** host tool 执行结果回传（host_tool_result client frame；视 pi-client 支持与否）。 */
	hostToolResult?(id: string, resultText: string, isError?: boolean): void;

	// ── P4 会话记录（serve 已实现 get_messages/get_session_stats/get_branch_messages）──
	/** 拉取当前 attached session 的全部消息（get_messages），转播放时间线。 */
	getMessages(): Promise<PlaybackEntry[]>;
	/** 拉取原始消息 JSON 序列（导出 JSONL 用，不转换）。 */
	getRawMessages(): Promise<unknown[]>;
	/** 分支候选（get_branch_messages：用户消息分支点 {entryId,text}）。 */
	getBranchMessages(): Promise<BranchPoint[]>;
	/** 历史会话索引（list_sessions；be-dev 就绪后返回真数据，未实现时返回基础查询）。 */
	listSessions(): Promise<SessionRecordSummary[]>;
}
