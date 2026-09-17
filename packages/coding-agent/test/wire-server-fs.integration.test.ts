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
// ── 以下 helpers + 两组用例整块来自 base 的 `wire-server-fs-write.integration.test.ts`。
// main 把 `-fs-write` 并入本文件后删掉了它，而 CAS / 截断边界两组在本文件里没有等价物
// ⇒ 按「接受 main 的删除，但缺哪条补哪条」搬进 main 的结构；共用的 5 条 fs_write/fs_edit/fs_diff 用例保留 main 版本。

type FsWriteResult = { path: string; bytesWritten: number; version: string; normalized?: boolean };
type FsReadResult = { path: string; text: string; truncated: boolean; version: string };

/** 单次整段写的服务端上界（`src/server/wire-server.ts` 的 FS_MAX_WRITE_BYTES）。 */
const FS_MAX_WRITE_BYTES = 8 * 1024 * 1024;

/**
 * `expectedVersion` 还没进 @cornfield/wire 的命令类型（pi-wire 是另一张票的范围），
 * 所以这里和服务端 / web-app 适配层一样按实测形状铸型——测的是行为，不是为了绕过类型。
 */
async function fsWrite(
	client: PiClient,
	payload: { path: string; content: string; expectedVersion?: string },
): Promise<FsWriteResult> {
	return client.request<FsWriteResult>({ type: "fs_write", ...payload } as never);
}

async function fsRead(client: PiClient, path: string): Promise<FsReadResult> {
	return client.request<FsReadResult>({ type: "fs_read", path } as never);
}

/** 取服务端原始错误文本（与 web-app conflictDetailOf 读的是同一个字段）。 */
function serverErrorText(err: unknown): string {
	const raw = (err as { serverError?: unknown }).serverError;
	if (typeof raw === "string") return raw;
	return err instanceof Error ? err.message : String(err);
}

/** 断言这次写被服务端拒绝，返回拒绝理由。 */
async function fsWriteError(
	client: PiClient,
	payload: { path: string; content: string; expectedVersion?: string },
): Promise<string> {
	try {
		await fsWrite(client, payload);
	} catch (err) {
		return serverErrorText(err);
	}
	throw new Error(`expected fs_write(${payload.path}) to be refused, but it succeeded`);
}

/** 盘上真实字节（绕过 wire，模拟外部写入者 / 验证拒绝后没落盘）。 */
async function diskText(rel: string): Promise<string> {
	return Bun.file(path.join(projectCwd, rel)).text();
}

