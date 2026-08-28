/**
 * InMemoryWireClient — 进程内 Wire 客户端（P3：TUI 经协议层消费核心）。
 *
 * 与 ws 客户端同协议语义（ClientFrame/ServerFrame + WireCommand），但帧对象
 * 直传不序列化：请求 → createWireCore().handleCommand → 响应回调；
 * push（progress/session_snapshot/permission_request）→ 注册的 handler。
 *
 * TUI 切换分两步（P3）：
 * 1. 本客户端就位（wire 语义可独立测试）
 * 2. interactive-mode 的关键路径（模型/审批/会话元数据）切到本客户端，
 *    逐步扩大直到 TUI 完全经协议层消费核心。
 */
import type { ServerFrame, SessionSnapshot, WireCommand } from "@cornfield/wire";
import type { CommandContext, WireCore, WireCoreTarget } from "./wire-server";

export interface InMemoryWireClient {
	/** 发送命令并等响应（与 wire-stdio/ws 的 request/response 语义一致）。 */
	sendCommand(command: WireCommand): Promise<{ ok: true; result?: unknown } | { ok: false; error: string }>;
	/** 订阅 push 帧（progress/session_snapshot/server_snapshot/permission_request/host_tool_*）。 */
	onPush(handler: (frame: ServerFrame) => void): () => void;
	/** 当前焦点 agent（TUI 切换 agent 时更新）。 */
	getActiveAgentId(): string;
	setActiveAgentId(id: string): void;
	/** 最近一次 session_snapshot（push 归约缓存；TUI 渲染状态源）。 */
	getSnapshot(): SessionSnapshot | undefined;
	/** 主动拉一次当前焦点快照（装配后调用，避免首帧前读空）。 */
	requestSnapshot(): Promise<void>;
	/** 从 wire core 注销（TUI 退出时）。 */
	dispose(): void;
}

export function createInMemoryWireClient(core: WireCore, options: { agentId?: string } = {}): InMemoryWireClient {
	let activeAgentId = options.agentId ?? "default";
	const pushHandlers = new Set<(frame: ServerFrame) => void>();
	let disposed = false;
	let snapshot: SessionSnapshot | undefined;

	const target: WireCoreTarget = {
		id: "tui-memory",
		getActiveAgentId: () => activeAgentId,
		send: frame => {
			// 快照归约：session_snapshot push 更新缓存（TUI 渲染状态源）
			if (frame.type === "push" && frame.event.type === "session_snapshot") {
				snapshot = (frame.event as { snapshot: SessionSnapshot }).snapshot;
			}
			for (const handler of pushHandlers) {
				try {
					handler(frame);
				} catch {
					// 客户端 handler 异常不中断其他 handler
				}
			}
		},
	};
	const removeTarget = core.addTarget(target);

	const ctx: CommandContext = {
		get activeAgentId() {
			return activeAgentId;
		},
		setActiveAgentId: id => {
			activeAgentId = id;
		},
		hostToolBridges: new Map(),
		sendPush: frame => {
			for (const handler of pushHandlers) handler(frame);
		},
		sendSessionSnapshot: () => core.sendSessionSnapshotTo(target),
		broadcastServerSnapshot: () => core.broadcastServerSnapshot(),
	};

	return {
		sendCommand(command: WireCommand): Promise<{ ok: true; result?: unknown } | { ok: false; error: string }> {
			if (disposed) return Promise.resolve({ ok: false, error: "client disposed" });
			return new Promise(resolve => {
				void core.handleCommand(ctx, command, frame => {
					if (frame.type === "response") {
						if (frame.ok) resolve({ ok: true, result: frame.result });
						else resolve({ ok: false, error: typeof frame.error === "string" ? frame.error : "unknown error" });
					}
				});
			});
		},
		onPush(handler: (frame: ServerFrame) => void): () => void {
			pushHandlers.add(handler);
			return () => pushHandlers.delete(handler);
		},
		getActiveAgentId: () => activeAgentId,
		setActiveAgentId: id => {
			activeAgentId = id;
		},
		getSnapshot: () => snapshot,
		requestSnapshot: async () => {
			await core.handleCommand(ctx, { type: "get_snapshot", sessionId: activeAgentId }, () => {});
		},
		dispose: () => {
			disposed = true;
			removeTarget();
			pushHandlers.clear();
			snapshot = undefined;
		},
	};
}
