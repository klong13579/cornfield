import { describe, expect, test } from "bun:test";
import type { AgentInfoDto } from "@cornfield/wire";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentMenuItem } from "../src/pages/workspace/ComposerBar";

/**
 * ComposerBar 的 agent 菜单行不再渲染 `cronCount`（票 10）：
 *   `{a.skillsCount ?? 0} 技能 · {a.cronCount ?? 0} 定时`  →  `{agent.skillsCount ?? 0} 技能`
 *
 * 为什么删而不是占位：`cronCount` 在服务端**没有数据源**（调度器在 gateway 进程，serve 的
 * `list_agents` 拿不到；见 `packages/pi-wire/src/results/agents.ts` 的【无数据源】标注与
 * `docs/web-app-fix-t6`），适配层从不填充 ⇒ 恒 undefined，`?? 0` 把它渲染成「0 定时」——
 * 一项不存在的数据被显示成「零」，看起来像功能坏了。`skillsCount` 有数据源（适配层
 * `skillCount`），必须留下。
 *
 * 环境约束：web-app 全仓走 `react-dom/server` 静态渲染（无 DOM、不跑 effect），所以断言落在
 * 提出来的纯展示组件上（与 `ModelList` / `ContextItemChip` 同一手法）——它就是 ComposerBar
 * 菜单里实际渲染的那一个（同文件、同一处调用）。
 */

const composerSrc = await Bun.file(new URL("../src/pages/workspace/ComposerBar.tsx", import.meta.url)).text();
/** 去注释后的代码文本：`cronCount` 只允许出现在「为什么删」的说明里，不允许出现在代码里。 */
const composerCode = composerSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

function agent(over: Partial<AgentInfoDto> = {}): AgentInfoDto {
	return {
		id: "hr",
		name: "HR 助手",
		face: "H",
		workspace: "hr",
		kind: "worker",
		status: "idle",
		...over,
	};
}

function render(a: AgentInfoDto, selected = false, stopped = false): string {
	return renderToStaticMarkup(
		createElement(AgentMenuItem, { agent: a, selected, stopped, onSelect: () => undefined }),
	);
}

describe("ComposerBar 菜单行：skillsCount 保留、cronCount 渲染已删", () => {
	test("skillsCount 有真值 → 渲染「7 技能」，且不出现「定时」", () => {
		const html = render(agent({ skillsCount: 7 }));
		expect(html).toContain("7 技能");
		expect(html).not.toContain("定时");
	});

	test("skillsCount 缺省 → 「0 技能」（保留 ?? 0 语义），仍不出现「定时」", () => {
		const html = render(agent());
		expect(html).toContain("0 技能");
		expect(html).not.toContain("定时");
	});

	test("cronCount 即使被填了值也不再渲染（渲染点已删，不是藏起来）", () => {
		const html = render(agent({ skillsCount: 3, cronCount: 5 }));
		expect(html).toContain("3 技能");
		expect(html).not.toContain("5 技能");
		expect(html).not.toContain("定时");
	});

	test("不留占位：缺值处不出现「—」「暂无」「定时」这类替代文案", () => {
		const html = render(agent({ skillsCount: undefined, cronCount: undefined }));
		expect(html).not.toContain("—");
		expect(html).not.toContain("暂无");
		expect(html).not.toContain("定时");
	});

	test("有数据源的邻居字段未受影响：名称 / 首字母 / 状态文案 / 类别", () => {
		const html = render(agent({ name: "编码助手", face: "C", kind: "coding", status: "online" }));
		expect(html).toContain("@编码助手");
		expect(html).toContain(">C<");
		expect(html).toContain('title="运行中"');
		expect(html).toContain("CODING");
		expect(render(agent())).toContain("WORKER");
	});

	test("选中态与停用态仍可见", () => {
		const stopped = render(agent(), false, true);
		expect(stopped).toContain("已停用");
		expect(stopped).toContain("opacity-60");
		expect(render(agent(), true)).toContain("bg-accent-dim");
	});
});

describe("源码不变量：ComposerBar 的 cronCount 渲染点已清零", () => {
	test("代码里不再引用 cronCount（注释里的说明不算）", () => {
		expect(composerCode).not.toContain("cronCount");
	});

	test("有数据源的 skillsCount 渲染仍在（没被一起删掉）", () => {
		expect(composerCode).toContain("skillsCount");
	});
});
