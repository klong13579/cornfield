import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionRecordSummary } from "../src/lib/records";
import {
	type CurrentRow,
	clampMenuPosition,
	renameNameToSubmit,
	renameTargetOf,
	SessionMenuPanel,
	SessionRow,
	type SidebarRow,
	sessionMenuItems,
} from "../src/pages/workspace/SessionSidebar";

/**
 * 会话改名：一行该发哪条命令（纯函数）+ 菜单/输入框长什么样（静态渲染）。
 *
 * 两条 wire 命令的分工是这组用例的核心：`rename_session` 按**会话文件**定位（列表里的历史
 * 会话），`set_session_name` 只能改**本连接挂着的那个**（当前会话那一行）——反过来用会被 serve
 * 拒（`session is open in this process`）。这个判据要是抽错，用户看到的是一条注定失败的命令。
 *
 * 环境约束：web-app 全仓走 `react-dom/server` 静态渲染（无 DOM、不跑 effect），所以交互（Enter
 * 提交 / Esc 取消）落在导出纯函数与静态标记上，真浏览器的行为由主 agent 手验。
 */

function session(patch: Partial<SessionRecordSummary> & { id: string }): SessionRecordSummary {
	return {
		name: patch.id,
		agent: "default",
		startedAt: "2026-09-15T10:00:00.000Z",
		messageCount: 1,
		status: "completed",
		source: "cli",
		...patch,
	};
}

const HISTORY_WITH_FILE = session({ id: "s1", name: "昨天的会话", sessionFile: "/root/sessions/a.jsonl" });
const HISTORY_WITHOUT_FILE = session({ id: "s2", name: "没落盘的会话" });
const CURRENT: CurrentRow = { id: "default", name: "实时会话", agent: "attached", current: true };

describe("renameTargetOf：这一行该发哪条命令", () => {
	it("历史行有 sessionFile → 改那个文件的 rename_session", () => {
		expect(renameTargetOf(HISTORY_WITH_FILE, CURRENT.id)).toEqual({
			kind: "history",
			sessionFile: "/root/sessions/a.jsonl",
		});
	});

	it("历史行没有 sessionFile → none，且带得出原因（不是画一个点了没反应的项）", () => {
		const target = renameTargetOf(HISTORY_WITHOUT_FILE, CURRENT.id);

		expect(target.kind).toBe("none");
		expect(target.kind === "none" ? target.reason : "").toContain("会话文件");
	});

	it("sessionFile 只有空白 → 同样当成没有（空路径发过去就是一次注定被拒的往返）", () => {
		expect(renameTargetOf(session({ id: "s3", sessionFile: "   " }), CURRENT.id).kind).toBe("none");
	});

	it("当前会话行 → active（它的 id 是附件地址，只能走 set_session_name）", () => {
		expect(renameTargetOf(CURRENT, CURRENT.id)).toEqual({ kind: "active" });
	});

	it("行的 id 就是本连接挂着的那个地址 → active（判据是身份，不是行的形状）", () => {
		// 形状上是历史行（有 sessionFile），但地址对上了本连接挂着的那个会话：拿文件去 rename_session
		// 会被 serve 拒（本进程打开着的会话），所以走 active。
		expect(renameTargetOf(HISTORY_WITH_FILE, HISTORY_WITH_FILE.id)).toEqual({ kind: "active" });
	});
});

describe("renameNameToSubmit：空名字不发命令", () => {
	it("空串 / 纯空白 → undefined（输入框原地留着让人接着改）", () => {
		expect(renameNameToSubmit("")).toBeUndefined();
		expect(renameNameToSubmit("   ")).toBeUndefined();
		expect(renameNameToSubmit("\t\n")).toBeUndefined();
	});

	it("正常的名字原样发（只 trim，不做第二遍清洗 —— 那是 serve 的事）", () => {
		expect(renameNameToSubmit("新名字")).toBe("新名字");
		expect(renameNameToSubmit("  新名字  ")).toBe("新名字");
	});
});

