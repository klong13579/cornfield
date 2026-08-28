/**
 * R-IMG-SERVE e2e — serve `fs_read_image` 二进制图片读取（真实 serve 子进程 + bun WS 客户端）。
 *
 * 预置：默认 agentDir（serve cwd 项目目录）下的 1x1 PNG + >2MB 大文件 + 未知扩展文件。
 * 验证：dataUrl 前缀与 MIME（按扩展名）、2MB 截断标记、路径越界拒绝、不存在文件错误。
 * 隔离 HOME + 临时项目 cwd（不污染仓库）。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { MULTIDEVICE_PROTOCOL_VERSION } from "@cornfield/wire";
import { waitForServe } from "./wait-for-serve";

type Frame = { type: string; [k: string]: unknown };

let isolatedHome: string;
let projectCwd: string;
let savedHome: string | undefined;
let proc: ReturnType<typeof Bun.spawn> | undefined;
let url = "";

/** 1x1 透明 PNG（已知最小合法字节序列）。 */
const PNG_1PX = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

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

interface FsImageResult {
	dataUrl: string;
	mimeType: string;
	sizeBytes: number;
	truncated: boolean;
}

describe("R-IMG-SERVE — fs_read_image 二进制图片读取", () => {
	test("PNG：dataUrl + image/png MIME（按扩展名）+ 完整大小", async () => {
		const { ws, frames } = await connect(url);
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
		const { ws, frames } = await connect(url);
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
		const { ws, frames } = await connect(url);
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

beforeAll(async () => {
	isolatedHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-serve-fsimg-"));
	savedHome = process.env.HOME;
	process.env.HOME = isolatedHome;
	projectCwd = path.join(isolatedHome, "project");
	await fs.mkdir(projectCwd, { recursive: true });

	// 种子文件：1x1 PNG + 2MB+7 字节大文件
	await Bun.write(path.join(projectCwd, "shot.png"), PNG_1PX);
	await Bun.write(path.join(projectCwd, "big.bin"), Buffer.alloc(2 * 1024 * 1024 + 7, 0xab));

	const repoRoot = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
	const port = await ((): Promise<number> => {
		return new Promise(resolve => {
			const srv = net.createServer();
			srv.listen(0, "127.0.0.1", () => {
				const p = (srv.address() as net.AddressInfo).port;
				srv.close(() => resolve(p));
			});
		});
	})();
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
	url = (await waitForServe(proc, port)).url;
}, 30_000);

afterAll(async () => {
	if (proc) {
		proc.kill();
		await proc.exited;
	}
	if (savedHome !== undefined) process.env.HOME = savedHome;
	await fs.rm(isolatedHome, { recursive: true, force: true });
});
