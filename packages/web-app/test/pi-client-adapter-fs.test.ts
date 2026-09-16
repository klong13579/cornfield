import { describe, expect, it } from "bun:test";
import type { PiWebSocketCtor, PiWebSocketLike } from "@cornfield/client";
import { FsConflictError } from "../src/lib/pi-client-api";
import { PiClientAdapter } from "../src/state/pi-client-adapter";

/**
 * fs 读写命令面的适配契约：命令拼装（fs_read / fs_write 带 expectedVersion / fs_diff）+
 * 服务端判决的归一（`fs_conflict:` → FsConflictError，其余错误原样上抛）。
 *
 * 冲突必须是**可区分**的：把它和「路径越界」「未连接」混成一种错误，UI 就没法说
 * 「选哪一份」而只能说「失败了」—— 那是两种完全不同的处置。
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

function lastCommand(): Record<string, unknown> {
	const reqs = sentRequests();
	return reqs[reqs.length - 1]!.command;
}

function respondOk(result: unknown): void {
	const reqs = sentRequests();
	lastCreated?.receive(JSON.stringify({ type: "response", id: reqs[reqs.length - 1]!.id, ok: true, result }));
}

function respondError(error: unknown): void {
	const reqs = sentRequests();
	lastCreated?.receive(JSON.stringify({ type: "response", id: reqs[reqs.length - 1]!.id, ok: false, error }));
}

async function withAdapter(fn: (adapter: PiClientAdapter) => Promise<void>): Promise<void> {
	lastCreated = undefined;
	const adapter = new PiClientAdapter({ wsUrl: "ws://127.0.0.1:1/ws", token: "" }, fakeCtor);
	try {
		await connectAdapter(adapter);
		await fn(adapter);
	} finally {
		adapter.disconnect();
	}
}

describe("fs_read", () => {
	it("透传 text/truncated/version", async () => {
		await withAdapter(async adapter => {
			const pending = adapter.fsRead("default", "src/a.ts");
			expect(lastCommand()).toMatchObject({ type: "fs_read", sessionId: "default", path: "src/a.ts" });
			respondOk({ text: "one\n", truncated: false, version: "v1" });
			expect(await pending).toEqual({ text: "one\n", truncated: false, version: "v1" });
		});
	});

	it("服务端未回 version（旧 serve）时版本为空串而不是 undefined", async () => {
		await withAdapter(async adapter => {
			const pending = adapter.fsRead("default", "src/a.ts");
			respondOk({ text: "one\n", truncated: true });
			expect(await pending).toEqual({ text: "one\n", truncated: true, version: "" });
		});
	});
});

describe("fs_write", () => {
	it("把 expectedVersion 原样发出去（CAS 的输入）", async () => {
		await withAdapter(async adapter => {
			const pending = adapter.fsWrite("default", "src/a.ts", "two\n", "v1");
			expect(lastCommand()).toMatchObject({
				type: "fs_write",
				sessionId: "default",
				path: "src/a.ts",
				content: "two\n",
				expectedVersion: "v1",
			});
			respondOk({ bytesWritten: 4, version: "v2", normalized: false });
			expect(await pending).toEqual({ path: "src/a.ts", bytesWritten: 4, version: "v2", normalized: false });
		});
	});

	it("新建文件也带 CAS 基线（空串），不是省略字段", async () => {
		await withAdapter(async adapter => {
			const pending = adapter.fsWrite("default", "new.ts", "x", "");
			const command = lastCommand();
			expect(command.expectedVersion).toBe("");
			expect(Object.hasOwn(command, "expectedVersion")).toBe(true);
			respondOk({ bytesWritten: 1, version: "v1", normalized: false });
			await pending;
		});
	});

	it("服务端落盘内容被改写时 normalized=true 透传", async () => {
		await withAdapter(async adapter => {
			const pending = adapter.fsWrite("default", "src/a.ts", "one\n", "v1");
			respondOk({ bytesWritten: 5, version: "v2", normalized: true });
			expect((await pending).normalized).toBe(true);
		});
	});

	it("fs_conflict：归一成 FsConflictError（保留服务端判决原文）", async () => {
		await withAdapter(async adapter => {
			const pending = adapter.fsWrite("default", "src/a.ts", "two\n", "v1");
			respondError("fs_conflict: expected v1, actual v9");
			let caught: unknown;
			try {
				await pending;
			} catch (err) {
				caught = err;
			}
			expect(caught).toBeInstanceOf(FsConflictError);
			expect((caught as FsConflictError).detail).toBe("fs_conflict: expected v1, actual v9");
		});
	});

	it("非冲突错误原样上抛（不能被误判成冲突）", async () => {
		await withAdapter(async adapter => {
			const pending = adapter.fsWrite("default", "../../x", "two\n", "v1");
			respondError("path escapes agentDir: ../../x");
			let caught: unknown;
			try {
				await pending;
			} catch (err) {
				caught = err;
			}
			expect(caught).not.toBeInstanceOf(FsConflictError);
			expect(caught instanceof Error ? caught.message : "").toContain("path escapes agentDir");
		});
	});

	it("消息里只是提到 fs_conflict 但不以它为前缀 → 不算冲突", async () => {
		await withAdapter(async adapter => {
			const pending = adapter.fsWrite("default", "src/a.ts", "two\n", "v1");
			respondError("write failed: fs_conflict: expected v1, actual v9");
			let caught: unknown;
			try {
				await pending;
			} catch (err) {
				caught = err;
			}
			expect(caught).not.toBeInstanceOf(FsConflictError);
		});
	});
});

describe("fs_diff", () => {
	it("before/after 纯文本 diff（不落地）", async () => {
		await withAdapter(async adapter => {
			const pending = adapter.fsDiff("one\n", "two\n");
			expect(lastCommand()).toMatchObject({ type: "fs_diff", before: "one\n", after: "two\n" });
			expect(Object.hasOwn(lastCommand(), "path")).toBe(false);
			respondOk({ diff: "@@ -1,1 +1,1 @@\n-1|one\n+1|two", firstChangedLine: 1 });
			expect(await pending).toEqual({ diff: "@@ -1,1 +1,1 @@\n-1|one\n+1|two", firstChangedLine: 1 });
		});
	});

	it("缺 diff 字段时回退空串（UI 显示「无差异」而不是崩溃）", async () => {
		await withAdapter(async adapter => {
			const pending = adapter.fsDiff("a", "a");
			respondOk({});
			expect(await pending).toEqual({ diff: "", firstChangedLine: undefined });
		});
	});
});
