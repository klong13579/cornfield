import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { PiWebSocketCtor, PiWebSocketLike } from "@cornfield/client";
import { WORKING_PROJECT_KEY } from "../src/lib/working-project";
import { activeAgentIdOf } from "../src/state/agent-context";
import { PiClientAdapter, type ServeConnectionConfig } from "../src/state/pi-client-adapter";
import { SessionStore } from "../src/state/session-store";

/**
 * 「新建会话建在哪个 Agent 上」的契约（顶栏表单、侧栏直建钮共用同一条路径）。
 *
 * 要钉住的那次竞态：serve 逐帧并发处理命令（wire-server.ts `void core.handleCommand(...)`），
 * `switch_session` 在改 `ctx.activeAgentId` 之前要 `await registry.attach`；而 `new_session`
 * 不带 `sessionId` 时按**处理那一刻**的 `ctx.activeAgentId` 定目标。于是「先切 Agent、紧接着新建」
 * 的两帧可能倒过来：新会话建在**旧** Agent 上，而客户端已经在显示新焦点。
 *
 * 下面的假 serve 复现那一刻（`switch_session` 的焦点要等一个 tick 才改），并像真 serve 一样
 * 按 `command.sessionId ?? activeAgent` 决定新会话落在谁身上、再推一份带**落地 Agent** 的
 * `session_snapshot`。断言只认 serve 侧的事实（`createdOn` / 推来的快照 / `renames`），不认客户端本地读数。
 */

let lastCreated: FakeServe | undefined;
const createdAdapters: PiClientAdapter[] = [];

class FakeServe implements PiWebSocketLike {
	readyState = 1;
	readonly sent: string[] = [];
	onopen: PiWebSocketLike["onopen"] = null;
	onmessage: PiWebSocketLike["onmessage"] = null;
	onclose: PiWebSocketLike["onclose"] = null;
	onerror: PiWebSocketLike["onerror"] = null;

	/** 注册表里已有的 agent（serve 的 meta）。 */
	readonly known = new Set(["default", "hr"]);
	/** 已 attach 的会话（boot 时 default 已 attach）。 */
	readonly attached = new Set(["default"]);
	/** 连接焦点（serve 的 conn.activeAgentId）。 */
	activeAgent = "default";
	/** 每条 new_session 到达时的「那一刻的连接焦点 + 命令带的目标」。 */
	readonly arrivals: Array<{ activeAgent: string; sessionId: string | undefined }> = [];
	/** 每条 `new_session` 到达时带的 Project（未声明归属时不带这个字段）。 */
	readonly projectArrivals: Array<string | undefined> = [];
	/** 已声明的 Project（serve 的注册表）；未声明过的 id 会被拒（ok:false）。 */
	readonly projects = new Set<string>();
	/** 真正建了会话的 Agent（serve 侧事实）。 */
	readonly createdOn: string[] = [];
	/** 推出去的 session_snapshot 帧上的 Agent（serve 对「本连接焦点是谁」的权威说法）。 */
	readonly pushedAgents: string[] = [];
	/**
	 * 每条 `set_session_name` 到达时的原文 + serve 侧的解析结果。
	 *
	 * `agent` 是 serve `resolveTarget` 的判断（没带 sessionId 就取**那一刻**的连接焦点），
	 * `sessionFile` 是那一刻该 Agent 的**当前**会话 —— 改名落在谁身上由它决定，
	 * 所以「改到了**上一个**会话」这件事是可判定的，不用看客户端本地读数。
	 */
	readonly renames: Array<{
		name: string | undefined;
		agent: string;
		focusAtArrival: string;
		sessionFile: string | undefined;
	}> = [];
	/** 各 Agent 当前的会话文件（session 级命令落在它上面；boot 时 default 已有一个）。 */
	readonly sessions = new Map<string, string>([["default", "/sessions/default.jsonl"]]);
	/** 下一条 `new_session` 的结局：true = serve 回 `cancelled:true`（接了命令但没建，见 wire-server）。 */
	cancelNextCreate = false;
	/**
	 * `list_projects` 的名单。`undefined` = 照旧回一个空 result（模拟「还没读到名单」）；
	 * 非 undefined = 真回一份名单：`SessionStore` 据此校验恢复出来的工作上下文，并用
	 * `defaultAgentId` 算「这个 Agent 的默认 Project」（§10 第 2 级）。
	 */
	declaredProjects: Array<{ projectId: string; defaultAgentId?: string }> | undefined = undefined;
	/** 让 `list_projects` 报错（存储损坏）—— 用来钉「读失败不校验」。 */
	listProjectsError: string | undefined = undefined;
	#seq = 0;

