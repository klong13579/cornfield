import { afterEach, describe, expect, it } from "bun:test";
import type { PiWebSocketCtor, PiWebSocketLike } from "@cornfield/client";
import type { SessionSnapshotDto } from "@cornfield/wire";
import { changesGroupsOf, fileOpenTargetOf } from "../src/pages/workspace/ChangesPanel";
import { promptTargetOf } from "../src/pages/workspace/ComposerBar";
import { FileWorkflowStore } from "../src/state/file-workflow-store";
import { PiClientAdapter, type ServeConnectionConfig } from "../src/state/pi-client-adapter";
import { SessionStore } from "../src/state/session-store";

/**
 * 工作台的 wire 定向身份：**每一条命令的载荷里写的就是会话身份（附件地址），不是 Agent 名**。
 *
 * 这一票修的是「拿 Agent 名当 `sessionId`」这一类缺陷的最后三处（发消息 / 列产物 / 开文件）。
 * wire 把 Agent 名解到那个 Agent **未绑定**的附件 —— 对绑了 Project 的会话，那是**另一个工作根**
 * （屏幕上根本没在看的那个会话）：消息进错会话、产物列的是另一个根、点开的文件在另一个根里。
 *
 * 所以这里的断言一律盯着**服务端收到的载荷**（记录 WS 里那一帧的 command），而不是前端内部
 * 存了什么：假 serve 只回响应，不做身份解析 —— 身份对不对全在载荷里。
 *
 * 与 file-workflow-store.test.ts 同一手法：真的 `SessionStore` + 真的 `PiClientAdapter` + 真的
 * `FileWorkflowStore`，替身只有 WS 那一层。
 */

/** serve 的 `attachmentKey(agentId, root)`：绑定后附件地址 = `agentId\u0000工作根`。 */
const PROJECT_ROOT = "/Users/me/work/mika";
const BOUND_ADDRESS = `hr\u0000${PROJECT_ROOT}`;
const UNBOUND_ADDRESS = "hr";
const SESSION_FILE = "/Users/me/.cornfield/agent/sessions/by-date/2026-09-16/143205__a1b2c3d4.jsonl";
const FILE_PATH = "PROJECT_ROOT.txt";
const FILE_TEXT = "marker-original\n";

const config: ServeConnectionConfig = { wsUrl: "ws://127.0.0.1:1/ws", token: "" };

/** 触发所有在途 promise 链（store 的方法是「发起即返回」，测试靠它对齐时序）。 */
async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) await Bun.sleep(0);
}

/**
 * 记录型的假 serve：只做两件事 —— 记下收到的 command、按命令给一个合法答复。
 *
 * 它**不**做身份解析（真 serve 才有 registry）：所以「收到的是地址还是 Agent 名」这件事
 * 只能来自载荷本身，断言因此钉得住。
 */
class FakeServe implements PiWebSocketLike {
	readyState = 1;
	onopen: PiWebSocketLike["onopen"] = null;
	onmessage: PiWebSocketLike["onmessage"] = null;
	onclose: PiWebSocketLike["onclose"] = null;
	onerror: PiWebSocketLike["onerror"] = null;
	/** 服务端收到的每一条命令（request 帧的 command，含 id）。 */
	readonly received: Array<Record<string, unknown>> = [];

	constructor(_url: string) {
		lastServe = this;
	}