describe("fs_write 乐观并发（expectedVersion ↔ fs_read version）", () => {
	test("fs_read 带回内容身份 version：同内容同版本，改内容换版本", async () => {
		await withClient(async client => {
			await fsWrite(client, { path: "cas-basic.txt", content: "alpha\n" });
			const first = await fsRead(client, "cas-basic.txt");
			expect(first.text).toBe("alpha\n");
			expect(first.truncated).toBe(false);
			expect(first.version).toMatch(/^[0-9a-f]{64}$/);

			const again = await fsRead(client, "cas-basic.txt");
			expect(again.version).toBe(first.version);

			await fsWrite(client, { path: "cas-basic.txt", content: "beta\n" });
			const changed = await fsRead(client, "cas-basic.txt");
			expect(changed.version).not.toBe(first.version);
		});
	});

	test("expectedVersion 命中：写入成功，返回的 version 就是新基线", async () => {
		await withClient(async client => {
			await fsWrite(client, { path: "cas-match.txt", content: "v1\n" });
			const base = await fsRead(client, "cas-match.txt");

			const res = await fsWrite(client, {
				path: "cas-match.txt",
				content: "v2\n",
				expectedVersion: base.version,
			});
			expect(res.path).toBe("cas-match.txt");
			// `normalized` 必须在：它回答「落盘的字节是不是我发的那份」。缺了它，客户端就无从知道
			// 服务端改写过内容（lsp.formatOnWrite 格式化），编辑器会停在一个「已保存但不等于磁盘」的谎上。
			// 默认配置下写入逐字节精确（已实测：无尾换行/CRLF/空串都同字节），所以这里恒为 false。
			expect(res.normalized).toBe(false);
			expect(res.bytesWritten).toBe(3);
			expect(res.version).toMatch(/^[0-9a-f]{64}$/);
			expect(res.version).not.toBe(base.version);
			expect(await diskText("cas-match.txt")).toBe("v2\n");
			// 返回的 version 可直接当新基线，无需重读。
			expect((await fsRead(client, "cas-match.txt")).version).toBe(res.version);
		});
	});

	test("外部写入者抢先落盘：CAS 拒写，磁盘保持外部内容", async () => {
		await withClient(async client => {
			await fsWrite(client, { path: "cas-conflict.txt", content: "mine-v1\n" });
			const base = await fsRead(client, "cas-conflict.txt");

			// 外部写入者（例如 agent 自己跑了 edit 工具）改了盘，客户端手上的 base 就此过期。
			await Bun.write(path.join(projectCwd, "cas-conflict.txt"), "external\n");

			const refusal = await fsWriteError(client, {
				path: "cas-conflict.txt",
				content: "mine-v2\n",
				expectedVersion: base.version,
			});
			expect(refusal.startsWith("fs_conflict: ")).toBe(true);
			expect(refusal).toContain(base.version);
			// 拒绝 = 一个字节都不落盘。
			expect(await diskText("cas-conflict.txt")).toBe("external\n");
		});
	});

	test("冲突可恢复：重读拿新 version 重试即成功", async () => {
		await withClient(async client => {
			await fsWrite(client, { path: "cas-recover.txt", content: "mine-v1\n" });
			const stale = await fsRead(client, "cas-recover.txt");
			await Bun.write(path.join(projectCwd, "cas-recover.txt"), "external\n");

			const refusal = await fsWriteError(client, {
				path: "cas-recover.txt",
				content: "mine-v2\n",
				expectedVersion: stale.version,
			});
			expect(refusal.startsWith("fs_conflict: ")).toBe(true);

			const fresh = await fsRead(client, "cas-recover.txt");
			expect(fresh.text).toBe("external\n");
			const res = await fsWrite(client, {
				path: "cas-recover.txt",
				content: "mine-v2\n",
				expectedVersion: fresh.version,
			});
			expect(res.version).toBe((await fsRead(client, "cas-recover.txt")).version);
			expect(await diskText("cas-recover.txt")).toBe("mine-v2\n");
		});
	});

	test('expectedVersion: "" 在不存在路径上创建（空基线 CAS）', async () => {
		await withClient(async client => {
			expect(await Bun.file(path.join(projectCwd, "cas-create.txt")).exists()).toBe(false);
			const res = await fsWrite(client, { path: "cas-create.txt", content: "created\n", expectedVersion: "" });
			expect(res.version).toMatch(/^[0-9a-f]{64}$/);
			expect(await diskText("cas-create.txt")).toBe("created\n");
		});
	});

	test('expectedVersion: "" 在已存在路径上冲突（不覆盖已有文件）', async () => {
		await withClient(async client => {
			await fsWrite(client, { path: "cas-existing.txt", content: "there\n" });
			const refusal = await fsWriteError(client, {
				path: "cas-existing.txt",
				content: "clobber\n",
				expectedVersion: "",
			});
			expect(refusal.startsWith("fs_conflict: ")).toBe(true);
			expect(await diskText("cas-existing.txt")).toBe("there\n");
		});
	});

	test(">128KB 文件只改尾部：裁剪后的 text 相同，version 仍变（CAS 发现得到）", async () => {
		await withClient(async client => {
			const head = "h".repeat(200 * 1024);
			await fsWrite(client, { path: "cas-big.txt", content: `${head}TAIL-1\n` });
			const before = await fsRead(client, "cas-big.txt");
			expect(before.truncated).toBe(true);

			await fsWrite(client, { path: "cas-big.txt", content: `${head}TAIL-2\n` });
			const after = await fsRead(client, "cas-big.txt");
			expect(after.text).toBe(before.text);
			expect(after.version).not.toBe(before.version);

			// 拿旧 version 回写：拒写，而不是把 >128KB 内容当成打开时的那样覆盖。
			const refusal = await fsWriteError(client, {
				path: "cas-big.txt",
				content: "short\n",
				expectedVersion: before.version,
			});
			expect(refusal.startsWith("fs_conflict: ")).toBe(true);
			expect((await diskText("cas-big.txt")).endsWith("TAIL-2\n")).toBe(true);
		});
	});

	test("超过 FS_MAX_WRITE_BYTES 的正文拒绝：一个字节都不落盘", async () => {
		await withClient(async client => {
			// 边界恰好在 8 MiB 之后：分配略超上限的正文（不真去写 8MiB 到磁盘）。
			const body = "x".repeat(FS_MAX_WRITE_BYTES + 1);
			const refusal = await fsWriteError(client, { path: "cas-oversize.txt", content: body });
			expect(refusal).toContain(`${FS_MAX_WRITE_BYTES + 1} bytes exceeds limit of ${FS_MAX_WRITE_BYTES} bytes`);
			expect(await Bun.file(path.join(projectCwd, "cas-oversize.txt")).exists()).toBe(false);
		});
	}, 20_000);
});

