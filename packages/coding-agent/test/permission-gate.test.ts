import { describe, expect, it } from "bun:test";
import { PERMISSION_TIMEOUT_OUTCOME, PermissionGate } from "@cornfield/coding-agent/server/permission-gate";

/**
 * 审批/澄清 shell 的 gate 级集成测试：inject（mock 测试通道）+ requestApproval（真实 bash 源）
 * → push 数据到位 → respond once/session/deny round-trip，脏值/未知 requestId 回 error，
 * session 放行写内存 allowlist（精确归一化匹配），always 已移除，超时/清空 settle 哨兵。
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

	it("once / session / deny 三路 round-trip", async () => {
		const gate = new PermissionGate();

		const once = gate.inject("approval");
		expect(gate.respond(once.push.requestId, "once")).toEqual({ ok: true });
		expect(await once.outcome).toBe("once");

		const session = gate.inject("approval");
		expect(gate.respond(session.push.requestId, "session")).toEqual({ ok: true });
		expect(await session.outcome).toBe("session");

		const deny = gate.inject("approval");
		expect(gate.respond(deny.push.requestId, "deny")).toEqual({ ok: true });
		expect(await deny.outcome).toBe("deny");
	});

	it("always 已移除：respond 回 error 且不消耗 pending（可重试）", async () => {
		const gate = new PermissionGate();
		const { push, outcome } = gate.inject("approval");

		expect(gate.respond(push.requestId, "always").ok).toBe(false);
		expect(gate.respond(push.requestId, "once")).toEqual({ ok: true });
		expect(await outcome).toBe("once");
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

	it("requestApproval 产出真实命令 push（patternKeys 为空）", () => {
		const gate = new PermissionGate();
		const { push } = gate.requestApproval("rm -rf /tmp/x", "bash");
		if (push.kind !== "approval") throw new Error("expected approval push");
		expect(push.type).toBe("permission_request");
		expect(push.command).toBe("rm -rf /tmp/x");
		expect(push.description).toBe("bash");
		expect(push.patternKeys).toEqual([]);
	});

	it("session 放行写入内存 allowlist（精确归一化匹配）", async () => {
		const gate = new PermissionGate();
		expect(gate.isSessionApproved("echo   hi")).toBe(false);

		const { push, outcome } = gate.requestApproval("echo   hi", "bash");
		expect(gate.respond(push.requestId, "session")).toEqual({ ok: true });
		expect(await outcome).toBe("session");

		// 折叠空白后命中精确命令
		expect(gate.isSessionApproved("echo hi")).toBe(true);
		// 前缀/其它命令不命中
		expect(gate.isSessionApproved("echo hi there")).toBe(false);
		expect(gate.isSessionApproved("echo")).toBe(false);
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
