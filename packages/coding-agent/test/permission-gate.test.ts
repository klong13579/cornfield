import { describe, expect, it } from "bun:test";
import { PERMISSION_TIMEOUT_OUTCOME, PermissionGate } from "@oh-my-pi/pi-coding-agent/server/permission-gate";

/**
 * 审批/澄清 shell 的 gate 级集成测试（壳内验证）：inject → push 数据到位 → respond
 * 三路（once/always/deny）round-trip，脏值/未知 requestId 回 error，超时/清空 settle 哨兵。
 * WS 传输（wire-server 的广播与 send）是薄封装，这里覆盖 pending/校验/决议全部逻辑。
 */
describe("PermissionGate", () => {
	it("approval inject 产出完整 push（command/description/patternKeys）", () => {
		const gate = new PermissionGate();
		const { push } = gate.inject("approval");
		if (push.kind !== "approval") throw new Error("expected approval push");
		expect(push.type).toBe("permission_request");
		expect(push.requestId).toBeTruthy();
		expect(push.command).toBeTruthy();
		expect(push.description).toBeTruthy();
		expect(push.patternKeys.length).toBeGreaterThan(0);
	});

	it("once / always / deny 三路 round-trip", async () => {
		const gate = new PermissionGate();

		const once = gate.inject("approval");
		expect(gate.respond(once.push.requestId, "once")).toEqual({ ok: true });
		expect(await once.outcome).toBe("once");

		const always = gate.inject("approval");
		expect(gate.respond(always.push.requestId, "always")).toEqual({ ok: true });
		expect(await always.outcome).toBe("always");

		const deny = gate.inject("approval");
		expect(gate.respond(deny.push.requestId, "deny")).toEqual({ ok: true });
		expect(await deny.outcome).toBe("deny");
	});

	it("脏值回 error 且不消耗 pending（可重试）", async () => {
		const gate = new PermissionGate();
		const { push, outcome } = gate.inject("approval");

		const bad = gate.respond(push.requestId, "sometimes");
		expect(bad.ok).toBe(false);
		if (bad.ok) throw new Error("expected error");

		expect(gate.respond(push.requestId, "session")).toEqual({ ok: true });
		expect(await outcome).toBe("session");
	});

	it("未知 requestId 回 error，不爆炸", () => {
		const gate = new PermissionGate();
		expect(gate.respond("missing", "deny").ok).toBe(false);
	});

	it("clarify：任意 option 均合法并回传", async () => {
		const gate = new PermissionGate();
		const { push, outcome } = gate.inject("clarify");
		if (push.kind !== "clarify") throw new Error("expected clarify push");
		expect(push.options.length).toBeGreaterThan(0);

		const option = push.options[0];
		expect(gate.respond(push.requestId, option)).toEqual({ ok: true });
		expect(await outcome).toBe(option);
	});

	it("超时 settle 哨兵值；clearAll 清空所有 pending", async () => {
		const short = new PermissionGate(20);
		const { outcome: timed } = short.inject("approval");
		expect(await timed).toBe(PERMISSION_TIMEOUT_OUTCOME);

		const gate = new PermissionGate(60_000);
		const pending = gate.inject("approval");
		gate.clearAll();
		expect(await pending.outcome).toBe(PERMISSION_TIMEOUT_OUTCOME);
	});
});
