import { afterAll, describe, expect, test } from "bun:test";
import type { Model } from "@cornfield/ai";
import {
	classifyModelTestFailure,
	MODEL_TEST_TIMEOUT_MS,
	runModelConnectivityProbe,
} from "@cornfield/coding-agent/session/model-connectivity";

/**
 * 连通性测试（#04）handler 层回归：outcome 六类映射 + 超时。
 *
 * 探测走 completeSimple 真实适配链路（openai-completions），错误形态与真实流量一致；
 * 本地 Bun.serve 模拟 Provider 行为（无 mock、无外网）：
 * - 200 SSE → success；401 → auth；403/404 → permission；429 → rate-limit；
 * - 连接拒绝 → network；挂起连接 + 短时限 → timeout。
 */

const SSE_HEADERS = { "content-type": "text/event-stream" };

/** 最小合法 openai-completions SSE 成功流（文本 delta → stop → usage → [DONE]）。 */
function sseSuccess(): string {
	const chunks = [
		{
			id: "chatcmpl-probe",
			object: "chat.completion.chunk",
			created: 1,
			model: "probe-test-model",
			choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }],
		},
		{
			id: "chatcmpl-probe",
			object: "chat.completion.chunk",
			created: 1,
			model: "probe-test-model",
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		},
		{
			id: "chatcmpl-probe",
			object: "chat.completion.chunk",
			created: 1,
			model: "probe-test-model",
			choices: [],
			usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
		},
	];
	return `${chunks.map(c => `data: ${JSON.stringify(c)}`).join("\n\n")}\n\ndata: [DONE]\n\n`;
}

function _jsonError(status: number, message: string): Response {
	return Response.json({ error: { message, type: "invalid_request_error", code: null } }, { status });
}

interface TestServer {
	url: string;
	stop: () => Promise<void>;
}

async function startServer(handler: (req: Request) => Response | Promise<Response>): Promise<TestServer> {
	const server = Bun.serve({ port: 0, fetch: req => handler(req) });
	return {
		url: `http://127.0.0.1:${server.port}`,
		stop: async () => {
			server.stop(true);
		},
	};
}

/** 与探测同型的最小 openai-completions 模型（provider/baseUrl 指向本地测试服务）。 */
function probeModel(baseUrl: string): Model<"openai-completions"> {
	return {
		id: "probe-test-model",
		name: "Probe Test Model",
		api: "openai-completions",
		provider: "probe-test-provider",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 1024,
	};
}

const servers: TestServer[] = [];
async function startTracked(handler: (req: Request) => Response | Promise<Response>): Promise<TestServer> {
	const s = await startServer(handler);
	servers.push(s);
	return s;
}

afterAll(async () => {
	await Promise.all(servers.map(s => s.stop()));
});

describe("runModelConnectivityProbe：outcome 六类映射（真实本地 HTTP）", () => {
	test("200 SSE → success，message 为确认文案", async () => {
		const s = await startTracked(() => new Response(sseSuccess(), { status: 200, headers: SSE_HEADERS }));
		const result = await runModelConnectivityProbe(probeModel(s.url), "sk-test", { timeoutMs: 5_000 });
		expect(result.outcome).toBe("success");
		expect(result.message).toBe("模型响应正常");
		expect(result.latencyMs).toBeGreaterThanOrEqual(0);
		expect(result.httpStatus).toBeUndefined();
	});

	test("401 → auth（SDK 错误前缀形态：`401 <body>`）", async () => {
		const s = await startTracked(
			() =>
				new Response(JSON.stringify({ error: { message: "Incorrect API key provided: sk-xxx." } }), {
					status: 401,
				}),
		);
		const result = await runModelConnectivityProbe(probeModel(s.url), "sk-bad", { timeoutMs: 5_000 });
		expect(result.outcome).toBe("auth");
		expect(result.httpStatus).toBe(401);
		expect(result.message).toContain("Incorrect API key");
	});

	test("403 → permission（凭据有效但无模型权限）", async () => {
		const s = await startTracked(
			() =>
				new Response(JSON.stringify({ error: { message: "You do not have access to this model." } }), {
					status: 403,
				}),
		);
		const result = await runModelConnectivityProbe(probeModel(s.url), "sk-limited", { timeoutMs: 5_000 });
		expect(result.outcome).toBe("permission");
		expect(result.httpStatus).toBe(403);
	});

	test("404 → permission（模型不存在/已下线）", async () => {
		const s = await startTracked(
			() =>
				new Response(JSON.stringify({ error: { message: "The model 'probe-test-model' does not exist." } }), {
					status: 404,
				}),
		);
		const result = await runModelConnectivityProbe(probeModel(s.url), "sk-ok", { timeoutMs: 5_000 });
		expect(result.outcome).toBe("permission");
		expect(result.httpStatus).toBe(404);
	});

	test("429 → rate-limit（Retry-After: 0 使 SDK 重试快速耗尽，不拖成超时）", async () => {
		const s = await startTracked(
			() =>
				new Response(JSON.stringify({ error: { message: "Rate limit reached for requests." } }), {
					status: 429,
					headers: { "retry-after": "0" },
				}),
		);
		const result = await runModelConnectivityProbe(probeModel(s.url), "sk-ok", { timeoutMs: 15_000 });
		expect(result.outcome).toBe("rate-limit");
		expect(result.httpStatus).toBe(429);
	});

	test("SSE 载荷损坏 → network（服务端响应异常；SDK 解码器抛 SyntaxError，不被重试层吞掉）", async () => {
		const s = await startTracked(
			() => new Response("data: {invalid-json\n\n", { status: 200, headers: SSE_HEADERS }),
		);
		const result = await runModelConnectivityProbe(probeModel(s.url), "sk-ok", { timeoutMs: 5_000 });
		expect(result.outcome).toBe("network");
		expect(result.message.length).toBeGreaterThan(0);
	});

	test("挂起连接 + 短时限 → timeout，latency 反映时限（默认时限常量为 20s）", async () => {
		const s = await startTracked(() => new Promise<Response>(() => {}));
		const started = Date.now();
		const result = await runModelConnectivityProbe(probeModel(s.url), "sk-ok", { timeoutMs: 400 });
		expect(result.outcome).toBe("timeout");
		expect(result.latencyMs).toBeGreaterThanOrEqual(350);
		expect(result.latencyMs).toBeLessThan(3_000);
		expect(Date.now() - started).toBeLessThan(3_000);
		expect(MODEL_TEST_TIMEOUT_MS).toBe(20_000);
	});

	test("并发探测互不干扰（同 server 两路同时发起，均 success）", async () => {
		const s = await startTracked(() => new Response(sseSuccess(), { status: 200, headers: SSE_HEADERS }));
		const [a, b] = await Promise.all([
			runModelConnectivityProbe(probeModel(s.url), "sk-ok", { timeoutMs: 5_000 }),
			runModelConnectivityProbe(probeModel(s.url), "sk-ok", { timeoutMs: 5_000 }),
		]);
		expect(a.outcome).toBe("success");
		expect(b.outcome).toBe("success");
	});
});

