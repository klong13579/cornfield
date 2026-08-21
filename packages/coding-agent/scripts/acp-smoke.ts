#!/usr/bin/env bun

/**
 * `omp acp` stdio 冒烟：spawn `omp acp`，发 initialize 收 response，发 ping 收 pong。
 *
 * 验证 ACP v1 JSON-RPC 2.0 over stdin/stdout 传输层 + 握手（initialize →
 * protocolVersion 协商）+ liveness（ping → pong）已通。
 *
 * 用法（仓库根）：
 *   bun packages/coding-agent/scripts/acp-smoke.ts
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
const cliPath = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");
const codingAgentDir = path.join(repoRoot, "packages", "coding-agent");

const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-acp-smoke-sessions-"));

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

async function readLine(timeoutMs: number): Promise<Record<string, unknown>> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const nl = stdoutBuf.indexOf("\n");
		if (nl >= 0) {
			const line = stdoutBuf.slice(0, nl).trim();
			stdoutBuf = stdoutBuf.slice(nl + 1);
			if (line) return JSON.parse(line) as Record<string, unknown>;
			continue;
		}
		if (Date.now() > deadline) {
			throw new Error(`timeout waiting for JSON-RPC line (stderr tail: ${stderrBuf.slice(-500)})`);
		}
		const { value, done } = await stdoutReader.read();
		if (done) {
			const rest = stdoutBuf.trim();
			if (rest) {
				stdoutBuf = "";
				return JSON.parse(rest) as Record<string, unknown>;
			}
			throw new Error(`stdout closed (exit=${proc.exitCode}, stderr tail: ${stderrBuf.slice(-500)})`);
		}
		if (value) stdoutBuf += decoder.decode(value, { stream: true });
	}
}

try {
	// 1. initialize（握手 + protocolVersion 协商）
	write({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
	const init = await readLine(90_000);
	if (
		init.id !== 1 ||
		typeof (init.result as { protocolVersion?: unknown } | undefined)?.protocolVersion !== "number"
	) {
		throw new Error(`bad initialize response: ${JSON.stringify(init)}`);
	}
	const protocolVersion = (init.result as { protocolVersion: number }).protocolVersion;
	console.log(`PASS initialize → protocolVersion=${protocolVersion}`);

	// 2. ping → pong（liveness）
	write({ jsonrpc: "2.0", id: 2, method: "ping", params: {} });
	const pong = await readLine(30_000);
	if (pong.id !== 2 || (pong.result as { pong?: unknown } | undefined)?.pong !== true) {
		throw new Error(`bad ping response: ${JSON.stringify(pong)}`);
	}
	console.log("PASS ping → pong=true");

	console.log("SMOKE OK");
	proc.kill();
	process.exit(0);
} catch (err) {
	console.error("SMOKE FAIL:", err instanceof Error ? err.message : String(err));
	proc.kill();
	process.exit(1);
}
