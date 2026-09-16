import { afterEach, describe, expect, it } from "bun:test";
import type { PiWebSocketCtor, PiWebSocketLike } from "@cornfield/client";
import type { SessionSnapshotDto } from "@cornfield/wire";
import { PiClientAdapter, type ServeConnectionConfig } from "../src/state/pi-client-adapter";
import { SessionStore, type SessionView } from "../src/state/session-store";

/**
 * 改动清单的读取状态机：**不存在**「读取结束但既没有清单也没有错误」这一态。
 *
 * 右栏改动卡片对这个组合本来无话可说（只认「读取中 / 读不到改动 / 工作区没有改动」三句），
 * 落进去就是一张只有组头的空白卡片；卡片侧已补上一句「改动状态未知」（ChangesPanel.tsx）。
 * 这一组用例钉住的是**写入侧**那条更根本的结论：session-store 只在同一步里同时落 data 或
 * error（`#loadGitChanges`），所以那个组合不是「少见」，而是不该出现 —— 谁把它写出来，
 * 这里就先红。
 *
 * 手法与 session-store-serve-fix.test.ts 同：真的 `SessionStore` + 真的 `PiClientAdapter`，
 * 替身只有 WS 那一层；答复由用例自己喂，成功 / 失败 / 换身份时在途响应作废这三种时序因此可控。
 */

const ADDRESS = "default\u0000/Users/me/work/mika";
const OTHER_ADDRESS = "hr";
const SESSION_FILE = "/Users/me/.cornfield/agent/sessions/by-date/2026-09-16/143205__a1b2c3d4.jsonl";
const REPO_ROOT = "/Users/me/work/mika";

const config: ServeConnectionConfig = { wsUrl: "ws://127.0.0.1:1/ws", token: "" };

let socket: FakeWebSocket | undefined;
const adapters: PiClientAdapter[] = [];

/** 只记录、不自答的假 WS：每条响应都由用例自己喂（时序是这一组用例的前提）。 */
class FakeWebSocket implements PiWebSocketLike {
	readyState = 1;
	onopen: PiWebSocketLike["onopen"] = null;
	onmessage: PiWebSocketLike["onmessage"] = null;
	onclose: PiWebSocketLike["onclose"] = null;
	onerror: PiWebSocketLike["onerror"] = null;
	readonly sent: string[] = [];

	constructor(_url: string) {
		socket = this;
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

afterEach(() => {
	for (const adapter of adapters) adapter.disconnect();
	adapters.length = 0;
	socket = undefined;
});

interface SentRequest {
	id: string;
	command: Record<string, unknown>;
}

function sentRequests(): SentRequest[] {
	return (socket?.sent ?? [])
		.map(raw => JSON.parse(raw) as { type?: string; id?: string; command?: Record<string, unknown> })
		.filter((frame): frame is SentRequest => frame.type === "request" && !!frame.id && !!frame.command);
}

/** 最新一条某类型的 request 帧 id：按类型挑（前面可能还有别的命令没答复），不按「最后一条」。 */
function lastRequestIdOf(type: string): string {
	const requests = sentRequests().filter(request => request.command.type === type);
	const last = requests[requests.length - 1];
	if (!last) throw new Error(`本用例的前提是已经发出过 ${type}，但没有`);
	return last.id;
}

function respondOk(type: string, result: unknown): void {
	socket?.receive(JSON.stringify({ type: "response", id: lastRequestIdOf(type), ok: true, result }));
}

function respondError(type: string, error: string): void {
	socket?.receive(JSON.stringify({ type: "response", id: lastRequestIdOf(type), ok: false, error }));
}

/** 触发所有在途 promise 链（答复是在别的调用栈里喂进来的）。 */
async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) await Bun.sleep(0);
}