	constructor(_url: string) {
		lastCreated = this;
	}

	send(data: string): void {
		this.sent.push(data);
		const frame = JSON.parse(data) as { type?: string; id?: string; command?: ServeCommand };
		if (frame.type !== "request" || !frame.id || !frame.command) return;
		this.#handle(frame.id, frame.command);
	}

	close(): void {}

	receive(data: string): void {
		this.onmessage?.({ data });
	}

	#handle(id: string, command: ServeCommand): void {
		const sessionId = command.sessionId;
		switch (command.type) {
			case "attach": {
				if (sessionId === undefined || !this.known.has(sessionId)) {
					return this.#fail(id, `unknown agent: ${sessionId}`);
				}
				this.attached.add(sessionId);
				// attach 打开的是该 Agent 已有的会话；已经有就不覆盖（重 attach 不会换会话）
				if (!this.sessions.has(sessionId)) this.sessions.set(sessionId, `/sessions/${sessionId}.jsonl`);
				return this.#ok(id, { sessionId, sessionFile: `/sessions/${sessionId}.jsonl` });
			}
			case "switch_session": {
				// serve：先 `await registry.attach` 再 `ctx.setActiveAgentId` —— 焦点不是这帧一进来就变的
				if (sessionId === undefined || !this.known.has(sessionId)) {
					return this.#fail(id, `unknown agent: ${sessionId}`);
				}
				const target = sessionId;
				setTimeout(() => {
					this.attached.add(target);
					this.activeAgent = target;
					this.#push(target, `/sessions/${target}.jsonl`);
					this.#ok(id, { sessionId: target });
				}, 1);
				return;
			}
			case "new_session": {
				this.arrivals.push({ activeAgent: this.activeAgent, sessionId });
				this.projectArrivals.push(command.projectId);
				// serve：没带 sessionId 就按这一刻的焦点定目标（这正是会建错的那条路）
				const landing = sessionId ?? this.activeAgent;
				if (!this.attached.has(landing)) {
					return this.#fail(id, `agent not attached: ${landing} (send attach first)`);
				}
				// serve：未声明的 projectId 直接 ok:false（不静默落回启动根），错误原文就是这个
				if (command.projectId !== undefined && !this.projects.has(command.projectId)) {
					return this.#fail(id, `no Project declared with projectId "${command.projectId}"; nothing was created.`);
				}
				// serve：`sessionDone({ cancelled: !success })` —— 命令受理了但这次没建（上一个会话还在）
				if (this.cancelNextCreate) {
					this.cancelNextCreate = false;
					return this.#ok(id, { cancelled: true });
				}
				this.createdOn.push(landing);
				const sessionFile = `/sessions/${landing}-${++this.#seq}.jsonl`;
				this.sessions.set(landing, sessionFile);
				this.#ok(id, { cancelled: false });
				this.#push(landing, sessionFile);
				return;
			}
			case "set_session_name": {
				// serve：`resolveTarget(command)` —— 没带 sessionId 就取本连接**当刻**的焦点；
				// 改名落在该 Agent 当刻那个会话上，所以「改到了上一个会话」在这里是可判定的
				const agent = sessionId ?? this.activeAgent;
				this.renames.push({
					name: command.name,
					agent,
					focusAtArrival: this.activeAgent,
					sessionFile: this.sessions.get(agent),
				});
				const name = command.name?.trim();
				if (!name) return this.#fail(id, "Session name cannot be empty");
				if (!this.attached.has(agent)) {
					return this.#fail(id, `agent not attached: ${agent} (send attach first)`);
				}
				return this.#ok(id, {});
			}
			case "list_projects": {
				// serve 的读面：名单与「当前会话归属」同一条命令。这里只回名单（归属与本文件无关）。
				if (this.listProjectsError !== undefined) return this.#fail(id, this.listProjectsError);
				if (this.declaredProjects === undefined) return this.#ok(id, {});
				return this.#ok(id, {
					projects: this.declaredProjects.map(project => ({
						projectId: project.projectId,
						name: project.projectId,
						root: `/repos/${project.projectId}`,
						...(project.defaultAgentId === undefined ? {} : { defaultAgentId: project.defaultAgentId }),
					})),
				});
			}
			default:
				return this.#ok(id, {});
		}
	}

	/** serve 的 `registry.detach`：这个 Agent 的会话没了（agent 进程退出 / 另一条连接 detach）。 */
	detach(agentId: string): void {
		this.attached.delete(agentId);
		this.sessions.delete(agentId);
	}

	/** serve 的 agent 列表推送（本连接焦点标 active）。 */
	pushAgents(sessions: Array<{ id: string; active?: boolean }>): void {
		this.receive(
			JSON.stringify({
				type: "push",
				event: {
					type: "server_snapshot",
					sessions: sessions.map((s, index) => ({
						id: s.id,
						active: s.active ?? index === 0,
						attached: this.attached.has(s.id),
					})),
				},
			}),
		);
	}

	#ok(id: string, result: unknown): void {
		this.receive(JSON.stringify({ type: "response", id, ok: true, result }));
	}

	#fail(id: string, error: string): void {
		this.receive(JSON.stringify({ type: "response", id, ok: false, error }));
	}

	/** 推一份权威快照：帧上的 `sessionId` 是**落地 Agent**（serve 的约定），快照里的是会话自己的 id。 */
	#push(agentId: string, sessionFile: string): void {
		this.pushedAgents.push(agentId);
		this.receive(
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
						sessionId: `${agentId}-sess`,
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
}

