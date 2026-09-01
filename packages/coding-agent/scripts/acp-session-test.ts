#!/usr/bin/env bun
/**
 * `omp acp` 会话流冒烟：initialize → newSession → prompt → 收 agent 消息/完成响应 → session/close。
 *
 * 验证对话级闭环（agent 收到消息、流式返回、会话关闭）。不依赖真实 LLM ——
 * prompt 用 ACP 内置 /help 命令（同步路由，不走模型），既测完整会话生命周期又保持确定性。
 *
 * 用法（仓库根）：
 *   bun packages/coding-agent/scripts/acp-session-test.ts
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
const cliPath = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");
const codingAgentDir = path.join(repoRoot, "packages", "coding-agent");

const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-acp-session-"));
const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-acp-ws-"));

const proc = Bun.spawn(["bun", cliPath, "acp", "--session-dir", sessionDir], {
	cwd: codingAgentDir,
	stdin: "pipe",
	stdout: "pipe",
	stderr: "pipe",
	env: { ...process.env, PI_NO_TITLE: "1" },
});

const decoder = new TextDecoder();
let stdoutBuf = "";
let stderrBuf = "";
const stdoutReader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
const stderrReader = (proc.stderr as ReadableStream<Uint8Array>).getReader();

// 后台 drain stderr，避免子进程写满 stderr 管道卡死（失败诊断用）。
void (async () => {
	for (;;) {
		const { value, done } = await stderrReader.read();
		if (done) break;
		if (value) stderrBuf += decoder.decode(value, { stream: true });
	}
})();

type StdinSink = { write(chunk: string): unknown; flush(): unknown };

function write(obj: unknown): void {
	const stdin = proc.stdin as unknown as StdinSink;
	stdin.write(`${JSON.stringify(obj)}\n`);
	void stdin.flush();
}

interface Frame {
	jsonrpc?: string;
	id?: number | string;
	method?: string;
	result?: unknown;
	error?: unknown;
	params?: unknown;
}

async function readLine(timeoutMs: number): Promise<Frame> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const nl = stdoutBuf.indexOf("\n");
		if (nl >= 0) {
			const line = stdoutBuf.slice(0, nl).trim();
			stdoutBuf = stdoutBuf.slice(nl + 1);
			if (line) return JSON.parse(line) as Frame;
			continue;
		}
		if (Date.now() > deadline) {
			throw new Error(`timeout waiting for frame (stderr tail: ${stderrBuf.slice(-500)})`);
		}
		const { value, done } = await stdoutReader.read();
		if (done) {
			const rest = stdoutBuf.trim();
			if (rest) {
				stdoutBuf = "";
				return JSON.parse(rest) as Frame;
			}
			throw new Error(`stdout closed (exit=${proc.exitCode}, stderr tail: ${stderrBuf.slice(-500)})`);
		}
		if (value) stdoutBuf += decoder.decode(value, { stream: true });
	}
}

/** 发一个 JSON-RPC 请求并读取到对应 id 的响应，沿途收集通知（session/update 等）。 */
async function request(
	id: number,
	method: string,
	params: unknown,
	timeoutMs: number,
): Promise<{ response: Frame; notifications: Frame[] }> {
	write({ jsonrpc: "2.0", id, method, params });
	const notifications: Frame[] = [];
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			throw new Error(`timeout waiting for response to ${method} (notifications=${notifications.length})`);
		}
		const frame = await readLine(remaining);
		if (frame.id === id) {
			return { response: frame, notifications };
		}
		if (frame.method !== undefined && frame.id === undefined) {
			notifications.push(frame);
		}
	}
}

function fail(message: string): never {
	throw new Error(message);
}

try {
	// 1. initialize（握手 + protocolVersion 协商）
	const init = await request(1, "initialize", { protocolVersion: 1 }, 90_000);
	const initResult = init.response.result as { protocolVersion?: unknown } | undefined;
	if (typeof initResult?.protocolVersion !== "number") {
		fail(`bad initialize response: ${JSON.stringify(init.response)}`);
	}
	console.log(`PASS initialize → protocolVersion=${initResult.protocolVersion}`);

	// 2. initialized 通知（握手第二步，无响应）
	write({ jsonrpc: "2.0", method: "initialized", params: {} });

	// 3. newSession（cwd 必须绝对路径）
	const ns = await request(2, "session/new", { cwd: workspaceDir, mcpServers: [] }, 60_000);
	const nsResult = ns.response.result as { sessionId?: unknown } | undefined;
	const sessionId = nsResult?.sessionId;
	if (typeof sessionId !== "string" || sessionId.length === 0) {
		fail(`bad newSession response: ${JSON.stringify(ns.response)}`);
	}
	console.log(`PASS newSession → sessionId=${sessionId}`);

	// 4. prompt（/help 同步路由，不走 LLM；agent 以 agent_message_chunk 流式返回，再完成）
	const pr = await request(3, "session/prompt", { sessionId, prompt: [{ type: "text", text: "/help" }] }, 60_000);
	const prResult = pr.response.result as { stopReason?: unknown } | undefined;
	if (prResult?.stopReason !== "end_turn") {
		fail(`bad prompt response: ${JSON.stringify(pr.response)}`);
	}
	const messageChunks = pr.notifications.filter(n => {
		const update = (n.params as { update?: { sessionUpdate?: string } } | undefined)?.update;
		return n.method === "session/update" && update?.sessionUpdate === "agent_message_chunk";
	});
	if (messageChunks.length === 0) {
		fail(`no agent_message_chunk received (notifications=${JSON.stringify(pr.notifications)})`);
	}
	const helpText = messageChunks
		.map(n => (n.params as { update: { content?: { text?: string } } }).update.content?.text ?? "")
		.join("");
	if (!helpText.includes("CornField")) {
		fail(`agent message missing expected help text (head: ${helpText.slice(0, 200)})`);
	}
	console.log(`PASS prompt → stopReason=${prResult.stopReason}, agent_message_chunks=${messageChunks.length}`);

	// 5. session/close
	const cl = await request(4, "session/close", { sessionId }, 30_000);
	if (cl.response.error) {
		fail(`session/close failed: ${JSON.stringify(cl.response)}`);
	}
	console.log("PASS session/close");

	console.log("SESSION FLOW OK");
	proc.kill();
	process.exit(0);
} catch (err) {
	console.error("SESSION FLOW FAIL:", err instanceof Error ? err.message : String(err));
	proc.kill();
	process.exit(1);
}
