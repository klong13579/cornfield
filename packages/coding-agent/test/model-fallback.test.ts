import { describe, expect, test, vi } from "bun:test";
import type { AssistantMessage, AssistantMessageEvent, AssistantMessageEventStream } from "@cornfield/ai";
import { isRetryableError, resolveFallbackModels, withModelFallback } from "../src/config/model-fallback";
import type { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";

describe("resolveFallbackModels", () => {
	const registry = {} as ModelRegistry;

	test("未配置 modelFallbacks → 返回空列表（不抛）", () => {
		const settings = Settings.isolated();
		expect(resolveFallbackModels(settings, registry, [])).toEqual([]);
	});

	test("settings.get('modelFallbacks') 有 schema 默认值", () => {
		expect(Settings.isolated().get("modelFallbacks")).toEqual([]);
	});
});

describe("isRetryableError", () => {
	test("401/429/5xx 可回退", () => {
		expect(isRetryableError({ status: 401 })).toBe(true);
		expect(isRetryableError({ statusCode: 429 })).toBe(true);
		expect(isRetryableError({ response: { status: 500 } })).toBe(true);
		expect(isRetryableError({ status: 503 })).toBe(true);
	});
	test("4xx 非鉴权/限流不可回退", () => {
		expect(isRetryableError({ status: 400 })).toBe(false);
		expect(isRetryableError({ status: 403 })).toBe(false);
		expect(isRetryableError({ status: 404 })).toBe(false);
	});
	test("网络类错误可回退，主动取消不可", () => {
		expect(isRetryableError(new TypeError("fetch failed"))).toBe(true);
		const abort = new Error("aborted");
		abort.name = "AbortError";
		expect(isRetryableError(abort)).toBe(false);
		expect(isRetryableError(new Error("ECONNRESET"))).toBe(true);
		expect(isRetryableError(new Error("socket hang up"))).toBe(true);
	});
	test("其他错误不可回退", () => {
		expect(isRetryableError(new Error("boom"))).toBe(false);
		expect(isRetryableError(null)).toBe(false);
		expect(isRetryableError(undefined)).toBe(false);
	});
});

type StreamLike = AsyncIterable<{ type: string; text?: string }>;

function streamOf(...events: Array<{ type: string; text?: string }>): StreamLike {
	return {
		async *[Symbol.asyncIterator]() {
			for (const e of events) yield e;
		},
	};
}

function failStream(err: unknown): StreamLike {
	return {
		[Symbol.asyncIterator](): AsyncIterator<{ type: string }> {
			return {
				next(): Promise<IteratorResult<{ type: string }>> {
					return Promise.reject(err);
				},
			};
		},
	};
}

function halfThenFail(err: unknown): StreamLike {
	let sent = 0;
	return {
		async *[Symbol.asyncIterator]() {
			if (sent++ < 1) yield { type: "text_delta", text: "part" };
			throw err;
		},
	};
}

type ModelMock = { provider: string; id: string };

describe("withModelFallback", () => {
	const primary: ModelMock = { provider: "p1", id: "main" };
	const backup: ModelMock = { provider: "p2", id: "backup" };
	const backup2: ModelMock = { provider: "p3", id: "backup2" };

	test("主模型失败(401) → 回退成功，产出备用事件", async () => {
		const raw = vi
			.fn()
			.mockReturnValueOnce(failStream({ status: 401 }))
			.mockReturnValue(streamOf({ type: "text_delta", text: "ok" }));
		const wrapped = withModelFallback(raw as never, [backup] as never);
		const out: string[] = [];
		for await (const e of wrapped(primary as never, {} as never, {} as never) as AsyncIterable<{
			type: string;
			text?: string;
		}>) {
			out.push(e.text ?? "");
		}
		expect(out).toEqual(["ok"]);
		expect(raw).toHaveBeenCalledTimes(2);
		expect(raw.mock.calls[1][0].id).toBe("backup");
	});

	test("主模型成功 → 不切", async () => {
		const raw = vi.fn().mockReturnValue(streamOf({ type: "text_delta", text: "main" }));
		const wrapped = withModelFallback(raw as never, [backup] as never);
		const out: string[] = [];
		for await (const e of wrapped(primary as never, {} as never, {} as never) as AsyncIterable<{
			type: string;
			text?: string;
		}>) {
			out.push(e.text ?? "");
		}
		expect(out).toEqual(["main"]);
		expect(raw).toHaveBeenCalledTimes(1);
	});

	test("流中途失败（已产出事件）→ 不重试，抛原错", async () => {
		const err = new Error("stream broke mid-way");
		const raw = vi.fn().mockReturnValue(halfThenFail(err));
		const wrapped = withModelFallback(raw as never, [backup] as never);
		await expect(
			(async () => {
				for await (const _ of wrapped(primary as never, {} as never, {} as never) as AsyncIterable<{
					type: string;
				}>) {
					// consume
				}
			})(),
		).rejects.toThrow("stream broke mid-way");
		expect(raw).toHaveBeenCalledTimes(1); // 不重试：上下文已不完整
	});

	test("AbortError → 不重试，抛原错", async () => {
		const abort = new Error("aborted");
		abort.name = "AbortError";
		const raw = vi.fn().mockReturnValue(failStream(abort));
		const wrapped = withModelFallback(raw as never, [backup] as never);
		await expect(
			(async () => {
				for await (const _ of wrapped(primary as never, {} as never, {} as never) as AsyncIterable<{
					type: string;
				}>) {
					// consume
				}
			})(),
		).rejects.toThrow("aborted");
		expect(raw).toHaveBeenCalledTimes(1);
	});

	test("全部失败 → 抛最后错误", async () => {
		const err = { status: 503 };
		const raw = vi.fn().mockReturnValue(failStream(err));
		const wrapped = withModelFallback(raw as never, [backup, backup2] as never);
		await expect(
			(async () => {
				for await (const _ of wrapped(primary as never, {} as never, {} as never) as AsyncIterable<{
					type: string;
				}>) {
					// consume
				}
			})(),
		).rejects.toEqual(err);
		expect(raw).toHaveBeenCalledTimes(3);
	});

	test("fallbacks 为空 → 原样返回（同引用）", () => {
		const raw = vi.fn() as never;
		expect(withModelFallback(raw, [])).toBe(raw);
	});
});

// result() 契约回归：agent-loop 在消费完事件后调 response.result() 拿最终消息，
// 缺了它就会抛 TypeError: response.result is not a function（网关 cron 崩溃根因）。
// 详见 packages/coding-agent/src/config/model-fallback.ts 头注释。
describe("withModelFallback result() 契约", () => {
	const primary: ModelMock = { provider: "p1", id: "main" };
	const backup: ModelMock = { provider: "p2", id: "backup" };

	function makeMessage(stopReason: AssistantMessage["stopReason"], errorMessage?: string): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text" as const, text: "hi" }],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "test-model",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason,
			errorMessage,
			timestamp: 0,
		};
	}

	function streamOfEvents(...events: AssistantMessageEvent[]): AsyncIterable<AssistantMessageEvent> {
		return {
			async *[Symbol.asyncIterator]() {
				for (const e of events) yield e;
			},
		};
	}

	/** 拉满包装流并断言迭代值，返回包装流（供 result() 断言）。 */
	async function consumeWrapped(raw: ReturnType<typeof vi.fn>): Promise<AssistantMessageEventStream> {
		const s = (await withModelFallback(raw as never, [backup] as never)(
			primary as never,
			{} as never,
			{} as never,
		)) as AssistantMessageEventStream;
		const types: string[] = [];
		for await (const e of s as AsyncIterable<{ type: string }>) {
			types.push(e.type);
		}
		return s;
	}

	test("done 终端事件 → result() 返回其最终消息", async () => {
		const msg = makeMessage("stop");
		const raw = vi.fn().mockReturnValue(streamOfEvents({ type: "done", reason: "stop", message: msg }));
		const s = await consumeWrapped(raw);
		expect(await s.result()).toBe(msg);
	});

	test("收到终端事件立即调 result()（不继续迭代）：拿得到最终消息", async () => {
		// streamAttempt 的收尾时序：for-await 收到 done/error 事件后立刻调
		// response.result()，不会把生成器再拉一轮。finalize 必须先于 yield
		// 落状态，否则这里会抛“流尚未产出终端事件”/拿到空结果。
		const msg = makeMessage("stop");
		const raw = vi
			.fn()
			.mockReturnValue(
				streamOfEvents(
					{ type: "text_delta", contentIndex: 0, delta: "a", partial: msg },
					{ type: "done", reason: "stop", message: msg },
				),
			);
		const s = (await withModelFallback(raw as never, [backup] as never)(
			primary as never,
			{} as never,
			{} as never,
		)) as AssistantMessageEventStream;
		const types: string[] = [];
		for await (const e of s as AsyncIterable<{ type: string }>) {
			types.push(e.type);
			if (e.type === "done" || e.type === "error") break;
		}
		expect(types).toEqual(["text_delta", "done"]);
		await expect(s.result()).resolves.toBe(msg);
	});

	test("主模型 setup 失败(401) → 回退模型 done，result() 返回备用模型的最终消息", async () => {
		const backupMsg = makeMessage("stop");
		const raw = vi
			.fn()
			.mockReturnValueOnce(failStream({ status: 401 }))
			.mockReturnValue(streamOfEvents({ type: "done", reason: "stop", message: backupMsg }));
		const s = await consumeWrapped(raw);
		expect(raw).toHaveBeenCalledTimes(2);
		expect(raw.mock.calls[1][0].id).toBe("backup");
		expect(await s.result()).toBe(backupMsg);
	});

	test("error 终端事件 → result() 返回错误消息（已产出事件的失败不回退）", async () => {
		const errMsg = makeMessage("error", "LLM failed mid-stream");
		const raw = vi.fn().mockReturnValue(streamOfEvents({ type: "error", reason: "error", error: errMsg }));
		const s = await consumeWrapped(raw);
		expect(raw).toHaveBeenCalledTimes(1);
		expect((await s.result()).errorMessage).toBe("LLM failed mid-stream");
	});

	test("内层流未发终端事件就结束 → result() 显式 reject（不悬挂）", async () => {
		const partial = makeMessage("stop");
		const raw = vi.fn().mockReturnValue(streamOfEvents({ type: "text_delta", contentIndex: 0, delta: "x", partial }));
		const s = await consumeWrapped(raw);
		await expect(s.result()).rejects.toThrow("未收到终端事件");
	});

	test("全部候选失败 → 迭代抛最后错误，result() 同错 reject", async () => {
		const err = { status: 503 };
		const raw = vi.fn().mockReturnValue(failStream(err));
		const s = (await withModelFallback(raw as never, [backup] as never)(
			primary as never,
			{} as never,
			{} as never,
		)) as AssistantMessageEventStream;
		await expect(
			(async () => {
				for await (const _ of s as AsyncIterable<{ type: string }>) {
					// consume
				}
			})(),
		).rejects.toEqual(err);
		expect(raw).toHaveBeenCalledTimes(2);
		await expect(s.result()).rejects.toEqual(err);
	});
});
