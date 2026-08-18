import { describe, expect, it } from "bun:test";
import type { PiWebSocketCtor, PiWebSocketLike } from "@oh-my-pi/pi-client";
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
