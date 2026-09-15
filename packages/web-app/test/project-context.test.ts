import { afterEach, describe, expect, it } from "bun:test";
import type { PiWebSocketCtor, PiWebSocketLike } from "@cornfield/client";
import { projectLabelOf } from "../src/components/ProjectContext";
import { PiClientAdapter, type ServeConnectionConfig } from "../src/state/pi-client-adapter";
import type { SessionView } from "../src/state/session-store";
import { SessionStore } from "../src/state/session-store";

/**
 * T8：Project 上下文的客户端契约（list_projects）。
 *
 * 这条链路唯一的风险是「读不到被显示成没声明」：存储损坏时 serve 回 ok:false，
 * 前端必须落成错误态，而不是一个空列表 —— 那会让用户以为自己的项目消失了。
 */

let lastCreated: FakeWebSocket | undefined;
const createdAdapters: PiClientAdapter[] = [];

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

afterEach(() => {
	for (const adapter of createdAdapters) adapter.disconnect();
	createdAdapters.length = 0;
});

function sentRequests(): Array<{ id: string; command: Record<string, unknown> }> {
	return (lastCreated?.sent ?? [])
		.map(s => JSON.parse(s) as { type?: string; id?: string; command?: Record<string, unknown> })
		.filter(
			(f): f is { id: string; command: Record<string, unknown> } => f.type === "request" && !!f.id && !!f.command,
		);
}

/**
 * 回给**最近一条 list_projects**。
 *
 * 不再是「最近一条请求」：同一个生命周期点（连接就绪 / 快照到达 / 切 Agent）现在还会有
 * 另一条 registry 读（T10A 的 list_agent_todos），回给「最后一条」就会把 Project 的结果
 * 投到别处，让这些用例在断言没变的情况下“失败”。这里定向到被测的那一条命令。
 */
function respond(result: unknown): void {
	respondTo(lastProjectRequestId(), result);
}

function respondError(error: string): void {
	respondErrorTo(lastProjectRequestId(), error);
}

/**
 * 最近一条请求的 id（不挑命令）。
 *
 * `respond` / `respondError` 一律定向到 list_projects：同一个生命周期点（连接就绪 / 快照
 * 到达 / 切 Agent）还会有别的 registry 读（T10A 的 list_agent_todos），回给「最后一条」就
 * 会把 Project 的结果投到别处。回**别的**命令时用这个显式取最后一条。
 */
function lastRequestId(): string {
	const reqs = sentRequests();
	const last = reqs.at(-1);
	if (!last) throw new Error("no request was sent");
	return last.id;
}

async function createConnectedStore(): Promise<{ store: SessionStore; adapter: PiClientAdapter }> {
	lastCreated = undefined;
	const adapter = new PiClientAdapter(config, fakeCtor);
	createdAdapters.push(adapter);
	const store = new SessionStore();
	store.init(adapter);
	const connectPromise = store.connect();
	lastCreated?.onopen?.({});
	lastCreated?.receive(JSON.stringify({ type: "hello_ack", connectionId: "c1", protocolVersion: 1 }));
	await connectPromise;
	return { store, adapter };
}

/** 推一份权威快照（切 Agent / 开新会话后 serve 必推一份）。 */
function pushSnapshot(agentId: string, sessionFile: string): void {
	lastCreated?.receive(
		JSON.stringify({
			type: "push",
			event: {
				type: "session_snapshot",
				sessionId: agentId,
				snapshot: {
					seq: 1,
					phase: "idle",
					retryAttempt: 0,
					isCompacting: false,
					isStreaming: false,
					sessionId: agentId,
					sessionFile,
					messages: [],
					messageEntryIds: {},
					todoPhases: [],
					activeToolNames: [],
					queuedMessageCount: 0,
					autoCompactionEnabled: false,
					autoRetryEnabled: false,
				},
			},
		}),
	);
}

/** 已发出的 list_projects 请求（id + command）。 */
function projectRequests(): Array<Record<string, unknown>> {
	return sentRequests()
		.map(r => r.command)
		.filter(c => c.type === "list_projects");
}

