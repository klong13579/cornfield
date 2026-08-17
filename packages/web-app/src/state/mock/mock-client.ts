import type { PiClient } from "../../lib/pi-client-api";
import type {
	AgentInfoDto,
	ConnectionInfoDto,
	EnvironmentSummaryDto,
	MessageContentDto,
	ModelInfoDto,
	ProgressEventDto,
	SessionSnapshotDto,
	TodoPhaseDto,
	WireServerEventDto,
} from "../../lib/wire-dto";
import { MOCK_AGENTS, MOCK_ENV, MOCK_MODELS, seedSnapshot } from "./mock-data";

/**
 * MockPiClient —— `@oh-my-pi/pi-client` 就绪前的本地替身。
 *
 * 替换点：`state/client.ts` 的 `createClient()` 换为真实 pi-client 后删除本目录。
 * 语义对齐：
 * - snapshot 权威（seed + 命令变更 → 推 session_snapshot；流收尾把助手消息完整提交进权威层）
 * - progress 仅事件（prompt 模拟一轮真实 agent 流：thinking_delta → 工具三态 → text_delta）
 * - 命令方法全部走 `#publish`，UI 只消费快照，行为与真机一致
 */
export class MockPiClient implements PiClient {
	#connection: ConnectionInfoDto = {
		connected: false,
		wsUrl: "ws://127.0.0.1:17894",
		protocolVersion: 1,
	};
	#snapshot: SessionSnapshotDto = seedSnapshot();
	#agents: AgentInfoDto[] = MOCK_AGENTS;
	#env: EnvironmentSummaryDto = MOCK_ENV;
	#listeners = new Set<(frame: WireServerEventDto) => void>();
	#timers = new Set<ReturnType<typeof setTimeout>>();
	#running = false;
	#seq = 1;
	/** 当前流式轮次的内容累积（提交进权威快照前的过程镜像）。 */
	#scenarioParts: MessageContentDto[] = [];

	async connect(): Promise<ConnectionInfoDto> {
		this.#connection = {
			connected: true,
			connectionId: `mock-${Math.random().toString(36).slice(2, 10)}`,
			wsUrl: this.#connection.wsUrl,
			protocolVersion: 1,
		};
		// 模拟 hello 握手后的初始推送：server_snapshot + 全量 session_snapshot
		this.#emit({
			type: "server_snapshot",
			sessions: [{ id: this.#snapshot.sessionId, name: this.#snapshot.sessionName, active: true }],
		});
		this.#publish();
		return this.#connection;
	}

	disconnect(): void {
		this.#connection = { connected: false, wsUrl: this.#connection.wsUrl, protocolVersion: 1 };
		this.#clearTimers();
		this.#running = false;
		this.#scenarioParts = [];
	}

	getConnection(): ConnectionInfoDto {
		return this.#connection;
	}

	getSnapshot(): SessionSnapshotDto | null {
		return this.#snapshot;
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

	// ── 命令面 ──

	async prompt(text: string): Promise<void> {
		if (this.#running || !text.trim()) return;
		this.#running = true;
		this.#scenarioParts = [];
		this.#runScenario(text.trim());
	}

	async abort(): Promise<void> {
		if (!this.#running) return;
		this.#clearTimers();
		this.#running = false;
		this.#commitStreaming("（已中止）", { phase: "idle", isStreaming: false, activeToolNames: [] });
	}

	async compact(): Promise<void> {
		if (this.#running) return;
		this.#snapshot = { ...this.#snapshot, phase: "compacting", isCompacting: true, seq: this.#seq++ };
		this.#publish();
		this.#delay(600, () => {
			this.#snapshot = {
				...this.#snapshot,
				phase: "idle",
				isCompacting: false,
				queuedMessageCount: 0,
				seq: this.#seq++,
			};
			this.#publish();
		});
	}

	async newSession(): Promise<void> {
		if (this.#running) return;
		this.#snapshot = {
			...seedSnapshot(),
			seq: this.#seq++,
			sessionId: `mock-${Math.random().toString(36).slice(2, 10)}`,
			sessionName: "新会话",
			messages: [],
			phase: "idle",
		};
		this.#publish();
	}

	async setModel(modelId: string): Promise<void> {
		this.#snapshot = {
			...this.#snapshot,
			seq: this.#seq++,
			model: { id: modelId, provider: modelId.split("/")[0] ?? "narwal-plan" },
		};
		this.#publish();
	}

	async setThinkingLevel(level: string): Promise<void> {
		this.#snapshot = { ...this.#snapshot, seq: this.#seq++, thinkingLevel: level };
		this.#publish();
	}

	async setTodos(phases: TodoPhaseDto[]): Promise<void> {
		this.#snapshot = { ...this.#snapshot, seq: this.#seq++, todoPhases: phases };
		this.#publish();
	}

	async setAutoCompaction(enabled: boolean): Promise<void> {
		this.#snapshot = { ...this.#snapshot, seq: this.#seq++, autoCompactionEnabled: enabled };
		this.#publish();
	}

	async setAutoRetry(enabled: boolean): Promise<void> {
		this.#snapshot = { ...this.#snapshot, seq: this.#seq++, autoRetryEnabled: enabled };
		this.#publish();
	}

	async getAvailableModels(): Promise<ModelInfoDto[]> {
		return MOCK_MODELS;
	}

	// ── 内部：模拟一轮 agent 流 ──

	/** 场景内固定的工具调用 id（与 #seq 解耦，避免 start/end 之间 seq 递增导致 id 错位）。 */
	static readonly SCENARIO_TOOL_READ = "scenario-tool-read";
	static readonly SCENARIO_TOOL_SEARCH = "scenario-tool-search";

	#runScenario(promptText: string): void {
		// 0 · 入队 + 快照（用户消息入权威层）
		const userContent: MessageContentDto[] = [{ type: "text", text: promptText }];
		this.#snapshot = {
			...this.#snapshot,
			seq: this.#seq++,
			phase: "streaming",
			isStreaming: true,
			messages: [...this.#snapshot.messages, { id: `u${this.#seq}`, role: "user", content: userContent }],
		};
		this.#emit({ type: "turn_start" });
		this.#emit({ type: "agent_start" });
		this.#publish();

		// 1 · thinking 流（thinking_delta × 8，~140ms 一拍）
		const thinking =
			"收到指令。先建立上下文：这个问题与 gateway 重启路径相关——启动时读重启哨兵决定是否恢复在途会话；优雅停止会写哨兵，SIGKILL 则不会。需要核对 gateway-daemon.ts 的 stop() 实现与哨兵读取时机，再给修复方案。";
		const thinkingChunks = thinking.match(/.{1,22}/g) ?? [thinking];
		this.#scenarioParts.push({ type: "thinking", thinking: "" });
		this.#emit({ type: "thinking_start", contentIndex: 0 });
		thinkingChunks.forEach((chunk, i) => {
			this.#delay(140 * i, () => {
				this.#appendThinking(chunk);
				this.#emit({
					type: "message_update",
					assistantEvent: { type: "thinking_delta", contentIndex: 0, delta: chunk },
				});
			});
		});
		this.#delay(140 * thinkingChunks.length + 120, () => this.#emit({ type: "thinking_end", contentIndex: 0 }));

		// 2 · 工具 read（运行中 → 完成）
		const t1At = 140 * thinkingChunks.length + 200;
		this.#delay(t1At, () => {
			this.#scenarioParts.push({
				type: "toolCall",
				id: MockPiClient.SCENARIO_TOOL_READ,
				name: "read",
				arguments: { path: "~/.omp/gateway-data/logs/service.log" },
				intent: "核对 00:20:30 附近日志",
			});
			this.#emit({
				type: "tool_execution_start",
				toolCallId: MockPiClient.SCENARIO_TOOL_READ,
				name: "read",
				arguments: { path: "~/.omp/gateway-data/logs/service.log" },
				intent: "核对 00:20:30 附近日志",
				startedAt: Date.now(),
			});
			this.#snapshot = { ...this.#snapshot, seq: this.#seq++, phase: "executing_tool", activeToolNames: ["read"] };
			this.#publish();
		});
		this.#delay(t1At + 650, () => {
			this.#scenarioParts.push({
				type: "toolResult",
				toolCallId: MockPiClient.SCENARIO_TOOL_READ,
				content: [
					{ type: "text", text: "00:20:30 [AgentBridge] bridge crashed (SIGKILL) — in-flight message lost" },
				],
			});
			this.#emit({
				type: "tool_execution_end",
				toolCallId: MockPiClient.SCENARIO_TOOL_READ,
				isError: false,
				resultText: "00:20:30 [AgentBridge] bridge crashed (SIGKILL) — in-flight message lost",
				durationMs: 650,
			});
			this.#snapshot = { ...this.#snapshot, seq: this.#seq++, phase: "streaming", activeToolNames: [] };
			this.#publish();
		});

		// 3 · 文本流 #1
		const text1 =
			"确认是 SIGKILL 而非优雅退出：重启哨兵没写入，会话恢复被跳过，in-flight IM 消息直接丢失。继续查哨兵写入路径：\n\n`packages/omp-gateway/src` 里 restart-sentinel 的写入时机。";
		const t1Chunks = chunkify(text1);
		t1Chunks.forEach((chunk, i) => {
			this.#delay(t1At + 750 + 36 * i, () => {
				this.#appendText(chunk);
				this.#emit({
					type: "message_update",
					assistantEvent: { type: "text_delta", contentIndex: 1, delta: chunk },
				});
			});
		});

		// 4 · 工具 search（运行中 → 完成）
		const t2At = t1At + 750 + 36 * t1Chunks.length + 150;
		this.#delay(t2At, () => {
			this.#scenarioParts.push({
				type: "toolCall",
				id: MockPiClient.SCENARIO_TOOL_SEARCH,
				name: "search",
				arguments: { pattern: "restart-sentinel", path: "packages/omp-gateway/src" },
				intent: "定位哨兵写入与读取的调用点",
			});
			this.#emit({
				type: "tool_execution_start",
				toolCallId: MockPiClient.SCENARIO_TOOL_SEARCH,
				name: "search",
				arguments: { pattern: "restart-sentinel", path: "packages/omp-gateway/src" },
				intent: "定位哨兵写入与读取的调用点",
				startedAt: Date.now(),
			});
			this.#snapshot = { ...this.#snapshot, seq: this.#seq++, phase: "executing_tool", activeToolNames: ["search"] };
			this.#publish();
		});
		this.#delay(t2At + 700, () => {
			this.#scenarioParts.push({
				type: "toolResult",
				toolCallId: MockPiClient.SCENARIO_TOOL_SEARCH,
				content: [{ type: "text", text: "restart-sentinel.ts · 3 matches" }],
			});
			this.#emit({
				type: "tool_execution_end",
				toolCallId: MockPiClient.SCENARIO_TOOL_SEARCH,
				isError: false,
				resultText: "restart-sentinel.ts · 3 matches",
				durationMs: 700,
			});
			this.#snapshot = { ...this.#snapshot, seq: this.#seq++, phase: "streaming", activeToolNames: [] };
			this.#publish();
		});

		// 5 · 文本流 #2 → 收尾
		const text2 =
			"修复建议：给 gateway.stop() 加 30s 硬超时，超时后先写重启哨兵再 escalate（bootout），避免 SIGKILL 丢消息；同步补一条回归测试覆盖该路径。";
		const t2Chunks = chunkify(text2);
		t2Chunks.forEach((chunk, i) => {
			this.#delay(t2At + 800 + 36 * i, () => {
				this.#appendText(chunk);
				this.#emit({
					type: "message_update",
					assistantEvent: { type: "text_delta", contentIndex: 1, delta: chunk },
				});
			});
		});

		const endAt = t2At + 800 + 36 * t2Chunks.length + 120;
		this.#delay(endAt, () =>
			this.#commitStreaming(undefined, { phase: "idle", isStreaming: false, activeToolNames: [] }),
		);
	}

	#appendThinking(delta: string): void {
		const part = this.#scenarioParts.find(p => p.type === "thinking");
		if (part?.type === "thinking") part.thinking += delta;
	}

	#appendText(delta: string): void {
		const part = this.#scenarioParts.find(p => p.type === "text");
		if (part?.type === "text") {
			part.text += delta;
		} else {
			this.#scenarioParts.push({ type: "text", text: delta });
		}
	}

	/**
	 * 流收尾：把瞬态内容并入权威快照（assistant 消息完整落库）→ agent_end/turn_end。
	 * abortNote 存在时为用户中止短消息（内容不完整标记）。
	 */
	#commitStreaming(
		abortNote: string | undefined,
		phasePatch: Partial<Pick<SessionSnapshotDto, "phase" | "isStreaming" | "activeToolNames">>,
	): void {
		this.#running = false;
		const parts = this.#scenarioParts.filter(p =>
			p.type === "thinking" ? p.thinking.length > 0 : p.type === "text" ? p.text.length > 0 : true,
		);
		this.#scenarioParts = [];
		if (abortNote) {
			parts.push({ type: "text", text: `${abortNote}（本消息被用户中止，内容不完整）` });
		}
		this.#snapshot = {
			...this.#snapshot,
			seq: this.#seq++,
			phase: phasePatch.phase ?? "idle",
			isStreaming: phasePatch.isStreaming ?? false,
			activeToolNames: phasePatch.activeToolNames ?? [],
			messages: [
				...this.#snapshot.messages,
				{ id: `a${this.#seq}`, role: "assistant", model: this.#snapshot.model?.id, content: parts },
			],
		};
		this.#emit({ type: "agent_end" });
		this.#emit({ type: "turn_end" });
		this.#publish();
	}

	#publish(): void {
		this.#emit({ type: "session_snapshot", sessionId: this.#snapshot.sessionId, snapshot: this.#snapshot });
	}

	/**
	 * 推送帧发送：push 帧直通；progress 事件自动包装为
	 * { type: "progress", sessionId, event }（wire 帧模型要求）。
	 */
	#emit(frame: WireServerEventDto | ProgressEventDto): void {
		const push: WireServerEventDto = isPushFrame(frame)
			? frame
			: { type: "progress", sessionId: this.#snapshot.sessionId, event: frame };
		for (const listener of this.#listeners) {
			try {
				listener(push);
			} catch (err) {
				// 浏览器侧日志占位：pi-utils logger 绑定 node/winston，不进浏览器包
				console.warn("[web-app] subscriber error", err);
			}
		}
	}

	#delay(ms: number, fn: () => void): void {
		const timer = setTimeout(() => {
			this.#timers.delete(timer);
			fn();
		}, ms);
		this.#timers.add(timer);
	}

	#clearTimers(): void {
		for (const timer of this.#timers) {
			clearTimeout(timer);
		}
		this.#timers.clear();
	}
}

function isPushFrame(frame: WireServerEventDto | ProgressEventDto): frame is WireServerEventDto {
	return frame.type === "session_snapshot" || frame.type === "server_snapshot" || frame.type === "progress";
}

function chunkify(text: string, size = 14): string[] {
	const parts: string[] = [];
	for (let i = 0; i < text.length; i += size) {
		parts.push(text.slice(i, i + size));
	}
	return parts;
}
