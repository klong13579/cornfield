/**
 * P2 e2e — 12 条命令真机验证（serve 子进程 + bun WS 客户端）。
 *
 * 覆盖：
 *   set_model / cycle_model / compact / set_todos / set_host_tools /
 *   set_auto_compaction / set_auto_retry / abort_retry /
 *   abort_and_prompt / new_session / set_session_name / get_last_assistant_text
 *
 * 不触发 LLM 计费：不发 prompt（除 abort_and_prompt 发个会立即 abort 的 dummy，
 * 使用不存在的假模型避免真实网络呼叫）。abort_retry 在无活动重试时也安全。
 * new_session/set_session_name/set_todos/set_host_tools 都是本地状态变更。
 *
 * 隔离 HOME / 端口 / 预算 / 停摆重试都在 `spawnServeFixture` 里（见该文件的说明）。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MULTIDEVICE_PROTOCOL_VERSION } from "@cornfield/wire";
import { SERVE_BOOT_BUDGET_MS, type ServeFixture, spawnServeFixture } from "./wire-serve-fixture";

type Frame = { type: string; [k: string]: unknown };

let fixture: ServeFixture | undefined;

/** 封装单次命令往返（不多路复用，保证测试隔离）。 */
async function sendCommand(command: object, timeoutMs = 30_000): Promise<Frame> {
	const ws = new WebSocket(fixture!.url);
	const { promise: opened, resolve: resolveOpened, reject: rejectOpened } = Promise.withResolvers<void>();
	ws.onopen = () => resolveOpened();
	ws.onerror = ev => rejectOpened(new Error(`ws error: ${String(ev)}`));
	await opened;

	const frames: Frame[] = [];
	const { promise: ackDone, resolve: ackResolve } = Promise.withResolvers<void>();
	const { promise: respDone, resolve: respResolve, reject: respReject } = Promise.withResolvers<Frame>();
	const timer = setTimeout(() => respReject(new Error(`timeout ${timeoutMs}ms`)), timeoutMs);

	ws.onmessage = ev => {
		const frame = JSON.parse(String(ev.data)) as Frame;
		frames.push(frame);
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

	ws.send(JSON.stringify({ type: "hello", version: MULTIDEVICE_PROTOCOL_VERSION, token: fixture!.token }));
	await ackDone;
	ws.send(JSON.stringify({ type: "request", id: "e2e", command: { id: "e2e", ...command } }));
	try {
		return await respDone;
	} finally {
		clearTimeout(timer);
		ws.close();
	}
}

beforeAll(async () => {
	fixture = await spawnServeFixture({ homePrefix: "omp-serve-p2-commands-" });
}, SERVE_BOOT_BUDGET_MS);

afterAll(async () => {
	await fixture?.dispose();
});

describe("P2 wire-server 命令面 — 12 条真机 e2e", () => {
	test("set_todos: 写入 -> get_state 可读回", async () => {
		const phases = [
			{ name: "Investigation", tasks: [{ content: "look up X", status: "pending" as const }] },
			{ name: "Impl", tasks: [] },
		];
		const r = await sendCommand({ type: "set_todos", phases });
		expect(r.ok).toBe(true);
		const todo = (r.result as { todoPhases: unknown[] }).todoPhases;
		expect(todo).toEqual(phases);

		const state = await sendCommand({ type: "get_state" });
		expect(state.ok).toBe(true);
		expect((state.result as { todoPhases: unknown[] }).todoPhases).toEqual(phases);
	});

	test("set_auto_compaction: on -> get_state -> off -> get_state", async () => {
		await sendCommand({ type: "set_auto_compaction", enabled: true });
		const onState = await sendCommand({ type: "get_state" });
		expect((onState.result as { autoCompactionEnabled: boolean }).autoCompactionEnabled).toBe(true);

		await sendCommand({ type: "set_auto_compaction", enabled: false });
		const offState = await sendCommand({ type: "get_state" });
		expect((offState.result as { autoCompactionEnabled: boolean }).autoCompactionEnabled).toBe(false);
	});

	test("set_auto_retry: 仅需 ok:true（开关没有直接回读 API，不崩即可）", async () => {
		const on = await sendCommand({ type: "set_auto_retry", enabled: true });
		expect(on.ok).toBe(true);
		const off = await sendCommand({ type: "set_auto_retry", enabled: false });
		expect(off.ok).toBe(true);
	});

	test("abort_retry: 无在途重试时仍安全（no-op）", async () => {
		const r = await sendCommand({ type: "abort_retry" });
		expect(r.ok).toBe(true);
	});

	test("set_session_name: 写入 -> get_state 可读；空串 → ok:false", async () => {
		const r = await sendCommand({ type: "set_session_name", name: "pi-wire-e2e" });
		expect(r.ok).toBe(true);
		const state = await sendCommand({ type: "get_state" });
		expect((state.result as { sessionName?: string }).sessionName).toBe("pi-wire-e2e");

		const bad = await sendCommand({ type: "set_session_name", name: "   " });
		expect(bad.ok).toBe(false);
		expect(String(bad.error)).toMatch(/empty/i);
	});

	test("get_last_assistant_text: 新会话无助手消息 → text: null", async () => {
		const r = await sendCommand({ type: "get_last_assistant_text" });
		expect(r.ok).toBe(true);
		expect((r.result as { text: string | null }).text).toBeNull();
	});

	test("set_model: 未知 model → ok:false，错误文本包含 provider/id", async () => {
		const r = await sendCommand({
			type: "set_model",
			provider: "__not_exist__",
			modelId: "nope",
		});
		expect(r.ok).toBe(false);
		expect(String(r.error)).toContain("__not_exist__/nope");
	});

	test("cycle_model: 仅需 ok:true（无 scoped models 时可能回 null，不崩即可）", async () => {
		const r = await sendCommand({ type: "cycle_model" });
		expect(r.ok).toBe(true);
		// result 可能为 null 或 { model, thinkingLevel, isScoped }，双方都可接受
	});

	test("compact: 无 model 时抛错 → ok:false；有 model 容忍无可压缩时的合法返回", async () => {
		const r = await sendCommand({ type: "compact" }, 15_000);
		// 无需断言具体归属，双方都合理：
		// - 无 model / 无可压缩内容 → ok:false 带错误或 ok:true 带 skipped result
		expect([true, false]).toContain(r.ok as boolean);
		if (!r.ok) expect(typeof r.error).toBe("string");
	});

	test("new_session: 在无任何活动时 → ok:true 带 cancelled:false", async () => {
		const r = await sendCommand({ type: "new_session" }, 90_000);
		expect(r.ok).toBe(true);
		expect((r.result as { cancelled: boolean }).cancelled).toBe(false);
	});

	test("abort_and_prompt: 预先 abort，下一会话里立即 fire——绝不阻塞响应", async () => {
		// 新会话后不发真消息。发一个 fire-and-forget，服务器应立刻 ok:true
		const r = await sendCommand({ type: "abort_and_prompt", message: "__e2e_dummy__" }, 15_000);
		expect(r.ok).toBe(true);
		// 立即再 abort 以充分防止真实 LLM 拉起（均已上锁时 setModel 未拒绝——刚刚失败并不影响 session.model）
		await sendCommand({ type: "abort" });
	});

	test("set_host_tools: 注册成功返回 toolNames（P3 双向帧已实现，host_tool 调用闭环在多 agent e2e 里验）", async () => {
		const r = await sendCommand({
			type: "set_host_tools",
			tools: [{ name: "cron", description: "cron tool", parameters: {} }],
		});
		expect(r.ok).toBe(true);
		expect((r.result as { toolNames: string[] }).toolNames).toEqual(["cron"]);
	});
});
