import { afterEach, describe, expect, test } from "bun:test";
import { MULTIDEVICE_PROTOCOL_VERSION } from "@cornfield/wire";
import { PiClient, type PiClientEventKind, type PiClientOptions } from "../src/client";
import { PiDisconnectedError, PiHandshakeError, PiRequestTimeoutError, PiServerError } from "../src/errors";
import { FakeClock, FakeWebSocket, FakeWebSocketCtor, tick } from "./helpers";

afterEach(() => FakeWebSocket.reset());

function buildClient(overrides: Partial<PiClientOptions> = {}): { client: PiClient; clock: FakeClock } {
	const clock = new FakeClock();
	let counter = 0;
	const client = new PiClient({
		url: "ws://test/ws",
		token: "tkn",
		webSocketCtor: FakeWebSocketCtor,
		clock: clock.api,
		requestTimeoutMs: 1_000,
		reconnectBaseMs: 100,
		reconnectMaxMs: 5_000,
		nextRequestId: () => `req_${++counter}`,
		...overrides,
	});
	return { client, clock };
}

// ── 组 1: 连接 + hello 握手 ──

describe("PiClient 连接 + hello 握手", () => {
	test("connect() 发 hello 帧，hello_ack 后 status 进入 open", async () => {
		const { client } = buildClient();
		const events: PiClientEventKind[] = [];
		client.subscribe(e => events.push(e));

		const connectP = client.connect();
		await tick();
		expect(FakeWebSocket.all.length).toBe(1);
		const ws = FakeWebSocket.all[0];
		expect(client.status).toBe("connecting");

		ws.open();
		await tick();
		expect(client.status).toBe("handshaking");
		expect(ws.sent).toHaveLength(1);
		const hello = JSON.parse(ws.sent[0]);
		expect(hello).toEqual({ type: "hello", version: MULTIDEVICE_PROTOCOL_VERSION, token: "tkn" });

		ws.recv(
			JSON.stringify({ type: "hello_ack", connectionId: "conn-42", protocolVersion: MULTIDEVICE_PROTOCOL_VERSION }),
		);
		await connectP;
		expect(client.status).toBe("open");
		const helloAck = events.find(e => e.type === "hello_ack");
		expect(helloAck).toEqual({
			type: "hello_ack",
			connectionId: "conn-42",
			protocolVersion: MULTIDEVICE_PROTOCOL_VERSION,
		});
	});

	test("hello_error 拒握手，connect() reject PiHandshakeError（关闭自动重连）", async () => {
		const { client } = buildClient({ autoReconnect: false });
		const connectP = client.connect();
		await tick();
		const ws = FakeWebSocket.all[0];
		ws.open();
		ws.recv(JSON.stringify({ type: "hello_error", error: "unsupported protocol version 999" }));

		let err: Error | undefined;
		try {
			await connectP;
		} catch (e) {
			err = e as Error;
		}
		expect(err).toBeInstanceOf(PiHandshakeError);
		expect((err as PiHandshakeError).serverError).toBe("unsupported protocol version 999");
	});
});

// ── 组 2: 命令收发 ──

