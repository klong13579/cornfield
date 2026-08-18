import { describe, expect, test, vi } from "bun:test";
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