/** 最后一条 list_projects 请求帧（用它定向回包）。 */
function lastProjectRequestId(): string {
	const frames = sentRequests().filter(r => r.command.type === "list_projects");
	const last = frames.at(-1);
	if (!last) throw new Error("no list_projects request was sent");
	return last.id;
}

/** 定向回一个成功响应（可以晚于后来的请求，用来复现乱序）。 */
function respondTo(id: string, result: unknown): void {
	lastCreated?.receive(JSON.stringify({ type: "response", id, ok: true, result }));
}

/** 定向回一个失败响应。 */
function respondErrorTo(id: string, error: string): void {
	lastCreated?.receive(JSON.stringify({ type: "response", id, ok: false, error }));
}

const PROJECTS = [
	{ projectId: "cornfield", root: "/Users/me/cornfield", name: "CornField" },
	{ projectId: "dtc", root: "/Users/me/dtc", name: "米克原子 DTC", defaultAgentId: "hr" },
];

describe("store.refreshProjects", () => {
	it("list_projects 定向当前 Agent，结果落进 view（含会话归属）", async () => {
		const { store } = await createConnectedStore();
		const pending = store.refreshProjects("hr");

		expect(sentRequests().at(-1)?.command).toMatchObject({ type: "list_projects", sessionId: "hr" });

		respond({ projects: PROJECTS, currentProjectId: "dtc" });
		await pending;

		const view = store.getSnapshot();
		expect(view.projects?.map(p => p.projectId)).toEqual(["cornfield", "dtc"]);
		expect(view.currentProjectId).toBe("dtc");
		expect(view.projectsError).toBeUndefined();
	});

	it("空列表是明确事实，不是错误", async () => {
		const { store } = await createConnectedStore();
		const pending = store.refreshProjects("hr");
		respond({ projects: [] });
		await pending;

		expect(store.getSnapshot().projects).toEqual([]);
		expect(store.getSnapshot().projectsError).toBeUndefined();
	});

	it("读取失败落成错误态，不伪装成空列表", async () => {
		const { store } = await createConnectedStore();
		const pending = store.refreshProjects("hr");
		respondError("list_projects failed: Project store at ... is not valid JSON");
		await pending;

		const view = store.getSnapshot();
		expect(view.projectsError).toContain("not valid JSON");
		expect(view.projects).toBeUndefined();
	});

	it("切 Agent 只清归属，不清 registry（Project 是客户端 scope，跨 Agent 共享）", async () => {
		const { store } = await createConnectedStore();
		const pending = store.refreshProjects("hr");
		respond({ projects: PROJECTS, currentProjectId: "dtc" });
		await pending;
		expect(store.getSnapshot().currentProjectId).toBe("dtc");

		store.switchSession("sw");

		const view = store.getSnapshot();
		expect(view.currentProjectId).toBeUndefined();
		expect(view.projects?.map(p => p.projectId)).toEqual(["cornfield", "dtc"]);
	});
});