interface ServeCommand {
	type?: string;
	sessionId?: string;
	name?: string;
	projectId?: string;
}

/** 相关请求帧的 `command` 原文（断言「命令里到底带了什么」）。 */
function creationCommands(serve: FakeServe): Array<Record<string, unknown>> {
	const interesting = new Set(["attach", "switch_session", "new_session", "set_session_name"]);
	return serve.sent
		.map(line => JSON.parse(line) as { type?: string; command?: Record<string, unknown> })
		.filter(f => f.type === "request" && interesting.has(String(f.command?.type)))
		.map(f => f.command ?? {});
}

const fakeCtor: PiWebSocketCtor = FakeServe;
const config: ServeConnectionConfig = { wsUrl: "ws://127.0.0.1:1/ws", token: "" };

afterEach(() => {
	for (const adapter of createdAdapters) adapter.disconnect();
	createdAdapters.length = 0;
	lastCreated = undefined;
});

/** 连接就绪的 store + 假 serve（注册表已推：default 是本连接焦点 —— 与真 serve 的连接顺序一致）。 */
async function createConnectedStore(): Promise<{ store: SessionStore; serve: FakeServe }> {
	lastCreated = undefined;
	const adapter = new PiClientAdapter(config, fakeCtor);
	createdAdapters.push(adapter);
	const store = new SessionStore();
	store.init(adapter);
	const connectPromise = store.connect();
	lastCreated?.onopen?.({});
	lastCreated?.receive(JSON.stringify({ type: "hello_ack", connectionId: "c1", protocolVersion: 1 }));
	await connectPromise;
	const serve = lastCreated;
	if (!serve) throw new Error("没有建立假 serve 连接");
	serve.pushAgents([{ id: "default", active: true }, { id: "hr" }]);
	return { store, serve };
}

/** 与「新建会话」相关的请求帧类型（其余是注册表/归属那几路读命令，不属于本条契约）。 */
function creationFrames(serve: FakeServe): string[] {
	const interesting = new Set(["attach", "switch_session", "new_session", "set_session_name"]);
	return serve.sent
		.map(line => JSON.parse(line) as { type?: string; command?: { type?: string } })
		.filter(f => f.type === "request" && interesting.has(String(f.command?.type)))
		.map(f => String(f.command?.type));
}

