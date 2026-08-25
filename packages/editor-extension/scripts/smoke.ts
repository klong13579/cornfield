#!/usr/bin/env bun

/**
 * editor-extension 验收冒烟（可在 worktree 内直接跑）：
 *   1. 静态校验壳配置：主题 color-token JSON 合法、omp agent 正规注册三键齐备、
 *      monaco worker 本地化、短 TMPDIR 落地；
 *   2. `omp acp` ACP 握手（initialize → protocolVersion + _ping → pong），
 *      证明「IDE 内与 omp agent 真实对话」的后端传输层可用。
 *
 * ACP 握手依赖 pi_natives 原生 addon（仓库前置构建：bun run build:native）；
 * 缺失时该检查记为 SKIP（非 FAIL），不阻塞其余壳配置校验。
 *
 * 用法（仓库根）：
 *   bun run --cwd=packages/editor-extension smoke
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
const shellDir = path.join(repoRoot, "packages", "editor-extension");
const cliPath = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");

type CheckOutcome = "pass" | "skip";
type Check = { name: string; run: () => Promise<CheckOutcome> };

async function assert(cond: unknown, msg: string): Promise<void> {
	if (!cond) throw new Error(msg);
}

function hasNativeAddon(): boolean {
	const nativeDir = path.join(repoRoot, "packages", "natives", "native");
	try {
		return fs.readdirSync(nativeDir).some(f => /^pi_natives\..*\.node$/.test(f));
	} catch {
		return false;
	}
}

const checks: Check[] = [
	{
		name: "theme color-token JSON 合法（colors + tokenColors + light）",
		run: async () => {
			const t = JSON.parse(
				await Bun.file(path.join(shellDir, "extensions/omp-web-app/omp-web-app-light.json")).text(),
			);
			await assert(t.type === "light", "theme type must be light");
			await assert(typeof t.colors === "object" && t.colors !== null, "colors must be object");
			await assert(Array.isArray(t.tokenColors) && t.tokenColors.length > 0, "tokenColors must be non-empty array");
			await assert(t.colors["editor.background"] === "#fafafa", "canvas token must map to editor.background");
			return "pass";
		},
	},
	{
		name: "omp agent 正规注册三键齐备（defaultType + agent.configs + acp.agents）",
		run: async () => {
			const src = await Bun.file(path.join(shellDir, "src/browser/index.ts")).text();
			await assert(src.includes('"ai.native.agent.defaultType"'), "missing ai.native.agent.defaultType");
			await assert(src.includes('"ai.native.agent.configs"'), "missing ai.native.agent.configs");
			await assert(src.includes('"ai-native.acp.agents"'), "missing ai-native.acp.agents");
			return "pass";
		},
	},
	{
		name: "monaco worker 本地化（MonacoEnvironment + 本地 bundle）",
		run: async () => {
			const src = await Bun.file(path.join(shellDir, "src/browser/monaco-env.ts")).text();
			await assert(src.includes("MonacoEnvironment"), "missing MonacoEnvironment");
			await assert(src.includes("editor.worker.bundle.js"), "missing local worker bundle path");
			return "pass";
		},
	},
	{
		name: "短 TMPDIR 落地（OMP_TMPDIR 切换）",
		run: async () => {
			const src = await Bun.file(path.join(shellDir, "src/node/start-server.ts")).text();
			await assert(src.includes("OMP_TMPDIR"), "missing OMP_TMPDIR");
			await assert(src.includes("process.env.TMPDIR"), "missing TMPDIR override");
			return "pass";
		},
	},
	{
		name: "omp acp ACP 握手（真实对话后端）",
		run: async () => {
			if (!hasNativeAddon()) {
				console.log(`SKIP omp acp ACP 握手（pi_natives 未构建，先 bun run build:native）`);
				return "skip";
			}
			await acpHandshake();
			return "pass";
		},
	},
];

async function acpHandshake(): Promise<void> {
	const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-editor-smoke-sessions-"));
	const proc = Bun.spawn(["bun", cliPath, "acp", "--session-dir", sessionDir], {
		cwd: path.join(repoRoot, "packages", "coding-agent"),
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

	void (async () => {
		for (;;) {
			const { value, done } = await stderrReader.read();
			if (done) break;
			if (value) stderrBuf += decoder.decode(value, { stream: true });
		}
	})();

	type StdinSink = { write(chunk: string): unknown; flush(): unknown };

	const write = (obj: unknown): void => {
		const stdin = proc.stdin as unknown as StdinSink;
		stdin.write(`${JSON.stringify(obj)}\n`);
		void stdin.flush();
	};

	const readLine = async (timeoutMs: number): Promise<Record<string, unknown>> => {
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
				throw new Error(`timeout (stderr tail: ${stderrBuf.slice(-400)})`);
			}
			const { value, done } = await stdoutReader.read();
			if (done) {
				const rest = stdoutBuf.trim();
				if (rest) {
					stdoutBuf = "";
					return JSON.parse(rest) as Record<string, unknown>;
				}
				throw new Error(`stdout closed (stderr tail: ${stderrBuf.slice(-400)})`);
			}
			if (value) stdoutBuf += decoder.decode(value, { stream: true });
		}
	};

	try {
		write({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
		const init = await readLine(90_000);
		await assert(
			init.id === 1 &&
				typeof (init.result as { protocolVersion?: unknown } | undefined)?.protocolVersion === "number",
			`bad initialize response: ${JSON.stringify(init)}`,
		);
		write({ jsonrpc: "2.0", id: 2, method: "_ping", params: {} });
		const pong = await readLine(30_000);
		await assert(
			pong.id === 2 && (pong.result as { pong?: unknown } | undefined)?.pong === true,
			"bad ping response",
		);
	} finally {
		proc.kill();
	}
}

async function main(): Promise<void> {
	let failed = 0;
	let skipped = 0;
	for (const check of checks) {
		try {
			const outcome = await check.run();
			if (outcome === "skip") {
				skipped++;
			} else {
				console.log(`PASS ${check.name}`);
			}
		} catch (err) {
			failed++;
			console.error(`FAIL ${check.name}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	const passed = checks.length - failed - skipped;
	if (failed > 0) {
		console.error(`SMOKE FAIL (${failed}/${checks.length})`);
		process.exit(1);
	}
	console.log(`SMOKE OK (${passed}/${checks.length} passed${skipped > 0 ? `, ${skipped} skipped` : ""})`);
}

main();
