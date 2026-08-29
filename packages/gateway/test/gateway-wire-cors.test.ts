/**
 * P2-4 — gateway 生产 wire 端点的 CORS（浏览器 web-app 直连）：
 * - OPTIONS preflight → 204 + allow-origin/allow-methods/allow-headers
 * - POST /wire 及错误分支（404/400）响应统一带 access-control-allow-origin
 *
 * 真实 Gateway 起服（临时 dataDir + 随机 wire 端口），bridge 用 fake wire 脚本
 * （hello 握手即可，端点不依赖 bridge 健康）。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Gateway } from "../src/gateway";

/** 最小 wire-stdio 假进程：hello 握手 + 任一 request 回 ok。 */
const FAKE_WIRE_SCRIPT = `#!/usr/bin/env bun
let buffer = "";
function emit(value) {
  process.stdout.write(JSON.stringify(value) + "\\n");
}
async function handleFrame(frame) {
  if (frame.type === "hello") {
    emit({ type: "hello_ack", connectionId: "cors-test", protocolVersion: 1 });
    return;
  }
  if (frame.type !== "request") return;
  emit({ type: "response", id: frame.id, ok: true, result: {} });
}
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk);
  let index = buffer.indexOf("\\n");
  while (index !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) await handleFrame(JSON.parse(line));
    index = buffer.indexOf("\\n");
  }
}
`;

describe("gateway wire endpoint CORS", () => {
	let tmpDir: string;
	let fakePath: string;
	let port: number;
	let gateway: Gateway | undefined;
	let savedPort: string | undefined;

	function makeGateway(): Gateway {
		return new Gateway({
			channels: {},
			dataDir: tmpDir,
			agent: { ompPath: fakePath },
			intercomDir: path.join(tmpDir, "intercom"),
		});
	}

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-wire-cors-"));
		fakePath = path.join(tmpDir, "fake-wire");
		await Bun.write(fakePath, FAKE_WIRE_SCRIPT);
		await fs.chmod(fakePath, 0o755);
		port = 49000 + Math.floor(Math.random() * 2000);
		savedPort = process.env.OMP_GATEWAY_WIRE_PORT;
		process.env.OMP_GATEWAY_WIRE_PORT = String(port);
	});

	afterEach(async () => {
		if (gateway) await gateway.stop();
		gateway = undefined;
		if (savedPort === undefined) delete process.env.OMP_GATEWAY_WIRE_PORT;
		else process.env.OMP_GATEWAY_WIRE_PORT = savedPort;
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	test("OPTIONS preflight → 204 + CORS 头", async () => {
		gateway = makeGateway();
		await gateway.start();
		const res = await fetch(`http://127.0.0.1:${port}/wire`, { method: "OPTIONS" });
		expect(res.status).toBe(204);
		expect(res.headers.get("access-control-allow-origin")).toBe("*");
		expect(res.headers.get("access-control-allow-methods")).toContain("POST");
		expect(res.headers.get("access-control-allow-headers")).toBe("content-type");
	});

	test("POST /wire 响应带 allow-origin（浏览器跨源可读）", async () => {
		gateway = makeGateway();
		await gateway.start();
		const res = await fetch(`http://127.0.0.1:${port}/wire`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ type: "get_cron_tasks" }),
		});
		// CORS 头是本测试目标（浏览器跨源可读）——所有响应都带。
		expect(res.headers.get("access-control-allow-origin")).toBe("*");
		// 200/503 取决于测试 config 是否启用 cron（storage 初始化）；
		// 200 时顺带断言数据形状（cron.enabled 生产网关已实机验证）。
		if (res.ok) {
			const data = (await res.json()) as { ok?: boolean; result?: { tasks?: unknown[] } };
			expect(data.ok).toBe(true);
			expect(Array.isArray(data.result?.tasks)).toBe(true);
		}
	});

	test("404/400 错误分支也带 CORS 头", async () => {
		gateway = makeGateway();
		await gateway.start();
		const notFound = await fetch(`http://127.0.0.1:${port}/other`);
		expect(notFound.status).toBe(404);
		expect(notFound.headers.get("access-control-allow-origin")).toBe("*");

		const badJson = await fetch(`http://127.0.0.1:${port}/wire`, { method: "POST", body: "not-json" });
		expect(badJson.status).toBe(400);
		expect(badJson.headers.get("access-control-allow-origin")).toBe("*");
	});
});