describe("PiClient request/response", () => {
	test("request() 发送带 id 的 request 帧，收到 ok:true 后 resolve result", async () => {
		const { client } = buildClient();
		const connectP = client.connect();
		await tick();
		const ws = FakeWebSocket.all[0];
		ws.open();
		ws.recv(JSON.stringify({ type: "hello_ack", connectionId: "c1", protocolVersion: MULTIDEVICE_PROTOCOL_VERSION }));
		await connectP;

		const reqP = client.request<{ ok: boolean }>({ type: "get_state" });
		await tick();
		// hello 占了 sent[0]，request 在 sent[1]
		const reqFrame = JSON.parse(ws.sent[1]);
		expect(reqFrame.type).toBe("request");
		expect(reqFrame.id).toBe("req_1");
		expect(reqFrame.command.type).toBe("get_state");
		expect(reqFrame.command.id).toBe("req_1"); // command 内嵌 id 也传

		ws.recv(JSON.stringify({ type: "response", id: "req_1", ok: true, result: { ok: true } }));
		const r = await reqP;
		expect(r).toEqual({ ok: true });
	});

	test("ok:false 拒 PiServerError，结构带 command + serverError", async () => {
		const { client } = buildClient();
		const p = client.connect();
		await tick();
		const ws = FakeWebSocket.all[0];
		ws.open();
		ws.recv(JSON.stringify({ type: "hello_ack", connectionId: "c", protocolVersion: MULTIDEVICE_PROTOCOL_VERSION }));
		await p;

		const reqP = client.request({ type: "compact" });
		await tick();
		ws.recv(JSON.stringify({ type: "response", id: "req_1", ok: false, error: "no model available" }));

		let err: Error | undefined;
		try {
			await reqP;
		} catch (e) {
			err = e as Error;
		}
		expect(err).toBeInstanceOf(PiServerError);
		expect((err as PiServerError).command).toBe("compact");
		expect((err as PiServerError).serverError).toBe("no model available");
	});

	test("未 open 时 request 立即 reject PiDisconnectedError", async () => {
		const { client } = buildClient();
		let err: Error | undefined;
		try {
			await client.request({ type: "get_state" });
		} catch (e) {
			err = e as Error;
		}
		expect(err).toBeInstanceOf(PiDisconnectedError);
	});
});

// ── 组 3: 请求超时 ──

describe("PiClient 请求超时", () => {
	test("超过 requestTimeoutMs 仍无响应时，reject PiRequestTimeoutError", async () => {
		const { client, clock } = buildClient();
		const p = client.connect();
		await tick();
		const ws = FakeWebSocket.all[0];
		ws.open();
		ws.recv(JSON.stringify({ type: "hello_ack", connectionId: "c", protocolVersion: MULTIDEVICE_PROTOCOL_VERSION }));
		await p;

		const reqP = client.request({ type: "get_state" });
		clock.advance(1_500); // > requestTimeoutMs (1_000)
		let err: Error | undefined;
		try {
			await reqP;
		} catch (e) {
			err = e as Error;
		}
		expect(err).toBeInstanceOf(PiRequestTimeoutError);
		expect((err as PiRequestTimeoutError).command).toBe("get_state");
		expect((err as PiRequestTimeoutError).timeoutMs).toBe(1_000);
	});
});

// ── 组 4: 快照缓存 + subscribe ──

describe("PiClient 快照缓存", () => {
	test("session_snapshot 推送自动缓存，getCachedSnapshot 可读", async () => {
		const { client } = buildClient();
		const snaps: Array<{ id: string; snap: unknown }> = [];
		client.subscribeSnapshot((id, snap) => snaps.push({ id, snap }));

		const p = client.connect();
		await tick();
		const ws = FakeWebSocket.all[0];
		ws.open();
		ws.recv(JSON.stringify({ type: "hello_ack", connectionId: "c", protocolVersion: MULTIDEVICE_PROTOCOL_VERSION }));
		await p;

		ws.recv(
			JSON.stringify({
				type: "push",
				event: { type: "session_snapshot", sessionId: "s1", snapshot: { seq: 1, messages: [] } },
			}),
		);
		ws.recv(
			JSON.stringify({
				type: "push",
				event: { type: "session_snapshot", sessionId: "s1", snapshot: { seq: 2, messages: [{}] } },
			}),
		);

		expect(snaps).toHaveLength(2);
		expect(client.getCachedSnapshot<{ seq: number; messages: unknown[] }>("s1")).toEqual({ seq: 2, messages: [{}] });
	});

	test("progress 推送只进 subscribe 不进 snapshot 缓存", async () => {
		const { client } = buildClient();
		const allEvents: PiClientEventKind[] = [];
		const snapCbs: string[] = [];
		client.subscribe(e => allEvents.push(e));
		client.subscribeSnapshot(id => snapCbs.push(id));

		const p = client.connect();
		await tick();
		const ws = FakeWebSocket.all[0];
		ws.open();
		ws.recv(JSON.stringify({ type: "hello_ack", connectionId: "c", protocolVersion: MULTIDEVICE_PROTOCOL_VERSION }));
		await p;

		ws.recv(
			JSON.stringify({
				type: "push",
				event: { type: "progress", sessionId: "s1", event: { type: "message_update" } },
			}),
		);

		const pushEvents = allEvents.filter(e => e.type === "push");
		expect(pushEvents).toHaveLength(1);
		expect(snapCbs).toHaveLength(0);
		expect(client.getCachedSnapshot("s1")).toBeUndefined();
	});
});

