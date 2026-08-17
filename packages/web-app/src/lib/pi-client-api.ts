import type {
	AgentInfoDto,
	ConnectionInfoDto,
	EnvironmentSummaryDto,
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
 * 替换点：`state/client.ts` 的 `createClient()` 当前返回 MockPiClient；
 * `@oh-my-pi/pi-client`（be-dev）发布后，仅替换该工厂的实现，
 * 上层组件与 store 不感知差异。
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

	// ── 命令面（12 条 workspace 命令子集）──
	prompt(text: string): Promise<void>;
	abort(): Promise<void>;
	compact(): Promise<void>;
	newSession(): Promise<void>;
	setModel(modelId: string): Promise<void>;
	setThinkingLevel(level: string): Promise<void>;
	setTodos(phases: TodoPhaseDto[]): Promise<void>;
	setAutoCompaction(enabled: boolean): Promise<void>;
	setAutoRetry(enabled: boolean): Promise<void>;
	getAvailableModels(): Promise<ModelInfoDto[]>;
}