describe("classifyModelTestFailure：状态码与文本模式映射", () => {
	test("HTTP 状态优先：401 auth / 403·404 permission / 429 rate-limit / 408 timeout / 5xx network", () => {
		const cases = [
			["auth", 401, "invalid credentials"],
			["permission", 403, "forbidden"],
			["permission", 404, "not found"],
			["rate-limit", 429, "slow down"],
			["timeout", 408, "gateway timeout"],
			["network", 500, "internal failure"],
			["network", 503, "unavailable"],
		] as const;
		for (const [expected, status, text] of cases) {
			expect(classifyModelTestFailure({ rawMessage: `${status} ${text}` }).outcome).toBe(expected);
		}
	});

	test("SDK 前缀形态：`401 status code (no body)` 与 `503 status code (no body)`", () => {
		expect(classifyModelTestFailure({ rawMessage: "401 status code (no body)" }).outcome).toBe("auth");
		expect(classifyModelTestFailure({ rawMessage: "503 status code (no body)" }).outcome).toBe("network");
	});

	test("无状态码时按文本模式：timeout / rate-limit / auth / permission / network", () => {
		expect(
			classifyModelTestFailure({ rawMessage: "Anthropic stream timed out while waiting for the first event" })
				.outcome,
		).toBe("timeout");
		expect(
			classifyModelTestFailure({ rawMessage: "You exceeded your current quota, please check your plan" }).outcome,
		).toBe("rate-limit");
		expect(classifyModelTestFailure({ rawMessage: "Invalid API key provided" }).outcome).toBe("auth");
		expect(classifyModelTestFailure({ rawMessage: "model_not_found: no access to model" }).outcome).toBe(
			"permission",
		);
		expect(classifyModelTestFailure({ rawMessage: "fetch failed: ECONNREFUSED" }).outcome).toBe("network");
	});

	test("deadline 命中兜底 timeout；无任何归因落 network；状态码随结果透出", () => {
		const aborted = classifyModelTestFailure({ deadlineHit: true, rawMessage: "Request was aborted." });
		expect(aborted.outcome).toBe("timeout");

		const unknown = classifyModelTestFailure({ rawMessage: "weird provider-specific failure" });
		expect(unknown.outcome).toBe("network");
		expect(unknown.httpStatus).toBeUndefined();

		const withStatus = classifyModelTestFailure({ rawMessage: "HTTP 429 too many" });
		expect(withStatus.outcome).toBe("rate-limit");
		expect(withStatus.httpStatus).toBe(429);
	});

	test("deadline 命中但错误带明确归因 → 按真实归因（不伪装成超时）", () => {
		const result = classifyModelTestFailure({ deadlineHit: true, rawMessage: "429 Rate limit reached" });
		expect(result.outcome).toBe("rate-limit");
	});

	test("长错误消息截断到 300 字符（保留可读摘要，防刷屏）", () => {
		const long = "x".repeat(1_000);
		const result = classifyModelTestFailure({ rawMessage: long });
		expect(result.message.length).toBe(301);
		expect(result.message.endsWith("…")).toBe(true);
	});
});
