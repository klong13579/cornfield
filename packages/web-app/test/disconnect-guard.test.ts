import { describe, expect, it } from "bun:test";
import type { ProviderDependencyDto } from "@cornfield/wire";
import {
	acquireDisconnectLock,
	disconnectInProgress,
	releaseDisconnectLock,
	subscribeDisconnectLock,
} from "../src/pages/models/providers/mcc-sync";
import {
	FORCE_ACK_LABEL,
	forceConfirmText,
	raceLockNotice,
	sessionModelWarning,
} from "../src/pages/models/providers/provider-display";

/**
 * 断开流竞态防护回归（#08）：断开锁状态机 + 竞态/会话占用/force 确认文案。
 * mcc-sync 为模块级外部状态——每个用例自清理，避免用例间串扰。
 */

const deps: ProviderDependencyDto[] = [
	{ kind: "session-model", ref: "sess-1", model: "anthropic/claude-x" },
	{ kind: "role-binding", ref: "coder", model: "anthropic/claude-x" },
	{ kind: "role-binding", ref: "reviewer", model: "anthropic/claude-x" },
	{ kind: "model-fallback", ref: "default[0]", model: "anthropic/claude-x" },
];

describe("断开锁（同一时刻仅一个 provider 断开流程）", () => {
	it("初始无持锁；申请后成为持锁者", () => {
		expect(disconnectInProgress()).toBeNull();
		expect(acquireDisconnectLock("a")).toBe(true);
		expect(disconnectInProgress()).toBe("a");
		releaseDisconnectLock("a");
	});

	it("他人持锁时其他 provider 申请失败且不夺取锁；同 provider 幂等", () => {
		acquireDisconnectLock("a");
		expect(acquireDisconnectLock("b")).toBe(false);
		expect(disconnectInProgress()).toBe("a");
		expect(acquireDisconnectLock("a")).toBe(true); // 重复申请幂等
		expect(disconnectInProgress()).toBe("a");
		releaseDisconnectLock("a");
		expect(disconnectInProgress()).toBeNull();
	});

	it("非持锁者释放为 no-op（防乱序释放）；只有持锁者能释放", () => {
		acquireDisconnectLock("a");
		releaseDisconnectLock("b");
		expect(disconnectInProgress()).toBe("a");
		releaseDisconnectLock("a");
		expect(disconnectInProgress()).toBeNull();
	});

	it("锁状态变化通知订阅者；退订后不再通知", () => {
		const seen: Array<string | null> = [];
		const unsubscribe = subscribeDisconnectLock(() => seen.push(disconnectInProgress()));
		acquireDisconnectLock("a");
		releaseDisconnectLock("a");
		unsubscribe();
		acquireDisconnectLock("c");
		releaseDisconnectLock("c");
		expect(seen).toEqual(["a", null]);
	});

	it("用例自清理：结束时无残留持锁", () => {
		expect(disconnectInProgress()).toBeNull();
	});
});

describe("竞态与会话占用文案", () => {
	it("raceLockNotice 指名持锁 provider", () => {
		expect(raceLockNotice("anthropic")).toBe(
			"anthropic 正在执行断开——为避免配置竞态，其他 Provider 的写操作已暂停，待断开完成后恢复。",
		);
	});

	it("sessionModelWarning：含 session-model 依赖时返回警告（含模型与切换指引）；否则 null", () => {
		const warn = sessionModelWarning(deps);
		expect(warn).toContain("anthropic/claude-x");
		expect(warn).toContain("切换会话模型");
		expect(warn).toContain("立即失败");
		expect(sessionModelWarning([deps[1] as ProviderDependencyDto, deps[3] as ProviderDependencyDto])).toBeNull();
		expect(sessionModelWarning([])).toBeNull();
	});

	it("sessionModelWarning：同模型多会话去重展示", () => {
		const warn = sessionModelWarning([
			{ kind: "session-model", ref: "s1", model: "a/m" },
			{ kind: "session-model", ref: "s2", model: "a/m" },
			{ kind: "session-model", ref: "s3", model: "b/n" },
		]);
		expect(warn).toContain("a/m、b/n");
		expect(warn).not.toContain("a/m、a/m");
	});
});

describe("force 二次确认与明示勾选文案（语义红线锁定）", () => {
	it("forceConfirmText 按 kind 汇总数量并明示失效待修复 + 不可自动改写", () => {
		const text = forceConfirmText("anthropic", deps);
		expect(text).toContain("anthropic");
		expect(text).toContain("会话当前模型 1 处");
		expect(text).toContain("角色绑定 2 处");
		expect(text).toContain("回退链 1 处");
		expect(text).toContain("失效待修复");
		expect(text).toContain("不会被自动改写");
		expect(text).toContain("重新接入");
	});

	it("FORCE_ACK_LABEL 覆盖三条红线：不改配置 / 失效待修复 / 重新接入可恢复", () => {
		expect(FORCE_ACK_LABEL).toContain("不会修改任何配置");
		expect(FORCE_ACK_LABEL).toContain("失效待修复");
		expect(FORCE_ACK_LABEL).toContain("重新接入");
	});
});