// ── 组 5: 重连 + 断线在途拒绝 ──

describe("PiClient 重连 + 断线在途拒绝", () => {
	test("服务器 close 后：在途请求立即拒 PiDisconnectedError", async () => {
		const { client } = buildClient();
		const p = client.connect();
		await tick();
		const ws = FakeWebSocket.all[0];
		ws.open();
		ws.recv(JSON.stringify({ type: "hello_ack", connectionId: "c", protocolVersion: MULTIDEVICE_PROTOCOL_VERSION }));
		await p;

		const reqP = client.request({ type: "get_state" });
		await tick();
		ws.remoteClose();

		let err: Error | undefined;
		try {
			await reqP;
		} catch (e) {
			err = e as Error;
		}
		expect(err).toBeInstanceOf(PiDisconnectedError);
		expect(client.status).toBe("disconnected");
	});

	test("重连：backoff 时间到后开新 socket，重新 hello；监听器继续生效", async () => {
		const { client, clock } = buildClient();
		const statuses: string[] = [];
		client.subscribe(e => {
			if (e.type === "status") statuses.push(e.status);
		});

		const p = client.connect();
		await tick();
		const ws1 = FakeWebSocket.all[0];
		ws1.open();
		ws1.recv(
			JSON.stringify({ type: "hello_ack", connectionId: "c1", protocolVersion: MULTIDEVICE_PROTOCOL_VERSION }),
		);
		await p;
		expect(client.status).toBe("open");

		ws1.remoteClose();
		expect(client.status).toBe("disconnected");
		expect(FakeWebSocket.all.length).toBe(1);

		// 退避首次：baseMs*2^0 = 100ms
		clock.advance(100);
		await tick();
		expect(FakeWebSocket.all.length).toBe(2);
		const ws2 = FakeWebSocket.all[1];
		ws2.open();
		await tick();
		const hello2 = JSON.parse(ws2.sent[0]);
		expect(hello2.type).toBe("hello");
		ws2.recv(
			JSON.stringify({ type: "hello_ack", connectionId: "c2", protocolVersion: MULTIDEVICE_PROTOCOL_VERSION }),
		);
		await tick();
		expect(client.status).toBe("open");
		expect(client.reconnectAttempt).toBe(0); // 重连成功后归零

		// 保留的 push 订阅在新 socket 上仍能收到
		const snaps: string[] = [];
		client.subscribeSnapshot(id => snaps.push(id));
		ws2.recv(
			JSON.stringify({
				type: "push",
				event: { type: "session_snapshot", sessionId: "s1", snapshot: { seq: 1 } },
			}),
		);
		expect(snaps).toEqual(["s1"]);
	});

	test("backoff 指数递增：失败两次后第三次提交的 timer delay = 400ms", async () => {
		// 重连 base=100 时，attempt=0/1/2 对应 delay 100/200/400
		const { client, clock } = buildClient();
		const p = client.connect();
		await tick();
		const ws1 = FakeWebSocket.all[0];
		ws1.open();
		ws1.recv(JSON.stringify({ type: "hello_ack", connectionId: "c", protocolVersion: MULTIDEVICE_PROTOCOL_VERSION }));
		await p;

		ws1.remoteClose();
		clock.advance(100);
		await tick();
		expect(FakeWebSocket.all.length).toBe(2);
		// 第二个连接失败——不 open 直接 close
		const ws2 = FakeWebSocket.all[1];
		ws2.remoteClose();
		// 下一次退避：baseMs*2^1 = 200ms
		clock.advance(199);
		await tick();
		expect(FakeWebSocket.all.length).toBe(2); // 未到时
		clock.advance(1);
		await tick();
		expect(FakeWebSocket.all.length).toBe(3);
		// 第三次失败
		const ws3 = FakeWebSocket.all[2];
		ws3.remoteClose();
		clock.advance(399);
		await tick();
		expect(FakeWebSocket.all.length).toBe(3);
		clock.advance(1);
		await tick();
		expect(FakeWebSocket.all.length).toBe(4);
		client.close(); // cleanup
	});

	test("close() 后不重连；and 在途请求全拒", async () => {
		const { client, clock } = buildClient();
		const p = client.connect();
		await tick();
		const ws = FakeWebSocket.all[0];
		ws.open();
		ws.recv(JSON.stringify({ type: "hello_ack", connectionId: "c", protocolVersion: MULTIDEVICE_PROTOCOL_VERSION }));
		await p;

		const reqP1 = client.request({ type: "get_state" });
		const reqP2 = client.request({ type: "compact" });
		await tick();

		client.close("user closed");
		for (const req of [reqP1, reqP2]) {
			let err: Error | undefined;
			try {
				await req;
			} catch (e) {
				err = e as Error;
			}
			expect(err).toBeInstanceOf(PiDisconnectedError);
		}

		clock.advance(10_000);
		await tick();
		expect(FakeWebSocket.all.length).toBe(1); // 不重连
		expect(client.status).toBe("closed");
	});
});