describe("会话切换后的归属重算（P1 回归）", () => {
	it("切到已绑定 Project 的会话：归属自动跟上，不需要手动刷新", async () => {
		const { store } = await createConnectedStore();

		// 初始会话（serve 焦点的 default）
		pushSnapshot("default", "/sessions/default.jsonl");
		await Bun.sleep(0);
		respond({ projects: PROJECTS, currentProjectId: "cornfield" });
		await Bun.sleep(0);
		expect(store.getSnapshot().currentProjectId).toBe("cornfield");

		// 切到 hr：serve 会推 hr 的权威快照，归属必须重算
		store.switchSession("hr");
		const before = projectRequests().length;
		pushSnapshot("hr", "/sessions/hr.jsonl");
		await Bun.sleep(0);

		// 窗口期：上一个会话的归属已作废，但现在还不知道新的 —— 必须是「未算出」，不是「未归属」
		const during = store.getSnapshot();
		expect(during.currentProjectId).toBeUndefined();
		expect(during.projectsPending).toBe(true);
		// 列表本身不随会话变，仍然缓存着（只重算归属，不重读 registry 的形状）
		expect(during.projects?.map(p => p.projectId)).toEqual(["cornfield", "dtc"]);
		// 换会话必须自己发起重算，且指名新的 Agent —— 这正是 P1：只清不请求会停在「未归属」
		expect(projectRequests().length).toBe(before + 1);
		expect(projectRequests().at(-1)).toMatchObject({ type: "list_projects", sessionId: "hr" });

		respond({ projects: PROJECTS, currentProjectId: "dtc" });
		await Bun.sleep(0);

		const after = store.getSnapshot();
		expect(after.currentProjectId).toBe("dtc");
		expect(after.projectsPending).toBe(false);
	});

	it("切到未绑定 Project 的会话：归属为空，且不残留上一个会话的项目", async () => {
		const { store } = await createConnectedStore();

		pushSnapshot("default", "/sessions/default.jsonl");
		await Bun.sleep(0);
		respond({ projects: PROJECTS, currentProjectId: "cornfield" });
		await Bun.sleep(0);
		expect(store.getSnapshot().currentProjectId).toBe("cornfield");

		store.switchSession("sw");
		pushSnapshot("sw", "/sessions/sw.jsonl");
		await Bun.sleep(0);
		// serve 没算出归属（会话不在任何已声明 Project 里）
		respond({ projects: PROJECTS });
		await Bun.sleep(0);

		const view = store.getSnapshot();
		expect(view.currentProjectId).toBeUndefined();
		expect(view.projectsPending).toBe(false);
		expect(view.projects?.map(p => p.projectId)).toEqual(["cornfield", "dtc"]);
	});

	it("同一会话的重复快照不重复请求 registry", async () => {
		const { store } = await createConnectedStore();

		pushSnapshot("default", "/sessions/default.jsonl");
		await Bun.sleep(0);
		respond({ projects: PROJECTS, currentProjectId: "cornfield" });
		await Bun.sleep(0);

		pushSnapshot("default", "/sessions/default.jsonl");
		const before = projectRequests().length;
		pushSnapshot("default", "/sessions/default.jsonl");
		pushSnapshot("default", "/sessions/default.jsonl");
		await Bun.sleep(0);

		expect(projectRequests().length).toBe(before);
		expect(store.getSnapshot().currentProjectId).toBe("cornfield");
	});
});