describe("新建会话选另一个 Agent：先等 serve 确认，再带显式目标建", () => {
	it("换 Agent 新建：new_session 到达时连接焦点已是目标，且命令带显式目标", async () => {
		const { store, serve } = await createConnectedStore();
		expect(store.getSnapshot().activeAgentId).toBeUndefined();

		const outcome = await store.newSession({ agentId: "hr" });

		expect(outcome).toEqual({ kind: "created", notApplied: [] });
		// serve 侧事实：新会话**真的建在 hr 上**，而不是按客户端显示的那个焦点碰运气
		expect(serve.createdOn).toEqual(["hr"]);
		// 竞态判据：new_session 到达那一刻，连接焦点已经切到 hr（切换是被 await 过的），
		// 且命令自己带了 sessionId —— 就算焦点旧了也跑不到别的 Agent 上
		expect(serve.arrivals).toEqual([{ activeAgent: "hr", sessionId: "hr" }]);
		expect(creationFrames(serve)).toEqual(["attach", "switch_session", "new_session"]);

		// 客户端报的 Agent 与 serve 推来的快照（就是那个新会话）属于同一个 Agent
		const view = store.getSnapshot();
		expect(serve.pushedAgents.at(-1)).toBe("hr");
		expect(view.activeAgentId).toBe(serve.pushedAgents.at(-1));
		expect(view.sessionFile).toBe("/sessions/hr-1.jsonl");
	});

	it("目标 Agent 不存在：把 serve 的原文给出来、一个会话都不建、焦点读数退回", async () => {
		const { store, serve } = await createConnectedStore();

		const outcome = await store.newSession({ agentId: "ghost" });

		expect(outcome.kind).toBe("not-created");
		expect(outcome.kind === "not-created" ? outcome.error : "").toContain("unknown agent: ghost");
		// 没建：new_session 一个字节都没发出去
		expect(creationFrames(serve)).toEqual(["attach"]);
		expect(serve.createdOn).toEqual([]);
		// 用户看得见 serve 的原文（唯一可见的错误面）
		expect(store.getSnapshot().commandError).toContain("unknown agent: ghost");
		// 焦点读数没有停在失败目标上：屏幕上报的仍是**真的**那个 Agent（注册表说 default）
		expect(store.getSnapshot().activeAgentId).toBeUndefined();
		expect(activeAgentIdOf(store.getSnapshot())).toBe("default");
	});

	it("默认路径（当前焦点 Agent）：不多切一次，但命令照样带显式目标", async () => {
		const { store, serve } = await createConnectedStore();

		const outcome = await store.newSession();

		expect(outcome).toEqual({ kind: "created", notApplied: [] });
		expect(serve.createdOn).toEqual(["default"]);
		expect(serve.arrivals).toEqual([{ activeAgent: "default", sessionId: "default" }]);
		// 焦点已经是它：不再 attach / switch（默认路径的表现与以前一致）
		expect(creationFrames(serve)).toEqual(["new_session"]);
		expect(store.getSnapshot().activeAgentId).toBeUndefined();
		expect(store.getSnapshot().sessionFile).toBe("/sessions/default-1.jsonl");
	});

	it("两次快速提交：第二次被挡下，只建出一个会话", async () => {
		const { store, serve } = await createConnectedStore();

		const first = store.newSession({ agentId: "hr" });
		const second = store.newSession({ agentId: "hr" });

		const duplicate = await second;
		expect(duplicate.kind).toBe("not-created");
		expect(duplicate.kind === "not-created" ? duplicate.error : "").toContain("重复提交");
		expect(await first).toEqual({ kind: "created", notApplied: [] });
		expect(serve.createdOn).toEqual(["hr"]);
		expect(creationFrames(serve).filter(t => t === "new_session")).toHaveLength(1);
	});

	it("焦点读不出来（注册表还没到）：明说无从确定，不发命令", async () => {
		lastCreated = undefined;
		const adapter = new PiClientAdapter(config, fakeCtor);
		createdAdapters.push(adapter);
		const store = new SessionStore();
		store.init(adapter);
		const connectPromise = store.connect();
		lastCreated?.onopen?.({});
		lastCreated?.receive(JSON.stringify({ type: "hello_ack", connectionId: "c1", protocolVersion: 1 }));
		await connectPromise;
		const serve = lastCreated;
		if (!serve) throw new Error("没有建立假 serve 连接");

		const outcome = await store.newSession();

		expect(outcome.kind).toBe("not-created");
		expect(outcome.kind === "not-created" ? outcome.error : "").toContain("无从确定");
		expect(creationFrames(serve)).toEqual([]);
		expect(serve.createdOn).toEqual([]);
	});
});

