/**
 * W3 D3 e2e — serve `get_memory` 只读记忆投影（真实 serve 子进程 + bun WS 客户端）。
 *
 * 预置：$HOME/.omp/user.md（user 区）+ $HOME/agent/memories/<encoded-cwd>/ 下 MEMORY.md
 * / memory_summary.md（project 区）；memory 区为空的 self-evolution 库（断言形状 + 空态）。
 *
 * 验证：
 *   1. 三分区结构齐全（user/project/memoryStore）
 *   2. user 区内容与路径正确
 *   3. project 区：memoryRoot 解析 + MEMORY.md / memory_summary.md 内容；未 seed raw 为 null
 *   4. memoryStore 形状（dbPath/sections/totalEntries）——隔离 HOME 下 0 条不崩
 *   5. 只读：不依赖 attached session（registry 级命令可直接调）
 *
 * 隔离 HOME：避免读真机记忆库/写坏真实 evolution.db。不触发 LLM 计费。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MULTIDEVICE_PROTOCOL_VERSION } from "@oh-my-pi/pi-wire";

const URL_RE = /ws:\/\/127\.0\.0\.1:(\d+)\/ws(\?token=([a-zA-Z0-9]+))?/;

type Frame = { type: string; [k: string]: unknown };

/** 与 self-evolution paths.encodeProjectPathForGlobalMemory 同规则。 */
function encodeProjectPath(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

let isolatedHome: string;
let savedHome: string | undefined;
let proc: ReturnType<typeof Bun.spawn> | undefined;
let url = "";
let serveCwd = "";
let repoRoot: string;

async function waitForServe(p: ReturnType<typeof Bun.spawn>): Promise<string> {
	const deadline = Date.now() + 30_000;
	const reader = (p.stdout as ReadableStream<Uint8Array>).getReader();
	const dec = new TextDecoder();
	let buf = "";
	while (Date.now() < deadline) {
		const { value, done } = await reader.read();
		if (done) throw new Error(`serve exited; log:\n${buf.slice(-1500)}`);
		buf += dec.decode(value);
		const m = buf.match(URL_RE);
		if (m) {
			reader.releaseLock();
			return m[0];
		}
	}
	reader.releaseLock();
	throw new Error(`serve not ready; log:\n${buf.slice(-1500)}`);
}

async function connect(wsUrl: string): Promise<WebSocket> {
	const ws = new WebSocket(wsUrl);
	await new Promise<void>((resolve, reject) => {
		ws.onopen = () => resolve();
		ws.onerror = e => reject(new Error(`ws error: ${String(e)}`));
	});
	const token = wsUrl.match(/token=([a-zA-Z0-9]+)/)?.[1] ?? "";
	ws.send(JSON.stringify({ type: "hello", version: MULTIDEVICE_PROTOCOL_VERSION, token }));
	const ack = await nextFrame(ws, f => f.type === "hello_ack", 10_000);
	if (!ack) throw new Error("no hello_ack");
	return ws;
}

let seq = 0;
async function request(ws: WebSocket, command: Record<string, unknown>): Promise<unknown> {
	const id = `q${++seq}`;
	ws.send(JSON.stringify({ type: "request", id, command: { ...command, id } }));
	const f = await nextFrame(ws, fr => fr.type === "response" && fr.id === id, 30_000);
	if (!f) throw new Error(`timeout: ${command.type}`);
	if (f.ok !== true) throw new Error(`command failed: ${JSON.stringify(f)}`);
	return (f as { result?: unknown }).result;
}

function nextFrame(ws: WebSocket, pred: (f: Frame) => boolean, timeoutMs: number): Promise<Frame | undefined> {
	return new Promise(resolve => {
		const timer = setTimeout(() => {
			ws.removeEventListener("message", onMessage as EventListener);
			resolve(undefined);
		}, timeoutMs);
		const onMessage = (ev: MessageEvent) => {
			const frame = JSON.parse(String(ev.data)) as Frame;
			if (!pred(frame)) return;
			clearTimeout(timer);
			ws.removeEventListener("message", onMessage as EventListener);
			resolve(frame);
		};
		ws.addEventListener("message", onMessage as EventListener);
	});
}

interface MemoryFileDto {
	path: string;
	content: string;
	truncated: boolean;
}

interface MemoryResult {
	user: MemoryFileDto | null;
	project: {
		memoryRoot: string;
		memoryMd: MemoryFileDto | null;
		summaryMd: MemoryFileDto | null;
		rawMd: MemoryFileDto | null;
	} | null;
	memoryStore: { dbPath: string; sections: { namespace: string; entries: unknown[] }[]; totalEntries: number };
}

describe("W3 D3 — serve get_memory 只读记忆投影", () => {
	test("get_memory: 三分区结构 + user/project 内容 + memory 区形状", async () => {
		const ws = await connect(url);
		try {
			const result = (await request(ws, { type: "get_memory" })) as MemoryResult;

			// 结构
			expect(typeof result).toBe("object");
			expect(result.user).not.toBeNull();
			expect(result.project).not.toBeNull();
			expect(typeof result.memoryStore).toBe("object");

			// user 区：seeded user.md
			expect(result.user?.path.endsWith("user.md")).toBe(true);
			expect(result.user?.content).toContain("测试用户画像");

			// project 区：canonical evolution 目录为空时回落到旧版扁平目录（agentDir/memories）——
			// 真机目前记忆投影在扁平目录，fallback 即生产路径。memoryRoot 应指向 seed 的扁平目录。
			expect(result.project?.memoryRoot).toBe(
				path.join(isolatedHome, ".omp", "agent", "memories", encodeProjectPath(repoRoot)),
			);
			expect(result.project?.memoryMd?.content).toContain("项目记忆 seed");
			expect(result.project?.summaryMd?.content).toContain("summary seed");
			expect(result.project?.rawMd).toBeNull();

			// memory 区：形状齐全；隔离 HOME 下 0 条不崩
			expect(typeof result.memoryStore.dbPath).toBe("string");
			expect(Array.isArray(result.memoryStore.sections)).toBe(true);
			expect(typeof result.memoryStore.totalEntries).toBe("number");
			expect(result.memoryStore.totalEntries).toBe(0);
		} finally {
			ws.close();
		}
	});

	test("get_memory: 不依赖 attached session（registry 级命令可直接调，幂等）", async () => {
		const ws = await connect(url);
		try {
			const again = (await request(ws, { type: "get_memory" })) as MemoryResult;
			expect(again.user?.content).toContain("测试用户画像");
			expect(again.memoryStore.totalEntries).toBe(0);
		} finally {
			ws.close();
		}
	});
});

beforeAll(async () => {
	isolatedHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-serve-memory-"));
	savedHome = process.env.HOME;
	process.env.HOME = isolatedHome;

	// user 区 seed：~/.omp/user.md
	await fs.mkdir(path.join(isolatedHome, ".omp"), { recursive: true });
	await Bun.write(
		path.join(isolatedHome, ".omp", "user.md"),
		"# 测试用户画像\n\n- name: 测试用户\n- note: seed content for wire e2e\n",
	);

	repoRoot = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
	serveCwd = `${repoRoot}/packages/coding-agent`;

	// project 区 seed：$HOME/agent/memories/<encoded-cwd>/{MEMORY.md, memory_summary.md}
	// serve 启动时会把 cwd 提升到 git 仓库根（resolveServeProjectRoot），
	// 记忆投影锚定 process.cwd()（仓库根），seed 必须用仓库根的 encoded。
	const memoryRoot = path.join(isolatedHome, ".omp", "agent", "memories", encodeProjectPath(repoRoot));
	await fs.mkdir(memoryRoot, { recursive: true });
	await Bun.write(path.join(memoryRoot, "MEMORY.md"), "# Memory Report\n\n## project\n\n- 项目记忆 seed\n");
	await Bun.write(path.join(memoryRoot, "memory_summary.md"), "# Memory Summary\n\n- summary seed\n");

	const port = 57000 + Math.floor(Math.random() * 8000);
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
			cwd: serveCwd,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, HOME: isolatedHome, PI_NO_TITLE: "1" },
		},
	);
	url = await waitForServe(proc);
}, 30_000);

afterAll(async () => {
	if (proc) {
		proc.kill();
		await proc.exited;
	}
	if (savedHome !== undefined) process.env.HOME = savedHome;
	await fs.rm(isolatedHome, { recursive: true, force: true });
});
