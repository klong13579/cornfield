import type { PiClient } from "../lib/pi-client-api";
import type { BranchPoint, PlaybackEntry, SessionRecordSummary } from "../lib/records";
import type {
	AgentInfoDto,
	EnvironmentSummaryDto,
	HostToolDefinitionDto,
	ImageContentDto,
	MessageContentDto,
	ModelInfoDto,
	ProgressEventDto,
	SessionPhaseDto,
	SessionSnapshotDto,
	TodoPhaseDto,
	WireServerEventDto,
} from "../lib/wire-dto";
import { createClient } from "./client";
import { type ServeConnectionConfig, saveServeConfig } from "./pi-client-adapter";

/** 渲染层工具卡状态（三态 + 参数/结果）。 */
export interface ToolView {
	id: string;
	name: string;
	argsText: string;
	intent?: string;
	state: "run" | "done" | "fail";
	result?: string;
	durationMs?: number;
}

/** 渲染层消息（由快照权威内容 + progress 瞬态增量归并而成）。 */
export interface TranscriptMessage {
	id: string;
	role: "user" | "assistant";
	model?: string;
	/** thinking 全文（瞬态层流式追加；快照到达后以权威内容覆盖）。 */
	thinking?: string;
	thinkingStreaming?: boolean;
	text?: string;
	textStreaming?: boolean;
	tools: ToolView[];
	done: boolean;
	error?: string;
}

/** 会话渲染视图 —— useSession() 的稳定快照。 */
export interface SessionView {
	connected: boolean;
	reconnecting: boolean;
	connectionId?: string;
	wsUrl: string;
	protocolVersion: number;
	phase: SessionPhaseDto;
	model: string | null;
	thinkingLevel: string | null;
	sessionId: string;
	sessionName?: string;
	/** 已落库消息。 */
	messages: TranscriptMessage[];
	/** 流式中的在途 assistant 消息（progress 瞬态层，快照到达即被权威替换）。 */
	live?: TranscriptMessage;
	isStreaming: boolean;
	activeToolNames: string[];
	queued: number;
	todo: TodoPhaseDto[];
	context?: { usedTokens: number; totalTokens: number; percent: number; lastCompaction: number | null };
	flags: { autoCompaction: boolean; autoRetry: boolean };
	agents: AgentInfoDto[];
	env: EnvironmentSummaryDto | null;
	/** 最近一次命令失败的可见错误（未连接等），成功或清空后为 undefined。 */
	commandError?: string;
}

const EMPTY_PHASE: SessionPhaseDto = "idle";

function cloneView(v: SessionView): SessionView {
	return {
		...v,
		messages: v.messages.map(m => ({ ...m, tools: m.tools.map(t => ({ ...t })) })),
		live: v.live ? { ...v.live, tools: v.live.tools.map(t => ({ ...t })) } : undefined,
		todo: v.todo.map(p => ({ ...p, tasks: p.tasks.map(t => ({ ...t })) })),
	};
}

/**
 * SessionStore —— 单例。快照权威（缓存）+ progress 瞬态（打字机）两层：
 * - session_snapshot 到达 → 缓存更新，瞬态层清空，视图整体重建（权威）
 * - progress 到达 → 仅作用在瞬态层（视图克隆上增量），绝不移入缓存
 * 与 wire-types.ts「progress 不得归约为状态」语义一致。
 */
class SessionStore {
	#client!: PiClient;
	#view: SessionView | null = null;
	#listeners = new Set<() => void>();

