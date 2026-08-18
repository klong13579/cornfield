/**
 * UNDO-1 e2e：真实 serve + WS 客户端验证 undo_exchange / fork_from / retry_from。
 *
 * 流程：prompt 两条消息 → undo 第二条（快照回退）→ retry 第一条（重放）→ fork 第一条（新会话）。
 * 用 get_branch_messages 拿 user entryId，session_snapshot 的 messageEntryIds 做断言辅助。
 *
 * 用法：bun run packages/web-app/test/e2e/undo-e2e.ts
 * 依赖：真实 LLM 鉴权。
 */

import { spawn } from "node:child_process";
import * as net from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const cliPath = path.join(repoRoot, "packages/coding-agent/src/cli.ts");

type Frame = Record<string, any>;

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

await waitForOutput(serve, /ws:\/\/127\.0\.0\.1:\d+\/ws/, 90_000, "serve 启动");

const ws = new WebSocket(wsUrl);
const pending = new Map<string, (frame: Frame) => void>();
let reqSeq = 0;
let latestSnapshot: Frame = {};
let messageEndCount = 0;

function request(command: Record<string, unknown>): Promise<Frame> {
	return new Promise((resolve, reject) => {
		const id = `req-${++reqSeq}`;
		pending.set(id, resolve);
		ws.send(JSON.stringify({ id, type: "request", command }));
		setTimeout(() => {
			if (pending.delete(id)) reject(new Error(`命令超时: ${command.type}`));
		}, 60_000);
	});
}

ws.onmessage = (e: MessageEvent) => {
	const frame = JSON.parse(String(e.data)) as Frame;
	if (frame.id && pending.has(frame.id)) {
		pending.get(frame.id)?.(frame);
		pending.delete(frame.id);
		return;
	}
	if (frame.type === "push" && frame.event?.type === "session_snapshot") {
		latestSnapshot = frame.event.snapshot ?? {};
	}
	if (frame.type === "push" && frame.event?.type === "progress" && frame.event.event?.type === "message_end") {
		messageEndCount += 1;
		console.log(`[e2e] message_end #${messageEndCount}`);
	}
};

await new Promise<void>((resolve, reject) => {
	ws.onopen = () => {
		ws.send(JSON.stringify({ id: "hello-1", type: "hello", token: "", version: 1 }));
		resolve();
	};
	ws.onerror = reject;
	setTimeout(() => reject(new Error("WS 连接超时")), 10_000);
});

// 等 messageEntryIds 字段就绪（收到首个含消息的 session_snapshot）
async function waitSnapshot(): Promise<void> {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		if (latestSnapshot.messages?.length > 0) return;
		await Bun.sleep(200);
	}
	throw new Error("等待 session_snapshot 超时");
}

async function userEntryIds(): Promise<Array<{ entryId: string; text: string }>> {
	const resp = await request({ type: "get_branch_messages" });
	return (resp.result?.messages ?? []) as Array<{ entryId: string; text: string }>;
}

async function latestUserCount(): Promise<number> {
	await waitSnapshot();
	return (latestSnapshot.messages as Array<{ role: string }>).filter(m => m.role === "user").length;
}
async function waitForUserCount(n: number, timeoutMs = 60_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const users = ((latestSnapshot.messages ?? []) as Array<{ role: string }>).filter(m => m.role === "user").length;
		if (users === n && !latestSnapshot.isStreaming) return;
		await Bun.sleep(200);
	}
	async function waitForTurn(target: number, timeoutMs = 60_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (messageEndCount >= target) return;
			await Bun.sleep(200);
		}
		throw new Error(`等待 message_end ${target} 超时（当前 ${messageEndCount}）`);
	}

	throw new Error(`等待 user 数 = ${n} 超时`);
}

const results: string[] = [];
const assert = (cond: boolean, label: string): void => {
	results.push(`${cond ? "PASS" : "FAIL"}: ${label}`);
	if (!cond) console.error(`[e2e] FAIL: ${label}`);
};

// 1. 两条 prompt
await request({ type: "prompt", message: "请回复：第一条测试消息。" });
await waitForTurn(2);
const entries1 = await userEntryIds();
assert(entries1.length === 1, `第一条 user entry 数 = 1（实际 ${entries1.length}）`);
const entry1 = entries1[0]?.entryId ?? "";

await request({ type: "prompt", message: "请回复：第二条测试消息。" });
await waitForTurn(4);
const entries2 = await userEntryIds();
assert(entries2.length === 2, `第二条后 user entry 数 = 2（实际 ${entries2.length}）`);
const entry2 = entries2[1]?.entryId ?? "";

// 2. undo_exchange 第二条 → 回退到 1 条 user
const undoResp = await request({ type: "undo_exchange", entryId: entry2 });
assert(undoResp.ok !== false, `undo_exchange ok（${JSON.stringify(undoResp.error ?? "ok")}）`);
await waitForUserCount(1);
const userCountAfterUndo = await latestUserCount();
assert(userCountAfterUndo === 1, `undo 后 user 数 = 1（实际 ${userCountAfterUndo}）`);

// 3. retry_from 第一条 → 重放（重新 prompt）
const retryResp = await request({ type: "retry_from", entryId: entry1 });
assert(retryResp.ok !== false, `retry_from ok（${JSON.stringify(retryResp.error ?? "ok")}）`);
await new Promise(r => setTimeout(r, 1500));

// 4. fork_from 第一条 → 新会话 id 变化
const forkResp = await request({ type: "fork_from", entryId: entry1 });
const forkResult = (forkResp.result ?? {}) as { cancelled?: boolean; sessionId?: string };
assert(forkResp.ok !== false, `fork_from ok（${JSON.stringify(forkResp.error ?? "ok")}）`);
assert(!forkResult.cancelled, "fork_from 未取消");
assert(
	typeof forkResult.sessionId === "string" && forkResult.sessionId.length > 0,
	`fork 返回 sessionId（${forkResult.sessionId ?? "无"}）`,
);

console.log("");
for (const r of results) console.log(`[e2e] ${r}`);
const failed = results.filter(r => r.startsWith("FAIL")).length;
console.log(`[e2e] 结果: ${results.length - failed}/${results.length} 通过`);

ws.close();
serve.kill("SIGTERM");
process.exit(failed > 0 ? 1 : 0);
