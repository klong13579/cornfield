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

function respond(result: unknown): void {
	const reqs = sentRequests();
	lastCreated?.receive(JSON.stringify({ type: "response", id: reqs[reqs.length - 1]!.id, ok: true, result }));
}

function respondError(error: string): void {
	const reqs = sentRequests();
	lastCreated?.receive(JSON.stringify({ type: "response", id: reqs[reqs.length - 1]!.id, ok: false, error }));
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
