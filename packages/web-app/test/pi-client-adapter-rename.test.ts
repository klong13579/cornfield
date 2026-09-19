import { afterEach, describe, expect, it } from "bun:test";
import type { PiWebSocketCtor, PiWebSocketLike } from "@cornfield/client";
import { PiServerError } from "@cornfield/client";
import { PiClientAdapter, type ServeConnectionConfig } from "../src/state/pi-client-adapter";

/**
 * 会话改名两条命令的**客户端契约**（rename_session / set_session_name）。
 *
 * 锁三件事：
 *   - 发出去的帧逐字对：命令名、字段名（`sessionFile` 而不是 sessionId）、以及 id 关联；
 *   - 成功 = serve 回 ack（不带载荷），方法 resolve；
 *   - 失败 = serve 回 `ok:false`，抛 `PiServerError` 且 **serve 的原文一个字不丢**（在
 *     `serverError` 上）—— 侧栏就是拿它显示给用户的，改写它就等于把用户唯一能据以修的东西扔了。
 */

let lastCreated: FakeWebSocket | undefined;

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

/** 已发出的 request 帧（id + command），hello/ping 之类不在内。 */
function sentRequests(): Array<{ id: string; command: Record<string, unknown> }> {
	return (lastCreated?.sent ?? [])
		.map(s => JSON.parse(s) as { type?: string; id?: string; command?: Record<string, unknown> })
		.filter(
			(f): f is { id: string; command: Record<string, unknown> } => f.type === "request" && !!f.id && !!f.command,
		);
}

/** 用**最新**那条 request 的 id 回一个响应（ok:true 不带载荷 = serve 的 ack）。 */
function respond(result?: unknown): void {
	const reqs = sentRequests();
	const frame =
		result === undefined
			? { type: "response", id: reqs[reqs.length - 1]!.id, ok: true }
			: { type: "response", id: reqs[reqs.length - 1]!.id, ok: true, result };
	lastCreated?.receive(JSON.stringify(frame));
}

/** 用最新那条 request 的 id 回一个拒绝（serve 的原文走 `error`）。 */
function respondError(error: string): void {
	const reqs = sentRequests();
	lastCreated?.receive(JSON.stringify({ type: "response", id: reqs[reqs.length - 1]!.id, ok: false, error }));
}

/** 起一条已握手的 adapter；每个用例自己收尾断开。 */
async function connectAdapter(): Promise<PiClientAdapter> {
	lastCreated = undefined;
	const adapter = new PiClientAdapter(config, fakeCtor);
	const pending = adapter.connect();
	lastCreated?.onopen?.({});
	lastCreated?.receive(JSON.stringify({ type: "hello_ack", connectionId: "c1", protocolVersion: 1 }));
	await pending;
	return adapter;
}

const open: PiClientAdapter[] = [];

afterEach(() => {
	for (const adapter of open.splice(0)) adapter.disconnect();
});

async function newAdapter(): Promise<PiClientAdapter> {
	const adapter = await connectAdapter();
	open.push(adapter);
	return adapter;
}

describe("PiClientAdapter.renameSession（rename_session）", () => {
	it("发出的帧逐字是 {type, sessionFile, name}，并带 id 关联", async () => {
		const adapter = await newAdapter();

		const pending = adapter.renameSession({ sessionFile: "/root/sessions/a.jsonl", name: "新名字" });

		const req = sentRequests().at(-1);
		expect(typeof req?.id).toBe("string");
		expect(req?.id.length).toBeGreaterThan(0);
		// 逐字：不得多一个字段（sessionId 在这里是错的字段名，会把命令打到另一个会话上）。
		// `id` 是 pi-client 盖在 command 上的关联 id（request 帧与 command 上各一份）。
		expect(req?.command).toEqual({
			id: req?.id,
			type: "rename_session",
			sessionFile: "/root/sessions/a.jsonl",
			name: "新名字",
		});

		respond();
		await expect(pending).resolves.toBeUndefined();
	});

	it("serve 拒了：抛 PiServerError，原文一字不落地在 serverError 上", async () => {
		const adapter = await newAdapter();
		const raw = "session is open in this process: rename it as the active session instead";

		const pending = adapter.renameSession({ sessionFile: "/root/sessions/a.jsonl", name: "新名字" });
		respondError(raw);

		const err = await pending.then(
			() => undefined,
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(PiServerError);
		expect((err as PiServerError).serverError).toBe(raw);
		expect((err as PiServerError).command).toBe("rename_session");
	});

	it("路径越界的拒绝原文同样原样透出", async () => {
		const adapter = await newAdapter();
		const raw = "not a session file: /tmp/x.txt";

		const pending = adapter.renameSession({ sessionFile: "/tmp/x.txt", name: "n" });
		respondError(raw);

		await expect(pending).rejects.toThrow(raw);
	});
});

describe("PiClientAdapter.renameActiveSession（set_session_name）", () => {
	it("发出的帧逐字是 {type, name}（不碰文件，也不带 sessionId = 当前焦点）", async () => {
		const adapter = await newAdapter();

		const pending = adapter.renameActiveSession("实时会话改名");

		const req = sentRequests().at(-1);
		expect(req?.command).toEqual({ id: req?.id, type: "set_session_name", name: "实时会话改名" });

		respond();
		await expect(pending).resolves.toBeUndefined();
	});

	it("空名被 serve 拒 → 抛错且原文不丢", async () => {
		const adapter = await newAdapter();

		const pending = adapter.renameActiveSession("   ");
		respondError("Session name cannot be empty");

		const err = await pending.then(
			() => undefined,
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(PiServerError);
		expect((err as PiServerError).serverError).toBe("Session name cannot be empty");
		expect((err as PiServerError).command).toBe("set_session_name");
	});
});