describe("新建会话的标题：真的建出来之后才发改名，改的是**这次**的会话", () => {
	it("带标题新建：命令顺序是 attach → switch_session → new_session → set_session_name，改名带的是表单里的标题", async () => {
		const { store, serve } = await createConnectedStore();

		const outcome = await store.newSession({ agentId: "hr", title: "季度复盘" });

		expect(outcome).toEqual({ kind: "created", notApplied: [] });
		// serve 侧事实一：改名这一帧是**创建回执之后**才到的，没跑到创建前面去
		expect(creationFrames(serve)).toEqual(["attach", "switch_session", "new_session", "set_session_name"]);
		// serve 侧事实二：只建了一个会话，改名落在它身上（hr-1 = 这一次新建出来的那个）
		expect(serve.createdOn).toEqual(["hr"]);
		expect(serve.renames).toEqual([
			{ name: "季度复盘", agent: "hr", focusAtArrival: "hr", sessionFile: "/sessions/hr-1.jsonl" },
		]);
	});

	it("第二个会话带标题：改名落在**这一次**的新会话上，上一个会话的名字不许动", async () => {
		const { store, serve } = await createConnectedStore();

		await store.newSession({ agentId: "hr" }); // 上一个会话：/sessions/hr-1.jsonl
		expect(serve.renames).toEqual([]);

		const outcome = await store.newSession({ agentId: "hr", title: "季度复盘" });

		expect(outcome).toEqual({ kind: "created", notApplied: [] });
		expect(serve.createdOn).toEqual(["hr", "hr"]);
		// 改名那一刻 hr 当刻的会话已经是**第二个**（hr-2）——改的不是上一个（hr-1）
		expect(serve.renames).toEqual([
			{ name: "季度复盘", agent: "hr", focusAtArrival: "hr", sessionFile: "/sessions/hr-2.jsonl" },
		]);
	});

	it("serve 回了 cancelled（命令受理了但这次没建）：一个改名帧都不发 —— 上一个会话不许被改名", async () => {
		const { store, serve } = await createConnectedStore();
		// 焦点上本来就有会话（这就是「上一个会话」：改名不带 sessionId 就会落到它头上）
		expect(serve.sessions.get("default")).toBe("/sessions/default.jsonl");
		serve.cancelNextCreate = true;

		const outcome = await store.newSession({ title: "季度复盘" });

		expect(outcome.kind).toBe("not-created");
		// serve 侧事实：这次没有会话被建出来，也没有任何 set_session_name 到达
		expect(serve.createdOn).toEqual([]);
		expect(creationFrames(serve)).toEqual(["new_session"]);
		expect(serve.renames).toEqual([]);
	});
});

describe("标题的边界：没给 / 空串 / 创建被拒 —— 都不发改名帧", () => {
	it("没给标题、或标题是空串：一个改名帧都不发（不拿空名字当标题）", async () => {
		const withoutTitle = await createConnectedStore();
		expect(await withoutTitle.store.newSession({ agentId: "hr" })).toEqual({ kind: "created", notApplied: [] });
		expect(withoutTitle.serve.renames).toEqual([]);
		expect(creationFrames(withoutTitle.serve)).toEqual(["attach", "switch_session", "new_session"]);

		const emptyTitle = await createConnectedStore();
		expect(await emptyTitle.store.newSession({ title: "" })).toEqual({ kind: "created", notApplied: [] });
		expect(emptyTitle.serve.renames).toEqual([]);
		expect(creationFrames(emptyTitle.serve)).toEqual(["new_session"]);
	});

	it("标题在、但创建被 serve 拒（ok:false）：报「确定没建」并把 serve 的原文给出来，不发改名帧", async () => {
		const { store, serve } = await createConnectedStore();
		expect(await store.newSession({ agentId: "hr" })).toEqual({ kind: "created", notApplied: [] });
		// serve 侧：hr 的会话没了（agent 进程退出 / 另一条连接 detach），而焦点还停在 hr
		serve.detach("hr");

		const outcome = await store.newSession({ title: "季度复盘" });

		// serve 回了 ok:false = 它看过并拒了：这是一个**确定的否定**，不是「建没建不知道」
		expect(outcome.kind).toBe("not-created");
		expect(outcome.kind === "not-created" ? outcome.error : "").toBe("agent not attached: hr (send attach first)");
		// 用户看得见的就是 serve 的原话（不加客户端前缀、不翻译）
		expect(store.getSnapshot().commandError).toContain("agent not attached: hr (send attach first)");

		// 创建本身被 serve 拒了：没有第二个会话，也没有改名帧
		expect(serve.createdOn).toEqual(["hr"]);
		expect(creationFrames(serve)).toEqual(["attach", "switch_session", "new_session", "new_session"]);
		expect(serve.renames).toEqual([]);
	});
});

/**
 * T28：新建会话的 Project **真的生效**（`new_session.projectId`）。
 *
 * 这一组钉的是「用户的选择真的上了命令」与「服务端的判决真的回得上屏」：
 * 前者以前落不下去（只会出现在 notApplied 里），后者以前被归成「说不准」。
 */