// ── 回归：默认 clock 在浏览器式严格 this 下不报 Illegal invocation ──
// fe-dev P3 报雷：旧实现 `this.#clock = options.clock ?? { setTimeout, clearTimeout }` 直接
// shorthand，方法调用形态下 this = clock 对象 → Chrome/Firefox/Safari 拒
// (浏览器 setTimeout 必须 this = window)。Bun/Node 不校验所以测不出。
// 本回归用 mock global setTimeout 模拟严格行为：如果 pi-client 默认 clock 回销了
// this-binding，真请求返回就会在 setTimeout 那行抛而不是正确为 PiRequestTimeoutError。
describe("PiClient 默认 clock browser this-binding 回归", () => {
	test("默认 clock 真发 request timeout，不抛 Illegal invocation", async () => {
		const realSetTimeout = globalThis.setTimeout;
		const realClearTimeout = globalThis.clearTimeout;
		const strictSetTimeout = function (this: unknown, fn: () => void, ms: number): ReturnType<typeof setTimeout> {
			if (this !== globalThis && this !== undefined) throw new TypeError("Illegal invocation");
			return realSetTimeout(fn, ms);
		};
		const strictClearTimeout = function (this: unknown, h: ReturnType<typeof setTimeout>): void {
			if (this !== globalThis && this !== undefined) throw new TypeError("Illegal invocation");
			realClearTimeout(h);
		};
		(globalThis as { setTimeout: typeof setTimeout }).setTimeout = strictSetTimeout as unknown as typeof setTimeout;
		(globalThis as { clearTimeout: typeof clearTimeout }).clearTimeout =
			strictClearTimeout as unknown as typeof clearTimeout;
		try {
			const client = new PiClient({
				url: "ws://test/ws",
				token: "tkn",
				webSocketCtor: FakeWebSocketCtor,
				requestTimeoutMs: 30,
			});
			const p = client.connect();
			await tick();
			const ws = FakeWebSocket.all[0];
			ws.open();
			ws.recv(
				JSON.stringify({ type: "hello_ack", connectionId: "c", protocolVersion: MULTIDEVICE_PROTOCOL_VERSION }),
			);
			await p;

			// 默认 clock 的 setTimeout 会被调用，旧实现 this=clock → 拒 Illegal invocation。
			const reqP = client.request({ type: "get_state" });
			let err: Error | undefined;
			try {
				await reqP;
			} catch (e) {
				err = e as Error;
			}
			// 应当真超时 (PiRequestTimeoutError)，不应当是 Illegal invocation（旧 bug）。
			expect(err).toBeInstanceOf(PiRequestTimeoutError);
			client.close();
		} finally {
			globalThis.setTimeout = realSetTimeout;
			globalThis.clearTimeout = realClearTimeout;
		}
	});
});