	send(data: string): void {
		const frame = JSON.parse(data) as { type?: string; id?: string; command?: Record<string, unknown> };
		if (frame.type !== "request" || !frame.id || !frame.command) return;
		this.received.push(frame.command);
		// 异步答复：调用方（pi-client）是在 send 之前登记 pending 的，但同步答复等于在别人的
		// send 调用栈里回调，队列一拍更接近真 serve 的时序。
		queueMicrotask(() =>
			this.receive(
				JSON.stringify({ type: "response", id: frame.id, ok: true, result: this.#resultFor(frame.command!) }),
			),
		);
	}

	close(): void {}

	receive(data: string): void {
		this.onmessage?.({ data });
	}

	/** 服务端收到的最后一条某类型命令（收到的顺序 = 发出的顺序）。 */
	lastOf(type: string): Record<string, unknown> | undefined {
		for (let i = this.received.length - 1; i >= 0; i--) {
			const command = this.received[i]!;
			if (command.type === type) return command;
		}
		return undefined;
	}

	#resultFor(command: Record<string, unknown>): unknown {
		switch (command.type) {
			case "list_projects":
				return { projects: [] };
			case "list_agent_todos":
				return { agentId: UNBOUND_ADDRESS, todos: [], projectIds: [] };
			case "list_artifacts":
				return { artifacts: [] };
			case "git_changes":
				return { repoRoot: PROJECT_ROOT, changes: [] };
			case "fs_read":
				return { text: FILE_TEXT, truncated: false, version: "v1" };
			case "fs_write":
				return { path: command.path, bytesWritten: 0, version: "v2", normalized: false };
			default:
				return {};
		}
	}
}

let lastServe: FakeServe | undefined;
const fakeCtor: PiWebSocketCtor = FakeServe;

const adapters: PiClientAdapter[] = [];
afterEach(() => {
	for (const adapter of adapters) adapter.disconnect();
	adapters.length = 0;
	lastServe = undefined;
});

/** 快照 payload（`session.sessionId` 是会话自己的 uuid，与附件地址不是一件事）。 */
function snapshotOf(): SessionSnapshotDto {
	return {
		seq: 2,
		phase: "idle",
		retryAttempt: 0,
		isCompacting: false,
		isStreaming: false,
		sessionId: "8f0e1d2c-0000-4000-8000-000000000001",
		sessionName: "project-binding",
		sessionFile: SESSION_FILE,
		model: { provider: "narwal-plan", id: "deepseek-v4-flash", name: "deepseek-v4-flash" },
		messages: [],
		messageEntryIds: {},
		todoPhases: [],
		activeToolNames: [],
		queuedMessageCount: 0,
		autoCompactionEnabled: false,
		autoRetryEnabled: false,
	};
}

interface World {
	store: SessionStore;
	files: FileWorkflowStore;
	adapter: PiClientAdapter;
	serve: FakeServe;
}

/**
 * 连上假 serve，并推一帧**焦点附件已绑定 Project** 的快照（附件地址 ≠ Agent 名）。
 * 工作台此刻看的会话在 `/Users/me/work/mika` 里，而不是 `hr` 那个 Agent 自己的根。
 */
async function createBoundWorld(): Promise<World> {
	const adapter = new PiClientAdapter(config, fakeCtor);
	adapters.push(adapter);
	const store = new SessionStore();
	store.init(adapter);
	const connect = store.connect();
	const serve = lastServe!;
	serve.onopen?.({});
	serve.receive(JSON.stringify({ type: "hello_ack", connectionId: "c1", protocolVersion: 1 }));
	await connect;
	// Agent 列表（跟真实连接一样由 server_snapshot 推）：屏幕上那个 Agent 叫 hr，但它看的是
	// 绑了 Project 的那个附件 —— 两个身份因此可以分开断言。
	serve.receive(
		JSON.stringify({
			type: "push",
			event: {
				type: "server_snapshot",
				sessions: [
					{
						id: UNBOUND_ADDRESS,
						name: "HR 助手",
						active: true,
						attached: true,
						agentDir: "/Users/me/.cornfield/agents/hr",
						sessionFile: SESSION_FILE,
					},
				],
			},
		}),
	);
	serve.receive(
		JSON.stringify({
			type: "push",
			event: { type: "session_snapshot", sessionId: BOUND_ADDRESS, snapshot: snapshotOf() },
		}),
	);
	await settle();
	const files = new FileWorkflowStore();
	files.init({ client: adapter, sessions: store });
	// 开文件走的是假 serve 的答复；先清空连接期的噪音，后面每条断言都只看本轮动作发出的帧。
	serve.received.length = 0;
	return { store, files, adapter, serve };
}

describe("会话身份：焦点附件的地址从快照帧进来（唯一来源）", () => {
	it("帧上的 sessionId 是附件地址；会话自己的 uuid 不是 wire 能解析的定向参数", async () => {
		const { store } = await createBoundWorld();
		const view = store.getSnapshot();
		expect(view.attachmentAddress).toBe(BOUND_ADDRESS);
		expect(view.attachmentAddress).not.toBe(UNBOUND_ADDRESS);
		// 会话 uuid 在另一个字段上，别把两者混起来
		expect(view.sessionId).toBe("8f0e1d2c-0000-4000-8000-000000000001");
		expect(view.sessionFile).toBe(SESSION_FILE);
	});
});

describe("发消息：载荷里的 sessionId 是会话身份，不是 Agent 名", () => {
	it("promptTargetOf 给的就是附件地址（ComposerBar 用它当第二个入参）", async () => {
		const { store } = await createBoundWorld();
		expect(promptTargetOf(store.getSnapshot())).toBe(BOUND_ADDRESS);
	});

	it("服务端收到的 prompt.sessionId = 附件地址（不是 hr）", async () => {
		const { store, serve } = await createBoundWorld();
		store.prompt("候选人的履历发我看看", promptTargetOf(store.getSnapshot()));
		await settle();

		const command = serve.lastOf("prompt");
		expect(command?.message).toBe("候选人的履历发我看看");
		expect(command?.sessionId).toBe(BOUND_ADDRESS);
		expect(command?.sessionId).not.toBe(UNBOUND_ADDRESS);
	});

	it("对照：拿 Agent 名当 sessionId（上一版的形状）落到的是另一个身份上", async () => {
		const { store, serve } = await createBoundWorld();
		store.prompt("上一版的形状", UNBOUND_ADDRESS);
		await settle();

		expect(serve.lastOf("prompt")?.sessionId).toBe(UNBOUND_ADDRESS);
		expect(serve.lastOf("prompt")?.sessionId).not.toBe(BOUND_ADDRESS);
	});
});

describe("列产物：载荷里的 sessionId 是会话身份（/preview 的第一段同源）", () => {
	it("list_artifacts 带附件地址 + 本会话的 sessionFile", async () => {
		const { store, serve } = await createBoundWorld();
		const view = store.getSnapshot();
		await store.listArtifacts(view.attachmentAddress, view.sessionFile);
		await settle();

		const command = serve.lastOf("list_artifacts");
		expect(command?.sessionId).toBe(BOUND_ADDRESS);
		expect(command?.sessionId).not.toBe(UNBOUND_ADDRESS);
		expect(command?.sessionFile).toBe(SESSION_FILE);
	});

	it("预览 URL 的第一段也是附件地址（拿 Agent 名解到的是未绑定附件的根 → 404）", async () => {
		const { adapter } = await createBoundWorld();
		expect(adapter.artifactPreviewUrl(BOUND_ADDRESS, FILE_PATH)).toBe(
			`http://127.0.0.1:1/preview/${encodeURIComponent(BOUND_ADDRESS)}/${FILE_PATH}`,
		);
	});
});

describe("开文件：改动清单读的根与点开的根是同一个（会话身份）", () => {
	it("切过焦点之后读改动仍然按会话身份（上一版这里会退化成 Agent 名）", async () => {
		const { store, serve } = await createBoundWorld();
		// 切过焦点：`#activeAgentId` 从此是 Agent 名 —— 上一版缺省拿它定向，本会话那一组就换了根。
		store.switchSession(UNBOUND_ADDRESS);
		serve.received.length = 0;
		await store.refreshGitChanges();
		await settle();

		const command = serve.lastOf("git_changes");
		expect(command?.sessionId).toBe(BOUND_ADDRESS);
		expect(command?.sessionId).not.toBe(UNBOUND_ADDRESS);
	});

	it("fs_read 的 sessionId 就是本会话那一组清单的 wire 身份", async () => {
		const { store, files, serve } = await createBoundWorld();
		const [root] = changesGroupsOf(store.getSnapshot(), new Map());
		// 本会话组：wire 身份 = 会话身份，agentId 只是归属展示
		expect(root?.agentId).toBe(UNBOUND_ADDRESS);
		files.requestOpen(fileOpenTargetOf(root!, FILE_PATH));
		await settle();

		const command = serve.lastOf("fs_read");
		expect(command?.path).toBe(FILE_PATH);
		expect(command?.sessionId).toBe(BOUND_ADDRESS);
		expect(command?.sessionId).not.toBe(UNBOUND_ADDRESS);
		expect(files.getSnapshot().open?.attachmentAddress).toBe(BOUND_ADDRESS);
	});
});