describe("新建会话带 Project：落到 new_session.projectId，未知 id 原样报错", () => {
	it("带 Project 新建：命令载荷里有那个 projectId，会话真的建在它上面", async () => {
		const { store, serve } = await createConnectedStore();
		serve.projects.add("dtc");

		const outcome = await store.newSession({ agentId: "hr", projectId: "dtc" });

		expect(outcome).toEqual({ kind: "created", notApplied: [] });
		// 验收点：projectId 曾经只会出现在 notApplied 里（「wire 落不下去」），现在它发得出去 ——
		// 出口还在（将来有表达不出来的字段仍然要从那里说），但它里面不该再有 projectId。
		expect(outcome.kind === "created" ? outcome.notApplied : ["not-created"]).not.toContain("projectId");
		// 命令面的事实：new_session 那一帧确实带了它（不是「客户端以为带了」）
		const create = creationCommands(serve).find(c => c.type === "new_session");
		expect(create).toMatchObject({ type: "new_session", sessionId: "hr", projectId: "dtc" });
		expect(serve.projectArrivals).toEqual(["dtc"]);
	});

	it("不指定 Project：new_session 不带这个字段（不拿空串冒充一个声明）", async () => {
		const { store, serve } = await createConnectedStore();

		expect(await store.newSession({ agentId: "hr" })).toEqual({ kind: "created", notApplied: [] });

		const create = creationCommands(serve).find(c => c.type === "new_session");
		expect(create).not.toHaveProperty("projectId");
		expect(serve.projectArrivals).toEqual([undefined]);
	});

	it("未知 projectId：serve 拒了 —— 报「确定没建」+ 它的原文，界面上看得到、不吞", async () => {
		const { store, serve } = await createConnectedStore();

		const outcome = await store.newSession({ agentId: "hr", projectId: "ghost" });

		expect(outcome.kind).toBe("not-created");
		expect(outcome.kind === "not-created" ? outcome.error : "").toContain(
			'no Project declared with projectId "ghost"',
		);
		// 唯一可见的错误面拿到的就是 serve 的原话
		const shown = store.getSnapshot().commandError ?? "";
		expect(shown).toContain('no Project declared with projectId "ghost"');
		// 一个会话都没建：不被静默落回启动根
		expect(serve.createdOn).toEqual([]);
	});

	it("工作上下文是客户端状态：切它不重启 serve、不发命令；下一次新建才带上它", async () => {
		const { store, serve } = await createConnectedStore();
		serve.projects.add("dtc");
		const framesBefore = serve.sent.length;

		store.setWorkingProject("dtc");
		expect(store.getSnapshot().workingProjectId).toBe("dtc");
		// 切上下文不是一个服务端动作：一帧都不发
		expect(serve.sent.length).toBe(framesBefore);

		expect(await store.newSession({ agentId: "hr", projectId: store.getSnapshot().workingProjectId })).toEqual({
			kind: "created",
			notApplied: [],
		});
		expect(serve.projectArrivals).toEqual(["dtc"]);

		// 切回「不指定」：下一个会话又不声明归属
		store.setWorkingProject(undefined);
		expect(store.getSnapshot().workingProjectId).toBeUndefined();
	});

	it("不带 opts.projectId 的入口（侧栏直建钮 / 设置页）也落在工作上下文上", async () => {
		const { store, serve } = await createConnectedStore();
		serve.projects.add("dtc");
		store.setWorkingProject("dtc");

		// 这两处调的就是 `store.newSession()`（不传任何入参）——「建在哪个 Project」的规则在 store 一处，
		// 所以它们与表单得到的是同一个答案；在调用点各自决定就会出现半生效。
		expect(await store.newSession()).toEqual({ kind: "created", notApplied: [] });
		expect(serve.projectArrivals).toEqual(["dtc"]);

		// 显式指名优先于工作上下文
		serve.projects.add("mkt");
		expect(await store.newSession({ agentId: "hr", projectId: "mkt" })).toEqual({
			kind: "created",
			notApplied: [],
		});

		expect(serve.projectArrivals).toEqual(["dtc", "mkt"]);
	});

	it("notApplied 是空数组而不是缺字段 —— 调用方看得出「全部落上了」", async () => {
		const { store, serve } = await createConnectedStore();
		serve.projects.add("dtc");
		store.setWorkingProject("dtc");

		const outcome = await store.newSession();
		if (outcome.kind !== "created") throw new Error(`预期建成功，实际 ${outcome.kind}`);

		// 这个出口留着（将来有 wire 表达不出来的字段要在这里说），今天确实一个都没有。
		// 缺字段与空数组不是一回事：前者说不出「有没有被落下」。
		expect(Array.isArray(outcome.notApplied)).toBe(true);
		expect(outcome.notApplied).toEqual([]);
	});

	it("开新会话作废的是**归属**，不是我的选择（同一个 Agent）", async () => {
		const { store, serve } = await createConnectedStore();
		serve.projects.add("dtc");
		store.setWorkingProject("dtc");

		await store.newSession();

		// 新会话的归属被作废了（它还没声明过归属），但工作上下文还是我选的那个
		const view = store.getSnapshot();
		expect(view.currentProjectId).toBeUndefined();
		expect(view.workingProjectId).toBe("dtc");
		// 而且真的带上去了：不是只有界面这么写
		expect(serve.projectArrivals).toEqual(["dtc"]);
	});

	it("跨 Agent 新建：用目标 Agent 那条工作上下文，不带焦点的那个 Agent 的项目", async () => {
		const { store, serve } = await createConnectedStore();
		serve.projects.add("dtc");
		serve.projects.add("mkt");
		store.setWorkingProject("dtc"); // 焦点 default 选的项目
		await store.focusAgent("hr");
		store.setWorkingProject("mkt"); // hr 自己那条
		await store.focusAgent("default");

		expect(await store.newSession({ agentId: "hr" })).toEqual({ kind: "created", notApplied: [] });
		expect(serve.projectArrivals).toEqual(["mkt"]);
	});
});