// ── 心跳（P3）：30s ping / 60s pong 超时 / 断链重连 ──
describe("PiClient heartbeat", () => {
	async function openClient(overrides: Partial<PiClientOptions> = {}) {
		const clock = new FakeClock();
		let counter = 0;
		const client = new PiClient({
			url: "ws://test/ws",
			token: "tkn",
			webSocketCtor: FakeWebSocketCtor,
			clock: clock.api,
			nextRequestId: () => `req_${++counter}`,
			heartbeatIntervalMs: 30_000,
			heartbeatTimeoutMs: 60_000,
			reconnectBaseMs: 100,
			...overrides,
		});
		const p = client.connect();
		await tick();
		const ws = FakeWebSocket.all.at(-1) as FakeWebSocket;
		ws.open();
		await tick();
		ws.recv(JSON.stringify({ type: "hello_ack", connectionId: "c", protocolVersion: MULTIDEVICE_PROTOCOL_VERSION }));
		await p;
		return { client, clock, ws };
	}

	test("正常：每 30s 发 ping，收到 pong 后排下一个 ping", async () => {
		const { client, clock, ws } = await openClient();
		const sentBefore = ws.sent.length;

		clock.advance(30_000);
		await tick();
		const ping = JSON.parse(ws.sent.at(-1) as string);
		expect(ping.type).toBe("ping");
		expect(typeof ping.ts).toBe("number");

		// 未到 60s 前不会做任何事
		clock.advance(59_999);
		expect(ws.sent.length).toBe(sentBefore + 1); // 仍只有一个 ping

		// 回 pong → 排下一个 ping（再过 30s 又发）
		ws.recv(JSON.stringify({ type: "pong", ts: ping.ts }));
		clock.advance(30_000);
		await tick();
		expect(JSON.parse(ws.sent.at(-1) as string).type).toBe("ping");
		client.close();
	});

	test("超时：ping 后 60s 无 pong → 主动断链 + 进入重连", async () => {
		const { client, clock } = await openClient();
		const errors: Error[] = [];
		client.subscribe(e => {
			if (e.type === "error") errors.push(e.error);
		});

		clock.advance(30_000); // 发 ping
		await tick();
		clock.advance(60_000); // pong 永远不来
		await tick();

		expect(errors.some(e => e.message.includes("no pong"))).toBe(true);
		expect(client.status).toBe("disconnected");
		// 重连已排（backoff 100ms 后开新 socket）
		clock.advance(100);
		await tick();
		expect(FakeWebSocket.all.length).toBe(2);
		client.close();
	});

	test("重连后恢复：新 socket 上心跳重新起算", async () => {
		const { client, clock } = await openClient();

		// 第一条链路死于 pong 超时
		clock.advance(30_000);
		await tick();
		clock.advance(60_000);
		await tick();
		expect(client.status).toBe("disconnected");

		// 重连
		clock.advance(100);
		await tick();
		const ws2 = FakeWebSocket.all.at(-1) as FakeWebSocket;
		ws2.open();
		await tick();
		ws2.recv(
			JSON.stringify({ type: "hello_ack", connectionId: "c2", protocolVersion: MULTIDEVICE_PROTOCOL_VERSION }),
		);
		await tick();
		expect(client.status).toBe("open");

		// 新链路：30s 后发 ping（说明心跳重新起算了）
		clock.advance(30_000);
		await tick();
		const ping = JSON.parse(ws2.sent.at(-1) as string);
		expect(ping.type).toBe("ping");
		client.close();
	});
});
