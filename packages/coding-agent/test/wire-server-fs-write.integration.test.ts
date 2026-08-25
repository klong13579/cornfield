import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { PiClient } from "@oh-my-pi/pi-client";

/**
 * 票 01 e2e — serve `fs_write` / `fs_edit` / `fs_diff`（真实 serve 子进程 + pi-client）。
 * 隔离 HOME + 临时项目 cwd（不污染仓库）；不触发 LLM。
 *
 * 验证：整段写可回读、replace 精确编辑、before/after 统一 diff、路径越界拒绝与 read 侧一致。
 */
const URL_RE = /ws:\/\/127\.0\.0\.1:(\d+)\/ws(\?token=([a-zA-Z0-9]+))?/;

let isolatedHome: string;
let projectCwd: string;
let savedHome: string | undefined;
let proc: ReturnType<typeof Bun.spawn> | undefined;
let serveInfo: { url: string; token: string } = { url: "", token: "" };

async function waitForServe(p: ReturnType<typeof Bun.spawn>): Promise<{ url: string; token: string }> {
	const deadline = Date.now() + 60_000;
	const reader = (p.stdout as ReadableStream<Uint8Array>).getReader();
	const dec = new TextDecoder();
	let buf = "";
	while (Date.now() < deadline) {
		const { value, done } = await reader.read();
		if (done) throw new Error(`serve exited before ready; log:\n${buf.slice(-1500)}`);
		buf += dec.decode(value);
		const m = buf.match(URL_RE);
		if (m) {
			reader.releaseLock();
			return { url: `ws://127.0.0.1:${m[1]}/ws${m[2] ?? ""}`, token: m[3] ?? "" };
		}
	}
	reader.releaseLock();
	throw new Error(`serve not ready within 60s; log:\n${buf.slice(-1500)}`);
}

beforeAll(async () => {
	isolatedHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-serve-fswrite-"));
	savedHome = process.env.HOME;
	process.env.HOME = isolatedHome;
	projectCwd = path.join(isolatedHome, "project");
	await fs.mkdir(projectCwd, { recursive: true });
	await Bun.write(path.join(projectCwd, "hello.txt"), "hello world\n");

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
			cwd: projectCwd,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, HOME: isolatedHome, PI_NO_TITLE: "1" },
		},
	);
	serveInfo = await waitForServe(proc);
}, 70_000);

afterAll(async () => {
	if (proc) {
		proc.kill();
		await proc.exited;
	}
	if (savedHome !== undefined) process.env.HOME = savedHome;
	await fs.rm(isolatedHome, { recursive: true, force: true });
});

async function withClient<T>(fn: (client: PiClient) => Promise<T>): Promise<T> {
	const client = new PiClient({ url: serveInfo.url, token: serveInfo.token, autoReconnect: false });
	await client.connect();
	try {
		return await fn(client);
	} finally {
		client.close();
	}
}

describe("fs 写命令面（fs_write / fs_edit / fs_diff）", () => {
	test("fs_write 整段写 + 磁盘回读", async () => {
		await withClient(async client => {
			const res = await client.request<{ path: string; bytesWritten: number }>({
				type: "fs_write",
				path: "out.txt",
				content: "one\ntwo\nthree\n",
			});
			expect(res.path).toBe("out.txt");
			expect(res.bytesWritten).toBe("one\ntwo\nthree\n".length);

			const onDisk = await Bun.file(path.join(projectCwd, "out.txt")).text();
			expect(onDisk).toBe("one\ntwo\nthree\n");
		});
	});

	test("fs_write 路径越界拒绝（与 read 侧 sandbox 一致）", async () => {
		await withClient(async client => {
			const bad = await client
				.request({
					type: "fs_write",
					path: "../../outside.txt",
					content: "nope",
				})
				.then(
					r => ({ ok: true as const, r }),
					err => ({ ok: false as const, err }),
				);
			expect(bad.ok).toBe(false);
		});
	});

	test("fs_edit replace 精确编辑 + 磁盘回读", async () => {
		await withClient(async client => {
			const res = await client.request<{ path: string; mode: string; diff: string }>({
				type: "fs_edit",
				path: "hello.txt",
				mode: "replace",
				edits: [{ old_text: "world", new_text: "omp" }],
			});
			expect(res.path).toBe("hello.txt");
			expect(res.mode).toBe("replace");
			expect(res.diff).toContain("world");

			const onDisk = await Bun.file(path.join(projectCwd, "hello.txt")).text();
			expect(onDisk).toBe("hello omp\n");
		});
	});

	test("fs_diff before/after 统一 diff", async () => {
		await withClient(async client => {
			const res = await client.request<{ diff: string }>({
				type: "fs_diff",
				before: "a\nb\nc\n",
				after: "a\nB\nc\n",
			});
			expect(res.diff).toContain("@@");
			expect(res.diff).toContain("-2|b");
			expect(res.diff).toContain("+2|B");
		});
	});

	test("fs_diff path+content（磁盘现状 vs 待写内容）", async () => {
		await withClient(async client => {
			const res = await client.request<{ diff: string }>({
				type: "fs_diff",
				path: "out.txt",
				content: "one\nTWO\nthree\n",
			});
			expect(res.diff).toContain("two");
		});
	});
});
