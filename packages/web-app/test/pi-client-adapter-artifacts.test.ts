import { describe, expect, it } from "bun:test";
import type { PiWebSocketCtor, PiWebSocketLike } from "@oh-my-pi/pi-client";
import { PiClientAdapter } from "../src/state/pi-client-adapter";

/**
 * R-ARTIFACTS 契约测试：listArtifacts 命令拼装 + artifactPreviewUrl 静态 URL 构造。
 *
 * - listArtifacts：发出 { type: "list_artifacts", sessionId }，把 serve 返回的 artifacts 透传，
 *   缺失字段回退空数组
 * - artifactPreviewUrl：ws://host:port/ws → http://host:port/preview/<agentId>/<path>；
 *   path 逐段 URL 编码；token 非空时带 ?token=
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

const fakeCtor: PiWebSocketCtor = FakeWebSocket;

async function connectAdapter(adapter: PiClientAdapter): Promise<void> {
	const connectPromise = adapter.connect();
	lastCreated?.onopen?.({});
	lastCreated?.receive(JSON.stringify({ type: "hello_ack", connectionId: "c1", protocolVersion: 1 }));
	await connectPromise;
}

function sentRequests(): Array<{ id: string; command: Record<string, unknown> }> {
	return (lastCreated?.sent ?? [])
		.map(s => JSON.parse(s) as { type?: string; id?: string; command?: Record<string, unknown> })
		.filter(
			(f): f is { id: string; command: Record<string, unknown> } => f.type === "request" && !!f.id && !!f.command,
		);
}

function respond(result: unknown): void {
	const reqs = sentRequests();
	lastCreated?.receive(JSON.stringify({ type: "response", id: reqs[reqs.length - 1]!.id, ok: true, result }));
}

describe("PiClientAdapter 产物（R-ARTIFACTS list_artifacts）", () => {
	it("listArtifacts 发出定向命令并把 artifacts 透传", async () => {
		lastCreated = undefined;
		const adapter = new PiClientAdapter({ wsUrl: "ws://127.0.0.1:1/ws", token: "" }, fakeCtor);
		try {
			await connectAdapter(adapter);
			const pending = adapter.listArtifacts("hr");
			const reqs = sentRequests();
			const cmd = reqs[reqs.length - 1]!.command;
			expect(cmd).toEqual({ type: "list_artifacts", sessionId: "hr", id: cmd.id });
			respond({
				artifacts: [
					{
						id: "dashboard.html",
						title: "dashboard.html",
						type: "html",
						path: "dashboard.html",
						updatedAt: 1787829000000,
						size: 13261,
					},
				],
			});
			const { artifacts } = await pending;
			expect(artifacts).toHaveLength(1);
			expect(artifacts[0]!.type).toBe("html");
			expect(artifacts[0]!.path).toBe("dashboard.html");
		} finally {
			adapter.disconnect();
		}
	});

	it("listArtifacts 带 sessionFile 定向单会话", async () => {
		lastCreated = undefined;
		const adapter = new PiClientAdapter({ wsUrl: "ws://127.0.0.1:1/ws", token: "" }, fakeCtor);
		try {
			await connectAdapter(adapter);
			const pending = adapter.listArtifacts("hr", "/abs/sessions/aaaa.jsonl");
			const reqs = sentRequests();
			const cmd = reqs[reqs.length - 1]!.command;
			expect(cmd).toEqual({
				type: "list_artifacts",
				sessionId: "hr",
				sessionFile: "/abs/sessions/aaaa.jsonl",
				id: cmd.id,
			});
			respond({ artifacts: [] });
			const { artifacts } = await pending;
			expect(artifacts).toEqual([]);
		} finally {
			adapter.disconnect();
		}
	});

	it("serve 返回缺 artifacts 字段时回退空数组", async () => {
		lastCreated = undefined;
		const adapter = new PiClientAdapter({ wsUrl: "ws://127.0.0.1:1/ws", token: "" }, fakeCtor);
		try {
			await connectAdapter(adapter);
			const pending = adapter.listArtifacts("hr");
			respond({});
			const { artifacts } = await pending;
			expect(artifacts).toEqual([]);
		} finally {
			adapter.disconnect();
		}
	});

	it("artifactPreviewUrl：ws→http + path 逐段编码 + token query", async () => {
		const adapter = new PiClientAdapter({ wsUrl: "ws://127.0.0.1:7891/ws", token: "" }, fakeCtor);
		try {
			expect(adapter.artifactPreviewUrl("hr", "dashboard.html")).toBe(
				"http://127.0.0.1:7891/preview/hr/dashboard.html",
			);
			// 子目录 + 特殊字符逐段编码
			expect(adapter.artifactPreviewUrl("hr", "sub dir/我的 报告.html")).toBe(
				"http://127.0.0.1:7891/preview/hr/sub%20dir/%E6%88%91%E7%9A%84%20%E6%8A%A5%E5%91%8A.html",
			);
		} finally {
			adapter.disconnect();
		}
	});

	it("artifactPreviewUrl：token 非空时带 query", async () => {
		const adapter = new PiClientAdapter({ wsUrl: "ws://127.0.0.1:7891/ws", token: "s3cr3t" }, fakeCtor);
		try {
			expect(adapter.artifactPreviewUrl("default", "a.html")).toBe(
				"http://127.0.0.1:7891/preview/default/a.html?token=s3cr3t",
			);
		} finally {
			adapter.disconnect();
		}
	});
});