/**
 * fs_read 的截断边界 —— 判定按磁盘**字节**，不是解码后的字符数；截断必须 UTF-8 安全。
 *
 * 这条边界是「只读降级」的唯一依据：`truncated:false` 等于告诉调用方「你手上是全文」，
 * 下游（编辑器）据此允许整段写回 —— 多报一次，写回就是把文件截断。多字节文本（中文 3B/字、
 * emoji 4B/字）按字符判会大面积漏报，是本用例组存在的原因。
 */
describe("fs_read 截断边界（128KiB 按字节，UTF-8 安全）", () => {
	const LIMIT = 128 * 1024;
	const READ_MAX_BYTES = LIMIT; // 与 src/server/wire-server.ts 的 FS_MAX_READ_BYTES 同值
	const replacementChar = "\uFFFD";

	async function readBack(client: PiClient, rel: string, content: string): Promise<FsReadResult> {
		await Bun.write(path.join(projectCwd, rel), content);
		return fsRead(client, rel);
	}

	test("恰好 128KiB 字节：不截断（边界本身算读全）", async () => {
		await withClient(async client => {
			const res = await readBack(client, "clip-exact.txt", "a".repeat(READ_MAX_BYTES));
			expect(res.truncated).toBe(false);
			expect(res.text.length).toBe(READ_MAX_BYTES);
		});
	});

	test("128KiB + 1 字节：截断（ASCII 基线）", async () => {
		await withClient(async client => {
			const res = await readBack(client, "clip-over.txt", "a".repeat(READ_MAX_BYTES + 1));
			expect(res.truncated).toBe(true);
			expect(res.text.length).toBe(READ_MAX_BYTES);
			expect(res.text.includes(replacementChar)).toBe(false);
		});
	});

	test("中文（3B/字）字符数不到 128K 但磁盘超限 → 必须截断", async () => {
		await withClient(async client => {
			// 45000 个汉字 = 135000 字节（> 128KiB），而 text.length 只有 45000（< 128K）
			const content = "中".repeat(45_000);
			expect(Buffer.byteLength(content, "utf8")).toBeGreaterThan(READ_MAX_BYTES);
			expect(content.length).toBeLessThan(READ_MAX_BYTES);
			const res = await readBack(client, "clip-cjk.txt", content);
			expect(res.truncated).toBe(true);
			// 截断后的内容必须是原文前缀，且编码后不超字节预算，且没有半个字造成的替换符
			expect(content.startsWith(res.text)).toBe(true);
			expect(Buffer.byteLength(res.text, "utf8")).toBeLessThanOrEqual(READ_MAX_BYTES);
			expect(res.text.includes(replacementChar)).toBe(false);
			expect(res.text.length).toBe(Math.floor(READ_MAX_BYTES / 3));
		});
	});

	test("边界切在 4 字节 emoji 中间：丢掉半个序列，不吐替换字符", async () => {
		await withClient(async client => {
			// 1 字节 ASCII + 33000 个 4 字节 emoji：131072 落在一个 emoji 的第 4 个字节之前，
			// 解码器必须把这三个字节一起丢掉（而不是补一个 U+FFFD）。
			const emojis = 33_000;
			const content = `a${"😀".repeat(emojis)}`;
			const res = await readBack(client, "clip-emoji.txt", content);
			expect(res.truncated).toBe(true);
			expect(res.text.includes(replacementChar)).toBe(false);
			// 完整保留的 emoji 个数 = floor((131072 - 1) / 4) = 32767，再加开头的 "a"。
			// 注意 JS 字符串长度是 UTF-16 码元数：一个 4 字节 emoji 占 2 个（所以这里乘 2）。
			// 别把码元数当字符数或字节数用——三套计数混着用正是本用例组要钉住的那类错。
			expect(res.text.length).toBe(1 + Math.floor((READ_MAX_BYTES - 1) / 4) * 2);
			expect(res.text.startsWith("a😀")).toBe(true);
			expect(res.text.endsWith("😀")).toBe(true);
			expect(content.startsWith(res.text)).toBe(true);
		});
	});

	test("截断只影响正文：version 仍覆盖整份文件字节", async () => {
		await withClient(async client => {
			const head = "中".repeat(45_000);
			const first = await readBack(client, "clip-version.txt", head);
			const second = await fsRead(client, "clip-version.txt");
			expect(second.version).toBe(first.version);
			// 只改裁剪区之外的尾部：正文一样，version 变（否则写侧 CAS 会放过一次真改动）
			const changed = await readBack(client, "clip-version.txt", `${head}尾`);
			expect(changed.text).toBe(first.text);
			expect(changed.version).not.toBe(first.version);
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
