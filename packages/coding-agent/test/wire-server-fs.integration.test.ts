/**
 * R-IMG-SERVE + 票 01 e2e — serve 文件系统命令面（真实 serve 子进程 + bun WS 客户端 / pi-client）。
 *
 * 覆盖命令：`fs_read_image`（二进制图片读取）、`fs_write`（整段写）、`fs_edit`（replace 精确编辑）、
 * `fs_diff`（before/after 与 path+content 统一 diff）。
 *
 * 夹具布局（隔离 HOME 由 `wire-serve-fixture` 提供；projectCwd 是独立 mkdtemp 项目目录，
 * 作为 serve 的 cwd → 不污染仓库）：
 * ```
 * <projectCwd>/
 *   shot.png   1x1 透明 PNG（PNG_1PX 的原始字节）
 *   big.bin    2 * 1024 * 1024 + 7 字节，未知扩展（MIME 兜底 application/octet-stream）
 *   hello.txt  "hello world\n"（fs_edit replace 的输入，测试内自行复位）
 *   out.txt    "one\ntwo\nthree\n"（fs_diff path+content 的磁盘现状，测试内自行复位）
 * ```
 * 所有用例只读或只改自身临时目录内的文件；文件写入用例在开始时复位其依赖的初始内容，
 * 因此每个 test 单独运行（`bun test -t <name>`）同样成立。
 *
 * 隔离 HOME / 端口 / 预算 / 停摆重试都在 `spawnServeFixture` 里（见该文件的说明）。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PiClient } from "@cornfield/client";
import { MULTIDEVICE_PROTOCOL_VERSION } from "@cornfield/wire";
import { SERVE_BOOT_BUDGET_MS, type ServeFixture, spawnServeFixture } from "./wire-serve-fixture";

type Frame = { type: string; [k: string]: unknown };

let fixture: ServeFixture | undefined;
/** serve 的 cwd（也是用例读写的项目目录）—— fixture 的隔离 HOME 之外的独立临时目录。 */
let projectCwd = "";

/** 1x1 透明 PNG（已知最小合法字节序列）。 */
const PNG_1PX = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

/** hello.txt 的初始内容（fs_edit replace 的输入）。 */
const HELLO_INITIAL = "hello world\n";
/** out.txt 的初始内容（fs_diff path+content 的磁盘现状）。 */
const OUT_INITIAL = "one\ntwo\nthree\n";

interface FrameSource {
	next(pred: (f: Frame) => boolean, timeoutMs: number): Promise<Frame | undefined>;
}

function collect(ws: WebSocket): FrameSource {
	const queue: Frame[] = [];
	const waiters: {
		pred: (f: Frame) => boolean;
		resolve: (f: Frame | undefined) => void;
		timer: ReturnType<typeof setTimeout>;
	}[] = [];
	ws.addEventListener("message", ev => {
		let frame: Frame;
		try {
			frame = JSON.parse(String(ev.data)) as Frame;
		} catch {
			return;
		}
		const waiter = waiters.find(w => w.pred(frame));
		if (waiter) {
			clearTimeout(waiter.timer);
			waiters.splice(waiters.indexOf(waiter), 1);
			waiter.resolve(frame);
		} else {
			queue.push(frame);
		}
	});
	return {
		next(pred, timeoutMs) {
			const idx = queue.findIndex(pred);
			if (idx >= 0) return Promise.resolve(queue.splice(idx, 1)[0]);
			if (timeoutMs <= 0) return Promise.resolve(undefined);
			return new Promise(resolve => {
				const waiter = {
					pred,
					resolve: (f: Frame | undefined) => resolve(f),
					timer: setTimeout(() => {
						waiters.splice(waiters.indexOf(waiter), 1);
						resolve(undefined);
					}, timeoutMs),
				};
				waiters.push(waiter);
			});
		},
	};
}

async function connect(wsUrl: string): Promise<{ ws: WebSocket; frames: FrameSource }> {
	const ws = new WebSocket(wsUrl);
	await new Promise<void>((resolve, reject) => {
		ws.onopen = () => resolve();
		ws.onerror = e => reject(new Error(`ws error: ${String(e)}`));
	});
	const frames = collect(ws);
	const token = wsUrl.match(/token=([a-zA-Z0-9]+)/)?.[1] ?? "";
	ws.send(JSON.stringify({ type: "hello", version: MULTIDEVICE_PROTOCOL_VERSION, token }));
	const ack = await frames.next(f => f.type === "hello_ack", 10_000);
	if (!ack) throw new Error("no hello_ack");
	return { ws, frames };
}

