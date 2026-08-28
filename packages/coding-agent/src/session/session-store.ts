import type { AgentSession, AgentSessionEvent } from "./agent-session";
import { reducePhase, type SessionPhase, type SessionSnapshot } from "./session-snapshot";

export type SnapshotListener = (snapshot: SessionSnapshot, event: AgentSessionEvent) => void;

/**
 * 会话快照层 —— 装饰器模式，零侵入。
 *
 * `attach(session)` 注册进 AgentSession 现有的事件监听（`subscribe()`），
 * 用纯函数归约出「权威快照 + 派生状态」。TUI / gateway 不感知本层存在，
 * 所有现有行为不变。
 *
 * 职责边界：
 * - 快照的静态部分（身份/模型/messages/todo…）在 getSnapshot() 时从
 *   AgentSession 公开 getter 实时读取 —— AgentSession 本身就是权威源，
 *   不做重复复制，避免 compaction/rewind 后的增量同步失配。
 * - 快照的派生部分（seq/phase/retryAttempt）由事件归约维护。
 *
 * 一致性语义：progress 类事件（message_update 等）只触发通知，归约仅影响
 * phase；权威事实以 getSnapshot() 返回值为准。断线重连：先 getSnapshot()
 * 全量重建，再 subscribe 增量。
 */
export class SessionStore {
	readonly #session: AgentSession;
	#seq = 0;
	#phase: SessionPhase = "idle";
	#retryAttempt = 0;
	#listeners = new Set<SnapshotListener>();
	#unsubscribeAgent?: () => void;

	private constructor(session: AgentSession) {
		this.#session = session;
	}

	/** 绑定现有 AgentSession 并开始归约。返回 store；调用方持有并负责释放。 */
	static attach(session: AgentSession): SessionStore {
		const store = new SessionStore(session);
		store.#unsubscribeAgent = session.subscribe(event => store.#onEvent(event));
		return store;
	}

	/** 当前权威快照。任何时刻可安全序列化并发送给远端。 */
	getSnapshot(): SessionSnapshot {
		const session = this.#session;
		return {
			seq: this.#seq,
			sessionId: session.sessionId,
			sessionName: session.sessionName,
			sessionFile: session.sessionFile,
			model: session.model,
			thinkingLevel: session.thinkingLevel,
			scopedModels: session.scopedModels,
			messages: session.messages,
			messageEntryIds: session.getMessageEntryIdMap(),
			todoPhases: session.getTodoPhases(),
			activeToolNames: session.getActiveToolNames(),
			queuedMessageCount: session.queuedMessageCount,
			customCommands: session.customCommands.map(c => ({
				name: c.command.name,
				description: `${c.command.description} (${c.source})`,
				source: c.source,
			})),
			skills: session.skills.map(s => ({
				name: s.name,
				filePath: s.filePath,
				description: s.description,
			})),
			configWarnings: session.configWarnings,
			phase: this.#phase,
			retryAttempt: this.#retryAttempt,
			isCompacting: session.isCompacting,
			// isStreaming 与 phase 联动：phase 归约是事件驱动的权威状态（分布式快照在
			// #promptInFlightCount 递减前会残留 streaming:true），idle 时强制 false，
			// 避免前端发送按钮被末段残留快照锁死在「停止」。
			isStreaming: this.#phase === "idle" ? false : session.isStreaming,
			autoCompactionEnabled: session.autoCompactionEnabled,
			autoRetryEnabled: session.autoRetryEnabled,
		};
	}

	/** 订阅快照变化。progress 事件也会触发通知（供打字机/delta 渲染）。 */
	subscribe(listener: SnapshotListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** 释放对 AgentSession 的订阅。 */
	dispose(): void {
		this.#unsubscribeAgent?.();
		this.#unsubscribeAgent = undefined;
		this.#listeners.clear();
	}

	#onEvent(event: AgentSessionEvent): void {
		this.#seq += 1;
		this.#phase = reducePhase(this.#phase, event.type);
		if (event.type === "auto_retry_start") {
			this.#retryAttempt = event.attempt;
		} else if (event.type === "auto_retry_end") {
			this.#retryAttempt = 0;
		}
		const snapshot = this.getSnapshot();
		for (const listener of this.#listeners) {
			listener(snapshot, event);
		}
	}
}