function snapshotOf(): SessionSnapshotDto {
	return {
		seq: 2,
		phase: "idle",
		retryAttempt: 0,
		isCompacting: false,
		isStreaming: false,
		sessionId: "8f0e1d2c-0000-4000-8000-000000000001",
		sessionName: "changes",
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

/** 推一帧焦点附件的快照（帧上的 sessionId 是**附件地址**，会话 uuid 在 snapshot 里）。 */
function pushSnapshot(address: string): void {
	socket?.receive(
		JSON.stringify({ type: "push", event: { type: "session_snapshot", sessionId: address, snapshot: snapshotOf() } }),
	);
}

async function createStore(): Promise<SessionStore> {
	const adapter = new PiClientAdapter(config, fakeCtor);
	adapters.push(adapter);
	const store = new SessionStore();
	store.init(adapter);
	const connecting = store.connect();
	socket?.onopen?.({});
	socket?.receive(JSON.stringify({ type: "hello_ack", connectionId: "c1", protocolVersion: 1 }));
	await connecting;
	return store;
}

/** 从此刻起记住每一次视图快照（含连接期那几帧）。 */
function watch(store: SessionStore): SessionView[] {
	const views: SessionView[] = [store.getSnapshot()];
	store.subscribe(() => views.push(store.getSnapshot()));
	return views;
}

/** 面板会渲染成一张空白卡片的组合：读取结束，但既没有清单也没有错误。 */
function blankReads(views: readonly SessionView[]): SessionView[] {
	return views.filter(
		view => !view.gitChangesPending && view.gitChanges === undefined && view.gitChangesError === undefined,
	);
}

describe("改动清单的读取状态机", () => {
	it("读到了：先「还不知道」再 ready + 清单，全程没有「结束了但没数据」的组合", async () => {
		const store = await createStore();
		const views = watch(store);
		pushSnapshot(ADDRESS);
		await settle();
		// 快照到手、答复还没来：此刻只许是「还不知道」，不许是「没有改动」
		expect(store.getSnapshot().gitChangesPending).toBe(true);

		respondOk("git_changes", { repoRoot: REPO_ROOT, changes: [] });
		await settle();

		const view = store.getSnapshot();
		expect(view.gitChangesPending).toBe(false);
		expect(view.gitChanges).toEqual({ repoRoot: REPO_ROOT, changes: [] });
		expect(view.gitChangesError).toBeUndefined();
		// 上面那条 ready 不是白捡的：读取途中真的经过「还不知道」，且这一次 ready 确实经过了 notify
		expect(views.some(v => v.gitChangesPending)).toBe(true);
		expect(views.some(v => v.gitChanges !== undefined)).toBe(true);
		expect(blankReads(views)).toEqual([]);
	});

	it("读不到：错误原文落进视图（不是空清单），全程也没有那个组合", async () => {
		const store = await createStore();
		const views = watch(store);
		pushSnapshot(ADDRESS);
		await settle();

		respondError("git_changes", "git_changes failed: not a git repository");
		await settle();

		const view = store.getSnapshot();
		expect(view.gitChangesPending).toBe(false);
		expect(view.gitChanges).toBeUndefined();
		// 错误原文照显（连接层只加了「谁拒的」那一层前缀，服务端原文在里面）
		expect(view.gitChangesError).toBe('Server rejected "git_changes": git_changes failed: not a git repository');
		// 「读不到」这一态确实经过了 notify（否则下面那条空数组什么都没证明）
		expect(views.some(v => v.gitChangesError !== undefined)).toBe(true);
		expect(blankReads(views)).toEqual([]);
	});

	it("换身份：作废之后仍然是「还不知道」，重读答复到了才 ready", async () => {
		const store = await createStore();
		const views = watch(store);
		pushSnapshot(ADDRESS);
		await settle();
		respondOk("git_changes", { repoRoot: REPO_ROOT, changes: [] });
		await settle();

		// 换会话：身份变了，在途/已到手的那一份都不再算数
		store.switchSession(OTHER_ADDRESS);
		pushSnapshot(OTHER_ADDRESS);
		await settle();
		expect(store.getSnapshot().gitChangesPending).toBe(true);
		expect(store.getSnapshot().gitChanges).toBeUndefined();

		respondOk("git_changes", { repoRoot: REPO_ROOT, changes: [] });
		await settle();
		expect(store.getSnapshot().gitChangesPending).toBe(false);
		expect(blankReads(views)).toEqual([]);
	});
});