let seq = 0;
async function rawRequest(ws: WebSocket, frames: FrameSource, command: Record<string, unknown>): Promise<Frame> {
	const id = `q${++seq}`;
	ws.send(JSON.stringify({ type: "request", id, command: { ...command, id } }));
	const f = await frames.next(fr => fr.type === "response" && fr.id === id, 30_000);
	if (!f) throw new Error(`timeout: ${JSON.stringify(command.type)}`);
	return f;
}

async function withClient<T>(fn: (client: PiClient) => Promise<T>): Promise<T> {
	const client = new PiClient({ url: fixture!.url, token: fixture!.token, autoReconnect: false });
	await client.connect();
	try {
		return await fn(client);
	} finally {
		client.close();
	}
}

interface FsImageResult {
	dataUrl: string;
	mimeType: string;
	sizeBytes: number;
	truncated: boolean;
}

describe("R-IMG-SERVE — fs_read_image 二进制图片读取", () => {
	test("PNG：dataUrl + image/png MIME（按扩展名）+ 完整大小", async () => {
		const { ws, frames } = await connect(fixture!.url);
		try {
			const resp = (await rawRequest(ws, frames, { type: "fs_read_image", path: "shot.png" })) as Frame;
			expect(resp.ok).toBe(true);
			const res = resp.result as FsImageResult;
			expect(res.mimeType).toBe("image/png");
			expect(res.sizeBytes).toBe(PNG_1PX.length);
			expect(res.truncated).toBe(false);
			expect(res.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
			expect(res.dataUrl).toBe(`data:image/png;base64,${PNG_1PX.toString("base64")}`);
		} finally {
			ws.close();
		}
	});

	test(">2MB 文件：截断 + truncated 标记 + octet-stream 兜底扩展", async () => {
		const { ws, frames } = await connect(fixture!.url);
		try {
			// 未知扩展（.bin 不在 MIME 表）→ application/octet-stream
			const big = (await rawRequest(ws, frames, { type: "fs_read_image", path: "big.bin" })) as Frame;
			expect(big.ok).toBe(true);
			const res = big.result as FsImageResult;
			expect(res.mimeType).toBe("application/octet-stream");
			expect(res.sizeBytes).toBe(2 * 1024 * 1024 + 7);
			expect(res.truncated).toBe(true);
			// dataUrl 体积 ≈ 2MB 的 base64（上限截断）
			expect(res.dataUrl.startsWith("data:application/octet-stream;base64,")).toBe(true);
			expect(res.dataUrl.length).toBeLessThan(3 * 1024 * 1024);
		} finally {
			ws.close();
		}
	});

	test("路径越界拒绝 + 不存在文件错误", async () => {
		const { ws, frames } = await connect(fixture!.url);
		try {
			const resp = (await rawRequest(ws, frames, { type: "fs_read_image", path: "../../etc/passwd" })) as Frame;
			expect(resp.ok).toBe(false);

			const missing = (await rawRequest(ws, frames, { type: "fs_read_image", path: "no-such.png" })) as Frame;
			expect(missing.ok).toBe(false);
			expect(String(missing.error)).toMatch(/no such file/);
		} finally {
			ws.close();
		}
	});
});

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
		// 复位：本用例依赖 hello.txt 的编辑前内容，单独运行也要成立。
		await Bun.write(path.join(projectCwd, "hello.txt"), HELLO_INITIAL);
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
		// 复位：fs_diff path+content 读磁盘现值，缺文件会失败——单独运行也要成立。
		await Bun.write(path.join(projectCwd, "out.txt"), OUT_INITIAL);
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

beforeAll(async () => {
	projectCwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-serve-fs-project-"));

	// 种子文件：1x1 PNG + 2MB+7 字节大文件 + fs_edit / fs_diff 的初始内容
	await Bun.write(path.join(projectCwd, "shot.png"), PNG_1PX);
	await Bun.write(path.join(projectCwd, "big.bin"), Buffer.alloc(2 * 1024 * 1024 + 7, 0xab));
	await Bun.write(path.join(projectCwd, "hello.txt"), HELLO_INITIAL);
	await Bun.write(path.join(projectCwd, "out.txt"), OUT_INITIAL);

	// projectCwd 必须在 spawn 前存在（它是子进程的 cwd），HOME / 端口 / 预算由夹具负责。
	fixture = await spawnServeFixture({ homePrefix: "omp-serve-fs-", cwd: projectCwd });
}, SERVE_BOOT_BUDGET_MS);

afterAll(async () => {
	await fixture?.dispose();
	await fs.rm(projectCwd, { recursive: true, force: true });
});
