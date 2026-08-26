import { describe, expect, test } from "bun:test";
import { isPushFrame, isResponseFrame, MULTIDEVICE_PROTOCOL_VERSION, type WireCommandOfType } from "../src/index";

/**
 * 命令面契约测试（阶段 0：fs 写 / git 最小集 / 配置读写）。
 *
 * pi-wire 是纯类型包，运行期可断言的对象有限；本测试锁定：
 *   1. 协议版本稳定（breaking 变更必须 bump）。
 *   2. 帧判别 helper 语义。
 *   3. 新命令的 `WireCommandOfType` 类型解析正确（同时由 tsgo 编译期校验形状）。
 */
describe("wire 命令面契约（阶段 0 新增命令）", () => {
	test("协议版本稳定为 v1", () => {
		expect(MULTIDEVICE_PROTOCOL_VERSION).toBe(1);
	});

	test("isPushFrame / isResponseFrame 判别", () => {
		expect(isPushFrame({ type: "push", event: { type: "server_snapshot", sessions: [] } })).toBe(true);
		expect(isPushFrame({ type: "response", id: "", ok: true })).toBe(false);
		expect(isResponseFrame({ type: "response", id: "", ok: true })).toBe(true);
		expect(isResponseFrame({ type: "push", event: { type: "server_snapshot", sessions: [] } })).toBe(false);
	});

	test("fs 写命令类型可解析且字段完整", () => {
		const fsWrite: WireCommandOfType<"fs_write"> = { type: "fs_write", path: "a.txt", content: "hi" };
		const fsEdit: WireCommandOfType<"fs_edit"> = {
			type: "fs_edit",
			path: "a.txt",
			mode: "replace",
			edits: [{ old_text: "hi", new_text: "bye" }],
		};
		const fsDiff: WireCommandOfType<"fs_diff"> = { type: "fs_diff", before: "a", after: "b" };

		expect(fsWrite.path).toBe("a.txt");
		expect(fsWrite.content).toBe("hi");
		expect(fsEdit.mode).toBe("replace");
		expect(fsDiff.before).toBe("a");
	});

	test("git 命令类型可解析且字段完整", () => {
		const gitStatus: WireCommandOfType<"git_status"> = { type: "git_status" };
		const gitLog: WireCommandOfType<"git_log"> = { type: "git_log", count: 5 };
		const gitShow: WireCommandOfType<"git_show"> = { type: "git_show", revision: "HEAD" };
		const gitBranches: WireCommandOfType<"git_branches"> = { type: "git_branches" };

		expect(gitStatus.type).toBe("git_status");
		expect(gitLog.count).toBe(5);
		expect(gitShow.revision).toBe("HEAD");
		expect(gitBranches.type).toBe("git_branches");
	});

	test("配置命令类型可解析且字段完整", () => {
		const getConfig: WireCommandOfType<"get_config"> = { type: "get_config", key: "edit.mode" };
		const setConfig: WireCommandOfType<"set_config"> = { type: "set_config", key: "edit.mode", value: "hashline" };

		expect(getConfig.key).toBe("edit.mode");
		expect(setConfig.value).toBe("hashline");
	});
});
