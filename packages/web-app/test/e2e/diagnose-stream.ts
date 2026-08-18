/**
 * STREAM-1 诊断脚本：起真实 serve + WS 客户端直接听 progress 帧，
 * 绕过 web-app UI，确认 progress 帧里 message_update 的字段名
 * （assistantMessageEvent vs assistantEvent）。
 *
 * 用法：E2E=1 bun run packages/web-app/test/e2e/diagnose-stream.ts
 * 依赖：真实 LLM 鉴权（本机 ~/.omp/agent/auth.db 或环境 API key）。
 */

import { spawn } from "node:child_process";
import * as net from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const cliPath = path.join(repoRoot, "packages/coding-agent/src/cli.ts");

function freePort(): Promise<number> {
	return new Promise(resolve => {
		const srv = net.createServer();
		srv.listen(0, "127.0.0.1", () => {
			const port = (srv.address() as net.AddressInfo).port;
			srv.close(() => resolve(port));
		});
	});
}

function waitForOutput(
	proc: ReturnType<typeof spawn>,
	matcher: RegExp,
	timeoutMs: number,
	label: string,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${label} 超时`)), timeoutMs);
		const onData = (buf: Buffer) => {
			if (matcher.test(buf.toString())) {
				clearTimeout(timer);
				proc.stdout?.removeListener("data", onData);
				proc.stderr?.removeListener("data", onData);
				resolve();
			}
		};
		proc.stdout?.on("data", onData);
		proc.stderr?.on("data", onData);
	});
}

const port = await freePort();
const wsUrl = `ws://127.0.0.1:${port}/ws`;

const serve = spawn("bun", [cliPath, "serve", "--port", String(port), "--host", "127.0.0.1", "--no-extensions"], {
	env: { ...process.env, PI_NO_TITLE: "1" },
	stdio: ["ignore", "pipe", "pipe"],
});

await waitForOutput(serve, /ws:\/\/127\.0\.0\.1:\d+\/ws/, 30_000, "serve 启动");

const progressSamples: Array<Record<string, unknown>> = [];
let sawProgressMessageUpdate = false;

const ws = new WebSocket(wsUrl);

ws.onopen = () => {
	console.log("[diagnose] WS open");
	ws.send(JSON.stringify({ id: "hello-1", type: "hello", token: "", version: 1 }));
	ws.send(
		JSON.stringify({
			id: "prompt-1",
			type: "request",
			command: {
				type: "prompt",
				message: "请回复：流式诊断测试。",
			},
		}),
	);
};

ws.onmessage = (e: MessageEvent) => {
	let frame: { type?: string; id?: string; event?: Record<string, unknown>; ok?: boolean } = {};
	try {
		frame = JSON.parse(String(e.data));
	} catch {
		return;
	}
	if (frame.type === "hello_error") {
		console.log("[diagnose] hello_error:", JSON.stringify(frame));
		return;
	}
	if (frame.type === "hello_ack") {
		console.log("[diagnose] hello_ack received");
		return;
	}
	if (frame.type === "push" && frame.event) {
		const evt = frame.event as Record<string, unknown>;
		console.log("[diagnose] push event type:", evt.type);
		if (evt.type === "progress" && evt.event) {
			const inner = evt.event as Record<string, unknown>;
			console.log("[diagnose]   progress inner type:", inner.type, "| keys:", Object.keys(inner));
			if (inner.type === "message_update") {
				sawProgressMessageUpdate = true;
				progressSamples.push({
					hasAssistantEvent: "assistantEvent" in inner,
					hasAssistantMessageEvent: "assistantMessageEvent" in inner,
				});
			}
		}
		return;
	}
	if (frame.type === "response" || frame.type === "error") {
		console.log("[diagnose] cmd response:", JSON.stringify(frame));
	}
};

ws.onclose = () => {
	console.log("[diagnose] WS close");
};

ws.onerror = () => {
	console.error("[diagnose] WS error");
	process.exit(2);
};

// 等 progress 帧（最多 60s）
const deadline = Date.now() + 60_000;
while (Date.now() < deadline && !sawProgressMessageUpdate) {
	await Bun.sleep(200);
}

console.log("");
console.log("[diagnose] 结论：");
console.log("  - 收到 progress message_update:", sawProgressMessageUpdate);
if (progressSamples.length > 0) {
	const first = progressSamples[0];
	console.log("  - 首帧字段:", JSON.stringify(first));
	const allHaveAssistantMessageEvent = progressSamples.every(s => s.hasAssistantMessageEvent === true);
	console.log("  - 全部帧含 assistantMessageEvent:", allHaveAssistantMessageEvent);
}

ws.close();
serve.kill("SIGTERM");
process.exit(0);
