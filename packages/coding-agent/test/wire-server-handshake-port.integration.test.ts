/**
 * F7 服务端侧：握手把 gateway 的 wire 端口报给客户端。
 *
 * 症状：浏览器读不到 `CORNFIELD_GATEWAY_WIRE_PORT`，于是 web-app 自己写死 `127.0.0.1:7892` ——
 * 用隔离 HOME 起的 serve 里打开页面，前端照样连到本机**真实运营中**的 gateway（实测页面上显示了
 * 真实 gateway 的 pid）。修法：serve 在 `hello_ack` 里报它自己用的那个端口（与 `callGatewayWire`
 * 同一个值），客户端照用。
 *
 * 这条用例钉住的是「serve 真的报」——声明了字段但没人填，是客户端最容易被骗到的那种契约。
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { MULTIDEVICE_PROTOCOL_VERSION } from "@cornfield/wire";
import { waitForServe } from "./wait-for-serve";

/** 一个刻意不是 7892 的端口：断言它来自 env，而不是某个写死的缺省。 */
const PORT_FROM_ENV = 7899;

let isolatedHome: string;
let savedHome: string | undefined;
let proc: ReturnType<typeof Bun.spawn> | undefined;
let info = { url: "", token: "" };

beforeAll(async () => {
	isolatedHome = await fs.mkdtemp(path.join(os.tmpdir(), "cf-hello-port-"));
	savedHome = process.env.HOME;
	process.env.HOME = isolatedHome;
	const cwd = path.join(isolatedHome, "project");
	await fs.mkdir(cwd, { recursive: true });

	const repoRoot = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
	const port = await new Promise<number>(resolve => {
		const srv = net.createServer();
		srv.listen(0, "127.0.0.1", () => {
			const p = (srv.address() as net.AddressInfo).port;
			srv.close(() => resolve(p));
		});
	});
	proc = Bun.spawn(
		[
			"bun",
			`${repoRoot}/packages/coding-agent/src/cli.ts`,
			"serve",
			"--port",
			String(port),
			"--host",
			"127.0.0.1",
			"--no-extensions",
		],
		{
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				HOME: isolatedHome,
				PI_NO_TITLE: "1",
				CORNFIELD_GATEWAY_WIRE_PORT: String(PORT_FROM_ENV),
			},
		},
	);
	info = await waitForServe(proc, port);
}, 70_000);

afterAll(async () => {
	if (proc) {
		proc.kill();
		await proc.exited;
	}
	if (savedHome !== undefined) process.env.HOME = savedHome;
	await fs.rm(isolatedHome, { recursive: true, force: true });
});

describe("hello_ack 的 gatewayWirePort", () => {
	test("报的是 serve 自己解析出来的端口（本轮从 env 来）", async () => {
		const ws = new WebSocket(info.url);
		const frames: Array<Record<string, unknown>> = [];
		try {
			await new Promise<void>((resolve, reject) => {
				ws.addEventListener("open", () => resolve());
				ws.addEventListener("error", () => reject(new Error("ws error")));
			});
			ws.addEventListener("message", ev => {
				frames.push(JSON.parse(String(ev.data)) as Record<string, unknown>);
			});
			ws.send(JSON.stringify({ type: "hello", version: MULTIDEVICE_PROTOCOL_VERSION, token: "" }));

			// 等 hello_ack（握手后的列表/快照帧会在它之后到，所以只挑这一帧）
			const deadline = Date.now() + 10_000;
			let ack = frames.find(f => f.type === "hello_ack");
			while (!ack && Date.now() < deadline) {
				await Bun.sleep(50);
				ack = frames.find(f => f.type === "hello_ack");
			}
			expect(ack, `收到的帧：${JSON.stringify(frames.map(f => f.type))}`).toBeDefined();
			expect(ack?.gatewayWirePort).toBe(PORT_FROM_ENV);
		} finally {
			ws.close();
		}
	}, 30_000);
});