describe("sessionMenuItems：改不了就说得出为什么", () => {
	it("能改：一项「重命名」，可用", () => {
		expect(sessionMenuItems({ kind: "active" })).toEqual([{ id: "rename", label: "重命名", disabled: false }]);
		expect(sessionMenuItems({ kind: "history", sessionFile: "/a.jsonl" })).toEqual([
			{ id: "rename", label: "重命名", disabled: false },
		]);
	});

	it("不能改：同一项仍在，但 disabled 且带原因（原因就是 none 给的那条）", () => {
		const target = renameTargetOf(HISTORY_WITHOUT_FILE, CURRENT.id);
		const items = sessionMenuItems(target);

		expect(items).toHaveLength(1);
		expect(items[0]?.label).toBe("重命名");
		expect(items[0]?.disabled).toBe(true);
		expect(items[0]?.reason).toBe(target.kind === "none" ? target.reason : undefined);
	});
});

describe("clampMenuPosition：贴光标但不越出视口", () => {
	const VIEWPORT = { width: 1000, height: 800 };
	const SIZE = { width: 150, height: 40 };

	it("视口里放得下：就贴在光标上", () => {
		expect(clampMenuPosition({ x: 100, y: 200 }, SIZE, VIEWPORT)).toEqual({ left: 100, top: 200 });
	});

	it("右边 / 下边放不下：收回来贴着边", () => {
		expect(clampMenuPosition({ x: 990, y: 795 }, SIZE, VIEWPORT)).toEqual({ left: 842, top: 752 });
	});

	it("视口比菜单还小：退到边距，不出现负坐标", () => {
		expect(clampMenuPosition({ x: 5, y: 5 }, SIZE, { width: 100, height: 20 })).toEqual({ left: 8, top: 8 });
	});
});

describe("SessionMenuPanel 静态渲染：role 与不可用项", () => {
	function render(props: Parameters<typeof SessionMenuPanel>[0]): string {
		return renderToStaticMarkup(createElement(SessionMenuPanel, props));
	}

	it("role=menu + 一项 role=menuitem 写「重命名」，可用时没有 disabled", () => {
		const html = render({
			left: 10,
			top: 20,
			items: sessionMenuItems({ kind: "active" }),
			onSelect: () => undefined,
		});

		expect(html).toContain('role="menu"');
		expect(html).toContain('role="menuitem"');
		expect(html).toContain("重命名");
		// 只看属性：class 里的 `disabled:` 变体不算
		expect(html).not.toContain('disabled=""');
	});

	it("sessionFile 缺失：那一项 disabled，且 title 上说得出为什么", () => {
		const items = sessionMenuItems(renameTargetOf(HISTORY_WITHOUT_FILE, CURRENT.id));
		const html = render({ left: 10, top: 20, items, onSelect: () => undefined });
		const reason = items[0]?.reason ?? "";

		expect(reason).not.toBe("");
		expect(html).toContain('role="menuitem"');
		expect(html).toContain('disabled=""');
		expect(html).toContain(`title="${reason}"`);
	});
});

describe("SessionRow 静态渲染：就地改名的输入框", () => {
	function render(row: SidebarRow, renaming: boolean): string {
		return renderToStaticMarkup(
			createElement(SessionRow, {
				row,
				pinned: false,
				active: false,
				renaming,
				onTogglePin: () => undefined,
				onRenameSubmit: () => undefined,
				onRenameCancel: () => undefined,
			}),
		);
	}

	it("改名前：还是原来那格名字（按钮），没有输入框", () => {
		const html = render(HISTORY_WITH_FILE, false);

		expect(html).not.toContain("<input");
		expect(html).toContain("昨天的会话");
	});

	it("改名中：名字那格换成输入框，初值就是当前名字", () => {
		const html = render(HISTORY_WITH_FILE, true);

		expect(html).toContain("<input");
		expect(html).toContain('value="昨天的会话"');
		expect(html).toContain('aria-label="会话名"');
	});
});