// ── 工作上下文落盘（localStorage）──────────────────────────────────────

/** 内存 Storage —— 与 `recent-paths.test.ts` 同一套约定：每个用例自己装、自己拆。 */
function makeMemoryStorage(): Storage {
	const data = new Map<string, string>();
	return {
		get length(): number {
			return data.size;
		},
		clear(): void {
			data.clear();
		},
		getItem(key: string): string | null {
			return data.has(key) ? data.get(key)! : null;
		},
		key(index: number): string | null {
			return [...data.keys()][index] ?? null;
		},
		removeItem(key: string): void {
			data.delete(key);
		},
		setItem(key: string, value: string): void {
			data.set(key, String(value));
		},
	};
}

/**
 * 工作上下文**按 Agent**：每个 Agent 各自记自己的 Project，落盘、恢复校验、没手选过时用注册表兜底。
 *
 * 六件事在这里被钉住：
 *   1. **按 Agent 分**：给一个 Agent 选不会改到别的 Agent（就是「改一个 Project，所有 Agent 都
 *      跟着变」的反面）；
 *   2. **刷新的表现**：重建 store（= 重开页面）后每个 Agent 还是自己那条；
 *   3. **恢复校验**：恢复到的那条不在名单里 → 丢掉（连同存储）；读失败不校验（读不到 ≠ 没有），
 *      用户自己刚做的选择也不校验（那是决定，不是恢复）；
 *   4. **兜底**：没手选过时用「`defaultAgentId` = 这个 Agent」的 Project，**恰好一个**才用
 *      （§10 第 2 级）；兜底是算出来的，**不落盘**；
 *   5. **多个 → 不指定**：两个 Project 都声明同一个 Agent 时不替用户猜；
 *   6. **显式「不指定」不被兜底顶掉**：那是用户做的选择，不是「没选过」。
 */
