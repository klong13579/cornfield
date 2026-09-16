import { describe, expect, test } from "bun:test";
import type { AgentSession, AgentSessionEvent, AgentSessionEventListener } from "../src/session/agent-session";
import { SessionManager } from "../src/session/session-manager";
import { reducePhase } from "../src/session/session-snapshot";
import { SessionStore } from "../src/session/session-store";

// ── reducePhase 纯函数边界 ──

describe("reducePhase", () => {
	test("message_update → streaming", () => {
		expect(reducePhase("idle", "message_update")).toBe("streaming");
	});

	test("tool_execution_start → executing_tool", () => {
		expect(reducePhase("streaming", "tool_execution_start")).toBe("executing_tool");
	});

	test("auto_compaction_start → compacting", () => {
		expect(reducePhase("idle", "auto_compaction_start")).toBe("compacting");
	});

	test("auto_retry_start → retrying", () => {
		expect(reducePhase("streaming", "auto_retry_start")).toBe("retrying");
	});

	test("all end-style events settle to idle (保守原则)", () => {
		for (const type of [
			"message_end",
			"tool_execution_end",
			"auto_compaction_end",
			"auto_retry_end",
			"agent_end",
			"agent_start",
			"turn_end",
			"turn_start",
		]) {
			expect(reducePhase("streaming", type), type).toBe("idle");
		}
	});

	test("unknown/irrelevant events keep current phase", () => {
		expect(reducePhase("compacting", "todo_reminder")).toBe("compacting");
		expect(reducePhase("retrying", "irc_message")).toBe("retrying");
	});
});

// ── SessionStore：最小 AgentSession stub（类型窄化，不手写全接口）──

interface StubSession extends Partial<AgentSession> {
	subscribe(listener: AgentSessionEventListener): () => void;
}

function makeStubSession(overrides: Partial<AgentSession> = {}) {
	const listeners = new Set<AgentSessionEventListener>();
	const session = {
		sessionId: "test-session",
		sessionName: "t",
		sessionFile: "/tmp/s.jsonl",
		// 真 SessionManager（in-memory）：快照里的归属是会话头里那条**记录**，没它就没什么可读的
		// —— 一个没有 sessionManager 的「会话」不是会话，桩不该把它删掉。
		sessionManager: SessionManager.inMemory("/tmp/s.jsonl"),
		model: undefined,
		thinkingLevel: undefined,
		scopedModels: [],
		messages: [],
		todoPhases: [],
		activeToolNames: [],
		queuedMessageCount: 0,
		customCommands: [],
		skills: [],
		isCompacting: false,
		isStreaming: false,
		autoCompactionEnabled: true,
		autoRetryEnabled: true,
		getTodoPhases: () => [],
		getActiveToolNames: () => [],
		getMessageEntryIdMap: () => new Map(),
		subscribe(listener: AgentSessionEventListener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		...overrides,
	} as unknown as StubSession;
	return {
		session,
		emit(event: AgentSessionEvent) {
			for (const l of listeners) l(event);
		},
	};
}

// ── 快照里的会话归属（T25）：只从会话**记录**读，不按 cwd 猜 ──

describe("SessionStore 快照的 projectId", () => {
	/** 挂一个**真** SessionManager（in-memory），这样归属是会话头里的真记录。 */
	function storeFor(manager: SessionManager): SessionStore {
		const { session } = makeStubSession({ sessionManager: manager });
		return SessionStore.attach(session as unknown as AgentSession);
	}

	test("有记录 → 填该 id；没记录 → undefined（不是空串）", async () => {
		const bound = SessionManager.inMemory("/tmp/proj");
		await bound.setResolvedProject({ projectId: "proj-a", source: "session" });
		const boundStore = storeFor(bound);
		expect(boundStore.getSnapshot().projectId).toBe("proj-a");
		boundStore.dispose();

		const unbound = SessionManager.inMemory("/tmp/proj");
		const unboundStore = storeFor(unbound);
		expect(unboundStore.getSnapshot().projectId).toBeUndefined();
		unboundStore.dispose();
	});

	test("记录里是空串也读成 undefined：空串不是归属", () => {
		const manager = SessionManager.inMemory("/tmp/proj");
		const header = manager.getHeader();
		if (!header) throw new Error("expected a session header");
		header.projectId = "";
		// 先确认记录里真的成了空串（否则下面那条断言就没在验东西）
		expect(manager.getHeader()?.projectId).toBe("");

		const store = storeFor(manager);
		expect(store.getSnapshot().projectId).toBeUndefined();
		store.dispose();
	});
});

describe("SessionStore", () => {
	test("attach 初始化 seq=0 且快照字段来自 session getters", () => {
		const { session } = makeStubSession();
		const store = SessionStore.attach(session as unknown as AgentSession);
		const snap = store.getSnapshot();
		expect(snap.seq).toBe(0);
		expect(snap.sessionId).toBe("test-session");
		expect(snap.phase).toBe("idle");
		store.dispose();
	});

	test("每个事件归约 seq+1，phase 随事件迁移", () => {
		const { session, emit } = makeStubSession();
		const store = SessionStore.attach(session as unknown as AgentSession);

		emit({ type: "message_update", message: undefined as never, assistantMessageEvent: undefined as never });
		expect(store.getSnapshot().seq).toBe(1);
		expect(store.getSnapshot().phase).toBe("streaming");

		emit({ type: "auto_compaction_start", reason: "threshold", action: "context-full" });
		expect(store.getSnapshot().seq).toBe(2);
		expect(store.getSnapshot().phase).toBe("compacting");

		store.dispose();
	});

	test("retryAttempt 在 auto_retry_start 置位、auto_retry_end 清零", () => {
		const { session, emit } = makeStubSession();
		const store = SessionStore.attach(session as unknown as AgentSession);

		emit({ type: "auto_retry_start", attempt: 3, maxAttempts: 5, delayMs: 1000, errorMessage: "boom" });
		expect(store.getSnapshot().retryAttempt).toBe(3);
		expect(store.getSnapshot().phase).toBe("retrying");

		emit({ type: "auto_retry_end", success: true, attempt: 3 });
		expect(store.getSnapshot().retryAttempt).toBe(0);

		store.dispose();
	});

	test("subscribe 每次事件收到最新 snapshot；unsubscribe 后不再收到", () => {
		const { session, emit } = makeStubSession();
		const store = SessionStore.attach(session as unknown as AgentSession);
		const seen: number[] = [];
		const unsub = store.subscribe(snap => {
			seen.push(snap.seq);
		});

		emit({ type: "agent_start" });
		emit({ type: "agent_end", messages: [] });
		expect(seen).toEqual([1, 2]);

		unsub();
		emit({ type: "agent_start" });
		expect(seen).toEqual([1, 2]);

		store.dispose();
	});

	test("快照 → 重建 → 再快照 幂等：同一 session 两次 getSnapshot 权威字段一致", () => {
		const messages = [{ role: "user", content: "hi", timestamp: 1 }];
		const { session } = makeStubSession({
			messages: messages as never,
			isStreaming: true,
		});
		const store = SessionStore.attach(session as unknown as AgentSession);
		const a = store.getSnapshot();
		const b = store.getSnapshot();
		expect(a.messages).toBe(b.messages);
		// isStreaming 与 phase 联动：idle 时强制 false（session-store.ts 设计，避免残留 streaming）
		expect(a.isStreaming).toBe(false);
		expect(a.phase).toBe("idle");
		store.dispose();
	});
});
