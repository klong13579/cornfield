/**
 * InMemoryWireClient — 进程内 wire 客户端单测（P3）。
 * 用 stub WireCore 验证：命令往返、push 分发、焦点切换、dispose。
 */
import { describe, expect, test } from "bun:test";
import type { ServerFrame, WireCommand } from "@oh-my-pi/pi-wire";
import { createInMemoryWireClient } from "../../src/server/memory-wire";
import type { CommandContext, WireCore, WireCoreTarget } from "../../src/server/wire-server";

function makeStubCore(): { core: WireCore; targets: WireCoreTarget[]; ctxs: CommandContext[] } {
	const targets: WireCoreTarget[] = [];
	const ctxs: CommandContext[] = [];
	const core: WireCore = {
		registry: {} as never,
		addTarget: (t: WireCoreTarget) => {
			targets.push(t);
			return () => {
				const idx = targets.indexOf(t);
				if (idx !== -1) targets.splice(idx, 1);
			};
		},
		handleCommand: async (ctx, command: WireCommand, reply) => {
			ctxs.push(ctx);
			switch (command.type) {
				case "get_state":
					reply({ type: "response", id: command.id ?? "", ok: true, result: { sessionId: ctx.activeAgentId } });
					return;
				case "set_model":
					reply({ type: "response", id: command.id ?? "", ok: true, result: command });
					return;
				default:
					reply({ type: "response", id: command.id ?? "", ok: false, error: `stub: ${command.type}` });
			}
		},
		sendSessionSnapshotTo: (t: WireCoreTarget) => {
			t.send({
				type: "push",
				event: { type: "session_snapshot", sessionId: t.getActiveAgentId(), snapshot: {} as never },
			});
		},
		broadcastServerSnapshot: () => {
			for (const t of targets) t.send({ type: "push", event: { type: "server_snapshot", sessions: [] } });
		},
	};
	return { core, targets, ctxs };
}

describe("InMemoryWireClient", () => {
	test("sendCommand round-trips through the core", async () => {
		const { core } = makeStubCore();
		const client = createInMemoryWireClient(core);
		const res = await client.sendCommand({ type: "get_state" });
		expect(res).toEqual({ ok: true, result: { sessionId: "default" } });
		client.dispose();
	});

	test("sendCommand surfaces core errors", async () => {
		const { core } = makeStubCore();
		const client = createInMemoryWireClient(core);
		const res = await client.sendCommand({ type: "bogus" as never });
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error).toContain("stub");
		client.dispose();
	});

	test("onPush receives server-snapshot broadcasts and session snapshots", async () => {
		const { core, targets } = makeStubCore();
		const client = createInMemoryWireClient(core);
		const pushes: ServerFrame[] = [];
		client.onPush(f => pushes.push(f));

		core.broadcastServerSnapshot();
		expect(pushes.length).toBe(1);
		expect(pushes[0].type).toBe("push");

		// sendSessionSnapshotTo 定向推
		const target = targets.find(t => t.id === "tui-memory");
		expect(target).toBeDefined();
		core.sendSessionSnapshotTo(target!);
		expect(pushes.length).toBe(2);
		const snap = pushes[1] as { event: { type: string; sessionId: string } };
		expect(snap.event.type).toBe("session_snapshot");
		expect(snap.event.sessionId).toBe("default");
		client.dispose();
	});

	test("setActiveAgentId flows into the command ctx", async () => {
		const { core, ctxs } = makeStubCore();
		const client = createInMemoryWireClient(core, { agentId: "default" });
		client.setActiveAgentId("hr");
		const res = await client.sendCommand({ type: "get_state" });
		expect(res).toEqual({ ok: true, result: { sessionId: "hr" } });
		expect(ctxs[0].activeAgentId).toBe("hr");
		client.dispose();
	});

	test("dispose rejects further commands and removes the target", async () => {
		const { core, targets } = makeStubCore();
		const client = createInMemoryWireClient(core);
		const res = await client.sendCommand({ type: "get_state" });
		expect(res.ok).toBe(true);
		client.dispose();
		expect(targets.find(t => t.id === "tui-memory")).toBeUndefined();
		const after = await client.sendCommand({ type: "get_state" });
		expect(after).toEqual({ ok: false, error: "client disposed" });
	});

	test("permission_request push reaches the client handler", async () => {
		const { core, targets } = makeStubCore();
		const client = createInMemoryWireClient(core);
		const pushes: Array<{ event: { type: string; requestId: string } }> = [];
		client.onPush(f => pushes.push(f as never));
		// 模拟 core 发 permission_request（通过 target.send）
		const target = targets.find(t => t.id === "tui-memory")!;
		target.send({
			type: "push",
			event: {
				type: "permission_request",
				kind: "approval",
				requestId: "r1",
				command: "bash",
				description: "run bash?",
				patternKeys: [],
			},
		});
		expect(pushes.length).toBe(1);
		expect(pushes[0].event.type).toBe("permission_request");
		expect(pushes[0].event.requestId).toBe("r1");
		client.dispose();
	});

	test("session_snapshot push populates the snapshot cache", async () => {
		const { core, targets } = makeStubCore();
		const client = createInMemoryWireClient(core);
		expect(client.getSnapshot()).toBeUndefined();
		const target = targets.find(t => t.id === "tui-memory")!;
		target.send({
			type: "push",
			event: {
				type: "session_snapshot",
				sessionId: "default",
				snapshot: {
					seq: 1,
					sessionId: "default",
					messages: [],
					todoPhases: [],
					activeToolNames: [],
					queuedMessageCount: 2,
					phase: "streaming",
					retryAttempt: 0,
					isCompacting: false,
					isStreaming: true,
					autoCompactionEnabled: true,
					autoRetryEnabled: true,
				},
			},
		});
		const snap = client.getSnapshot();
		expect(snap).toBeDefined();
		expect(snap?.queuedMessageCount).toBe(2);
		expect(snap?.isStreaming).toBe(true);
		// 后续 push 覆盖缓存
		target.send({
			type: "push",
			event: {
				type: "session_snapshot",
				sessionId: "default",
				snapshot: {
					seq: 2,
					sessionId: "default",
					messages: [],
					todoPhases: [],
					activeToolNames: [],
					queuedMessageCount: 0,
					phase: "idle",
					retryAttempt: 0,
					isCompacting: false,
					isStreaming: false,
					autoCompactionEnabled: true,
					autoRetryEnabled: true,
				},
			},
		});
		expect(client.getSnapshot()?.isStreaming).toBe(false);
		client.dispose();
		expect(client.getSnapshot()).toBeUndefined();
	});
});