describe("工作上下文：按 Agent 分，落盘 + 兜底", () => {
	let storage: Storage;

	beforeEach(() => {
		storage = makeMemoryStorage();
		(globalThis as { localStorage?: Storage }).localStorage = storage;
	});

	afterEach(() => {
		delete (globalThis as { localStorage?: Storage }).localStorage;
	});

	const stored = (): string | null => storage.getItem(WORKING_PROJECT_KEY);
	const seed = (table: Record<string, string>): void => {
		storage.setItem(WORKING_PROJECT_KEY, JSON.stringify(table));
	};

	it("给一个 Agent 选不会改到别的 Agent", async () => {
		const { store, serve } = await createConnectedStore();
		serve.declaredProjects = [{ projectId: "dtc" }, { projectId: "mkt" }];

		store.setWorkingProject("dtc"); // 焦点还是 default
		expect(store.getSnapshot().workingProjectId).toBe("dtc");

		await store.focusAgent("hr");
		expect(store.getSnapshot().activeAgentId).toBe("hr");
		expect(store.getSnapshot().workingProjectId).toBeUndefined(); // hr 没选过

		store.setWorkingProject("mkt");
		expect(store.getSnapshot().workingProjectId).toBe("mkt");

		await store.focusAgent("default");
		expect(store.getSnapshot().workingProjectId).toBe("dtc"); // 回到 default，它那条没被改掉

		// 落盘的是**一张表**：两个 Agent 各一条
		expect(JSON.parse(stored() ?? "{}")).toEqual({ default: "dtc", hr: "mkt" });
	});

	it("重建 store（= 重开页面）后每个 Agent 还是自己那条", async () => {
		const before = await createConnectedStore();
		before.store.setWorkingProject("dtc");
		await before.store.focusAgent("hr");
		before.store.setWorkingProject("mkt");

		const after = await createConnectedStore();
		// 焦点还是 default，并且名单还没读到也不是「没有」
		expect(after.store.getSnapshot().workingProjectId).toBe("dtc");
		expect(after.store.getSnapshot().projects).toBeUndefined();
		await after.store.focusAgent("hr");
		expect(after.store.getSnapshot().workingProjectId).toBe("mkt");
	});

	it("恢复到的那条已不在名单里：丢掉（连同存储）", async () => {
		seed({ hr: "ghost" });
		const { store, serve } = await createConnectedStore();
		await store.focusAgent("hr");
		// 名单还没读到：手选那份照用（判不出它还在不在，不先说它没了）
		expect(store.getSnapshot().workingProjectId).toBe("ghost");

		serve.declaredProjects = [{ projectId: "mkt" }];
		await store.refreshProjects();

		expect(store.getSnapshot().workingProjectId).toBeUndefined();
		expect(stored()).toBeNull();
	});

	it("恢复到的那条还在名单里：留着（校验不是「一律清掉」）", async () => {
		seed({ hr: "dtc" });
		const { store, serve } = await createConnectedStore();
		await store.focusAgent("hr");

		serve.declaredProjects = [{ projectId: "dtc" }, { projectId: "mkt" }];
		await store.refreshProjects();

		expect(store.getSnapshot().workingProjectId).toBe("dtc");
		expect(JSON.parse(stored() ?? "{}")).toEqual({ hr: "dtc" });
	});

	it("名单读失败：「不知道」不删用户的选择（读不到 ≠ 没有）", async () => {
		seed({ hr: "ghost" });
		const { store, serve } = await createConnectedStore();
		await store.focusAgent("hr");
		serve.listProjectsError = "Project store is not valid JSON";

		await store.refreshProjects();

		expect(store.getSnapshot().projectsError).toContain("not valid JSON");
		expect(store.getSnapshot().workingProjectId).toBe("ghost");
		expect(JSON.parse(stored() ?? "{}")).toEqual({ hr: "ghost" });

		// 一次读失败不能把校验吃掉：下一次真的读到名单时仍然判一次
		serve.listProjectsError = undefined;
		serve.declaredProjects = [];
		await store.refreshProjects();
		expect(store.getSnapshot().workingProjectId).toBeUndefined();
	});

	it("恢复之后用户自己改过：那道校验不再动他刚做的决定", async () => {
		seed({ hr: "ghost" });
		const { store, serve } = await createConnectedStore();
		await store.focusAgent("hr");
		store.setWorkingProject("mkt"); // 他刚选的，名单里此刻还没有它

		serve.declaredProjects = [];
		await store.refreshProjects();

		expect(store.getSnapshot().workingProjectId).toBe("mkt");
	});

	it("没手选过：用注册表里声明了这个 Agent 的那个 Project（恰好一个），且不落盘", async () => {
		const { store, serve } = await createConnectedStore();
		serve.declaredProjects = [{ projectId: "dtc", defaultAgentId: "hr" }];
		await store.focusAgent("hr");

		await store.refreshProjects();

		expect(store.getSnapshot().workingProjectId).toBe("dtc");
		// 兜底是**算出来的**，不落盘 —— 否则「手选过」与「注册表推出来的」就分不开了
		expect(stored()).toBeNull();
	});

	it("两个 Project 都声明了这个 Agent：不指定，不替用户猜", async () => {
		const { store, serve } = await createConnectedStore();
		serve.declaredProjects = [
			{ projectId: "a", defaultAgentId: "hr" },
			{ projectId: "b", defaultAgentId: "hr" },
		];
		await store.focusAgent("hr");

		await store.refreshProjects();

		expect(store.getSnapshot().workingProjectId).toBeUndefined();
	});

	it("手选优先于兜底；选「不指定」也不会被兜底顶回来", async () => {
		const { store, serve } = await createConnectedStore();
		serve.declaredProjects = [{ projectId: "dtc", defaultAgentId: "hr" }];
		await store.focusAgent("hr");
		await store.refreshProjects();
		expect(store.getSnapshot().workingProjectId).toBe("dtc"); // 兜底

		store.setWorkingProject("mkt");
		expect(store.getSnapshot().workingProjectId).toBe("mkt"); // 手选赢了

		store.setWorkingProject(undefined);
		expect(store.getSnapshot().workingProjectId).toBeUndefined(); // 显式不指定：不被 dtc 顶回来
		expect(JSON.parse(stored() ?? "{}")).toEqual({ hr: "" });
	});
});
