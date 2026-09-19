import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionRecordSummary } from "../src/lib/records";
import {
	type CurrentRow,
	groupRowsId,
	isGroupOpen,
	renderGroups,
	SessionGroupHeader,
	type SidebarRow,
	splitPinned,
} from "../src/pages/workspace/SessionSidebar";

/**
 * 会话侧栏按 Agent 折叠（默认全折叠）。
 *
 * 折叠的意义在于列表长度：default 一个 Agent 就 800+ 个会话文件，进工作台先看见的是 Agent，
 * 不是会话。三条规则在这里钉住：
 *   - 默认态是**折叠**（展开态是点出来的，不是默认值），且不持久化；
 *   - 不可折叠的组（当前会话 / 置顶）恒展开 —— 不给它们画箭头，因为点了不会有反应；
 *   - 过滤中一律展开：过滤已经剔掉了不命中的行，命中却藏在折叠里等于没命中；此时组头也退回
 *     纯标题（一个此刻点了没用的开关比没有它更坏），但箭头照画（让它消失会把整个列表左移一档）。
 *
 * pin 的处理同样是这组用例的一部分：pin 是视图偏好，不是分组轴 —— 它把行从 Agent 组里**搬**进
 * 「置顶」组（不是复制），否则折叠一上来就把 pin 的东西藏了，pin 等于废掉；而「当前会话」永远是
 * 第一组（那一行是回实时的唯一入口）。
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

const CURRENT: CurrentRow = { id: "live", name: "当前会话", agent: "attached", current: true };

describe("splitPinned：pin 过的行搬去置顶组，不是复制", () => {
	it("pin 过的行从 rest 里消失，进 pinned（顺序 = 原行序）", () => {
		const rows: SidebarRow[] = [
			session({ id: "s1", agent: "hr" }),
			session({ id: "s2", agent: "default" }),
			session({ id: "s3", agent: "hr" }),
		];

		const { pinned, rest } = splitPinned(rows, new Set(["s3", "s1"]));

		expect(pinned.map(r => r.id)).toEqual(["s1", "s3"]);
		expect(rest.map(r => r.id)).toEqual(["s2"]);
	});

	it("没 pin 的一律留在 rest（空 pin 表 = 原样）", () => {
		const rows: SidebarRow[] = [session({ id: "s1" }), session({ id: "s2" })];

		const { pinned, rest } = splitPinned(rows, new Set());

		expect(pinned).toHaveLength(0);
		expect(rest.map(r => r.id)).toEqual(["s1", "s2"]);
	});

	it("当前会话那一行不会被 pin 表里同名的字符串认领走（它的 id 是附件地址）", () => {
		// 用户点当前会话那一行的 pin，写进去的是附件地址（如 `default`）——它不得把这一行搬出
		// 「当前会话」组：那一行是回实时的唯一入口，搬走等于把入口藏了。
		const rows: SidebarRow[] = [CURRENT, session({ id: "s1", agent: "default" })];

		const { pinned, rest } = splitPinned(rows, new Set([CURRENT.id, "s1"]));

		expect(pinned.map(r => r.id)).toEqual(["s1"]);
		expect(rest.map(r => r.id)).toEqual([CURRENT.id]);
	});
});

describe("isGroupOpen：默认折叠，除两种例外", () => {
	const DEFAULT_GROUP = { key: "agent:default", collapsible: true };

	it("可折叠的组默认是折叠的（expanded 空集 = 一个都没点过）", () => {
		expect(isGroupOpen(DEFAULT_GROUP, { expanded: new Set(), filtering: false })).toBe(false);
	});

	it("点过（在 expanded 里）就是展开的", () => {
		expect(isGroupOpen(DEFAULT_GROUP, { expanded: new Set(["agent:default"]), filtering: false })).toBe(true);
	});

	it("过滤中一律展开（命中藏在折叠里等于没命中）", () => {
		expect(isGroupOpen(DEFAULT_GROUP, { expanded: new Set(), filtering: true })).toBe(true);
	});

	it("不可折叠的组恒展开（当前会话 / 置顶）", () => {
		expect(isGroupOpen({ key: "current", collapsible: false }, { expanded: new Set(), filtering: false })).toBe(true);
		expect(isGroupOpen({ key: "pinned", collapsible: false }, { expanded: new Set(), filtering: false })).toBe(true);
	});
});

describe("renderGroups：当前会话永远第一，置顶第二，其余按 Agent", () => {
	const CURRENT_GROUP = { key: "current", label: "当前会话", rows: [CURRENT] };
	const HR_GROUP = { key: "agent:hr", label: "hr", rows: [session({ id: "s1", agent: "hr" })] };
	const DEFAULT_GROUP = { key: "agent:default", label: "default", rows: [session({ id: "s2" })] };

	it("没 pin：当前会话 → Agent 组；只有 Agent 组有折叠位", () => {
		const out = renderGroups([CURRENT_GROUP, HR_GROUP, DEFAULT_GROUP], []);

		expect(out.map(g => g.key)).toEqual(["current", "agent:hr", "agent:default"]);
		expect(out.map(g => g.collapsible)).toEqual([false, true, true]);
	});

	it("pin 过的行进置顶组，排在当前会话之后（不得把回实时的入口顶下去）", () => {
		const out = renderGroups([CURRENT_GROUP, HR_GROUP], [session({ id: "s9", agent: "hr" })]);

		expect(out.map(g => g.key)).toEqual(["current", "pinned", "agent:hr"]);
		expect(out.map(g => g.collapsible)).toEqual([false, false, true]);
		expect(out[1]?.label).toBe("置顶");
		expect(out[1]?.rows.map(r => r.id)).toEqual(["s9"]);
	});

	it("没有当前会话（未连接 / 还没拿到会话）：置顶排在最前", () => {
		const out = renderGroups([HR_GROUP], [session({ id: "s9", agent: "hr" })]);

		expect(out.map(g => g.key)).toEqual(["pinned", "agent:hr"]);
	});

	it("没 pin 就不画置顶组（空组头比没有它更坏）", () => {
		const out = renderGroups([HR_GROUP], []);

		expect(out.map(g => g.key)).toEqual(["agent:hr"]);
	});
});

describe("groupRowsId：aria-controls 指得到真目标", () => {
	it("key 原样拼进去（agent id 带冒号也是合法 id）", () => {
		expect(groupRowsId("agent:hr")).toBe("session-group-rows-agent:hr");
	});

	it("不同 key 不会撞成同一个 id（洗字符才会撞：`a:b` vs `a-b`）", () => {
		expect(groupRowsId("agent:a:b")).not.toBe(groupRowsId("agent:a-b"));
		expect(groupRowsId("agent:a-b")).toBe("session-group-rows-agent:a-b");
	});
});

describe("SessionGroupHeader 静态渲染：可点的才画成开关", () => {
	function render(props: Parameters<typeof SessionGroupHeader>[0]): string {
		return renderToStaticMarkup(createElement(SessionGroupHeader, props));
	}

	const BASE = { label: "DEFAULT", count: 88, collapsible: true, rowsId: "session-group-rows-agent:default" };

	it("可折叠 + 关着：是 button，aria-expanded=false，aria-controls 指到行容器，title 说「展开」", () => {
		const html = render({ ...BASE, open: false, onToggle: () => undefined });

		expect(html).toContain("<button");
		expect(html).toContain('aria-expanded="false"');
		expect(html).toContain('aria-controls="session-group-rows-agent:default"');
		expect(html).toContain('title="展开 DEFAULT"');
		expect(html).toContain("DEFAULT");
		expect(html).toContain(">88<");
	});

	it("可折叠 + 展开：aria-expanded=true，title 说「折叠」，箭头换向", () => {
		const html = render({ ...BASE, open: true, onToggle: () => undefined });

		expect(html).toContain('aria-expanded="true"');
		expect(html).toContain('title="折叠 DEFAULT"');
		expect(html).toContain("lucide-chevron-down");
	});

	it("过滤中（无 onToggle）：退回纯标题 —— 不是 button、没有 aria-expanded，但箭头照画", () => {
		const html = render({ ...BASE, open: true });

		expect(html).not.toContain("<button");
		expect(html).not.toContain("aria-expanded");
		expect(html).not.toContain("aria-controls");
		expect(html).toContain("lucide-chevron-down");
	});

	it("不可折叠（当前会话 / 置顶）：纯标题，且连箭头都不画（这个组本来就没有折叠位）", () => {
		const html = render({
			label: "置顶",
			count: 2,
			collapsible: false,
			open: true,
			rowsId: "session-group-rows-pinned",
		});

		expect(html).not.toContain("<button");
		expect(html).not.toContain("lucide-chevron");
		expect(html).toContain("置顶");
		expect(html).toContain(">2<");
	});
});