describe("迟到响应不得覆盖当前会话的归属（P1 回归）", () => {
	it("A 慢→切 B→B 先返回→A 后返回：A 的那份整份丢掉", async () => {
		const { store } = await createConnectedStore();

		// 会话 A：发请求，先不回包
		pushSnapshot("default", "/sessions/a.jsonl");
		await Bun.sleep(0);
		const requestA = lastProjectRequestId();

		// 切到会话 B
		store.switchSession("hr");
		pushSnapshot("hr", "/sessions/b.jsonl");
		await Bun.sleep(0);
		const requestB = lastProjectRequestId();
		expect(requestB).not.toBe(requestA);

		// B 先回来：落地
		respondTo(requestB, { projects: PROJECTS, currentProjectId: "dtc" });
		await Bun.sleep(0);
		expect(store.getSnapshot().currentProjectId).toBe("dtc");
		expect(store.getSnapshot().projectsPending).toBe(false);

		// A 后回来（携带着 A 的归属）：不得改动任何一项
		respondTo(requestA, { projects: PROJECTS, currentProjectId: "cornfield" });
		await Bun.sleep(0);

		const view = store.getSnapshot();
		expect(view.currentProjectId).toBe("dtc");
		expect(view.projectsPending).toBe(false);
		expect(view.projectsError).toBeUndefined();
	});

	it("切换后、新快照到达前旧响应就到了：同样丢掉（不能提交进已切走的视图）", async () => {
		const { store } = await createConnectedStore();

		// 会话 A：发请求，挂着不回
		pushSnapshot("default", "/sessions/a.jsonl");
		await Bun.sleep(0);
		const requestA = lastProjectRequestId();
		expect(store.getSnapshot().projectsPending).toBe(true);

		// 切到 B —— 此时 B 的权威快照**还没到**（身份尚未落定）
		store.switchSession("hr");
		await Bun.sleep(0);

		// A 的响应现在才回来：它的代际已经作废，不得写入任何一项
		respondTo(requestA, { projects: PROJECTS, currentProjectId: "cornfield" });
		await Bun.sleep(0);

		const during = store.getSnapshot();
		expect(during.currentProjectId).toBeUndefined();
		expect(during.projects).toBeUndefined();
		expect(during.projectsPending).toBe(true);
		expect(during.projectsError).toBeUndefined();

		// B 的快照到达后才重算并落地
		pushSnapshot("hr", "/sessions/b.jsonl");
		await Bun.sleep(0);
		respond({ projects: PROJECTS, currentProjectId: "dtc" });
		await Bun.sleep(0);
		expect(store.getSnapshot().currentProjectId).toBe("dtc");
	});

	it("同一个 Agent 下换会话（打开另一个历史会话）：旧响应同样落不了地", async () => {
		const { store } = await createConnectedStore();

		// hr 的活跃会话：归属落地为 cornfield
		pushSnapshot("hr", "/sessions/hr-live.jsonl");
		await Bun.sleep(0);
		respond({ projects: PROJECTS, currentProjectId: "cornfield" });
		await Bun.sleep(0);
		expect(store.getSnapshot().currentProjectId).toBe("cornfield");

		// 制造一个在途请求（它会带着当前代际）
		const inFlight = store.refreshProjects("hr");
		await Bun.sleep(0);
		const staleRequest = lastProjectRequestId();

		// 同一个 Agent、另一个会话：agentId 没变，只有会话文件变了
		const opening = store.openHistorySession({
			id: "history-1",
			agent: "hr",
			sessionFile: "/sessions/hr-history.jsonl",
		});
		await Bun.sleep(0);
		respondTo(lastRequestId(), {}); // switch_session 回包，让 #setActiveAgent 真的跑到
		await Bun.sleep(0);

		// 旧会话的响应现在才回来：它的代际已作废，不得写入
		respondTo(staleRequest, { projects: PROJECTS, currentProjectId: "cornfield" });
		await Bun.sleep(0);

		const view = store.getSnapshot();
		expect(view.currentProjectId).toBeUndefined();
		expect(view.projectsPending).toBe(true);
		expect(view.projectsError).toBeUndefined();

		void opening;
		void inFlight;
	});

	it("新会话：旧响应在新会话快照到达前也落不了地", async () => {
		const { store } = await createConnectedStore();

		pushSnapshot("hr", "/sessions/hr-live.jsonl");
		await Bun.sleep(0);
		respond({ projects: PROJECTS, currentProjectId: "cornfield" });
		await Bun.sleep(0);
		expect(store.getSnapshot().currentProjectId).toBe("cornfield");

		// 在途请求
		const inFlight = store.refreshProjects("hr");
		await Bun.sleep(0);
		const staleRequest = lastProjectRequestId();

		// 开新会话：身份必然变（新文件还不知道），旧响应必须作废
		store.newSession();
		await Bun.sleep(0);
		respondTo(staleRequest, { projects: PROJECTS, currentProjectId: "cornfield" });
		await Bun.sleep(0);

		const during = store.getSnapshot();
		expect(during.currentProjectId).toBeUndefined();
		expect(during.projectsPending).toBe(true);
		expect(during.projectsError).toBeUndefined();

		// 新会话的快照到达后才重算
		pushSnapshot("hr", "/sessions/hr-new.jsonl");
		await Bun.sleep(0);
		respond({ projects: PROJECTS, currentProjectId: "dtc" });
		await Bun.sleep(0);
		expect(store.getSnapshot().currentProjectId).toBe("dtc");
		void inFlight;
	});

	it("A 的迟到**错误**也不会把 B 打成错误态", async () => {
		const { store } = await createConnectedStore();

		pushSnapshot("default", "/sessions/a.jsonl");
		await Bun.sleep(0);
		const requestA = lastProjectRequestId();

		store.switchSession("hr");
		pushSnapshot("hr", "/sessions/b.jsonl");
		await Bun.sleep(0);
		const requestB = lastProjectRequestId();

		respondTo(requestB, { projects: PROJECTS, currentProjectId: "dtc" });
		await Bun.sleep(0);
		respondErrorTo(requestA, "list_projects failed: A 的存储坏了");
		await Bun.sleep(0);

		const view = store.getSnapshot();
		expect(view.projectsError).toBeUndefined();
		expect(view.currentProjectId).toBe("dtc");
		expect(view.projects?.map(p => p.projectId)).toEqual(["cornfield", "dtc"]);
	});

	it("上一个会话的错误不残留：切换 / newSession 后的 pending 期间显示「读取中」", async () => {
		const { store } = await createConnectedStore();

		// hr：归属请求失败
		pushSnapshot("hr", "/sessions/hr-live.jsonl");
		await Bun.sleep(0);
		respondError("list_projects failed: Project store at ... is not valid JSON");
		await Bun.sleep(0);
		expect(store.getSnapshot().projectsError).toContain("not valid JSON");

		// 切走：旧错误与归属一起作废，窗口期是「还不知道」，不是「读不出来」
		store.switchSession("sw");
		await Bun.sleep(0);
		const duringSwitch = store.getSnapshot();
		expect(duringSwitch.projectsError).toBeUndefined();
		expect(duringSwitch.projectsPending).toBe(true);
		expect(projectLabelOf(duringSwitch).label).toBe("…");

		// sw 也失败（存储还是坏的），然后开新会话
		pushSnapshot("sw", "/sessions/sw.jsonl");
		await Bun.sleep(0);
		respondError("list_projects failed: Project store at ... is not valid JSON");
		await Bun.sleep(0);
		expect(store.getSnapshot().projectsError).toBeDefined();

		store.newSession();
		await Bun.sleep(0);
		const duringNew = store.getSnapshot();
		expect(duringNew.projectsError).toBeUndefined();
		expect(duringNew.projectsPending).toBe(true);
		expect(projectLabelOf(duringNew).label).toBe("…");
	});
});

