import { describe, expect, it } from "bun:test";
import type { PiWebSocketCtor, PiWebSocketLike } from "@cornfield/client";
import type { PermissionRequestDto, WireServerEventDto } from "../src/lib/wire-dto";
import { PiClientAdapter, type ServeConnectionConfig } from "../src/state/pi-client-adapter";

/**
 * MOUNT-2 回归：PiClientAdapter 把 serve 推来的 `permission_request` push 帧透传给订阅者。
 * 修复前 `#handlePush` 只处理 server_snapshot/session_snapshot/progress/host_tool_call，
 * permission_request 被静默丢弃——这就是审批卡链路断裂（推到了 pi-client，但没到 store/UI）。
 */

let lastCreated: FakeWebSocket | undefined;

class FakeWebSocket implements PiWebSocketLike {
	readyState = 1;
	sent: string[] = [];
	onopen: PiWebSocketLike["onopen"] = null;
	onmessage: PiWebSocketLike["onmessage"] = null;
	onclose: PiWebSocketLike["onclose"] = null;
	onerror: PiWebSocketLike["onerror"] = null;

	constructor(_url: string) {
		lastCreated = this;
	}

	send(data: string): void {
		this.sent.push(data);
	}

	close(): void {}

	receive(data: string): void {
		this.onmessage?.({ data });
	}
}

// FakeWebSocket 是合法的 PiWebSocketCtor（new (url) => PiWebSocketLike）。
const fakeCtor: PiWebSocketCtor = FakeWebSocket;

const config: ServeConnectionConfig = { wsUrl: "ws://127.0.0.1:1/ws", token: "" };

async function connectAdapter(adapter: PiClientAdapter): Promise<void> {
	const connectPromise = adapter.connect();
	lastCreated?.onopen?.({});
	lastCreated?.receive(JSON.stringify({ type: "hello_ack", connectionId: "c1", protocolVersion: 1 }));
	await connectPromise;
}

describe("PiClientAdapter 模型禁用（W3 set_model_disabled）", () => {
	/** 解析已发出的 request 帧（不含 hello/ping）。 */
	function sentRequests(): Array<{ id: string; command: Record<string, unknown> }> {
		return (lastCreated?.sent ?? [])
			.map(s => JSON.parse(s) as { type?: string; id?: string; command?: Record<string, unknown> })
			.filter(
				(f): f is { id: string; command: Record<string, unknown> } => f.type === "request" && !!f.id && !!f.command,
			);
	}

	/** 用当前最新 request 帧的 id 回一个 ok 响应（result 为 serve 的 response.result）。 */
	function respond(result: unknown): void {
		const reqs = sentRequests();
		lastCreated?.receive(JSON.stringify({ type: "response", id: reqs[reqs.length - 1]!.id, ok: true, result }));
	}

	it("getAvailableModels 映射 models + 停用名单（Fallback 无）", async () => {
		lastCreated = undefined;
		const adapter = new PiClientAdapter(config, fakeCtor);
		try {
			await connectAdapter(adapter);
			const pending = adapter.getAvailableModels();
			respond({
				models: [
					{
						id: "glm-5.2",
						name: "GLM 5.2",
						provider: "narwal-plan",
						reasoning: true,
						contextWindow: 1_000_000,
						cost: { input: 1 },
					},
				],
				disabledProviders: ["openai"],
				disabledModels: ["test-plan/glm-5"],
			});
			const result = await pending;
			expect(result.models).toHaveLength(1);
			expect(result.models[0]).toMatchObject({
				id: "glm-5.2",
				provider: "narwal-plan",
				description: "GLM 5.2",
				supportsThinking: true,
			});
			expect(result.disabledProviders).toEqual(["openai"]);
			expect(result.disabledModels).toEqual(["test-plan/glm-5"]);
			expect(result.models[0]?.contextWindow).toContain("1"); // fmtTokens 数字→“1M”格式化
		} finally {
			adapter.disconnect();
		}
	});

	it("setModelDisabled（模型级）发 provider/modelId 命令并映射返回名单", async () => {
		lastCreated = undefined;
		const adapter = new PiClientAdapter(config, fakeCtor);
		try {
			await connectAdapter(adapter);
			const pending = adapter.setModelDisabled("narwal-plan", "glm-5.2", true);

			const req = sentRequests().at(-1);
			expect(req?.command).toMatchObject({
				type: "set_model_disabled",
				provider: "narwal-plan",
				modelId: "glm-5.2",
				disabled: true,
			});

			respond({ ok: true, disabledProviders: [], disabledModels: ["narwal-plan/glm-5.2"] });
			const result = await pending;
			expect(result).toEqual({ ok: true, disabledProviders: [], disabledModels: ["narwal-plan/glm-5.2"] });
		} finally {
			adapter.disconnect();
		}
	});

	it("setModelDisabled（provider 级）不带 modelId 字段", async () => {
		lastCreated = undefined;
		const adapter = new PiClientAdapter(config, fakeCtor);
		try {
			await connectAdapter(adapter);
			const pending = adapter.setModelDisabled("narwal-plan", undefined, true);

			const req = sentRequests().at(-1);
			expect(req?.command).toMatchObject({ type: "set_model_disabled", provider: "narwal-plan", disabled: true });
			expect(req?.command).not.toHaveProperty("modelId");

			respond({ ok: true, disabledProviders: ["narwal-plan"], disabledModels: [] });
			expect(await pending).toEqual({ ok: true, disabledProviders: ["narwal-plan"], disabledModels: [] });
		} finally {
			adapter.disconnect();
		}
	});
});

describe("PiClientAdapter push 转发", () => {
	it("permission_request（approval）透传给订阅者", async () => {
		lastCreated = undefined;
		const adapter = new PiClientAdapter(config, fakeCtor);
		const received: WireServerEventDto[] = [];
		adapter.subscribe(frame => received.push(frame));

		try {
			await connectAdapter(adapter);

			const request: PermissionRequestDto = {
				type: "permission_request",
				requestId: "r1",
				kind: "approval",
				command: "echo hi",
				description: "bash",
				patternKeys: [],
			};
			lastCreated?.receive(JSON.stringify({ type: "push", event: request }));

			expect(received).toEqual([request]);
		} finally {
			adapter.disconnect();
		}
	});

	it("permission_request（clarify）同样透传", async () => {
		lastCreated = undefined;
		const adapter = new PiClientAdapter(config, fakeCtor);
		const received: WireServerEventDto[] = [];
		adapter.subscribe(frame => received.push(frame));

		try {
			await connectAdapter(adapter);

			const request: PermissionRequestDto = {
				type: "permission_request",
				requestId: "r2",
				kind: "clarify",
				question: "要继续吗？",
				options: ["是", "否"],
			};
			lastCreated?.receive(JSON.stringify({ type: "push", event: request }));

			expect(received).toEqual([request]);
		} finally {
			adapter.disconnect();
		}
	});
});
