import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PiClient } from "@cornfield/client";
import type { WireServerEvent } from "@cornfield/wire";
import { SERVE_BOOT_BUDGET_MS, type ServeFixture, spawnServeFixture } from "./wire-serve-fixture";

/**
 * 粘贴图片落盘（A3：会话 artifacts 目录 + B2：wire-server 一处收口）。
 *
 * **为什么这件事必须端到端证**：`prompt.images` 只是 inline base64，它能不能到模型取决于
 * provider 有没有透传（实测某 provider 没透传，模型回的是「没收到图」）；而 `inspect_image`
 * 只认磁盘路径（`tools/inspect-image.ts` 的 `loadImageInput({ path })`）。图不落盘 + 消息里
 * 没有路径，agent 就永远读不到用户贴的图。所以要证两层：
 *
 *   1. **句柄**：真正发给模型的那段消息文本带我给出的路径；
 *   2. **句柄不是编的**：那个路径确实在盘上、字节与发出去的一致。
 *
 * 落点约定：`<sessionFile 去掉 .jsonl>/uploads/uploaded-<UTC 秒>-<内容 hash 前 8 位>.<ext>`
 * —— 与截断工具输出、子 agent 输出同一棵会话树，随会话 fork/move/drop 一起走。
 *
 * 两个用例各起一个 serve：它们都要在**没有在跑的会话**上发 prompt（streaming 中的 prompt 会
 * 走 steer/followUp 队列，不再产出 user message 事件），共用夹具就是让第二个用例去等第一个
 * 用例的模型调用收尾——那是竞态，不是断言。
 *
 * 隔离 HOME / 端口 / 预算 / 停摆重试都在 `spawnServeFixture`（见该文件的说明）。
 */

/** 1×1 PNG。落盘要按字节比对，所以必须是能解出 PNG 魔数的真东西，不能用随手编的 base64。 */
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_BYTES = Buffer.from(PNG_BASE64, "base64");

/** 用例自己的超时；默认 5s 连一次 serve 往返都不够，会把「没等到」伪装成失败。 */
const CASE_TIMEOUT_MS = 60_000;

type ProgressPush = {
	type?: string;
	event?: { type?: string; message?: { role?: string; content?: unknown } };
};

/** 从 push 流里取「role=user 的 message_start」文本 —— 那段就是发给模型的原文。 */
function userMessageText(events: readonly WireServerEvent[]): string | undefined {
	for (const raw of events) {
		const push = raw as ProgressPush;
		if (push.type !== "progress" || push.event?.type !== "message_start") continue;
		const message = push.event.message;
		if (message?.role !== "user" || !Array.isArray(message.content)) continue;
		const textBlock = message.content.find(c => (c as { type?: string }).type === "text") as
			| { text?: string }
			| undefined;
		if (typeof textBlock?.text === "string") return textBlock.text;
	}
	return undefined;
}

/** 超时时把「到底收到了什么」写进报错——「没等到」和「消息里没这段话」是两回事。 */
function summarize(events: readonly WireServerEvent[]): string {
	const kinds = events.map(raw => {
		const push = raw as ProgressPush;
		return push.type === "progress" ? `progress/${push.event?.type ?? "?"}` : (push.type ?? "?");
	});
	return kinds.length > 0 ? [...new Set(kinds)].join(", ") : "(一条 push 都没收到)";
}

async function waitForUserMessage(events: readonly WireServerEvent[], timeoutMs = 60_000): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const text = userMessageText(events);
		if (text !== undefined) return text;
		if (Date.now() > deadline) {
			throw new Error(`没等到 user message_start；已收到的 push：${summarize(events)}`);
		}
		await Bun.sleep(50);
	}
}

/** 一条连接 + 订阅到的 push 流；用例自己关。 */
async function connect(fixture: ServeFixture): Promise<{ client: PiClient; events: WireServerEvent[] }> {
	const client = new PiClient({ url: fixture.url, token: fixture.token, autoReconnect: false });
	await client.connect();
	const events: WireServerEvent[] = [];
	client.subscribe(ev => {
		if (ev.type === "push") events.push(ev.event);
	});
	return { client, events };
}

describe("粘贴图片 → 落盘 + 消息里给出 inspect_image 能读的路径", () => {
	let fixture: ServeFixture | undefined;

	beforeAll(async () => {
		fixture = await spawnServeFixture({ homePrefix: "omp-serve-img-" });
	}, SERVE_BOOT_BUDGET_MS);

	afterAll(async () => {
		await fixture?.dispose();
	});

	test(
		"图片落进会话 artifacts 目录，路径写进消息，盘上字节与发出的一致",
		async () => {
			expect(PNG_BYTES.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47])); // 夹具自检：真 PNG

			const { client, events } = await connect(fixture!);
			try {
				await client.request({
					type: "prompt",
					message: "看看这张图",
					images: [{ type: "image", data: PNG_BASE64, mimeType: "image/png" }],
				});

				const text = await waitForUserMessage(events);
				expect(text).toContain("看看这张图");

				// 句柄形态：`[image: <绝对路径> (mime, 字节)]` —— 与 gateway 的 `[file: <路径> (mime, 大小)]` 同族。
				const match = /\[image: (.+?) \((image\/png), (\d+)B\)\]/.exec(text);
				expect(match).not.toBeNull();
				const savedPath = match![1];
				expect(match![3]).toBe(String(PNG_BYTES.byteLength));
				expect(savedPath.startsWith("/")).toBe(true);
				expect(savedPath).toMatch(/\/sessions\/.+\/uploads\/uploaded-\d{14}-[0-9a-f]{8}\.png$/);

				// 句柄不是编的：文件真在，字节一模一样（落盘没被转码、没被截断）。
				const saved = await Bun.file(savedPath).arrayBuffer();
				expect(Buffer.from(saved)).toEqual(PNG_BYTES);
			} finally {
				client.close();
			}
		},
		CASE_TIMEOUT_MS,
	);
});

describe("读不了的图片不静默", () => {
	let fixture: ServeFixture | undefined;

	beforeAll(async () => {
		fixture = await spawnServeFixture({ homePrefix: "omp-serve-img-bad-" });
	}, SERVE_BOOT_BUDGET_MS);

	afterAll(async () => {
		await fixture?.dispose();
	});

	test(
		"转不了的格式：消息里写明这张图 inspect_image 拿不到",
		async () => {
			const { client, events } = await connect(fixture!);
			try {
				await client.request({
					type: "prompt",
					message: "看看这张图",
					images: [{ type: "image", data: "bm90LWFuLWltYWdl", mimeType: "image/x-nonsense" }],
				});

				const text = await waitForUserMessage(events);
				// 不钉死具体分支文案（转不了 / 存不下都行）——要防的缺陷是「静默丢掉」。
				expect(text).toContain("image/x-nonsense");
				expect(text).toContain("inspect_image cannot read this attachment");
			} finally {
				client.close();
			}
		},
		CASE_TIMEOUT_MS,
	);
});
