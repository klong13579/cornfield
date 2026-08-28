/**
 * 听记 wire 命令 e2e —— record_transcribe / listen_list（真实 serve 子进程 + WS 客户端）。
 *
 * 默认覆盖（不触发真实模型）：
 * - record_transcribe 入参校验：缺 audio / 空 / base64 解码失败 / 音频过小 → ok:false
 * - listen_list：隔离配置根（空）→ recordings: []
 * - listen_list：预置一条 json → 返回文件名/recordedAt/text（读盘+解析+排序路径）
 *
 * E2E=1 时追加：真实 WAV（packages/web-app/public/test-voice.wav，say 中文语音）→
 * record_transcribe → 本地 whisper 转写文本 + 落盘一致（require 真实模型；默认 skip）。
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MULTIDEVICE_PROTOCOL_VERSION } from "@oh-my-pi/pi-wire";
import { waitForServe } from "./wait-for-serve";

type Frame = { type: string; [k: string]: unknown };

interface E2eContext {
	proc: ReturnType<typeof Bun.spawn>;
	url: string;
	token: string;
}

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");

// ── helpers（与 wire-server-p2-commands.integration.test.ts 同构） ──

async function sendCommand(command: object, timeoutMs = 15_000): Promise<Frame> {
	const ws = new WebSocket(ctx.url);
	const { promise: opened, resolve: resolveOpened, reject: rejectOpened } = Promise.withResolvers<void>();
	ws.onopen = () => resolveOpened();
	ws.onerror = ev => rejectOpened(new Error(`ws error: ${String(ev)}`));
	await opened;

	const { promise: ackDone, resolve: ackResolve } = Promise.withResolvers<void>();
	const { promise: respDone, resolve: respResolve, reject: respReject } = Promise.withResolvers<Frame>();
	const timer = setTimeout(() => respReject(new Error(`timeout ${timeoutMs}ms`)), timeoutMs);

	ws.onmessage = ev => {
		const frame = JSON.parse(String(ev.data)) as Frame;
		if (frame.type === "hello_ack") {
			ackResolve();
			return;
		}
		if (frame.type === "hello_error") {
			respReject(new Error(`hello_error: ${String(frame.error)}`));
			return;
		}
		if (frame.type === "response") {
			clearTimeout(timer);
			respResolve(frame);
		}
	};

	ws.send(JSON.stringify({ type: "hello", version: MULTIDEVICE_PROTOCOL_VERSION, token: ctx.token }));
	await ackDone;
	ws.send(JSON.stringify({ type: "request", id: "e2e", command: { id: "e2e", ...command } }));
	try {
		return await respDone;
	} finally {
		ws.close();
	}
}

// ── orchestration（真实 serve 子进程，隔离配置根） ──
// 注意：serve 启动在模块顶层 await 完成（hook 超时固定 5s 不可调，beforeAll 起 serve 会
// 在本地慢机器超时——模块加载期不受 hook 超时约束）。afterAll 负责杀进程。

const isoHome = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-listen-wire-test-"));
// 默认 record.model 是 API 模型（qwen-audio）——隔离环境预置本地 whisper，否则真实转写
// case 会因 provider base URL 缺失而 ok:false。
await fsp.mkdir(path.join(isoHome, "agent"), { recursive: true });
await fsp.writeFile(
	path.join(isoHome, "agent", "config.yml"),
	`record:\n  model: mlx-community/whisper-large-v3-turbo\nstt:\n  language: zh\n`,
	"utf-8",
);
const port = 19000 + Math.floor(Math.random() * 500);
const proc = Bun.spawn(
	[
		"bun",
		path.join(repoRoot, "packages/coding-agent/src/cli.ts"),
		"serve",
		"--port",
		String(port),
		"--no-extensions",
		"--host",
		"127.0.0.1",
	],
	{
		env: { ...process.env, CORNFIELD_CONFIG_DIR: isoHome, PI_NO_TITLE: "1" },
		stdout: "pipe",
		stderr: "pipe",
	},
);
const ready = await waitForServe(proc, port);
const ctx: E2eContext = { proc, ...ready };

afterAll(() => {
	try {
		ctx?.proc.kill("SIGTERM");
	} catch {
		/* already gone */
	}
});

// ── tests ──

describe("record_transcribe 入参校验（不触模型）", () => {
	test("missing audio → ok:false", async () => {
		const res = await sendCommand({ type: "record_transcribe" });
		expect(res.ok).toBe(false);
		expect(String(res.error)).toContain("audio required");
	});

	test("empty audio → ok:false", async () => {
		const res = await sendCommand({ type: "record_transcribe", audio: "" });
		expect(res.ok).toBe(false);
		expect(String(res.error)).toContain("audio required");
	});

	test("invalid base64 → ok:false", async () => {
		const res = await sendCommand({ type: "record_transcribe", audio: "!!not-base64!!" });
		// Buffer.from 宽容解码：'!' 可能被忽略 —— 真正失败点落在字节数校验
		expect(res.ok).toBe(false);
	});

	test("tiny audio (<100B) → ok:false", async () => {
		const res = await sendCommand({
			type: "record_transcribe",
			audio: Buffer.from("x".repeat(50), "utf-8").toString("base64"),
		});
		expect(res.ok).toBe(false);
		expect(String(res.error)).toMatch(/too small|empty/);
	});
});

describe("listen_list（隔离根）", () => {
	test("empty dir → recordings: []", async () => {
		const res = await sendCommand({ type: "listen_list" });
		expect(res.ok).toBe(true);
		expect((res.result as { recordings: unknown[] }).recordings).toEqual([]);
	});

	test("preseeded json is listed with name/recordedAt/text", async () => {
		const listenDir = path.join(isoHome, "listen");
		await fsp.mkdir(listenDir, { recursive: true });
		await fsp.writeFile(
			path.join(listenDir, "2026-08-20-集成测试.json"),
			JSON.stringify({ version: 1, recorded_at: "2026-08-20T00:00:00.000Z", text: "集成测试转写" }),
			"utf-8",
		);

		const res = await sendCommand({ type: "listen_list" });
		expect(res.ok).toBe(true);
		const recs = (res.result as { recordings: Array<{ name: string; recordedAt: string; text: string }> }).recordings;
		expect(recs.length).toBe(1);
		expect(recs[0]?.name).toBe("2026-08-20-集成测试.json");
		expect(recs[0]?.recordedAt).toBe("2026-08-20T00:00:00.000Z");
		expect(recs[0]?.text).toBe("集成测试转写");
	});

	const realTranscribe = test.skipIf(!process.env.E2E);
	realTranscribe(
		"record_transcribe 真实 WAV → 本地 whisper 转写文本 + 落盘一致",
		async () => {
			const wavPath = path.join(repoRoot, "packages/web-app/public/test-voice.wav");
			const b64 = Buffer.from(await fsp.readFile(wavPath)).toString("base64");
			const res = await sendCommand({ type: "record_transcribe", audio: b64, desc: "e2e-voice" }, 240_000);
			expect(res.ok).toBe(true);
			const r = res.result as { text: string; path: string; model: string };
			expect(r.text.length).toBeGreaterThan(0);
			expect(r.path).toContain("listen");
			// 落盘 json 与返回文本一致（与 TUI /record 同格式）
			const saved = JSON.parse(await fsp.readFile(r.path, "utf-8")) as { version: number; text: string };
			expect(saved.version).toBe(1);
			expect(saved.text).toBe(r.text);
		},
		300_000,
	);
});