describe("projectLabelOf", () => {
	function viewOf(patch: Partial<SessionView>): SessionView {
		return {
			connected: true,
			reconnecting: false,
			wsUrl: "ws://127.0.0.1:1/ws",
			protocolVersion: 1,
			phase: "idle",
			model: null,
			thinkingLevel: null,
			sessionId: "",
			messages: [],
			messageEntryIds: {},
			isStreaming: false,
			activeToolNames: [],
			queued: 0,
			todo: [],
			flags: { autoCompaction: false, autoRetry: false },
			agents: [],
			env: null,
			historyLoading: false,
			sessionTreeLoading: false,
			...patch,
		};
	}

	it("读不到 → 读取失败（不说「未声明」）", () => {
		const label = projectLabelOf(viewOf({ projectsError: "not valid JSON" }));
		expect(label.label).toBe("读取失败");
		expect(label.title).toContain("not valid JSON");
	});

	it("还没查 → 读取中", () => {
		expect(projectLabelOf(viewOf({})).label).toBe("…");
	});

	it("查到空列表 → 未声明", () => {
		expect(projectLabelOf(viewOf({ projects: [] })).label).toBe("未声明");
	});

	it("有归属 → 显示那个 Project 的名字", () => {
		const label = projectLabelOf(viewOf({ projects: PROJECTS, currentProjectId: "dtc" }));
		expect(label.label).toBe("米克原子 DTC");
		expect(label.title).toContain("/Users/me/dtc");
	});

	it("声明了但会话不在其中 → 未归属（不拿第一个凑数）", () => {
		const label = projectLabelOf(viewOf({ projects: PROJECTS }));
		expect(label.label).toBe("未归属");
		expect(label.title).toContain("2 个");
	});
});