	init(client: PiClient): void {
		this.#client = client;
		const unsub = client.subscribe(frame => this.#onFrame(frame));
		// 连接状态变化（断线重连等）——真实链路由 adapter 的 subscribeConnection 驱动；mock 忽略
		if (client.subscribeConnection) {
			const unsubConn = client.subscribeConnection(conn => {
				this.#view = cloneView(this.getSnapshot());
				this.#view.connected = conn.connected;
				this.#view.reconnecting = conn.reconnecting ?? false;
				this.#view.connectionId = conn.connectionId;
				this.#view.protocolVersion = conn.protocolVersion;
				this.#view.wsUrl = conn.wsUrl;
				this.#view.env = this.#client.getEnvironment();
				this.#notify();
				void unsubConn;
			});
		}
		this.#view = this.#buildBaseView();
		this.#notify();
		// 生命周期与 store 共存；mock 客户端无额外清理（真机换 pi-client 时这里接断线清理）
		void unsub;
	}

	connect(): Promise<void> {
		return this.#client.connect().then(() => {
			this.#view = this.#buildBaseView();
			this.#notify();
		});
	}

	/** 保存连接配置并用新配置重建客户端（设置页保存/重连用）。 */
	async reconfigure(config: ServeConnectionConfig): Promise<void> {
		saveServeConfig(config);
		this.#client.disconnect();
		this.#client = createClient();
		this.init(this.#client);
		await this.#client.connect();
		this.#view = this.#buildBaseView();
		this.#notify();
	}

	getSnapshot(): SessionView {
		if (!this.#view) {
			this.#view = this.#buildBaseView();
		}
		return this.#view;
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	// ── 命令透传 ──

	/** 执行命令；失败（如未连接）时把错误写进 view.commandError，UI 显示提示条。 */
	async #run<T = void>(fn: () => Promise<T>): Promise<T | undefined> {
		try {
			const r = await fn();
			this.#clearCommandError();
			return r;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.#view = cloneView(this.getSnapshot());
			this.#view.commandError = `命令失败（未连接）：${msg}`;
			this.#notify();
			return undefined;
		}
	}

	clearCommandError(): void {
		this.#clearCommandError();
	}

	#clearCommandError(): void {
		if (!this.#view?.commandError) return;
		this.#view = cloneView(this.getSnapshot());
		this.#view.commandError = undefined;
		this.#notify();
	}

	prompt(text: string, sessionId?: string, images?: ImageContentDto[]): void {
		void this.#run(() => this.#client.prompt(text, sessionId, images));
	}

	abort(): void {
		void this.#run(() => this.#client.abort());
	}

	compact(): void {
		void this.#run(() => this.#client.compact());
	}

	newSession(): void {
		void this.#run(() => this.#client.newSession());
	}

	setModel(modelId: string, provider?: string): void {
		void this.#client.setModel(modelId, provider).catch(() => undefined);
	}

	setThinkingLevel(level: string): void {
		void this.#client.setThinkingLevel(level).catch(() => undefined);
	}

	setTodos(phases: TodoPhaseDto[]): void {
		void this.#client.setTodos(phases).catch(() => undefined);
	}

	setAutoCompaction(enabled: boolean): void {
		void this.#client.setAutoCompaction(enabled).catch(() => undefined);
	}

	setAutoRetry(enabled: boolean): void {
		void this.#client.setAutoRetry(enabled).catch(() => undefined);
	}

	abortRetry(): void {
		void this.#run(() => this.#client.abortRetry());
	}

	/** 前端已注册 host tools（set_host_tools 本地权威态）。 */
	getHostTools(): HostToolDefinitionDto[] {
		return this.#client.getHostTools();
	}

	setHostTools(tools: HostToolDefinitionDto[]): void {
		void this.#run(() => this.#client.setHostTools(tools));
	}

	toggleTodo(phaseName: string, index: number): void {
		const view = this.getSnapshot();
		const phases = view.todo.map(p => ({ ...p, tasks: p.tasks.map(t => ({ ...t })) }));
		const phase = phases.find(p => p.name === phaseName);
		const task = phase?.tasks[index];
		if (!phase || !task) return;
		task.status = task.status === "completed" ? "pending" : "completed";
		void this.#client.setTodos(phases).catch(() => undefined);
	}

	addTodo(phaseName: string, content: string): void {
		const view = this.getSnapshot();
		const phases = view.todo.map(p => ({ ...p, tasks: p.tasks.map(t => ({ ...t })) }));
		const trimmed = content.trim();
		if (!trimmed) return;
		if (view.todo.some(p => p.name === phaseName)) {
			const phase = phases.find(p => p.name === phaseName);
			phase?.tasks.push({ content: trimmed, status: "pending" });
		} else {
			phases.push({ name: phaseName, tasks: [{ content: trimmed, status: "pending" }] });
		}
		void this.#client.setTodos(phases).catch(() => undefined);
	}

	removeTodo(phaseName: string, index: number): void {
		const view = this.getSnapshot();
		const phases = view.todo.map(p => ({ ...p, tasks: p.tasks.map(t => ({ ...t })) }));
		const phase = phases.find(p => p.name === phaseName);
		if (!phase) return;
		phase.tasks.splice(index, 1);
		void this.#client.setTodos(phases).catch(() => undefined);
	}

	/** 拉取模型市场数据（get_available_models）；展示层自行持有。 */
	fetchModels(): Promise<ModelInfoDto[]> {
		return this.#client.getAvailableModels();
	}

	/** 别名（ComposerBar 接入真实模型列表）；serve stub 期间由 adapter 回退 fallback。 */
	getAvailableModels(): Promise<ModelInfoDto[]> {
		return this.#client.getAvailableModels();
	}

	/** 拉取注册表 agent 列表（list_agents）并刷新视图。 */
	async fetchAgents(): Promise<void> {
		const agents = await this.#client.listAgents();
		this.#view = cloneView(this.getSnapshot());
		this.#view.agents = agents;
		this.#notify();
	}

	/** lazy attach 注册表 agent（attach 后 serve 会推该会话快照/进度）。 */
	attach(sessionId: string): void {
		void this.#client.attach(sessionId).catch(() => undefined);
	}

	/** 切换活动会话（switch_session；serve 随后推新 session_snapshot，工作台自动跟随）。 */
	switchSession(sessionId: string): void {
		void this.#client.switchSession(sessionId).catch(() => undefined);
	}

	/** 拉取当前会话消息（get_messages）转播放时间线。 */
	getMessages(): Promise<PlaybackEntry[]> {
		return this.#client.getMessages();
	}

	/** 原始消息 JSON 序列（导出 JSONL）。 */
	getRawMessages(): Promise<unknown[]> {
		return this.#client.getRawMessages();
	}

	/** 分支候选（get_branch_messages）。 */
	getBranchMessages(): Promise<BranchPoint[]> {
		return this.#client.getBranchMessages();
	}

	/** 历史会话索引（list_sessions；未就绪时空数组，调用方回退 mock）。 */
	listSessions(): Promise<SessionRecordSummary[]> {
		return this.#client.listSessions();
	}

	// ── 帧归约 ──

	#onFrame(frame: WireServerEventDto): void {
		switch (frame.type) {
			case "session_snapshot":
				this.#applySnapshot(frame.snapshot);
				break;
			case "server_snapshot":
				// 多 Agent 后 server_snapshot 是 agents 列表权威源 —— 重读映射
				this.#view = cloneView(this.getSnapshot());
				this.#view.agents = this.#client.getServerAgents();
				this.#notify();
				break;
			case "progress":
				this.#applyProgress(frame.event);
				break;
		}
	}

	#applySnapshot(snapshot: SessionSnapshotDto): void {
		const prevLive = this.#view?.live;
		const base = this.#buildBaseView();
		const view: SessionView = {
			...base,
			phase: snapshot.phase,
			model: snapshot.model?.id ?? null,
			thinkingLevel: snapshot.thinkingLevel ?? null,
			sessionId: snapshot.sessionId,
			sessionName: snapshot.sessionName,
			messages: snapshot.messages.map(m => this.#toMessage(m)),
			isStreaming: snapshot.isStreaming || snapshot.phase === "streaming",
			activeToolNames: [...snapshot.activeToolNames],
			queued: snapshot.queuedMessageCount,
			todo: snapshot.todoPhases,
			context: snapshot.context
				? {
						...snapshot.context,
						percent: ratioPercent(snapshot.context.usedTokens, snapshot.context.totalTokens),
						lastCompaction: snapshot.context.lastCompaction ?? null,
					}
				: undefined,
			flags: { autoCompaction: snapshot.autoCompactionEnabled, autoRetry: snapshot.autoRetryEnabled },
		};
		// 流式期间的里程碑快照（仅相位/工具变更）不含流式消息本体：保留瞬态层累积内容，
		// 避免已流出的 thinking/文本在每次 publish 后闪没；收尾快照（含完整消息）自然替换。
		if (view.isStreaming && prevLive && !view.messages.some(m => m.id === prevLive.id) && !view.live) {
			view.live = prevLive;
		}
		this.#view = view;
		this.#notify();
	}

	#applyProgress(event: ProgressEventDto): void {
		const prev = this.getSnapshot();
		const view = cloneView(prev);

		switch (event.type) {
			case "turn_start":
			case "agent_start":
				view.isStreaming = true;
				view.phase = "streaming";
				break;
			case "turn_end":
			case "agent_end": {
				view.isStreaming = false;
				if (view.phase === "streaming") view.phase = EMPTY_PHASE;
				if (view.live) {
					view.live.done = true;
					view.live.textStreaming = false;
					view.live.thinkingStreaming = false;
					const live = view.live;
					view.live = undefined;
					view.messages.push(live);
				}
				break;
			}
			case "thinking_start":
				view.live = ensureLive(view, prev);
				view.live.thinking = view.live.thinking ?? "";
				view.live.thinkingStreaming = true;
				break;
			case "thinking_end":
				if (view.live) view.live.thinkingStreaming = false;
				break;
			case "message_update": {
				view.live = ensureLive(view, prev);
				const ev = event.assistantEvent;
				if (ev.type === "thinking_delta") {
					view.live.thinking = (view.live.thinking ?? "") + ev.delta;
					view.live.thinkingStreaming = true;
				} else if (ev.type === "text_delta") {
					view.live.text = (view.live.text ?? "") + ev.delta;
					view.live.textStreaming = true;
				}
				break;
			}
			case "tool_execution_start": {
				view.live = ensureLive(view, prev);
				view.live.tools = [
					...view.live.tools,
					{
						id: event.toolCallId,
						name: event.name,
						argsText: prettyArgs(event.arguments),
						intent: event.intent,
						state: "run",
					},
				];
				view.phase = "executing_tool";
				break;
			}
			case "tool_execution_end": {
				const tool = view.live?.tools.find(t => t.id === event.toolCallId);
				if (tool) {
					tool.state = event.isError ? "fail" : "done";
					tool.result = event.resultText;
					tool.durationMs = event.durationMs;
				}
				view.phase = "streaming";
				break;
			}
			case "auto_compaction_start":
				view.phase = "compacting";
				break;
			case "auto_retry_start":
				view.phase = "retrying";
				break;
			// todo_reminder / todo_auto_clear —— UI 提示型，暂不消费
			case "todo_reminder":
			case "todo_auto_clear":
				break;
		}

		this.#view = view;
		this.#notify();
	}

	#toMessage(msg: {
		id: string;
		role: "user" | "assistant" | "developer";
		model?: string;
		content: MessageContentDto[];
		errorMessage?: string;
	}): TranscriptMessage {
		const content = Array.isArray(msg.content) ? msg.content : [];
		const thinking = content
			.filter((c): c is Extract<MessageContentDto, { type: "thinking" }> => c.type === "thinking")
			.map(c => c.thinking)
			.join("\n");
		const text = content
			.filter((c): c is Extract<MessageContentDto, { type: "text" }> => c.type === "text")
			.map(c => c.text)
			.join("\n\n");
		const calls = content.filter((c): c is Extract<MessageContentDto, { type: "toolCall" }> => c.type === "toolCall");
		const results = new Map(
			content
				.filter((c): c is Extract<MessageContentDto, { type: "toolResult" }> => c.type === "toolResult")
				.map(c => [c.toolCallId, c] as const),
		);
		const tools: ToolView[] = calls.map(call => {
			const result = results.get(call.id);
			return {
				id: call.id,
				name: call.name,
				argsText: prettyArgs(call.arguments),
				intent: call.intent,
				state: result ? (result.isError ? "fail" : "done") : "done",
				result: result ? textOf(result) : undefined,
			};
		});
		return {
			id: msg.id,
			role: msg.role === "user" ? "user" : "assistant",
			model: msg.model,
			thinking: thinking || undefined,
			text: text || undefined,
			tools,
			done: msg.role !== "user",
			error: msg.errorMessage,
		};
	}

	#buildBaseView(): SessionView {
		const snapshot = this.#client.getSnapshot();
		const connection = this.#client.getConnection();
		const agents = this.#client.getServerAgents();
		const env = this.#client.getEnvironment();
		if (!snapshot) {
			return {
				connected: connection.connected,
				reconnecting: connection.reconnecting ?? false,
				connectionId: connection.connectionId,
				wsUrl: connection.wsUrl,
				protocolVersion: connection.protocolVersion,
				phase: EMPTY_PHASE,
				model: null,
				thinkingLevel: null,
				sessionId: "",
				messages: [],
				isStreaming: false,
				activeToolNames: [],
				queued: 0,
				todo: [],
				flags: { autoCompaction: false, autoRetry: false },
				agents,
				env,
			};
		}
		return {
			connected: connection.connected,
			reconnecting: connection.reconnecting ?? false,
			connectionId: connection.connectionId,
			wsUrl: connection.wsUrl,
			protocolVersion: connection.protocolVersion,
			phase: snapshot.phase,
			model: snapshot.model?.id ?? null,
			thinkingLevel: snapshot.thinkingLevel ?? null,
			sessionId: snapshot.sessionId,
			sessionName: snapshot.sessionName,
			messages: snapshot.messages.map(m => this.#toMessage(m)),
			isStreaming: snapshot.isStreaming,
			activeToolNames: [...snapshot.activeToolNames],
			queued: snapshot.queuedMessageCount,
			todo: snapshot.todoPhases,
			context: snapshot.context
				? {
						...snapshot.context,
						percent: ratioPercent(snapshot.context.usedTokens, snapshot.context.totalTokens),
						lastCompaction: snapshot.context.lastCompaction ?? null,
					}
				: undefined,
			flags: { autoCompaction: snapshot.autoCompactionEnabled, autoRetry: snapshot.autoRetryEnabled },
			agents,
			env,
		};
	}

	#notify(): void {
		for (const listener of this.#listeners) {
			listener();
		}
	}
}

function ensureLive(view: SessionView, prev: SessionView): TranscriptMessage {
	if (view.live) return view.live;
	const live: TranscriptMessage = {
		id: `live-${view.messages.length}`,
		role: "assistant",
		model: prev.model ?? undefined,
		tools: [],
		done: false,
	};
	view.live = live;
	return live;
}

function prettyArgs(args: Record<string, unknown> | undefined): string {
	if (!args) return "";
	return Object.entries(args)
		.map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
		.join(" · ");
}

function textOf(result: Extract<MessageContentDto, { type: "toolResult" }>): string {
	const parts = result.content ?? [];
	return parts
		.filter((p): p is { type: "text"; text: string } => p.type === "text")
		.map(p => p.text)
		.join("\n");
}

function ratioPercent(used: number, total: number): number {
	if (total <= 0) return 0;
	return Math.min(100, Math.round((used / total) * 100));
}

/** 单例导出。 */
const store = new SessionStore();
export function useSessionStore(): SessionStore {
	return store;
}
